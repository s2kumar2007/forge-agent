import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HandoffTracker } from '../src/agent/handoff';
import { AgentController } from '../src/agent/controller';
import { ReviewApprovals, type ReviewUi } from '../src/review/approvals';
import { DecisionStore } from '../src/review/decisions';
import { FakeTrueForge, RecordingUi, approvalRequired, created, delta, done, toolMsg } from './fakes';

describe('HandoffTracker unit tests', () => {
  it('enforces brief size cap under maxTokens budget even with massive inputs', () => {
    const tracker = new HandoffTracker('Refactor authentication service');

    // Add huge inputs
    for (let i = 0; i < 20; i++) {
      tracker.recordReadOnlyCall(
        'read_file',
        { path: `src/module_${i}.ts` },
        'A'.repeat(5000)
      );
    }
    for (let i = 0; i < 10; i++) {
      tracker.recordReadOnlyCall(
        'search_workspace',
        { query: `query_${i}`, kind: 'text' },
        'MATCH '.repeat(500)
      );
    }
    tracker.recordPlanText('P'.repeat(10000));
    for (let i = 0; i < 10; i++) {
      tracker.recordPendingDiff({
        path: `src/module_${i}.ts`,
        rationale: 'R'.repeat(500),
      });
    }

    // Default maxTokens: 1200 (~4800 chars)
    const briefDefault = tracker.buildHandoffBrief({ maxTokens: 1200 });
    expect(briefDefault.length).toBeLessThanOrEqual(1200 * 4);
    expect(briefDefault).toContain('Handoff from Previous Session');
    expect(briefDefault).toContain('Refactor authentication service');

    // Custom maxTokens: 500 (~2000 chars)
    const briefSmall = tracker.buildHandoffBrief({ maxTokens: 500 });
    expect(briefSmall.length).toBeLessThanOrEqual(500 * 4);
  });

  it('strictly excludes secret files from files read, searches, and pending diffs', () => {
    const tracker = new HandoffTracker('Check configuration files');

    // Attempt to record secret-like files
    tracker.recordReadOnlyCall('read_file', { path: '.env' }, 'SECRET_KEY=12345');
    tracker.recordReadOnlyCall('read_file', { path: '.env.local' }, 'API_TOKEN=abcde');
    tracker.recordReadOnlyCall('read_file', { path: 'server.pem' }, 'CERTIFICATE DATA');
    tracker.recordReadOnlyCall('read_file', { path: 'config.key' }, 'KEY DATA');
    tracker.recordReadOnlyCall('read_file', { path: 'id_rsa' }, 'PRIVATE KEY DATA');
    tracker.recordReadOnlyCall('read_file', { path: 'credentials.json' }, 'AUTH DATA');
    tracker.recordReadOnlyCall('read_file', { path: 'keystore.p12' }, 'P12 DATA');
    tracker.recordReadOnlyCall('read_file', { path: '.git/config' }, 'GIT CONFIG');

    // Legitimate file
    tracker.recordReadOnlyCall('read_file', { path: 'src/config.py' }, 'DEBUG = True\nPORT = 8080\n');

    // Pending diff on secret file
    tracker.recordPendingDiff({
      path: '.env',
      rationale: 'Update secret key',
    });
    // Pending diff on legitimate file
    tracker.recordPendingDiff({
      path: 'src/config.py',
      rationale: 'Update debug flag',
    });

    const brief = tracker.buildHandoffBrief();

    // Verify secret files never appear
    expect(brief).not.toContain('.env');
    expect(brief).not.toContain('.env.local');
    expect(brief).not.toContain('server.pem');
    expect(brief).not.toContain('config.key');
    expect(brief).not.toContain('id_rsa');
    expect(brief).not.toContain('credentials.json');
    expect(brief).not.toContain('keystore.p12');
    expect(brief).not.toContain('.git/config');
    expect(brief).not.toContain('SECRET_KEY');
    expect(brief).not.toContain('12345');

    // Verify legitimate file appears
    expect(brief).toContain('src/config.py');
    expect(tracker.getUniqueFilesCount()).toBe(1);
    expect(tracker.getUniqueFiles()).toEqual(['src/config.py']);
  });
});

