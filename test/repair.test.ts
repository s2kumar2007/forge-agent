import { describe, it, expect } from 'vitest';
import { AgentController } from '../src/agent/controller';
import type { AgentUi } from '../src/agent/types';
import type { TrueForge } from '@truefoundry/trueforge-sdk';

describe('verify-and-repair loop and fault injection', () => {
  it('triggers immediate fallback when fault injection is enabled', async () => {
    const answeredAgents: string[] = [];
    const notices: string[] = [];

    const fakeClient = {
      sessions: {
        create: async (req: any) => {
          answeredAgents.push(req.agent.name);
          return { data: { id: 's-' + req.agent.name } };
        },
        createTurnStream: () => ({
          withMetadata: async function* () {
            yield { data: { id: 'e1', type: 'model.message', content: 'Fallback answered successfully' } };
            yield { data: { id: 'e2', type: 'turn.done', state: { status: 'done' } } };
          },
        }),
      },
    } as unknown as TrueForge;

    const ui: AgentUi = {
      textDelta() {},
      toolCall() {},
      notice(t) { notices.push(t); },
      finished() {},
    };

    const ctl = new AgentController({
      getClient: () => fakeClient,
      approvals: { decide: async () => ({ status: 'allow' }), cancelAll() {} },
      agents: () => ({ primary: 'forge-primary', fallback: 'forge-fallback', fallbackModel: 'google-gemini/gemini-3-8-flash' }),
      retries: 0,
      faultInjection: 'auth',
    });

    await ctl.run('test prompt', ui);

    expect(answeredAgents).toEqual(['forge-fallback']);
    expect(notices.some((n) => n.includes('Primary model failed, using fallback'))).toBe(true);
  });

  it('triggers verify-and-repair loop when post-edit verification detects errors', async () => {
    let turnCount = 0;
    const notices: string[] = [];
    let verificationChecked = 0;

    const fakeClient = {
      sessions: {
        create: async () => ({ data: { id: 's1' } }),
        createTurnStream: () => ({
          withMetadata: async function* () {
            turnCount++;
            if (turnCount === 1) {
              yield {
                data: {
                  id: `e-msg-1`,
                  type: 'model.message',
                  toolCalls: [{ id: `tc-1`, function: { name: 'propose_write', arguments: '{"path":"file.py"}' } }],
                },
              };
              yield {
                data: {
                  id: `e-appr-1`,
                  type: 'tool.approval_required',
                  threadId: 'main',
                  toolCalls: [{ id: `tc-1`, sourceEventId: `e-msg-1` }],
                },
              };
              yield {
                data: {
                  id: `e-done-1`,
                  type: 'turn.done',
                  state: { status: 'done' },
                },
              };
            } else {
              yield {
                data: {
                  id: `e-msg-${turnCount}`,
                  type: 'model.message',
                  content: 'Completed turn',
                },
              };
              yield {
                data: {
                  id: `e-done-${turnCount}`,
                  type: 'turn.done',
                  state: { status: 'done' },
                },
              };
            }
          },
        }),
      },
    } as unknown as TrueForge;

    const ui: AgentUi = {
      textDelta() {},
      toolCall() {},
      notice(t) { notices.push(t); },
      finished() {},
    };

    const ctl = new AgentController({
      getClient: () => fakeClient,
      approvals: { decide: async () => ({ status: 'allow' }), cancelAll() {} },
      agents: () => ({ primary: 'forge-primary' }),
      retries: 0,
      maxRepairRounds: 2,
      verifyAndRepair: async () => {
        verificationChecked++;
        if (verificationChecked === 1) {
          return { ok: false, errors: 'SyntaxError: unexpected EOF' };
        }
        return { ok: true };
      },
    });

    await ctl.run('fix the bug', ui);

    expect(verificationChecked).toBe(2);
    expect(notices.some((n) => n.includes('Verification detected errors (repair round 1/2)'))).toBe(true);
  });
});
