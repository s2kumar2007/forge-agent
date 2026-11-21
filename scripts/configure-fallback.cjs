/** Thin backward-compatibility wrapper around configure-provider.cjs. */
const { configureProvider } = require('./configure-provider.cjs');

async function configureFallback(opts = {}) {
  return configureProvider({
    providerName: opts.providerName || process.env.PROVIDER_NAME || 'forge-fallback',
    providerBaseUrl: opts.providerBaseUrl || process.env.PROVIDER_BASE_URL || process.env.FALLBACK_BASE_URL,
    apiKey: opts.apiKey || process.env.PROVIDER_API_KEY || process.env.FALLBACK_API_KEY,
    model: opts.model || process.env.PROVIDER_MODEL || process.env.FALLBACK_MODEL,
    modelName: opts.modelName || process.env.PROVIDER_MODEL_NAME,
    baseUrl: opts.baseUrl,
    targetAgents: opts.targetAgents || (process.env.TARGET_AGENTS ? process.env.TARGET_AGENTS.split(',') : ['forge-agent-fallback']),
    fetchImpl: opts.fetchImpl,
  });
}

module.exports = { configureFallback, configureProvider };

if (require.main === module) {
  configureFallback({
    baseUrl: process.argv[2] || 'http://localhost:8790',
  }).then(console.log).catch((error) => {
    console.error(error instanceof Error ? error.message.split(/[\r\n]/)[0] : 'Fallback setup failed.');
    process.exitCode = 1;
  });
}
