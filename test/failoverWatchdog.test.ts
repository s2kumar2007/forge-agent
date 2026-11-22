import { describe, it, expect, vi, afterEach } from 'vitest';
import { runWithFallback, ForgeFailure, isOverloadedError, isStallError, type FallbackTarget } from '../src/agent/resilience';
import { AgentController, ModelHealthTracker } from '../src/agent/controller';
import { ReviewApprovals } from '../src/review/approvals';
import { DecisionStore } from '../src/review/decisions';
import { FakeTrueForge, RecordingUi, created, delta, done, toolMsg, approvalRequired } from './fakes';
import { tempRepo } from './helpers';
import { runTurn } from '../src/forge/turnRunner';

describe('watchdog, failover budget, and model health', () => {
  it('classifies 503 "high demand", UNAVAILABLE, and ECONNRESET as overloaded', () => {
    expect(isOverloadedError(new Error('503 Service Unavailable: High demand for model'))).toBe(true);
    expect(isOverloadedError(new Error('503 UNAVAILABLE: The model is overloaded'))).toBe(true);
    expect(isOverloadedError(new Error('Model is currently overloaded due to high demand'))).toBe(true);
    expect(isOverloadedError(new Error('read ECONNRESET'))).toBe(true);
    expect(isOverloadedError(new Error('stream terminated unexpectedly'))).toBe(true);
    expect(isOverloadedError(new Error('socket hang up'))).toBe(true);
    expect(isOverloadedError(new Error('connection reset'))).toBe(true);
    expect(isOverloadedError(new Error('503 Please retry in 60s.'))).toBe(false);
    expect(isOverloadedError(new Error('429 rate limit reached'))).toBe(false);
    expect(isOverloadedError(new Error('401 Unauthorized'))).toBe(false);
  });

  it('classifies stall and first token timeouts', () => {
    expect(isStallError(new Error('Stall timeout: no stream event for 20000ms'))).toBe(true);
    expect(isStallError(new Error('First token timeout: no response within 25000ms'))).toBe(true);
    expect(isStallError(new Error('429 Too Many Requests'))).toBe(false);
  });

  it('watchdog cancels stalled turn via sessions.cancel, clears review state, and fails over', async () => {
    const { root, gitStatus } = tempRepo();
    let onCancelCalled = false;
    let turn1Started = false;

    // Simulate primary stream that sends created() and then stalls indefinitely
    const stalledScript = async function* () {
      turn1Started = true;
      yield created();
      await new Promise(() => {}); // never resolves
    };

    const tf = new FakeTrueForge({
      'forge-primary': [stalledScript as any],
      'forge-fallback': [() => [created(), delta('m1', 'fallback response'), done()]],
    });

    const store = new DecisionStore();
    const approvals = new ReviewApprovals({
      root,
      ui: { reviewHunks: async () => [], confirmCommand: async () => false, close() {} },
      store,
      readText: async () => undefined,
    });

    const ctl = new AgentController({
      getClient: () => tf.client,
      approvals,
      agents: () => ({ primary: 'forge-primary', fallback: 'forge-fallback' }),
      firstTokenTimeoutMs: 500,
      stallTimeoutMs: 50, // triggers quickly in test
      onCancel: () => { onCancelCalled = true; store.clear(); },
      sleep: async () => {},
    });

    const ui = new RecordingUi();
    await ctl.run('test stall watchdog', ui);

    expect(turn1Started).toBe(true);
    expect(ui.result?.status).toBe('done');
    expect(ui.text).toBe('fallback response');
    // Verify sessions.cancel was called for the stalled session
    expect(tf.cancels).toContain('s1');
    expect(onCancelCalled).toBe(true);
    expect(ui.notices.some((n) => n.includes('sent nothing for') && n.includes('switching to fallback'))).toBe(true);
    expect(gitStatus()).toBe('');
  });

  it('watchdog cancels turn when no first token arrives within firstTokenTimeoutMs', async () => {
    const { root, gitStatus } = tempRepo();

    // Stream that yields nothing
    const noTokenScript = async function* () {
      await new Promise(() => {});
    };

    const tf = new FakeTrueForge({
      'forge-primary': [noTokenScript as any],
      'forge-fallback': [() => [created(), delta('m1', 'fallback answer'), done()]],
    });

    const ctl = new AgentController({
      getClient: () => tf.client,
      approvals: { decide: async () => ({ status: 'deny' as const, reason: 'no' }), cancelAll() {} },
      agents: () => ({ primary: 'forge-primary', fallback: 'forge-fallback' }),
      firstTokenTimeoutMs: 50,
      stallTimeoutMs: 500,
      sleep: async () => {},
    });

    const ui = new RecordingUi();
    await ctl.run('test first token timeout', ui);

    expect(ui.result?.status).toBe('done');
    expect(ui.text).toBe('fallback answer');
    expect(tf.cancels).toContain('s1');
    expect(gitStatus()).toBe('');
  });

  it('overloaded 503 "high demand" does at most 1 quick retry (<=2s) before switching to next model', async () => {
    const { root, gitStatus } = tempRepo();
    let primaryAttempts = 0;
    const sleeps: number[] = [];

    const tf = new FakeTrueForge({
      'forge-primary': [
        () => {
          primaryAttempts++;
          throw new Error('503 UNAVAILABLE: High demand for model');
        },
        () => {
          primaryAttempts++;
          throw new Error('503 UNAVAILABLE: High demand for model');
        },
        () => {
          primaryAttempts++;
          throw new Error('503 UNAVAILABLE: High demand for model');
        },
      ],
      'forge-fallback': [() => [created(), delta('m1', 'Fallback recovered'), done()]],
    });

    const ctl = new AgentController({
      getClient: () => tf.client,
      approvals: { decide: async () => ({ status: 'deny' as const, reason: 'no' }), cancelAll() {} },
      agents: () => ({ primary: 'forge-primary', fallback: 'forge-fallback' }),
      retries: 3, // Controller allows 3, but overloaded must cap at 1 retry!
      backoffMs: 1000,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    const ui = new RecordingUi();
    await ctl.run('test overloaded capping', ui);

    expect(ui.result?.status).toBe('done');
    expect(ui.text).toBe('Fallback recovered');
    // Exactly 2 attempts on primary (1 initial + 1 quick retry), NOT 4!
    expect(primaryAttempts).toBe(2);
    // Retry delay must be <= 2000ms
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeLessThanOrEqual(2000);
    expect(gitStatus()).toBe('');
  });

  it('enforces total failover budget and leaves workspace unchanged', async () => {
    const { root, gitStatus } = tempRepo();
    let nowTime = 1000;

    const tf = new FakeTrueForge({
      'forge-primary': [
        () => { throw new Error('503 UNAVAILABLE: High demand'); },
        () => { throw new Error('503 UNAVAILABLE: High demand'); },
      ],
      'forge-fallback': [
        () => { throw new Error('503 UNAVAILABLE: High demand'); },
      ],
    });

    const ctl = new AgentController({
      getClient: () => tf.client,
      approvals: { decide: async () => ({ status: 'deny' as const, reason: 'no' }), cancelAll() {} },
      agents: () => ({ primary: 'forge-primary', fallback: 'forge-fallback' }),
      failoverBudgetMs: 2500,
      now: () => nowTime,
      sleep: async () => { nowTime += 3000; },
    });

    const ui = new RecordingUi();
    await ctl.run('test budget', ui);

    expect(ui.result?.status).toBe('error');
    expect(ui.result?.message).toContain('Failover budget exceeded (3s). Last error (overloaded): 503 UNAVAILABLE: High demand. No changes were made to your workspace.');
    expect(gitStatus()).toBe('');
  });

  it('navigates ordered fallback list across multiple models', async () => {
    const { root, gitStatus } = tempRepo();
    const calls: string[] = [];

    const tf = new FakeTrueForge({
      'forge-primary': [() => { calls.push('primary'); throw new Error('503 UNAVAILABLE: High demand'); }],
      'forge-agent-fallback': [
        // Model 1 (e.g. groq) fails
        () => { calls.push('fallback-1'); throw new Error('503 UNAVAILABLE: High demand'); },
        // Model 2 (e.g. gemini) succeeds
        () => { calls.push('fallback-2'); return [created(), delta('m1', 'Gemini succeeded'), done()]; },
      ],
    });

    const ctl = new AgentController({
      getClient: () => tf.client,
      approvals: { decide: async () => ({ status: 'deny' as const, reason: 'no' }), cancelAll() {} },
      agents: () => ({
        primary: 'forge-primary',
        fallback: 'forge-agent-fallback',
        fallbackModels: ['groq/llama-3.3-70b-versatile', 'google-gemini/gemini-3-8-flash'],
      }),
      sleep: async () => {},
    });

    const ui = new RecordingUi();
    await ctl.run('multi-model fallback', ui);

    expect(ui.result?.status).toBe('done');
    expect(ui.text).toBe('Gemini succeeded');
    expect(calls).toContain('primary');
    expect(calls).toContain('fallback-1');
    expect(calls).toContain('fallback-2');
    expect(gitStatus()).toBe('');
  });

  it('marks overloaded model unhealthy for 5 minutes and skips it for later requests', async () => {
    let nowTime = 100_000;
    const health = new ModelHealthTracker(5 * 60 * 1000, () => nowTime);

    expect(health.isHealthy('model-a')).toBe(true);
    health.markUnhealthy('model-a');
    expect(health.isHealthy('model-a')).toBe(false);

    // 2 minutes later: still unhealthy
    nowTime += 2 * 60 * 1000;
    expect(health.isHealthy('model-a')).toBe(false);

    // 5 minutes and 1 second later: healthy again
    nowTime += 3 * 60 * 1000 + 1000;
    expect(health.isHealthy('model-a')).toBe(true);
  });

  it('logs session id, agent, and model per attempt and injects handoff brief into failover session', async () => {
    const { root, file } = tempRepo();
    const attemptsLogged: string[] = [];

    // Turn 1 on primary reads a file, then stalls/fails with ECONNRESET; retry also fails with ECONNRESET
    const tf = new FakeTrueForge({
      'forge-primary': [
        async function* () {
          yield created();
          yield toolMsg('m1', 'tc1', 'read_file', { path: 'f.txt' });
          throw new Error('read ECONNRESET');
        },
        () => {
          throw new Error('read ECONNRESET');
        },
      ],
      'forge-fallback': [
        (input: any[]) => {
          // Verify handoff brief was injected into fallback turn input!
          const userMsg = input.find((item: any) => item.type === 'user.message')?.content ?? '';
          expect(userMsg).toContain('Handoff from Previous Session');
          expect(userMsg).toContain('f.txt');
          return [created(), delta('m2', 'Received brief, writing proposal'), done()];
        },
      ],
    });

    const ctl = new AgentController({
      getClient: () => tf.client,
      approvals: { decide: async () => ({ status: 'allow' as const }), cancelAll() {} },
      agents: () => ({ primary: 'forge-primary', fallback: 'forge-fallback', fallbackModel: 'test-fallback-model' }),
      logAttempt: (line) => attemptsLogged.push(line),
      sleep: async () => {},
    });

    const ui = new RecordingUi();
    await ctl.run('read and modify', ui);

    expect(ui.result?.status).toBe('done');
    expect(attemptsLogged.some((l) => /\[forge\] Attempt 1: session=s1 agent=forge-primary/.test(l))).toBe(true);
    expect(attemptsLogged.some((l) => /\[forge\] Attempt 1 result: agent=forge-primary .* outcome=failed class=overloaded/.test(l))).toBe(true);
    expect(attemptsLogged.some((l) => /\[forge\] Attempt 2: session=s2 agent=forge-primary/.test(l))).toBe(true);
    expect(attemptsLogged.some((l) => /\[forge\] Attempt 2 result: agent=forge-primary .* outcome=failed class=overloaded/.test(l))).toBe(true);
    expect(attemptsLogged.some((l) => /\[forge\] Attempt 3: session=s3 agent=forge-fallback model=test-fallback-model/.test(l))).toBe(true);
    expect(attemptsLogged.some((l) => /\[forge\] Attempt 3 result: agent=forge-fallback model=test-fallback-model outcome=done/.test(l))).toBe(true);
    expect(ui.notices.some((n) => n.includes('Primary unavailable, continuing on fallback (reusing 1 files already read)'))).toBe(true);
  });

  describe('watchdog fake clock timers (STEP 1)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const createControllableStream = (abortSignal?: AbortSignal) => {
      const queue: any[] = [];
      let waitingResolve: (() => void) | undefined;
      let closed = false;

      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          closed = true;
          if (waitingResolve) {
            const r = waitingResolve;
            waitingResolve = undefined;
            r();
          }
        });
      }

      const push = (ev: any) => {
        queue.push(ev);
        if (waitingResolve) {
          const r = waitingResolve;
          waitingResolve = undefined;
          r();
        }
      };

      const close = () => {
        closed = true;
        if (waitingResolve) {
          const r = waitingResolve;
          waitingResolve = undefined;
          r();
        }
      };

      const stream = {
        async *[Symbol.asyncIterator]() {
          while (true) {
            while (queue.length === 0 && !closed && !abortSignal?.aborted) {
              await new Promise<void>((res) => {
                waitingResolve = res;
              });
            }
            if (queue.length > 0) {
              yield { data: queue.shift() };
            } else if (closed || abortSignal?.aborted) {
              if (abortSignal?.aborted) {
                throw new Error('AbortError');
              }
              break;
            }
          }
        },
        withMetadata() {
          return this;
        },
      };

      return { push, close, stream };
    };

    it('no event for 30s with firstTokenTimeoutMs=45000 does NOT trigger, then at 46s triggers First token timeout', async () => {
      vi.useFakeTimers();
      let streamCtrl: any;
      const fakeClient = {
        sessions: {
          createTurnStream: async (_id: string, _opts: any, reqOpts: any) => {
            streamCtrl = createControllableStream(reqOpts?.abortSignal);
            return streamCtrl.stream;
          },
        },
      } as any;

      let caughtError: Error | undefined;
      const turnPromise = runTurn(
        fakeClient,
        's1',
        [],
        { onTextDelta: () => {}, onToolCall: () => {} },
        undefined,
        { firstTokenTimeoutMs: 45000, stallTimeoutMs: 20000 }
      ).catch((e) => {
        caughtError = e;
      });

      // After 30s: does NOT trigger
      await vi.advanceTimersByTimeAsync(30000);
      expect(caughtError).toBeUndefined();

      // At 46s (16s more): triggers "First token timeout"
      await vi.advanceTimersByTimeAsync(16000);
      await turnPromise;
      expect(caughtError).toBeDefined();
      expect(caughtError?.message).toContain('First token timeout: no response within 45000ms');
    });

    it('an event at 5s followed by 21s of silence triggers Stall timeout', async () => {
      vi.useFakeTimers();
      let streamCtrl: any;
      const fakeClient = {
        sessions: {
          createTurnStream: async (_id: string, _opts: any, reqOpts: any) => {
            streamCtrl = createControllableStream(reqOpts?.abortSignal);
            return streamCtrl.stream;
          },
        },
      } as any;

      let caughtError: Error | undefined;
      const turnPromise = runTurn(
        fakeClient,
        's1',
        [],
        { onTextDelta: () => {}, onToolCall: () => {} },
        undefined,
        { firstTokenTimeoutMs: 45000, stallTimeoutMs: 20000 }
      ).catch((e) => {
        caughtError = e;
      });

      // Advance to 5s and send event
      await vi.advanceTimersByTimeAsync(5000);
      streamCtrl.push({ type: 'turn.created', id: 't1' });
      await vi.advanceTimersByTimeAsync(100);
      expect(caughtError).toBeUndefined();

      // Silence for 21s (stallTimeout is 20s): triggers "Stall timeout"
      await vi.advanceTimersByTimeAsync(21000);
      await turnPromise;
      expect(caughtError).toBeDefined();
      expect(caughtError?.message).toContain('Stall timeout: no stream event for 20000ms');
    });

    it('steady events never trigger any timeout', async () => {
      vi.useFakeTimers();
      let streamCtrl: any;
      const fakeClient = {
        sessions: {
          createTurnStream: async (_id: string, _opts: any, reqOpts: any) => {
            streamCtrl = createControllableStream(reqOpts?.abortSignal);
            return streamCtrl.stream;
          },
        },
      } as any;

      let caughtError: Error | undefined;
      const turnPromise = runTurn(
        fakeClient,
        's1',
        [],
        { onTextDelta: () => {}, onToolCall: () => {} },
        undefined,
        { firstTokenTimeoutMs: 45000, stallTimeoutMs: 20000 }
      ).catch((e) => {
        caughtError = e;
      });

      // Send event at 5s
      await vi.advanceTimersByTimeAsync(5000);
      streamCtrl.push({ type: 'turn.created', id: 't1' });

      // Send another event every 10s up to 60s
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(10000);
        streamCtrl.push({ type: 'model.message', id: `m${i}`, threadId: 'main', content: 'chunk' });
      }

      await vi.advanceTimersByTimeAsync(5000);
      streamCtrl.push({ type: 'turn.done', id: 'td1', state: { status: 'done' } });
      streamCtrl.close();

      const result = await turnPromise;
      expect(caughtError).toBeUndefined();
      expect(result?.status).toBe('done');
    });
  });
});
