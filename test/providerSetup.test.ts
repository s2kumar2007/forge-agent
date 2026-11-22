import { it, expect, vi, describe } from 'vitest';
import { createRequire } from 'node:module';

const { configureProvider, deriveCatalogName, validateCatalogName } = createRequire(import.meta.url)('../scripts/configure-provider.cjs');
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

describe('catalog name derivation and validation', () => {
  it('derives valid catalog names with slashes and dots removed', () => {
    expect(deriveCatalogName('nvidia/nemotron-3.5-lightning-30b-a3b')).toBe('nemotron-3-5-lightning-30b-a3b');
    expect(deriveCatalogName('meta/llama-3.3-70b-instruct')).toBe('llama-3-3-70b-instruct');
    expect(deriveCatalogName('mistralai/mistral-large-4-1t-a52b')).toBe('mistral-large-4-1t-a52b');
    expect(deriveCatalogName('qwen/qwen2.5-coder-32b')).toBe('qwen2-5-coder-32b');
  });

  it('rejects invalid catalog names', () => {
    expect(() => validateCatalogName('123-model')).toThrow('must start with a lowercase letter');
    expect(() => validateCatalogName('-invalid')).toThrow('must start with a lowercase letter');
    expect(() => validateCatalogName('invalid-')).toThrow('must end with an alphanumeric character');
    expect(() => validateCatalogName('a')).toThrow('must be 2-64 lowercase characters');
    expect(() => validateCatalogName('model/name')).toThrow('must contain only lowercase letters, digits, and hyphens');
    expect(() => validateCatalogName('model.name')).toThrow('must contain only lowercase letters, digits, and hyphens');
    expect(() => validateCatalogName('Model-Name')).toThrow('must start with a lowercase letter');
    expect(() => validateCatalogName('a'.repeat(65))).toThrow('must be 2-64 lowercase characters');
  });
});

describe('configureProvider execution and isolation', () => {
  it('updates only TARGET_AGENTS and never touches unlisted agents', async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, options: { method?: string; body?: string } = {}) => {
      calls.push({ url, ...options });
      if (url.includes('/settings/model-providers')) {
        return ok(options.method ? {} : { data: [] });
      }
      if (url.includes('/api/v1/agents?limit=100')) {
        return ok({
          data: [
            { id: 'id-agent', name: 'forge-agent', description: 'Primary', manifest: { model: { name: 'old/model' } } },
            { id: 'id-inline', name: 'forge-inline', description: 'Inline', manifest: { model: { name: 'old/model' } } },
            { id: 'id-fallback', name: 'forge-agent-fallback', description: 'Fallback', manifest: { model: { name: 'old/model' } } },
          ],
        });
      }
      return ok({});
    });

    const result = await configureProvider({
      providerBaseUrl: 'https://integrate.api.nvidia.com/v1',
      model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      apiKey: 'nvapi-fake-test-key-999',
      providerName: 'forge-nvidia',
      targetAgents: ['forge-agent', 'forge-inline'],
      fetchImpl,
    });

    expect(result).toBe('Registered provider forge-nvidia for model nvidia/nemotron-3.5-lightning-30b-a3b as forge-nvidia/nemotron-3-5-lightning-30b-a3b; updated agents: forge-agent, forge-inline.');
    expect(result).not.toContain('nvapi');

    const agentCalls = calls.filter((c) => c.url.includes('/api/v1/agents/') && c.method === 'PUT');
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[0]!.url).toBe('http://localhost:8790/api/v1/agents/id-agent');
    expect(agentCalls[1]!.url).toBe('http://localhost:8790/api/v1/agents/id-inline');
    expect(calls.some((c) => c.url.includes('id-fallback'))).toBe(false);
  });

  it('never exposes API keys in output or error messages', async () => {
    const fakeKey = 'nvapi-mock-test-key';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/settings/model-providers')) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { message: `Blocked key ${fakeKey} on outbound connection` } }),
        };
      }
      return ok({});
    });

    const error = await configureProvider({
      providerBaseUrl: 'https://integrate.api.nvidia.com/v1',
      model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      apiKey: fakeKey,
      fetchImpl,
    }).catch((e: Error) => e.message);

    expect(error).toContain('TrueForge request failed (HTTP 400)');
    expect(error).not.toContain(fakeKey);
    expect(error).toContain('[REDACTED]');
  });

  it('surfaces TrueForge error messages accurately', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/settings/model-providers')) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { message: 'Outbound URL blocked for host integrate.api.nvidia.com' } }),
        };
      }
      return ok({});
    });

    await expect(
      configureProvider({
        providerBaseUrl: 'https://integrate.api.nvidia.com/v1',
        model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        apiKey: 'nvapi-fake-key',
        fetchImpl,
      })
    ).rejects.toThrow('TrueForge request failed (HTTP 400): Outbound URL blocked for host integrate.api.nvidia.com.');
  });
});
