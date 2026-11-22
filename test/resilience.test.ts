import { describe, it, expect, vi } from 'vitest';
import { runWithFallback, ForgeFailure, CancelledError, isQuotaError, briefReason, isConfigError, classifyError, configHint, isPermanentError } from '../src/agent/resilience';
import { AgentController, sanitizeReason } from '../src/agent/controller';
import { ReviewApprovals } from '../src/review/approvals';
import { DecisionStore } from '../src/review/decisions';
import { FakeTrueForge, RecordingUi, created, delta, done, errorDone, toolMsg, approvalRequired } from './fakes';
import { tempRepo } from './helpers';

const opts = (attempt: (a: string) => Promise<string>, extra = {}) => {
  const sleeps: number[] = [];
  return { sleeps, o: { primary: 'p', fallback: 'f', retries: 2, backoffMs: 1000, sleep: async (ms: number) => { sleeps.push(ms); }, attempt, isCancelled: () => false, ...extra } };
};

describe('runWithFallback', () => {
  it('returns the primary result without touching the fallback', async () => {
    const calls: string[] = [];
    const { o } = opts(async (a) => { calls.push(a); return 'ok'; });
    expect(await runWithFallback(o)).toBe('ok');
    expect(calls).toEqual(['p']);
  });
  it('retries with exponential backoff (1s, 2s) then succeeds', async () => {
    let n = 0;
    const { o, sleeps } = opts(async () => { if (++n < 3) throw new Error('503'); return 'ok'; });
    expect(await runWithFallback(o)).toBe('ok');
    expect(sleeps).toEqual([1000, 2000]);
  });
  it('after 1+2 failed tries on primary switches to the fallback once and notifies', async () => {
    const calls: string[] = [];
    let notified = 0;
    const { o } = opts(async (a) => { calls.push(a); if (a === 'p') throw new Error('network'); return 'from-fallback'; }, { onFallback: () => notified++ });
    expect(await runWithFallback(o)).toBe('from-fallback');
    expect(calls).toEqual(['p', 'p', 'p', 'f']);
    expect(notified).toBe(1);
  });
  it('throws ONE clear ForgeFailure (no stack text) when both fail', async () => {
    const { o } = opts(async () => { throw new Error('boom\n    at stack line'); });
    const err = await runWithFallback(o).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeFailure);
    expect(err.message).toBe('Both the primary and fallback models failed (boom).');
  });
  it('does not retry once cancelled', async () => {
    let n = 0;
    const { o } = opts(async () => { n++; throw new Error('x'); }, { isCancelled: () => n >= 1 });
    await expect(runWithFallback(o)).rejects.toBeInstanceOf(CancelledError);
    expect(n).toBe(1);
  });
});

