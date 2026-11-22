import * as vscode from 'vscode';

/** Typed access to the `forge.*` settings. Read lazily so changes apply without reload. */
export function getConfig() {
  const c = vscode.workspace.getConfiguration('forge');
  return {
    baseUrl: c.get<string>('baseUrl', 'http://localhost:8790'),
    agentName: c.get<string>('agentName', 'forge-agent'),
    fallbackAgentName: c.get<string>('fallbackAgentName', 'forge-agent-fallback'),
    fallbackModel: c.get<string>('fallbackModel', 'google-gemini/gemini-3-8-flash'),
    fallbackModels: c.get<string[]>('fallbackModels', [c.get<string>('fallbackModel', 'google-gemini/gemini-3-8-flash')]),
    firstTokenTimeoutMs: Math.max(1000, c.get<number>('firstTokenTimeoutMs', 45000)),
    stallTimeoutMs: Math.max(1000, c.get<number>('stallTimeoutMs', 20000)),
    failoverBudgetMs: Math.max(5000, c.get<number>('failoverBudgetMs', 45000)),
    contextBudget: Math.max(500, c.get<number>('contextBudget', 2000)),
    fallbackContextBudget: Math.max(500, c.get<number>('fallbackContextBudget', 1500)),
    explorationBudget: Math.max(1, c.get<number>('explorationBudget', 12)),
    faultInjection: c.get<string>('faultInjection', 'none'),
    guideCharacter3d: c.get<boolean>('guide.character3d', false),
    panelTheme: c.get<string>('panel.theme', 'auto'),
  };
}
