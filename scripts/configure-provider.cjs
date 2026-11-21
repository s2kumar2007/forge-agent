/** Generic local opt-in provider setup helper for TrueForge. */
const fs = require('node:fs/promises');
const path = require('node:path');

function requiresApiKey(endpoint) {
  if (['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) return false;
  if (endpoint.hostname.includes('nvidia.com')) return true;
  return false;
}

function validateCatalogName(name) {
  if (typeof name !== 'string' || name.length < 2 || name.length > 64) {
    throw new Error(`Invalid catalog name "${name}": must be 2-64 lowercase characters.`);
  }
  if (!/^[a-z]/.test(name)) {
    throw new Error(`Invalid catalog name "${name}": must start with a lowercase letter.`);
  }
  if (!/[a-z0-9]$/.test(name)) {
    throw new Error(`Invalid catalog name "${name}": must end with an alphanumeric character.`);
  }
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) {
    throw new Error(`Invalid catalog name "${name}": must contain only lowercase letters, digits, and hyphens (no slashes or dots).`);
  }
  return true;
}

function deriveCatalogName(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    throw new Error('Model ID is required to derive a catalog name.');
  }
  const base = modelId.includes('/') ? modelId.split('/').pop() : modelId;
  let slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '');
  if (slug.length > 64) {
    slug = slug.slice(0, 64).replace(/-+$/, '');
  }
  validateCatalogName(slug);
  return slug;
}

async function configureProvider({
  baseUrl = 'http://localhost:8790',
  providerBaseUrl = process.env.PROVIDER_BASE_URL || process.env.FALLBACK_BASE_URL,
  apiKey = process.env.PROVIDER_API_KEY || process.env.FALLBACK_API_KEY,
  model = process.env.PROVIDER_MODEL || process.env.FALLBACK_MODEL,
  modelName = process.env.PROVIDER_MODEL_NAME,
  providerName = process.env.PROVIDER_NAME || 'forge-nvidia',
  targetAgents = process.env.TARGET_AGENTS ? process.env.TARGET_AGENTS.split(',') : ['forge-agent', 'forge-inline'],
  fetchImpl = fetch,
} = {}) {
  if (!providerBaseUrl?.trim()) throw new Error('PROVIDER_BASE_URL (or FALLBACK_BASE_URL) is required.');
  if (!model?.trim()) throw new Error('PROVIDER_MODEL (or FALLBACK_MODEL) is required.');

  const local = new URL(baseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname) || !['http:', 'https:'].includes(local.protocol)) {
    throw new Error('This helper sends credentials only to a loopback TrueForge server.');
  }

  const endpoint = new URL(providerBaseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('PROVIDER_BASE_URL (or FALLBACK_BASE_URL) must be an HTTP(S) URL without embedded credentials or query parameters.');
  }

  if (requiresApiKey(endpoint) && !apiKey?.trim()) {
    throw new Error(`FALLBACK_API_KEY is required for ${endpoint.hostname.includes('nvidia.com') ? 'NVIDIA NIM' : endpoint.hostname} (or PROVIDER_API_KEY). Enter it locally; never put it in the repository or chat.`);
  }

  const catalogName = modelName?.trim() ? modelName.trim() : deriveCatalogName(model.trim());
  validateCatalogName(catalogName);

  const normalizedBaseUrl = endpoint.toString().replace(/\/+$/, '');
  const modelId = model.trim();
  const key = apiKey?.trim() || undefined;

  const targetAgentsList = (Array.isArray(targetAgents) ? targetAgents : String(targetAgents).split(','))
    .map((s) => s.trim())
    .filter(Boolean);

  const request = async (url, options = {}) => {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      let detail = '';
      try {
        const text = await response.text();
        try {
          const parsed = JSON.parse(text);
          detail = parsed?.error?.message ? `: ${parsed.error.message.split(/[\r\n]+/)[0].trim()}` : parsed?.message ? `: ${parsed.message.split(/[\r\n]+/)[0].trim()}` : '';
        } catch {
          if (text) detail = `: ${text.split(/[\r\n]+/)[0].trim().slice(0, 120)}`;
        }
      } catch {}
      detail = detail
        .replace(/(?:Bearer\s+|api[-_ ]?key\s*[:=]?\s*)[^\s"']+/gi, '[REDACTED]')
        .replace(/\b(?:nvapi-|sk-|gsk_|AIza)[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
      throw new Error(`TrueForge request failed (HTTP ${response.status})${detail}.`);
    }
    return response.status === 204 ? {} : response.json();
  };

  const providers = await request(baseUrl + '/api/v1/settings/model-providers');
  const existing = providers.data?.find((provider) => provider.name === providerName);
  if (existing && (existing.manifest?.type !== 'custom' || existing.manifest?.base_url !== normalizedBaseUrl)) {
    throw new Error(`A different provider named ${providerName} already exists. It was not overwritten.`);
  }

  const manifest = {
    type: 'custom',
    name: providerName,
    base_url: normalizedBaseUrl,
    ...(key ? { auth: { api_key: key } } : {}),
    models: [
      ...(existing?.manifest?.models || []).filter((item) => item.name !== catalogName),
      { name: catalogName, model_id: modelId, properties: {} },
    ],
  };

  await request(baseUrl + '/api/v1/settings/model-providers', {
    method: existing ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });

  const registered = await request(baseUrl + '/api/v1/agents?limit=100');
  const updatedAgents = [];

  for (const agentName of targetAgentsList) {
    const current = registered.data?.find((agent) => agent.name === agentName);
    let payload;
    if (current) {
      payload = {
        description: current.description,
        manifest: {
          ...current.manifest,
          model: {
            ...current.manifest?.model,
            name: `${providerName}/${catalogName}`,
          },
        },
      };
    } else {
      const agentFile = path.join(__dirname, '..', 'agents', `${agentName}.json`);
      try {
        const diskAgent = JSON.parse(await fs.readFile(agentFile, 'utf8'));
        diskAgent.manifest.model.name = `${providerName}/${catalogName}`;
        payload = diskAgent;
      } catch {
        payload = {
          name: agentName,
          description: `${agentName} coding agent`,
          manifest: {
            model: { name: `${providerName}/${catalogName}`, params: { temperature: 0.2, parallel_tool_calls: false } },
            instructions: '',
            mcp_servers: [{ name: 'forge-editor', enable_tools: ['@all'] }],
          },
        };
      }
    }

    await request(baseUrl + '/api/v1/agents' + (current ? `/${current.id}` : ''), {
      method: current ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    updatedAgents.push(agentName);
  }

  return `Registered provider ${providerName} for model ${modelId} as ${providerName}/${catalogName}; updated agents: ${updatedAgents.join(', ')}.`;
}

module.exports = { configureProvider, validateCatalogName, deriveCatalogName };

if (require.main === module) {
  configureProvider({
    baseUrl: process.argv[2] || 'http://localhost:8790',
  }).then(console.log).catch((error) => {
    console.error(error instanceof Error ? error.message.split(/[\r\n]/)[0] : 'Provider setup failed.');
    process.exitCode = 1;
  });
}