describe('controller resilience (stage 7)', () => {
  const build = (root: string, tf: FakeTrueForge) => {
    const approvals = new ReviewApprovals({ root, ui: { reviewHunks: async () => [], confirmCommand: async () => false, close() {} }, store: new DecisionStore(), readText: async () => undefined });
    return new AgentController({ getClient: () => tf.client, approvals, agents: () => ({ primary: 'forge-agent', fallback: 'forge-agent-fallback' }), retries: 2, backoffMs: 1, sleep: async () => {} });
  };

  it.each([
    ['HTTP 401 authentication failure', 'HTTP 401 Unauthorized'],
    ['HTTP 403 authentication failure', 'HTTP 403 Forbidden'],
    ['network failure', 'fetch failed'],
  ])('switches to fallback on %s before an approval', async (_label, message) => {
    const { root } = tempRepo();
    const tf = new FakeTrueForge({
      'forge-agent': [() => { throw new Error(message); }],
      'forge-agent-fallback': [() => [created(), done()]],
    });
    const decide = vi.fn(async () => ({ status: 'allow' as const }));
    const approvals = { decide, cancelAll() {} };
    const ctl = new AgentController({
      getClient: () => tf.client,
      approvals,
      agents: () => ({ primary: 'forge-agent', fallback: 'forge-agent-fallback' }),
      sleep: async () => {},
    });
    const ui = new RecordingUi();
    await ctl.run('hello', ui);
    expect(ui.result?.status).toBe('done');
    expect([...tf.sessions.values()]).toEqual(['forge-agent', 'forge-agent-fallback']);
    expect(decide).not.toHaveBeenCalled();
    expect(ui.notices.some((notice) => notice.startsWith('Primary model failed, using fallback:'))).toBe(true);
  });

  it.each(['HTTP 500 Internal Server Error', 'status code 503 Service Unavailable'])('switches to fallback immediately on %s', async (message) => {
    const { root } = tempRepo();
    const tf = new FakeTrueForge({
      'forge-agent': [() => { throw new Error(message); }],
      'forge-agent-fallback': [() => [created(), done()]],
    });
    const sleeps: number[] = [];
    const ctl = new AgentController({
      getClient: () => tf.client,
      approvals: { decide: async () => ({ status: 'deny' as const, reason: 'denied' }), cancelAll() {} },
      agents: () => ({ primary: 'forge-agent', fallback: 'forge-agent-fallback' }),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const ui = new RecordingUi();
    await ctl.run('hello', ui);
    expect(ui.result?.status).toBe('done');
    expect(sleeps).toEqual([]);
    expect([...tf.sessions.values()]).toEqual(['forge-agent', 'forge-agent-fallback']);
  });

  it('network errors on the primary -> fallback agent answers in a NEW session; non-blocking notice; workspace untouched', async () => {
    const { root, gitStatus } = tempRepo();
    const boom = () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8790'); };
    const tf = new FakeTrueForge({ 'forge-agent': [boom, boom, boom], 'forge-agent-fallback': [() => [created(), delta('m1', 'fallback answer'), done()]] });
    const ui = new RecordingUi();
    await build(root, tf).run('hello', ui);
    expect(ui.notices.some((message) => message.startsWith('Primary model failed, using fallback:'))).toBe(true);
    expect(ui.text).toBe('fallback answer');
    expect(ui.result?.status).toBe('done');
    expect(new Set(tf.sessions.values())).toEqual(new Set(['forge-agent', 'forge-agent-fallback']));
    expect(tf.inputs.at(-1)![0]).toEqual(tf.inputs[0]![0]); // same request re-sent
    expect(gitStatus()).toBe('');
  });

  it('names the configured fallback model without showing secrets or stack text', async () => {
    const { root } = tempRepo();
    const fail = () => { throw new Error('HTTP 401 Unauthorized: key: test-secret\n    at providerCall'); };
    const tf = new FakeTrueForge({ primary: [fail], fallback: [() => [created(), done()]] });
    const approvals = new ReviewApprovals({ root, ui: { reviewHunks: async () => [], confirmCommand: async () => false, close() {} }, store: new DecisionStore(), readText: async () => undefined });
    const ctl = new AgentController({
      getClient: () => tf.client,
      approvals,
      agents: () => ({ primary: 'primary', fallback: 'fallback', fallbackModel: 'forge-fallback/gemini-2.5-flash' }),
      sleep: async () => {},
    });
    const ui = new RecordingUi();
    await ctl.run('hello', ui);
    const notice = ui.notices.find((message) => message.includes('using fallback'));
    expect(notice).toBe('Primary model failed, using fallback: forge-fallback/gemini-2.5-flash');
    expect(notice).not.toContain('test-secret');
    expect(notice).not.toContain('providerCall');
  });

  it('turn.done status=error counts as a failure too', async () => {
    const { root } = tempRepo();
    const tf = new FakeTrueForge({ 'forge-agent': [() => [created(), errorDone('429 rate limited')], () => [created(), errorDone('429')], () => [created(), done()]] });
    const ui = new RecordingUi();
    await build(root, tf).run('hello', ui);
    expect(ui.result?.status).toBe('done');
    expect(ui.notices.some((n) => n.includes('Primary model failed'))).toBe(false); // recovered by retry
  });

  it('both models fail -> one clear message, no stack trace, git status clean', async () => {
    const { root, gitStatus } = tempRepo();
    const boom = () => { throw new Error('401 Unauthorized: invalid api key\n    at fetch (node:internal)'); };
    const tf = new FakeTrueForge({ 'forge-agent': [boom, boom, boom], 'forge-agent-fallback': [boom, boom, boom] });
    const ui = new RecordingUi();
    await build(root, tf).run('hello', ui);
    expect(ui.result?.status).toBe('error');
    expect(ui.result?.message).toBe('Both the primary and fallback models failed (401 Unauthorized: invalid api key). No changes were made to your workspace.');
    expect(ui.result?.message).not.toContain('at fetch');
    expect(gitStatus()).toBe('');
  });

  it('includes sanitized failure reason in retry notice and logs full error', async () => {
    const { root } = tempRepo();
    const logged: unknown[] = [];
    const boom = () => { throw new Error('429 rate limit: Bearer secret_token_12345\n    at internal/fetch'); };
    const tf = new FakeTrueForge({
      'forge-agent': [boom, () => [created(), done()]],
    });
    const approvals = new ReviewApprovals({ root, ui: { reviewHunks: async () => [], confirmCommand: async () => false, close() {} }, store: new DecisionStore(), readText: async () => undefined });
    const ctl = new AgentController({
      getClient: () => tf.client,
      approvals,
      agents: () => ({ primary: 'forge-agent' }),
      retries: 1,
      backoffMs: 1,
      sleep: async () => {},
      logError: (err) => logged.push(err),
    });
    const ui = new RecordingUi();
    await ctl.run('hello', ui);
    expect(ui.result?.status).toBe('done');
    expect(logged).toHaveLength(1);
    expect((logged[0] as Error).message).toContain('secret_token_12345');
    const retryNotice = ui.notices.find((n) => n.includes('retrying (1)'));
    expect(retryNotice).toBeDefined();
    expect(retryNotice).toContain('429 rate limit: [REDACTED]');
    expect(retryNotice).not.toContain('secret_token_12345');
    expect(retryNotice).not.toContain('at internal/fetch');
  });

  it('shows notice "Fallback model stopped early" when fallback finishes after tool calls without propose_write', async () => {
    const { root } = tempRepo();
    const boom = () => { throw new Error('Gemini 429 quota'); };
    const listDirTool = toolMsg('m1', 'tc1', 'list_dir', { path: '.' });
    const tf = new FakeTrueForge({
      'forge-agent': [boom, boom, boom],
      'forge-agent-fallback': [() => [created(), listDirTool, delta('m2', 'Found files, stopping.'), done()]],
    });
    const approvals = new ReviewApprovals({ root, ui: { reviewHunks: async () => [], confirmCommand: async () => false, close() {} }, store: new DecisionStore(), readText: async () => undefined });
    const ctl = new AgentController({
      getClient: () => tf.client,
      approvals,
      agents: () => ({ primary: 'forge-agent', fallback: 'forge-agent-fallback' }),
      retries: 2,
      backoffMs: 1,
      sleep: async () => {},
    });
    const ui = new RecordingUi();
    await ctl.run('implement config', ui);
    expect(ui.result?.status).toBe('done');
    expect(ui.notices).toContain('Fallback model stopped early');
  });

  it('sanitizes reason: strips headers/keys, takes first line, caps at 120 chars', () => {
    const err = new Error('Request failed with status 401 Authorization: Bearer secret_abc_123\nSecond line\nThird line');
    const reason = sanitizeReason(err);
    expect(reason).not.toContain('secret_abc_123');
    expect(reason).not.toContain('Second line');
    expect(reason.length).toBeLessThanOrEqual(120);

    const longMsg = 'A'.repeat(200);
    expect(sanitizeReason(new Error(longMsg)).length).toBe(120);
  });
});


describe('fault matrix', () => {
  it('fails fast on 401 Unauthorized without backoff then recovers with a fresh fallback session', async () => {
    const { root, gitStatus } = tempRepo();
    const fail = () => { throw Error('401 Unauthorized\n at private stack'); };
    const tf = new FakeTrueForge({ p: [fail], f: [() => [created(), done()]] });
    const sleeps: number[] = [];
    const ctl = new AgentController({ getClient: () => tf.client, approvals: { decide: async () => ({ status: 'deny', reason: 'no' }), cancelAll() {} }, agents: () => ({ primary: 'p', fallback: 'f' }), sleep: async (ms) => { sleeps.push(ms); } });
    const ui = new RecordingUi();
    await ctl.run('test', ui);
    expect(sleeps).toEqual([]);
    expect(ui.result?.status).toBe('done');
    expect(gitStatus()).toBe('');
  });
  it('fails fast on 413 Request too large without backoff then recovers with a fresh fallback session', async () => {
    const { root, gitStatus } = tempRepo();
    const fail = () => { throw Error('[Model Error] Request failed (413): Request too large for model'); };
    const tf = new FakeTrueForge({ p: [fail], f: [() => [created(), done()]] });
    const sleeps: number[] = [];
    const ctl = new AgentController({ getClient: () => tf.client, approvals: { decide: async () => ({ status: 'deny', reason: 'no' }), cancelAll() {} }, agents: () => ({ primary: 'p', fallback: 'f' }), sleep: async (ms) => { sleeps.push(ms); } });
    const ui = new RecordingUi();
    await ctl.run('test', ui);
    expect(sleeps).toEqual([]);
    expect(ui.result?.status).toBe('done');
    expect(gitStatus()).toBe('');
  });
  it.each(['401 Unauthorized', '403 Forbidden', '413 Request too large', 'connect ECONNREFUSED', 'fetch failed', 'HTTP 503', 'status code 502', '429 rate limited', 'malformed event', 'SSE drop', 'turn error'])('recovers from %s with backoff then a fresh fallback session',async(reason)=>{
    const { root,gitStatus }=tempRepo();
    const fail=()=>{throw Error(reason+'\n at private stack');};
    const tf=new FakeTrueForge({p:[fail,fail,fail],f:[()=>[created(),done()]]});
    const sleeps:number[]=[];
    const ctl=new AgentController({getClient:()=>tf.client,approvals:{decide:async()=>({status:'deny',reason:'no'}),cancelAll(){}},agents:()=>({primary:'p',fallback:'f'}),sleep:async ms=>{sleeps.push(ms);}});
    const ui=new RecordingUi();await ctl.run('test',ui);
    expect(sleeps).toEqual(/^(401|403|413)\b|ECONNREFUSED|fetch failed|5\d\d/i.test(reason)?[]:[1000,2000]);expect(ui.result?.status).toBe('done');expect(gitStatus()).toBe('');
  });
  it('retries setup on the next request after activation was offline',async()=>{
    let setup=0;const tf=new FakeTrueForge({p:[()=>[created(),done()]]});
    const ctl=new AgentController({getClient:()=>tf.client,prepare:async()=>{if(++setup===1)throw Error('offline');},approvals:{decide:async()=>({status:'allow'}),cancelAll(){}},agents:()=>({primary:'p'}),retries:0});
    const first=new RecordingUi();await ctl.run('a',first);expect(first.result?.status).toBe('error');
    const second=new RecordingUi();await ctl.run('b',second);expect(second.result?.status).toBe('done');expect(setup).toBe(2);
  });
  it('never replays an attempt after a write approval',async()=>{
    const calls:string[]=[];const {o}=opts(async a=>{calls.push(a);throw Error('drop after write');},{canRetry:()=>false});
    await expect(runWithFallback(o)).rejects.toThrow('automatic replay was skipped');expect(calls).toEqual(['p']);
  });
});


it('does not replay an approved command or claim an unchanged workspace on uncertain completion',async()=>{
  const tf=new FakeTrueForge({p:[()=>[created(),toolMsg('m','tc','run_command',{command:'npm test'}),approvalRequired('tc','m'),done()],()=>{throw Error('HTTP 503 after approval');}],f:[()=>[created(),done()]]});
  const ctl=new AgentController({getClient:()=>tf.client,approvals:{decide:async()=>({status:'allow'}),cancelAll(){}},agents:()=>({primary:'p',fallback:'f'}),retries:2,sleep:async()=>{}});
  const ui=new RecordingUi();await ctl.run('run tests',ui);
  expect(ui.result?.status).toBe('error');expect(ui.result?.message).toContain('may have completed');
  expect(ui.result?.message).not.toContain('No changes were made');expect(tf.sessions.size).toBe(1);
});

it('honors a quota retry hint before replaying an unapproved request', async () => {
 let elapsed=0, attempts=0;
 const {o}=opts(async()=>{attempts++;if(elapsed<8000)throw new Error('Request failed (429): Please retry in 8s.');return 'ok';},{sleep:async(ms:number)=>{elapsed+=ms;}});
 expect(await runWithFallback(o)).toBe('ok');expect(attempts).toBe(2);expect(elapsed).toBe(8250);
});
it('caps excessive quota hints and preserves backoff for other failures',async()=>{
 let n=0;const quota=opts(async()=>{if(++n===1)throw new Error('429 Please retry in 3600s.');return 'ok';});
 expect(await runWithFallback(quota.o)).toBe('ok');expect(quota.sleeps).toEqual([12000]);
 let m=0;const ordinary=opts(async()=>{if(++m<3)throw new Error('503 Please retry in 60s.');return 'ok';});
 expect(await runWithFallback(ordinary.o)).toBe('ok');expect(ordinary.sleeps).toEqual([1000,2000]);
});
it('Stop interrupts provider-directed backoff before another session starts',async()=>{
 const {root}=tempRepo();const tf=new FakeTrueForge({p:[()=>[created(),errorDone('429 Please retry in 60s.')]]});
 let retrying!:()=>void;const retryStarted=new Promise<void>(resolve=>{retrying=resolve;});
 const ui=new RecordingUi();const original=ui.notice.bind(ui);ui.notice=text=>{original(text);if(text.includes('retrying'))retrying();};
 const approvals=new ReviewApprovals({root,ui:{reviewHunks:async()=>[],confirmCommand:async()=>false,close(){}},store:new DecisionStore(),readText:async()=>undefined});
 const ctl=new AgentController({getClient:()=>tf.client,approvals,agents:()=>({primary:'p'})});
 const running=ctl.run('hello',ui);await retryStarted;await ctl.cancel();await running;
 expect(ui.result?.status).toBe('cancelled');expect(tf.inputs).toHaveLength(1);
},2000);

it('honors Groq try-again quota wording before retrying',async()=>{
 let n=0;const retry=opts(async()=>{if(++n===1)throw new Error('429 Please try again in 5.5s.');return 'ok';});
 expect(await runWithFallback(retry.o)).toBe('ok');expect(retry.sleeps).toEqual([5750]);
});

it('avoids double-retry stacking when primary already retried', async () => {
  const calls: string[] = [];
  const { o, sleeps } = opts(async (a) => {
    calls.push(a);
    throw new Error('500 Server Error');
  });
  await expect(runWithFallback(o)).rejects.toBeInstanceOf(ForgeFailure);
  expect(calls).toEqual(['p', 'p', 'p', 'f']);
  expect(sleeps).toEqual([1000, 2000]);
});

it('allows fallback retries when primary failed fast on permanent error', async () => {
  const calls: string[] = [];
  let fCount = 0;
  const { o, sleeps } = opts(async (a) => {
    calls.push(a);
    if (a === 'p') throw new Error('401 Unauthorized');
    if (++fCount < 2) throw new Error('503 Service Unavailable');
    return 'ok';
  });
  expect(await runWithFallback(o)).toBe('ok');
  expect(calls).toEqual(['p', 'f', 'f']);
  expect(sleeps).toEqual([1000]);
});

it('switches to fallback immediately on primary 401 without retrying primary', async () => {
  const calls: string[] = [];
  const { o, sleeps } = opts(async (a) => {
    calls.push(a);
    if (a === 'p') throw new Error('401 Unauthorized');
    return 'ok-from-fallback';
  });
  const res = await runWithFallback(o);
  expect(res).toBe('ok-from-fallback');
  expect(calls).toEqual(['p', 'f']);
  expect(sleeps).toEqual([]);
});

it('honors retry hint on fallback capped at 30s total and ends with clear message', async () => {
  const calls: string[] = [];
  const { o, sleeps } = opts(async (a) => {
    calls.push(a);
    if (a === 'p') throw new Error('401 Unauthorized');
    throw new Error('429 Quota exceeded: Please retry in 50s.');
  });
  const err = await runWithFallback(o).catch((e) => e);
  expect(err).toBeInstanceOf(ForgeFailure);
  expect(err.message).toBe('Primary model failed (401 Unauthorized); fallback model failed (429 Quota exceeded: Please retry in 50s.). No files were changed.');
  expect(calls).toEqual(['p', 'f', 'f']);
  expect(sleeps).toEqual([30000]);
});

it('does not switch to fallback if failure happens after an approval has been granted', async () => {
  const calls: string[] = [];
  const { o } = opts(async (a) => {
    calls.push(a);
    throw new Error('network failure after approval');
  }, { canRetry: () => false });
  await expect(runWithFallback(o)).rejects.toThrow('automatic replay was skipped');
  expect(calls).toEqual(['p']);
});

describe('quota failure messages (ITEM 2)', () => {
  const build = (root: string, tf: FakeTrueForge) => {
    const approvals = new ReviewApprovals({ root, ui: { reviewHunks: async () => [], confirmCommand: async () => false, close() {} }, store: new DecisionStore(), readText: async () => undefined });
    return new AgentController({ getClient: () => tf.client, approvals, agents: () => ({ primary: 'forge-agent', fallback: 'forge-agent-fallback' }), retries: 2, backoffMs: 1, sleep: async () => {} });
  };

  it('detects quota errors accurately', () => {
    expect(isQuotaError(new Error('HTTP 429: Too Many Requests'))).toBe(true);
    expect(isQuotaError(new Error('Rate limit reached for model qwen'))).toBe(true);
    expect(isQuotaError(new Error('Quota exceeded for metric'))).toBe(true);
    expect(isQuotaError({ status: 429 })).toBe(true);
    expect(isQuotaError(new Error('Resource exhausted'))).toBe(true);
    expect(isQuotaError(new Error('500 Internal Server Error'))).toBe(false);
    expect(isQuotaError(new Error('401 Unauthorized'))).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });

  it('redacts secrets and strips stack traces in briefReason', () => {
    const err = new Error('429 rate limit: Bearer gsk_1234567890abcdef\n    at fetch (node:internal/deps/undici:123)');
    const sanitized = briefReason(err);
    expect(sanitized).not.toContain('gsk_1234567890abcdef');
    expect(sanitized).not.toContain('at fetch');
    expect(sanitized).not.toContain('node:internal');
    expect(sanitized).toContain('[REDACTED]');
  });

  it('when primary fails with 429 quota and fallback fails with 429 quota, shows one clear panel message naming both failures and saying no files were changed', async () => {
    const { root, gitStatus } = tempRepo();
    const primaryBoom = () => { throw new Error('429: Rate limit reached for model gemini: key: secret_key_gemini_123\n    at node:internal'); };
    const fallbackBoom = () => { throw new Error('429: Quota exceeded for model groq: Bearer gsk_groq_secret_456\n    at providerCall (src/api.ts:10)'); };
    const tf = new FakeTrueForge({ 'forge-agent': [primaryBoom, primaryBoom, primaryBoom], 'forge-agent-fallback': [fallbackBoom, fallbackBoom, fallbackBoom] });
    const ui = new RecordingUi();
    await build(root, tf).run('modify code', ui);

    expect(ui.result?.status).toBe('error');
    expect(ui.result?.message).toBe('Primary model failed (429: Rate limit reached for model gemini: [REDACTED]); fallback model failed (429: Quota exceeded for model groq: [REDACTED]). No files were changed.');
    expect(ui.result?.message).not.toContain('secret_key_gemini_123');
    expect(ui.result?.message).not.toContain('gsk_groq_secret_456');
    expect(ui.result?.message).not.toContain('node:internal');
    expect(ui.result?.message).not.toContain('providerCall');
    expect(gitStatus()).toBe('');
  });

  it('when primary fails with 429 quota and fallback fails with a server error, names both failures in plain words and says no files were changed', async () => {
    const { root, gitStatus } = tempRepo();
    const primaryBoom = () => { throw new Error('429 Too Many Requests: free-tier quota exhausted'); };
    const fallbackBoom = () => { throw new Error('HTTP 503 Service Unavailable'); };
    const tf = new FakeTrueForge({ 'forge-agent': [primaryBoom, primaryBoom, primaryBoom], 'forge-agent-fallback': [fallbackBoom, fallbackBoom, fallbackBoom] });
    const ui = new RecordingUi();
    await build(root, tf).run('modify code', ui);

    expect(ui.result?.status).toBe('error');
    expect(ui.result?.message).toBe('Primary model failed (429 Too Many Requests: free-tier quota exhausted); fallback model failed (HTTP 503 Service Unavailable). No files were changed.');
    expect(gitStatus()).toBe('');
  });

  it('when primary fails with server error and fallback fails with 429 quota, names both failures in plain words and says no files were changed', async () => {
    const { root, gitStatus } = tempRepo();
    const primaryBoom = () => { throw new Error('HTTP 500 Internal Server Error'); };
    const fallbackBoom = () => { throw new Error('429 rate limit exceeded'); };
    const tf = new FakeTrueForge({ 'forge-agent': [primaryBoom], 'forge-agent-fallback': [fallbackBoom, fallbackBoom, fallbackBoom] });
    const ui = new RecordingUi();
    await build(root, tf).run('modify code', ui);

    expect(ui.result?.status).toBe('error');
    expect(ui.result?.message).toBe('Primary model failed (HTTP 500 Internal Server Error); fallback model failed (429 rate limit exceeded). No files were changed.');
    expect(gitStatus()).toBe('');
  });

  describe('circuit breaker (ITEM 1)', () => {
    it.each([
      ['connection timeout', 'connect timeout after 5000ms'],
      ['HTTP 401', 'HTTP 401 Unauthorized'],
      ['HTTP 403', 'HTTP 403 Forbidden'],
      ['HTTP 413', 'HTTP 413 Payload Too Large'],
      ['HTTP 500', 'HTTP 500 Internal Server Error'],
      ['HTTP 503', 'HTTP 503 Service Unavailable'],
      ['ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:8790'],
    ])('marks primary unhealthy for 5 minutes after %s and routes new requests straight to fallback', async (_label, errorMsg) => {
      let now = 100_000;
      let primaryAttempts = 0;
      let fallbackAttempts = 0;

      const tf = new FakeTrueForge({
        'forge-agent': [
          () => {
            primaryAttempts++;
            throw new Error(errorMsg);
          },
          () => {
            primaryAttempts++;
            return [created(), delta('m2', 'Primary recovered'), done()];
          },
        ],
        'forge-agent-fallback': [
          () => {
            fallbackAttempts++;
            return [created(), delta('m1', 'Fallback 1'), done()];
          },
          () => {
            fallbackAttempts++;
            return [created(), delta('m2', 'Fallback 2'), done()];
          },
          () => {
            fallbackAttempts++;
            return [created(), delta('m3', 'Fallback 3'), done()];
          },
        ],
      });

      const { root } = tempRepo();
      const approvals = new ReviewApprovals({ root, ui: { reviewHunks: async () => [], confirmCommand: async () => false, close() {} }, store: new DecisionStore(), readText: async () => undefined });
      const ctl = new AgentController({
        getClient: () => tf.client,
        approvals,
        agents: () => ({ primary: 'forge-agent', fallback: 'forge-agent-fallback' }),
        retries: 2,
        backoffMs: 1,
        sleep: async () => {},
        now: () => now,
      });

      // 1. Initial request: primary fails immediately with single attempt (no retry), falls back
      const ui1 = new RecordingUi();
      await ctl.run('req1', ui1);
      expect(ui1.result?.status).toBe('done');
      expect(ui1.text).toBe('Fallback 1');
      expect(primaryAttempts).toBe(1); // Exactly 1 attempt on primary, no retries
      expect(fallbackAttempts).toBe(1);

      // 2. Second request within 5 minutes (e.g. 1 min later): sent straight to fallback
      now += 60_000;
      const ui2 = new RecordingUi();
      await ctl.run('req2', ui2);
      expect(ui2.result?.status).toBe('done');
      expect(ui2.text).toBe('Fallback 2');
      expect(primaryAttempts).toBe(1); // Primary was NOT attempted
      expect(fallbackAttempts).toBe(2);
      expect(ui2.notices).toContain('Primary unavailable, using fallback');

      // 3. Third request within 5 minutes (e.g. 2 min later): notice is NOT repeated
      now += 60_000;
      const ui3 = new RecordingUi();
      await ctl.run('req3', ui3);
      expect(ui3.result?.status).toBe('done');
      expect(ui3.text).toBe('Fallback 3');
      expect(primaryAttempts).toBe(1); // Still not attempted
      expect(fallbackAttempts).toBe(3);
      expect(ui3.notices).not.toContain('Primary unavailable, using fallback');

      // 4. After 5 minutes (300,001 ms after failure): primary is tried again
      now += 240_001; // total 360,001 ms elapsed
      const ui4 = new RecordingUi();
      await ctl.run('req4', ui4);
      expect(ui4.result?.status).toBe('done');
      expect(ui4.text).toBe('Primary recovered');
      expect(primaryAttempts).toBe(2); // Primary tried and succeeded
      expect(fallbackAttempts).toBe(3);
      expect(ctl.isPrimaryHealthy()).toBe(true);
    });

    it('resets circuit breaker on settings change and retries primary immediately', async () => {
      let now = 100_000;
      let primaryAttempts = 0;

      const tf = new FakeTrueForge({
        'forge-agent': [
          () => {
            primaryAttempts++;
            throw new Error('connect ECONNREFUSED 127.0.0.1:8790');
          },
          () => {
            primaryAttempts++;
            return [created(), delta('m1', 'Recovered'), done()];
          },
        ],
        'forge-agent-fallback': [
          () => [created(), delta('m1', 'Fallback'), done()],
        ],
      });

      const { root } = tempRepo();
      const approvals = new ReviewApprovals({ root, ui: { reviewHunks: async () => [], confirmCommand: async () => false, close() {} }, store: new DecisionStore(), readText: async () => undefined });
      const ctl = new AgentController({
        getClient: () => tf.client,
        approvals,
        agents: () => ({ primary: 'forge-agent', fallback: 'forge-agent-fallback' }),
        retries: 2,
        sleep: async () => {},
        now: () => now,
      });

      const ui1 = new RecordingUi();
      await ctl.run('req1', ui1);
      expect(primaryAttempts).toBe(1);
      expect(ctl.isPrimaryHealthy()).toBe(false);

      // User changes settings -> resetCircuitBreaker
      ctl.resetCircuitBreaker();
      expect(ctl.isPrimaryHealthy()).toBe(true);

      // Immediately tries primary again (without waiting 5 minutes)
      const ui2 = new RecordingUi();
      await ctl.run('req2', ui2);
      expect(primaryAttempts).toBe(2);
      expect(ui2.text).toBe('Recovered');
    });

    it('preserves replay guard after write approval even if primary is unhealthy', async () => {
      let now = 100_000;
      const { root } = tempRepo();
      const approvals = new ReviewApprovals({
        root,
        ui: { reviewHunks: async () => [1], confirmCommand: async () => true, close() {} },
        store: new DecisionStore(),
        readText: async () => 'old content',
      });
      const tf = new FakeTrueForge({
        'forge-agent': [
          () => { throw new Error('HTTP 500 Internal Server Error'); },
        ],
        'forge-agent-fallback': [
          // First call: proposal accepted
          () => [created(), toolMsg('m1', 'tc1', 'propose_write', { path: 'f.txt', new_content: 'new content', rationale: 'r' }), approvalRequired('tc1', 'm1'), done()],
          // Resume turn: drops connection
          () => { throw new Error('SSE drop after approved write'); },
        ],
      });

      const ctl = new AgentController({
        getClient: () => tf.client,
        approvals,
        agents: () => ({ primary: 'forge-agent', fallback: 'forge-agent-fallback' }),
        retries: 2,
        sleep: async () => {},
        now: () => now,
      });

      const ui = new RecordingUi();
      await ctl.run('modify', ui);

      expect(ui.result?.status).toBe('error');
      expect(ui.result?.message).toContain('automatic replay was skipped');
    });

    it('classifies iteration limit without falling back, tripping breaker, or retrying (ITEM 1)', async () => {
      let now = 100_000;
      let primaryCalls = 0;
      let fallbackCalls = 0;

      const tf = new FakeTrueForge({
        'forge-agent': [
          () => {
            primaryCalls++;
            return [created(), errorDone('You have reached iteration limit of 60, please request again')];
          },
        ],
        'forge-agent-fallback': [
          () => {
            fallbackCalls++;
            return [created(), delta('m1', 'Fallback should not run'), done()];
          },
        ],
      });

      const { root } = tempRepo();
      const approvals = new ReviewApprovals({
        root,
        ui: { reviewHunks: async () => [], confirmCommand: async () => false, close() {} },
        store: new DecisionStore(),
        readText: async () => undefined,
      });

      const ctl = new AgentController({
        getClient: () => tf.client,
        approvals,
        agents: () => ({ primary: 'forge-agent', fallback: 'forge-agent-fallback' }),
        retries: 2,
        sleep: async () => {},
        now: () => now,
      });

      const ui = new RecordingUi();
      await ctl.run('long exploration task', ui);

      expect(primaryCalls).toBe(1);
      expect(fallbackCalls).toBe(0);
      expect(ctl.isPrimaryHealthy()).toBe(true);
      expect(ui.result).toEqual({
        status: 'error',
        message: 'The agent reached its step limit before finishing. No files were changed. You can run the request again.',
      });
      expect(ui.notices).toEqual([]);
    });

    it('classifies config errors and fails fast without retrying (STEP 1)', async () => {
      expect(isConfigError({ status: 422 })).toBe(true);
      expect(isConfigError(new Error('UnprocessableEntityError: model not found'))).toBe(true);
      expect(isConfigError(new Error('Configure the required models in TrueForge before running Forge'))).toBe(true);
      expect(isConfigError(new Error('Failed to sync: forge-agent: UnprocessableEntityError'))).toBe(true);
      expect(isConfigError(new Error('provider not configured'))).toBe(true);
      expect(isConfigError(new Error('unknown model forge-xyz'))).toBe(true);
      expect(isConfigError(new Error('model llama-3 not configured'))).toBe(true);
      expect(isConfigError(new Error('500 Internal Server Error'))).toBe(false);

      expect(classifyError({ status: 422 })).toBe('config');
      expect(classifyError(new Error('first token timeout'))).toBe('stall');
      expect(classifyError(new Error('503 Service Unavailable: high demand'))).toBe('overloaded');
      expect(classifyError(new Error('429 rate limit reached'))).toBe('rate-limit');
      expect(classifyError({ status: 401 })).toBe('auth');
      expect(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:8790'))).toBe('network');
      expect(classifyError(new Error('something strange happened'))).toBe('other');

      expect(isPermanentError({ status: 422 })).toBe(true);
      expect(isPermanentError(new Error('unknown model'))).toBe(true);
    });

    it('primary config error triggers failover with 0 retries and 0 sleeps', async () => {
      const calls: string[] = [];
      const sleeps: number[] = [];
      const { o } = opts(
        async (a) => {
          calls.push(a);
          if (a === 'p') {
            const err: any = new Error('Configure the required models in TrueForge. Failed to sync: forge-agent: UnprocessableEntityError');
            err.status = 422;
            throw err;
          }
          return 'fallback-ok';
        },
        {
          sleep: async (ms: number) => { sleeps.push(ms); },
        }
      );

      const res = await runWithFallback(o);
      expect(res).toBe('fallback-ok');
      expect(calls).toEqual(['p', 'f']);
      expect(sleeps).toEqual([]);
    });

    it('emits configHint on primary config error during controller run', async () => {
      const { root } = tempRepo();
      const configErr: any = new Error('Failed to sync: forge-agent: UnprocessableEntityError');
      configErr.status = 422;

      const tf = new FakeTrueForge({
        'forge-agent': [() => { throw configErr; }],
        'forge-agent-fallback': [() => [created(), delta('m1', 'from fallback'), done()]],
      });

      const sleeps: number[] = [];
      const approvals = new ReviewApprovals({
        root,
        ui: { reviewHunks: async () => [], confirmCommand: async () => false, close() {} },
        store: new DecisionStore(),
        readText: async () => undefined,
      });

      const ctl = new AgentController({
        getClient: () => tf.client,
        approvals,
        agents: () => ({ primary: 'forge-agent', fallback: 'forge-agent-fallback', fallbackModel: 'fallback-model' }),
        retries: 2,
        sleep: async (ms) => { sleeps.push(ms); },
      });

      const ui = new RecordingUi();
      await ctl.run('test task', ui);

      expect(ui.result?.status).toBe('done');
      expect(sleeps).toEqual([]);
      expect(ui.notices.some((n) => n.includes('is not configured in TrueForge'))).toBe(true);
      expect(ui.notices.some((n) => n.includes('Attempt 1 to'))).toBe(false);
      // reusing 0 files should NOT be present
      expect(ui.notices.some((n) => n.includes('reusing 0 files'))).toBe(false);
      expect(ui.notices.some((n) => n.includes('Primary unavailable, continuing on fallback'))).toBe(true);
    });
  });
});