describe('Handoff failover integration in AgentController', () => {
  function setupTestController(acceptIds: number[] = []) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
    const helpersFile = path.join(root, 'helpers.py');
    fs.writeFileSync(helpersFile, 'def get_debug_flag():\n    return False\n');

    const store = new DecisionStore();
    const ui: ReviewUi = {
      reviewHunks: async () => acceptIds,
      confirmCommand: async () => true,
      close() {},
    };
    const approvals = new ReviewApprovals({
      root,
      ui,
      store,
      readText: async (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined),
    });

    return { root, helpersFile, approvals, store };
  }

  it('passes handoff brief to fallback so it continues without repeating exploration calls', async () => {
    const { approvals } = setupTestController();
    let fallbackReceivedInput: any[] = [];
    const fallbackToolCalls: string[] = [];

    const tf = new FakeTrueForge({
      'forge-primary': [
        // Primary turn: explores helpers.py and then fails with network error
        async function* () {
          yield created();
          yield delta('m1', 'Inspecting helpers.py to locate get_debug_flag... ');
          yield toolMsg('m1', 'tc1', 'read_file', { path: 'helpers.py', start: 1, end: 10 });
          throw new Error('ECONNRESET 127.0.0.1:8790 connection reset');
        },
      ],
      'forge-fallback': [
        // Fallback turn: receives the handoff brief and directly calls propose_write
        (input) => {
          fallbackReceivedInput = input;
          return [
            created(),
            delta('m2', 'Continuing with propose_write as indicated in handoff brief. '),
            toolMsg('m2', 'tc2', 'propose_write', { path: 'helpers.py', new_content: 'def get_debug_flag():\n    return True\n', rationale: 'fix' }),
            approvalRequired('tc2', 'm2'),
            done(),
          ];
        },
        () => [created(), delta('m3', 'Done.'), done()],
      ],
    });

    const ctl = new AgentController({
      getClient: () => tf.client,
      approvals,
      agents: () => ({ primary: 'forge-primary', fallback: 'forge-fallback' }),
      retries: 0,
      fallbackContextBudget: 1200,
    });

    const ui = new RecordingUi();
    await ctl.run('Update get_debug_flag in helpers.py', ui);

    // 1. Notice shows files reused from primary exploration
    expect(ui.notices).toContain('Primary unavailable, continuing on fallback (reusing 1 files already read)');

    // 2. Fallback received the handoff brief in its initial input
    expect(fallbackReceivedInput.length).toBeGreaterThan(0);
    const firstContent = fallbackReceivedInput[0].content;
    expect(firstContent).toContain('Handoff from Previous Session (Continue Exploration)');
    expect(firstContent).toContain('helpers.py');
    expect(firstContent).toContain('Do NOT repeat completed file reads or searches below');

    // 3. Fallback did not repeat read_file; it proceeded directly to propose_write
    expect(ui.tools).toEqual(['read_file', 'propose_write']);
  });

  it('replay guard still blocks fallback after an approved write or command', async () => {
    const { approvals, helpersFile } = setupTestController([1]); // Accept hunk

    const tf = new FakeTrueForge({
      'forge-primary': [
        // Turn 1: primary proposes write and gets approved
        () => [
          created(),
          toolMsg('m1', 'tc1', 'propose_write', {
            path: 'helpers.py',
            new_content: 'def get_debug_flag():\n    return True\n',
            rationale: 'update',
          }),
          approvalRequired('tc1', 'm1'),
          done(),
        ],
        // Turn 2: primary fails with server 500 error AFTER approval
        () => {
          throw new Error('HTTP 500 Internal Server Error after approval');
        },
      ],
      'forge-fallback': [
        // Fallback should NEVER be invoked!
        () => [created(), delta('m_fallback', 'Should not run'), done()],
      ],
    });

    const ctl = new AgentController({
      getClient: () => tf.client,
      approvals,
      agents: () => ({ primary: 'forge-primary', fallback: 'forge-fallback' }),
      retries: 0,
    });

    const ui = new RecordingUi();
    await ctl.run('Update get_debug_flag', ui);

    // Replay guard must halt and refuse automatic failover
    expect(ui.result?.status).toBe('error');
    expect(ui.result?.message).toContain('1 approved operation(s) may have completed');
    expect(ui.result?.message).toContain('inspect the workspace and use "Forge: Undo last applied change" to revert');

    // Fallback was never called
    expect(tf.sessions.has('s2')).toBe(false);
  });
});
