/** Local opt-in setup for a second OpenAI-compatible provider. */
const fs = require('node:fs/promises');
const path = require('node:path');

function requiresApiKey(endpoint) {
  if (['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) return false;
  if (endpoint.hostname.includes('nvidia.com')) return true;
  return false;
}

function toModelSlug(modelId) {
  const base = modelId.includes('/') ? modelId.split('/').pop() : modelId;
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'default-model';
}

async function configureFallback({
  baseUrl = 'http://localhost:8790',
  providerBaseUrl = process.env.FALLBACK_BASE_URL,
  apiKey = process.env.FALLBACK_API_KEY,
  model = process.env.FALLBACK_MODEL,
  fetchImpl = fetch,
} = {}) {
  if (!providerBaseUrl?.trim()) throw new Error('FALLBACK_BASE_URL is required.');
  if (!model?.trim()) throw new Error('FALLBACK_MODEL is required.');

  const local = new URL(baseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname) || !['http:', 'https:'].includes(local.protocol)) {
    throw new Error('This helper sends credentials only to a loopback TrueForge server.');
  }

  const endpoint = new URL(providerBaseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('FALLBACK_BASE_URL must be an HTTP(S) URL without embedded credentials or query parameters.');
  }

  if (requiresApiKey(endpoint) && !apiKey?.trim()) {
    throw new Error(`FALLBACK_API_KEY is required for ${endpoint.hostname.includes('nvidia.com') ? 'NVIDIA NIM' : endpoint.hostname}. Enter it locally; never put it in the repository or chat.`);
  }

  const normalizedBaseUrl = endpoint.toString().replace(/\/+$/, '');
  const providerName = 'forge-fallback';
  const modelId = model.trim();
  const modelSlug = toModelSlug(modelId);
  const key = apiKey?.trim() || undefined;
  const request = async (url, options = {}) => {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      let detail = '';
      try {
        const text = await response.text();
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message ? `: ${parsed.error.message}` : `: ${text}`;
      } catch {}
      throw new Error(`TrueForge request failed (HTTP ${response.status})${detail}.`);
    }
    return response.status === 204 ? {} : response.json();
  };

  const providers = await request(baseUrl + '/api/v1/settings/model-providers');
  const existing = providers.data.find((provider) => provider.name === providerName);
  if (existing && (existing.manifest.type !== 'custom' || existing.manifest.base_url !== normalizedBaseUrl)) {
    throw new Error('A different provider named forge-fallback already exists. It was not overwritten.');
  }
  const manifest = {
    type: 'custom',
    name: providerName,
    base_url: normalizedBaseUrl,
    ...(key ? { auth: { api_key: key } } : {}),
    models: [
      ...(existing?.manifest.models || []).filter((item) => item.name !== modelSlug),
      { name: modelSlug, model_id: modelId, properties: {} },
    ],
  };
  await request(baseUrl + '/api/v1/settings/model-providers', {
    method: existing ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });

  const fallbackAgent = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'agents', 'forge-agent-fallback.json'), 'utf8'));
  fallbackAgent.manifest.model.name = `${providerName}/${modelSlug}`;
  const registered = await request(baseUrl + '/api/v1/agents?limit=100');
  const current = registered.data.find((agent) => agent.name === fallbackAgent.name);
  const payload = current
    ? { description: fallbackAgent.description, manifest: fallbackAgent.manifest }
    : fallbackAgent;
  await request(baseUrl + '/api/v1/agents' + (current ? `/${current.id}` : ''), {
    method: current ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return `Registered provider ${providerName} for model ${modelSlug}.`;
}

module.exports = { configureFallback };
if (require.main === module) {
  configureFallback({
    baseUrl: process.argv[2] || 'http://localhost:8790',
    providerBaseUrl: process.env.FALLBACK_BASE_URL,
    apiKey: process.env.FALLBACK_API_KEY,
    model: process.env.FALLBACK_MODEL,
  }).then(console.log).catch((error) => {
    console.error(error instanceof Error ? error.message.split(/[\r\n]/)[0] : 'Fallback provider setup failed.');
    process.exitCode = 1;
  });
}
