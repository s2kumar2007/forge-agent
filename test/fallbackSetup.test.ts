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
    models: [{ name: 'qwen2-5-coder', model_id: 'qwen2.5-coder' }],
  });
  expect(saved.manifest).not.toHaveProperty('auth');
  expect(result).not.toContain('key');
});

it('selects the second provider only for the remote fallback agent', async () => {
  const calls: { url: string; method?: string; body?: string }[] = [];
  const fetchImpl = vi.fn(async (url: string, options: { method?: string; body?: string } = {}) => {
    calls.push({ url, ...options });
    return options.method ? ok({}) : ok({ data: [] });
  });
  await configureFallback({
    providerBaseUrl: 'https://provider.test/v1',
    model: 'model-x',
    fetchImpl,
  });
  const agentWrite = calls.find((call) => call.url.endsWith('/agents') && call.method === 'POST');
  expect(JSON.parse(agentWrite!.body!)).toMatchObject({
    name: 'forge-agent-fallback',
    manifest: { model: { name: 'forge-fallback/model-x' } },
  });
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

it('requires an API key when configuring NVIDIA NIM as fallback provider', async () => {
  const fetchImpl = vi.fn();
  await expect(configureFallback({
    providerBaseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.3-70b-instruct',
    fetchImpl,
  })).rejects.toThrow('FALLBACK_API_KEY is required for NVIDIA NIM');
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('configures NVIDIA NIM as fallback provider using fake credentials without exposing them', async () => {
  const calls: { url: string; method?: string; body?: string }[] = [];
  const fetchImpl = vi.fn(async (url: string, options: { method?: string; body?: string } = {}) => {
    calls.push({ url, ...options });
    return options.method ? ok({}) : ok({ data: [] });
  });

  const result = await configureFallback({
    providerBaseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.3-70b-instruct',
    apiKey: 'nvapi-fake-test-key-12345',
    fetchImpl,
  });

  expect(result).toBe('Registered provider forge-fallback for model llama-3-3-70b-instruct.');
  expect(result).not.toContain('nvapi');

  // Verify provider payload
  const providerCall = calls.find((c) => c.url.endsWith('/settings/model-providers') && (c.method === 'POST' || c.method === 'PUT'))!;
  const providerBody = JSON.parse(providerCall.body!);
  expect(providerBody.manifest).toMatchObject({
    type: 'custom',
    name: 'forge-fallback',
    base_url: 'https://integrate.api.nvidia.com/v1',
    auth: { api_key: 'nvapi-fake-test-key-12345' },
    models: [{ name: 'llama-3-3-70b-instruct', model_id: 'meta/llama-3.3-70b-instruct' }],
  });

  // Verify agent payload
  const agentCall = calls.find((c) => c.url.includes('/api/v1/agents') && (c.method === 'POST' || c.method === 'PUT'))!;
  const agentBody = JSON.parse(agentCall.body!);
  expect(agentBody.name).toBe('forge-agent-fallback');
  expect(agentBody.manifest.model.name).toBe('forge-fallback/llama-3-3-70b-instruct');
});

it('reads FALLBACK_BASE_URL, FALLBACK_MODEL and FALLBACK_API_KEY from environment', async () => {
  const origEnv = { ...process.env };
  try {
    process.env.FALLBACK_BASE_URL = 'https://integrate.api.nvidia.com/v1';
    process.env.FALLBACK_MODEL = 'meta/llama-3.3-70b-instruct';
    process.env.FALLBACK_API_KEY = 'nvapi-env-fake-key';

    const calls: { url: string; method?: string; body?: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, options: { method?: string; body?: string } = {}) => {
      calls.push({ url, ...options });
      return options.method ? ok({}) : ok({ data: [] });
    });

    await configureFallback({ fetchImpl });

    const providerCall = calls.find((c) => c.url.endsWith('/settings/model-providers') && c.method === 'POST')!;
    const providerBody = JSON.parse(providerCall.body!);
    expect(providerBody.manifest.base_url).toBe('https://integrate.api.nvidia.com/v1');
    expect(providerBody.manifest.auth).toEqual({ api_key: 'nvapi-env-fake-key' });
    expect(providerBody.manifest.models[0].name).toBe('llama-3-3-70b-instruct');
  } finally {
    process.env = origEnv;
  }
});
