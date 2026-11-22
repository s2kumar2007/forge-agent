import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { getAgentModel, type AgentFile } from './agents';
import { configHint } from '../agent/resilience';

export interface ProviderStatus {
  agent: string;
  model: string;
  ready: boolean;
  checked: boolean;
  reason?: string;
  fix?: string;
}

export async function listConfiguredModels(client: TrueForge): Promise<string[] | undefined> {
  try {
    const res = await (client as any)?.models?.list?.();
    if (!res) return undefined;
    let items: any[] = [];
    if (Array.isArray(res)) {
      items = res;
    } else if (Array.isArray(res.data)) {
      items = res.data;
    } else if (Symbol.asyncIterator in Object(res)) {
      for await (const m of res) items.push(m);
    } else if (Symbol.iterator in Object(res)) {
      items = Array.from(res);
    }
    const names = items
      .map((m: any) => (typeof m === 'string' ? m : (m?.name ?? m?.id)))
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    return names;
  } catch {
    return undefined;
  }
}

export async function checkProviders(
  client: TrueForge,
  agentFiles: AgentFile[]
): Promise<ProviderStatus[]> {
  let configuredModels: string[] | undefined;
  try {
    configuredModels = await listConfiguredModels(client);
  } catch {
    configuredModels = undefined;
  }

  const statuses: ProviderStatus[] = [];

  for (const agentFile of agentFiles) {
    let model = agentFile.manifest?.model?.name ?? 'unknown';
    try {
      const serverModel = await getAgentModel(client, agentFile.name);
      if (serverModel) {
        model = serverModel;
      }
    } catch {
      // keep manifest model
    }

    if (configuredModels === undefined) {
      statuses.push({
        agent: agentFile.name,
        model,
        ready: true,
        checked: false,
        reason: 'Provider models list unavailable',
      });
      continue;
    }

    const ready = configuredModels.includes(model);
    if (ready) {
      statuses.push({
        agent: agentFile.name,
        model,
        ready: true,
        checked: true,
      });
    } else {
      statuses.push({
        agent: agentFile.name,
        model,
        ready: false,
        checked: true,
        reason: `Model "${model}" is not configured in TrueForge.`,
        fix: configHint(model),
      });
    }
  }

  return statuses;
}

export function formatProviderReport(statuses: ProviderStatus[]): string {
  const lines: string[] = ['Forge Provider Status:'];
  for (const s of statuses) {
    if (!s.checked) {
      lines.push(`  - ${s.agent} (${s.model}): UNCHECKED (models list unavailable)`);
    } else if (s.ready) {
      lines.push(`  - ${s.agent} (${s.model}): READY`);
    } else {
      lines.push(`  - ${s.agent} (${s.model}): NOT READY - ${s.reason ?? 'not configured'}`);
      if (s.fix) {
        lines.push(`    Fix: ${s.fix}`);
      }
    }
  }
  return lines.join('\n');
}
