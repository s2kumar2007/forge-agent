// Webview script. textContent is used everywhere (never innerHTML) so model output cannot inject markup.
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const metricsFooter = document.getElementById('metrics-footer');
const bubbles = new Map(); // message id -> element, so deltas append to the right bubble

function add(cls, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}
function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  vscode.postMessage({ type: 'send', text });
}
sendBtn.onclick = send;
stopBtn.onclick = () => vscode.postMessage({ type: 'stop' });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });

window.addEventListener('message', ({ data: m }) => {
  switch (m.type) {
    case 'userMessage': add('user', m.text); break;
    case 'delta': {
      let el = bubbles.get(m.id);
      if (!el) { el = add('agent', ''); bubbles.set(m.id, el); }
      el.textContent += m.text;
      log.scrollTop = log.scrollHeight;
      break;
    }
    case 'tool': add('tool', 'tool call: ' + m.name); break;
    case 'diffPreview': {
      const card = document.createElement('div');
      card.className = 'msg preview-card';
      const title = document.createElement('div');
      title.className = 'preview-title';
      title.textContent = '📝 Proposed change: ' + m.path;
      card.appendChild(title);
      if (m.rationale) {
        const desc = document.createElement('div');
        desc.className = 'preview-desc';
        desc.textContent = m.rationale;
        card.appendChild(desc);
      }
      log.appendChild(card);
      log.scrollTop = log.scrollHeight;
      break;
    }
    case 'notice': add('notice', m.text); break;
    case 'session': add('notice', 'Session: ' + m.id); break;
    case 'done':
      if (m.status === 'error') add('error', m.message || 'The request failed.');
      else if (m.status === 'cancelled') add('notice', m.message || 'Cancelled - no changes applied');
      break;
    case 'context': {
      const d = document.createElement('details'); d.className = 'msg notice';
      const sm = document.createElement('summary'); sm.textContent = 'Context: ' + m.items.length + ' items, ' + m.tokens + ' of ' + m.budget + ' estimated tokens';
      d.append(sm);
      for (const it of m.items) { const r = document.createElement('div'); r.className = 'context-item'; r.textContent = it.label + ' (' + it.tokens + ' estimated tokens) - ' + it.reason; d.append(r); }
      log.appendChild(d); log.scrollTop = log.scrollHeight; break;
    }
    case 'suggestions': showSuggestions(m.items); break;
    case 'metrics': {
      if (metricsFooter && m.metrics) {
        const met = m.metrics;
        const ttft = met.timeToFirstTokenMs !== undefined ? `${met.timeToFirstTokenMs}ms` : 'n/a';
        const total = `${(met.totalTimeMs / 1000).toFixed(2)}s`;
        const agent = met.agentAnswered || 'primary';
        metricsFooter.textContent = `${agent} · ${total} · TTFT ${ttft} · ${met.modelTurns} turns · ~${met.estimatedTokensIn} in / ~${met.estimatedTokensOut} out`;
      }
      break;
    }
    case 'busy': sendBtn.disabled = m.value; stopBtn.disabled = !m.value; break;
  }
});

// --- @file / @symbol autocomplete: type "@" (or "@symbol:Name") and pick a suggestion ---
const ac = document.getElementById('ac');
function currentToken() {
  const upto = input.value.slice(0, input.selectionStart);
  const m = /@([^\s]*)$/.exec(upto);
  return m ? { start: upto.length - m[0].length, text: m[1] } : undefined;
}
function showSuggestions(items) {
  ac.textContent = '';
  const tok = currentToken();
  if (!tok || !items.length) { ac.style.display = 'none'; return; }
  for (const it of items) {
    const row = document.createElement('div'); row.className = 'ac-item'; row.textContent = it.label;
    row.onclick = () => { input.value = input.value.slice(0, tok.start) + it.insert + ' ' + input.value.slice(input.selectionStart); ac.style.display = 'none'; input.focus(); };
    ac.append(row);
  }
  ac.style.display = 'block';
}
input.addEventListener('input', () => {
  const tok = currentToken();
  if (tok) vscode.postMessage({ type: 'suggest', prefix: tok.text }); else ac.style.display = 'none';
});
