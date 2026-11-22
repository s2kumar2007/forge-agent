import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { AgentController } from '../agent/controller';
import type { AgentUi } from '../agent/types';
import { assembleContext, computeAdaptiveBudget } from '../context/assemble';
import type { WorkspaceContextDeps } from '../context/vscodeDeps';
import { getConfig } from '../config';
import type { RunMetrics } from '../metrics';

type ToWebview =
  | { type: 'userMessage'; text: string }
  | { type: 'delta'; id: string; text: string }
  | { type: 'tool'; name: string }
  | { type: 'notice'; text: string }
  | { type: 'session'; id: string }
  | { type: 'done'; status: string; message?: string }
  | { type: 'busy'; value: boolean }
  | { type: 'context'; items: { label: string; reason: string; tokens: number }[]; tokens: number; budget: number }
  | { type: 'suggestions'; items: { insert: string; label: string }[] }
  | { type: 'metrics'; metrics: RunMetrics }
  | { type: 'diffPreview'; path: string; rationale?: string; confidence?: { tag: string; score: number } };

/** Webview chat. A thin UI over AgentController; all network work is async so the host never blocks. */
export class ChatPanel {
  private static current: ChatPanel | undefined;
  private sending = false;
  private sendAbort = new AbortController();

  static show(ctx: vscode.ExtensionContext, controller: AgentController, deps: WorkspaceContextDeps): void {
    if (ChatPanel.current) { ChatPanel.current.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('forgeAgent', 'Forge Agent', vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
      retainContextWhenHidden: true,
    });
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'logo.png');
    ChatPanel.current = new ChatPanel(panel, ctx, controller, deps);
  }

  private constructor(private panel: vscode.WebviewPanel, private ctx: vscode.ExtensionContext, private controller: AgentController, private deps: WorkspaceContextDeps) {
    panel.webview.html = this.html(panel.webview);
    panel.onDidDispose(() => { if (this.sending) { this.sendAbort.abort(); void this.controller.cancel(); } ChatPanel.current = undefined; });
    panel.webview.onDidReceiveMessage((m: { type: string; text?: string; prefix?: string; theme?: string }) => {
      if (m.type === 'send' && m.text) void this.send(m.text);
      if (m.type === 'suggest') void this.deps.suggest(m.prefix ?? '').then((items) => this.post({ type: 'suggestions', items }));
      if (m.type === 'stop') { this.sendAbort.abort(); void this.controller.cancel(); }
      if (m.type === 'setTheme' && (m.theme === 'auto' || m.theme === 'light' || m.theme === 'dark')) {
        void vscode.workspace.getConfiguration('forge').update('panel.theme', m.theme, vscode.ConfigurationTarget.Global);
      }
    });
  }

  private post(msg: ToWebview): void { void this.panel.webview.postMessage(msg); }

  private async send(text: string): Promise<void> {
    if (this.sending || this.controller.busy) return;
    this.sending = true;
    this.sendAbort = new AbortController();
    this.post({ type: 'userMessage', text });
    this.post({ type: 'busy', value: true });
    const ui: AgentUi = {
      textDelta: (id, t) => this.post({ type: 'delta', id, text: t }),
      toolCall: (name) => this.post({ type: 'tool', name }),
      notice: (t) => { this.post({ type: 'notice', text: t }); void vscode.window.showWarningMessage('Forge: ' + t); },
      finished: (info) => this.post({ type: 'done', status: info.status, message: info.message }),
      eventLine: (t) => this.post({ type: 'notice', text: t }),
      session: (id) => this.post({ type: 'session', id }),
      metrics: (metrics) => this.post({ type: 'metrics', metrics }),
      diffPreview: (preview) => this.post({ type: 'diffPreview', path: preview.path, rationale: preview.rationale, confidence: preview.confidence }),
    };
    try {
      const buildMessage = async (budget: number): Promise<string> => {
        try {
          const promptTokens = Math.ceil(text.length / 4);
          const effectiveBudget = Math.max(500, Math.min(budget, 4000 - promptTokens));
          const ctx = await assembleContext(text, this.deps, effectiveBudget, this.sendAbort.signal);
          this.post({
            type: 'context',
            items: ctx.items.map((i) => ({ label: i.label, reason: i.reason, tokens: i.tokens })),
            tokens: ctx.tokens,
            budget: ctx.budget,
          });
          return `## Task\n${text}\n\n## Context (hints only, may be incomplete)\n${ctx.text}\n\n## Reminder\nDo the task above: use the tools, call propose_write for every file you change, and do not just describe the workspace.`;
        } catch {
          this.post({ type: 'notice', text: 'Context assembly failed; sending the request without it.' });
          return text;
        }
      };

      const baseBudget = getConfig().contextBudget;
      const primaryMessage = await buildMessage(computeAdaptiveBudget(text, baseBudget));
      if (this.sendAbort.signal.aborted) { ui.finished({ status: 'cancelled', message: 'Cancelled - no changes applied' }); return; }
      await this.controller.run(primaryMessage, ui, undefined, async (agent) => {
        if (agent === getConfig().fallbackAgentName) {
          return await buildMessage(getConfig().fallbackContextBudget);
        }
        return primaryMessage;
      });
    } finally { this.sending = false; this.post({ type: 'busy', value: false }); }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'main.js'));
    const characterJs = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'character.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'main.css'));
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'logo.png'));
    const guide3d = getConfig().guideCharacter3d;
    const panelTheme = getConfig().panelTheme;
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<header id="header">
  <div class="header-left">
    <img class="header-logo" src="${logo}" alt="Forge Agent logo" width="24" height="24">
    <div class="header-titles">
      <div class="header-title">Forge Agent</div>
    </div>
  </div>
  <div class="header-right">
    <div id="theme-switch" class="theme-switch" role="radiogroup" aria-label="Theme mode">
      <button type="button" class="theme-btn active" data-theme="auto" role="radio" aria-checked="true" tabindex="0" title="Auto (follow VS Code)">
        <span class="theme-icon" aria-hidden="true">&#9680;</span>
        <span class="sr-only">Auto</span>
      </button>
      <button type="button" class="theme-btn" data-theme="light" role="radio" aria-checked="false" tabindex="0" title="White (Light theme)">
        <span class="theme-icon" aria-hidden="true">&#9728;</span>
        <span class="sr-only">White</span>
      </button>
      <button type="button" class="theme-btn" data-theme="dark" role="radio" aria-checked="false" tabindex="0" title="Black (Dark theme)">
        <span class="theme-icon" aria-hidden="true">&#9789;</span>
        <span class="sr-only">Black</span>
      </button>
    </div>
    <span id="theme-high-contrast-notice" class="theme-hc-notice" style="display:none;" aria-live="polite">Using High Contrast theme</span>
    <div class="header-status">
      <span class="status-dot healthy" id="status-dot"></span>
      <span id="status-text">forge-nvidia / nemotron-3.5</span>
    </div>
  </div>
