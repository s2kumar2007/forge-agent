import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';

export interface AgentFile {
  name: string;
  description: string;
  manifest: TrueForgeApi.AgentSpec;
}

export async function loadAgentFiles(dir: string): Promise<AgentFile[]> {
  const names = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(names.map(async (f) => JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as AgentFile));
}

/**
 * Create-or-update each agent. Agent ids are server-generated and names are
 * immutable, so we look the agent up by name (list is a substring match; we
 * require an exact match) and then update by id, else create.
 * Returns per-agent outcome so the UI can show non-fatal problems.
 */
export async function syncAgents(client: TrueForge, agents: AgentFile[]): Promise<{ name: string; ok: boolean; error?: string }[]> {
  const results: { name: string; ok: boolean; error?: string }[] = [];
  let availableModels: string[] | undefined;
  const getAvailableModels = async (): Promise<string[]> => {
    if (availableModels) return availableModels;
    try {
      const res = await (client as any).models?.list?.();
      availableModels = res?.data?.map((m: any) => m.name).filter(Boolean) ?? [];
    } catch {
      availableModels = [];
    }
    return availableModels ?? [];
  };

  for (const a of agents) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const existing = await findAgent(client, a.name);
        if (existing) {
          let configuredModel = existing.manifest?.model?.name;
          if (configuredModel && /gemini-2[-.]5-flash/i.test(configuredModel)) {
            configuredModel = 'google-gemini/gemini-3-8-flash';
          }
          let manifest = configuredModel
            ? { ...a.manifest, model: { ...a.manifest.model, name: configuredModel } }
            : a.manifest;
          try {
            await client.agents.update(existing.id, { description: a.description, manifest });
          } catch (updateErr: any) {
            const isUnknownModel = updateErr?.status === 422 || updateErr?.status === 404 || /unknown model|provider not configured|unprocessable|no longer available/i.test(updateErr?.message ?? '');
            if (isUnknownModel) {
              const models = await getAvailableModels();
              const fallbackModel = models.find((m) => m.startsWith('forge-fallback/') || m.startsWith('google-gemini/')) ?? models[0];
              if (fallbackModel && fallbackModel !== manifest.model?.name) {
                manifest = { ...a.manifest, model: { ...a.manifest.model, name: fallbackModel } };
                await client.agents.update(existing.id, { description: a.description, manifest });
              } else {
                throw updateErr;
              }
            } else {
              throw updateErr;
            }
          }
        } else {
          try {
            await client.agents.create({ name: a.name, description: a.description, manifest: a.manifest });
          } catch (createErr: any) {
            const isUnknownModel = createErr?.status === 422 || /unknown model|provider not configured|unprocessable/i.test(createErr?.message ?? '');
            if (isUnknownModel) {
              const models = await getAvailableModels();
              const fallbackModel = models.find((m) => m.startsWith('forge-fallback/') || m.startsWith('google-gemini/')) ?? models[0];
              if (fallbackModel && fallbackModel !== a.manifest.model?.name) {
                const manifest = { ...a.manifest, model: { ...a.manifest.model, name: fallbackModel } };
                await client.agents.create({ name: a.name, description: a.description, manifest });
              } else {
                throw createErr;
              }
            } else {
              throw createErr;
            }
          }
        }
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (lastError) {
      results.push({ name: a.name, ok: false, error: lastError instanceof Error ? lastError.message : String(lastError) });
    } else {
      results.push({ name: a.name, ok: true });
    }
  }
  return results;
}

export async function getAgentModel(client: TrueForge, name: string): Promise<string | undefined> {
  const agent = await findAgent(client, name);
  return agent?.manifest.model.name;
}

async function findAgent(client: TrueForge, name: string): Promise<TrueForgeApi.Agent | undefined> {
  const page = await client.agents.list({ agentName: name, limit: 100 });
  for await (const agent of page) {
    if (agent.name === name) return agent;
  }
  return undefined;
}
