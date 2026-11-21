import { describe, it, expect } from 'vitest';
import { RunMetricsCollector } from '../src/metrics';
import { AgentController } from '../src/agent/controller';
import type { AgentUi } from '../src/agent/types';
import type { TrueForge } from '@truefoundry/trueforge-sdk';

describe('RunMetricsCollector', () => {
  it('tracks start time, end time, total time, and TTFT', () => {
    let now = 1000;
    const collector = new RunMetricsCollector(() => now);

    collector.recordInput('Hello world, please help me with this task.');
    now = 1250;
    collector.recordTextDelta('Certainly!');
    now = 1400;
    collector.recordTextDelta(' Here is the result.');
    now = 2000;
    collector.recordModelTurn();
    collector.setAgentAnswered('test-agent');

    const metrics = collector.finish();
    expect(metrics.startTime).toBe(1000);
    expect(metrics.endTime).toBe(2000);
    expect(metrics.totalTimeMs).toBe(1000);
    expect(metrics.timeToFirstTokenMs).toBe(250);
    expect(metrics.modelTurns).toBe(1);
    expect(metrics.agentAnswered).toBe('test-agent');
    expect(metrics.estimatedTokensIn).toBeGreaterThan(0);
    expect(metrics.estimatedTokensOut).toBeGreaterThan(0);
  });

  it('tracks tool call start and duration', () => {
    let now = 1000;
    const collector = new RunMetricsCollector(() => now);

    now = 1100;
    collector.recordToolStart('read_file');
    now = 1350;
    collector.recordToolEnd();

    now = 1400;
    collector.recordToolStart('search_workspace');
    now = 1600;
    collector.recordToolEnd('search_workspace');

    const metrics = collector.finish();
    expect(metrics.toolCalls).toHaveLength(2);
    expect(metrics.toolCalls[0]).toEqual({ name: 'read_file', durationMs: 250 });
    expect(metrics.toolCalls[1]).toEqual({ name: 'search_workspace', durationMs: 200 });
  });

  it('formats a concise summary string for logs', () => {
    let now = 1000;
    const collector = new RunMetricsCollector(() => now);
    collector.recordInput('Do something');
    now = 1120;
    collector.recordTextDelta('Ok');
    now = 1200;
    collector.recordToolStart('read_file');
    now = 1350;
    collector.recordToolEnd();
    collector.recordModelTurn();
    collector.setAgentAnswered('forge-primary');
    now = 2500;

    const summary = collector.formatSummary();
    expect(summary).toContain('[Metrics]');
    expect(summary).toContain('forge-primary');
    expect(summary).toContain('1.50s');
    expect(summary).toContain('TTFT: 120ms');
    expect(summary).toContain('Turns: 1');
    expect(summary).toContain('read_file: 150ms');
  });

  it('emits metrics and logs when AgentController completes a run', async () => {
    let fakeNow = 1000;
    let loggedSummary: string | undefined;
    let uiMetrics: unknown;

    const fakeClient = {
      sessions: {
        create: async () => ({ data: { id: 's1' } }),
        createTurnStream: () => ({
          withMetadata: async function* () {
            fakeNow += 50;
            yield { data: { id: 'e1', type: 'model.message', content: 'Done!' } };
            yield { data: { id: 'e2', type: 'turn.done', state: { status: 'done' } } };
          },
        }),
      },
    } as unknown as TrueForge;

    const ui: AgentUi = {
      textDelta() {},
      toolCall() {},
      notice() {},
      finished() {},
      metrics(m) { uiMetrics = m; },
    };

    const ctl = new AgentController({
      getClient: () => fakeClient,
      approvals: { decide: async () => ({ status: 'allow' }), cancelAll() {} },
      agents: () => ({ primary: 'agent-a' }),
      retries: 0,
      now: () => fakeNow,
      logMetrics: (sum) => { loggedSummary = sum; },
    });

    await ctl.run('test prompt', ui);

    expect(uiMetrics).toBeDefined();
    expect((uiMetrics as any).agentAnswered).toBe('agent-a');
    expect(loggedSummary).toBeDefined();
    expect(loggedSummary).toContain('[Metrics]');
    expect(loggedSummary).toContain('agent-a');
  });
});
