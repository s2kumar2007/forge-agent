import { it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const { configureFallback } = createRequire(import.meta.url)('../scripts/configure-fallback.cjs');
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

it('validates required environment values and loopback TrueForge before making requests', async () => {
  const fetchImpl = vi.fn();
  await expect(configureFallback({ baseUrl: 'https://outside.example', providerBaseUrl: 'https://provider.test/v1', model: 'model', fetchImpl })).rejects.toThrow('loopback');
  await expect(configureFallback({ baseUrl: 'http://localhost:8790', model: 'model', fetchImpl })).rejects.toThrow('FALLBACK_BASE_URL');
  await expect(configureFallback({ baseUrl: 'http://localhost:8790', providerBaseUrl: 'https://provider.test/v1', fetchImpl })).rejects.toThrow('FALLBACK_MODEL');
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('registers an unauthenticated OpenAI-compatible provider without adding auth', async () => {
  const calls: { url: string; method?: string; body?: string }[] = [];
  const fetchImpl = vi.fn(async (url: string, options: { method?: string; body?: string } = {}) => {
    calls.push({ url, ...options });
    return options.method ? ok({}) : ok({ data: [] });
  });
  const result = await configureFallback({
    providerBaseUrl: 'http://127.0.0.1:11434/v1/',
    model: 'qwen2.5-coder',
    fetchImpl,
  });
  const saved = JSON.parse(calls[1]!.body!);
  expect(saved.manifest).toMatchObject({
    type: 'custom',
    name: 'forge-fallback',
    base_url: 'http://127.0.0.1:11434/v1',
    models: [{ name: 'qwen2.5-coder', model_id: 'qwen2.5-coder' }],
  });
  expect(saved.manifest).not.toHaveProperty('auth');
  expect(result).not.toContain('key');
});

it('stores an optional API key only in the TrueForge provider request', async () => {
  const calls: { url: string; method?: string; body?: string }[] = [];
  const fetchImpl = vi.fn(async (url: string, options: { method?: string; body?: string } = {}) => {
    calls.push({ url, ...options });
    return options.method ? ok({}) : ok({ data: [] });
  });
  await configureFallback({
    providerBaseUrl: 'https://provider.test/v1',
    apiKey: 'secret-test-key',
    model: 'model-x',
    fetchImpl,
  });
  expect(calls[0]!.url).toBe('http://localhost:8790/api/v1/settings/model-providers');
  expect(JSON.parse(calls[1]!.body!).manifest.auth).toEqual({ api_key: 'secret-test-key' });
});

it('does not expose credentials in a TrueForge error', async () => {
  const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  await expect(configureFallback({
    providerBaseUrl: 'https://provider.test/v1',
    apiKey: 'secret-test-key',
    model: 'model-x',
    fetchImpl,
  })).rejects.toThrow('HTTP 500');
  await expect(configureFallback({
    providerBaseUrl: 'https://provider.test/v1',
    apiKey: 'secret-test-key',
    model: 'model-x',
    fetchImpl,
  }).catch((error: Error) => error.message)).resolves.not.toContain('secret-test-key');
});
