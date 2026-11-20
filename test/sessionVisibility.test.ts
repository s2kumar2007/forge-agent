import { describe, it, expect, vi } from 'vitest';
import { runTurn } from '../src/forge/turnRunner';
import { AgentController } from '../src/agent/controller';
import { ReviewApprovals } from '../src/review/approvals';
import { DecisionStore } from '../src/review/decisions';
import {
  FakeTrueForge,
  RecordingUi,
  created,
  done,
  delta,
  subagentCreated,
  subagentDone,
  compactionStarted,
  compactionFinished,
  unknownEvent,
} from './fakes';

describe('stream event visibility (subagents & compaction)', () => {
  it('notifies when subagent starts and finishes', async () => {
    const lines: string[] = [];
    const client = {
      sessions: {
        createTurnStream: async () => ({
          withMetadata: async function* () {
            yield { data: created(), id: '1' };
            yield { data: subagentCreated('search', 'sub-1'), id: '2' };
            yield { data: delta('m1', 'working'), id: '3' };
            yield { data: subagentDone('search', 'sub-1'), id: '4' };
            yield { data: done(), id: '5' };
          },
        }),
      },
    } as any;

    const res = await runTurn(client, 's1', [{ type: 'user.message', content: 'hello' }], {
      onTextDelta: () => {},
      onToolCall: () => {},
      onEventLine: (line) => lines.push(line),
    });

    expect(res.status).toBe('done');
    expect(lines).toContain('Subagent search started');
    expect(lines).toContain('Subagent search finished');
  });

  it('notifies when context compaction starts and finishes', async () => {
    const lines: string[] = [];
    const client = {
      sessions: {
        createTurnStream: async () => ({
          withMetadata: async function* () {
            yield { data: created(), id: '1' };
            yield { data: compactionStarted(), id: '2' };
            yield { data: compactionFinished(), id: '3' };
            yield { data: done(), id: '4' };
          },
        }),
      },
    } as any;

    const res = await runTurn(client, 's1', [{ type: 'user.message', content: 'hello' }], {
      onTextDelta: () => {},
      onToolCall: () => {},
      onEventLine: (line) => lines.push(line),
    });

    expect(res.status).toBe('done');
    expect(lines).toContain('Context compaction started');
    expect(lines).toContain('Context compacted');
  });

  it('safely ignores unknown stream events', async () => {
    const lines: string[] = [];
    const client = {
      sessions: {
        createTurnStream: async () => ({
          withMetadata: async function* () {
            yield { data: created(), id: '1' };
            yield { data: unknownEvent('future.event_type'), id: '2' };
            yield { data: unknownEvent('another.unrecognized.event'), id: '3' };
            yield { data: delta('m1', 'ok'), id: '4' };
            yield { data: done(), id: '5' };
          },
        }),
      },
    } as any;

    const res = await runTurn(client, 's1', [{ type: 'user.message', content: 'hello' }], {
      onTextDelta: () => {},
      onToolCall: () => {},
      onEventLine: (line) => lines.push(line),
    });

    expect(res.status).toBe('done');
    expect(lines).toEqual([]); // Unknown events do not emit any lines
  });

  it('ignores thread.created and thread.done on main thread', async () => {
    const lines: string[] = [];
    const client = {
      sessions: {
        createTurnStream: async () => ({
          withMetadata: async function* () {
            yield { data: created(), id: '1' };
            yield { data: { type: 'thread.created', id: 'e1', threadId: 'main', title: 'Main thread' }, id: '2' };
            yield { data: { type: 'thread.done', id: 'e2', threadId: 'main', title: 'Main thread' }, id: '3' };
            yield { data: done(), id: '4' };
          },
        }),
      },
    } as any;

    const res = await runTurn(client, 's1', [{ type: 'user.message', content: 'hello' }], {
      onTextDelta: () => {},
      onToolCall: () => {},
      onEventLine: (line) => lines.push(line),
    });

    expect(res.status).toBe('done');
    expect(lines).toEqual([]); // Main thread events are not reported as subagent events
  });
});

describe('session id visibility in controller', () => {
  it('reports the TrueForge session id to ui.session and renders through controller', async () => {
    const tf = new FakeTrueForge({
      'forge-agent': [
        () => [
          created(),
          subagentCreated('search', 'sub-1'),
          delta('m1', 'found files'),
          subagentDone('search', 'sub-1'),
          compactionFinished(),
          done(),
        ],
      ],
    });
    const store = new DecisionStore();
    const approvals = new ReviewApprovals({
      root: '/tmp',
      ui: { reviewHunks: async () => [], confirmCommand: async () => false, close() {} },
      store,
      readText: async () => undefined,
    });
    const ctl = new AgentController({
      getClient: () => tf.client,
      approvals,
      agents: () => ({ primary: 'forge-agent' }),
      retries: 0,
    });
    const ui = new RecordingUi();

    await ctl.run('investigate', ui);

    expect(ui.result?.status).toBe('done');
    expect(ui.sessions).toEqual(['s1']);
    expect(ui.events).toContain('Subagent search started');
    expect(ui.events).toContain('Subagent search finished');
    expect(ui.events).toContain('Context compacted');
  });
});