</header>
<div id="timeline" class="timeline">
  <div class="timeline-step" id="step-context">Context</div>
  <div class="timeline-step" id="step-model">Model</div>
  <div class="timeline-step" id="step-tools">Tools</div>
  <div class="timeline-step" id="step-review">Review</div>
  <div class="timeline-step" id="step-done">Done</div>
</div>
<div id="token-bar-container">
  <div id="token-bar-track">
    <div id="token-bar-fill"></div>
  </div>
  <div id="token-bar-label">0 / 3000 tokens</div>
</div>
<div id="log"></div>
<div id="ac"></div>
<div id="chips">
  <button class="chip" data-prompt="Add a new built-in CLI command flask config that prints configuration as JSON, masking secret keys">flask config CLI</button>
  <button class="chip" data-prompt="Refactor get_debug_flag in src/flask/helpers.py to support off and n">inline get_debug_flag</button>
  <button class="chip" data-prompt="Run test suite and fix any failing tests">run tests</button>
  <button class="chip" data-prompt="Get compiler and linter diagnostics for workspace">diagnostics</button>
</div>
<div id="ask-forge-container">
  <div id="bar">
    <textarea id="input" rows="3" placeholder="Ask Forge... (Ctrl+Enter to send, @ to mention files)"></textarea>
    <div id="bar-buttons">
      <button id="send">Send</button>
      <button id="stop" disabled>Stop</button>
    </div>
  </div>
  <aside id="forge-character-dock" aria-label="Forge Assistant Guide" class="character-dock">
    <div id="character-speech-bubble" class="character-speech" style="display:none;" aria-hidden="true"></div>
    <div class="character-viewport">
      <canvas id="forge-character-canvas" width="160" height="160" aria-label="3D Forge character" role="img"></canvas>
      <div id="forge-character-svg" class="character-2d" style="display:none;" aria-label="2D Forge avatar" role="img"></div>
    </div>
    <div class="character-controls">
      <div class="character-mode-toggle" role="radiogroup" aria-label="Character display mode">
        <button type="button" class="mode-btn" data-mode="3D" role="radio" aria-checked="false" tabindex="0">3D</button>
        <button type="button" class="mode-btn" data-mode="2D" role="radio" aria-checked="false" tabindex="0">2D</button>
        <button type="button" class="mode-btn active" data-mode="Off" role="radio" aria-checked="true" tabindex="0">Off</button>
      </div>
    </div>
    <div id="character-aria-live" aria-live="polite" class="sr-only">Forge is idle and ready</div>
  </aside>
</div>
<footer id="footer">
  <div id="metrics-footer">Ready</div>
</footer>
<script nonce="${nonce}">
  window.__FORGE_INITIAL_CONFIG__ = { guideCharacter3d: ${guide3d}, panelTheme: '${panelTheme}' };
</script>
<script nonce="${nonce}" src="${js}"></script>
<script nonce="${nonce}" src="${characterJs}"></script></body></html>`;
  }
}
