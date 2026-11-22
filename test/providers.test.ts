import { describe, it, expect } from 'vitest';
import { checkProviders, formatProviderReport, listConfiguredModels } from '../src/forge/providers';
import type { AgentFile } from '../src/forge/agents';

describe('forge providers check (STEP 1)', () => {
  const fakeAgentFiles: AgentFile[] = [
    {
      name: 'forge-agent',
      description: 'Primary agent',
      manifest: {
        model: { name: 'google-gemini/gemini-3-8-flash' },
        instruction: '',
        toolIds: [],
      } as any,
    },
    {
      name: 'forge-agent-fallback',
      description: 'Fallback agent',
      manifest: {
        model: { name: 'forge-fallback/gemini-2.5-flash' },
        instruction: '',
        toolIds: [],
      } as any,
    },
    {
      name: 'forge-inline',
      description: 'Inline edit agent',
      manifest: {
        model: { name: 'missing-provider/missing-model' },
        instruction: '',
        toolIds: [],
      } as any,
    },
  ];

  it('reports all ready when all models exist in client.models.list', async () => {
    const fakeClient = {
      models: {
        list: async () => ({
          data: [
            { name: 'google-gemini/gemini-3-8-flash' },
            { name: 'forge-fallback/gemini-2.5-flash' },
            { name: 'missing-provider/missing-model' },
          ],
        }),
      },
      agents: {
        list: async () => [],
      },
    } as any;

    const statuses = await checkProviders(fakeClient, fakeAgentFiles);
    expect(statuses).toHaveLength(3);
    expect(statuses.every((s) => s.ready && s.checked)).toBe(true);

    const report = formatProviderReport(statuses);
    expect(report).toContain('google-gemini/gemini-3-8-flash): READY');
    expect(report).toContain('forge-fallback/gemini-2.5-flash): READY');
    expect(report).toContain('missing-provider/missing-model): READY');
  });

  it('flags unconfigured models with fix hint', async () => {
    const fakeClient = {
      models: {
        list: async () => ({
          data: [
            { name: 'google-gemini/gemini-3-8-flash' },
            { name: 'forge-fallback/gemini-2.5-flash' },
          ],
        }),
      },
      agents: {
        list: async () => [],
      },
    } as any;

    const statuses = await checkProviders(fakeClient, fakeAgentFiles);
    expect(statuses).toHaveLength(3);
    const missing = statuses.find((s) => s.agent === 'forge-inline');
    expect(missing?.ready).toBe(false);
    expect(missing?.checked).toBe(true);
    expect(missing?.reason).toContain('is not configured in TrueForge');
    expect(missing?.fix).toContain('scripts/configure-provider.cjs');

    const report = formatProviderReport(statuses);
    expect(report).toContain('NOT READY');
    expect(report).toContain('Fix: Model "missing-provider/missing-model" is not configured in TrueForge');
  });

  it('marks checked: false when models.list throws or is unavailable (no false alarm)', async () => {
    const throwingClient = {
      models: {
        list: async () => {
          throw new Error('Connection refused to localhost:8790');
        },
      },
      agents: {
        list: async () => [],
      },
    } as any;

    const statuses = await checkProviders(throwingClient, fakeAgentFiles);
    expect(statuses).toHaveLength(3);
    expect(statuses.every((s) => !s.checked && s.ready)).toBe(true);

    const report = formatProviderReport(statuses);
    expect(report).toContain('UNCHECKED (models list unavailable)');
  });
});
