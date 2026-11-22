// Webview script. textContent is used everywhere (never innerHTML) so model output cannot inject markup.
const vscode = acquireVsCodeApi();
window.vscode = vscode;
const log = document.getElementById('log');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const metricsFooter = document.getElementById('metrics-footer');
if (metricsFooter) metricsFooter.title = metricsFooter.textContent || 'Ready';
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const tokenFill = document.getElementById('token-bar-fill');
const tokenLabel = document.getElementById('token-bar-label');
const bubbles = new Map(); // message id -> element, so deltas append to the right bubble

const timelineSteps = ['context', 'model', 'tools', 'review', 'done'];

function setTimelineStep(activeStep) {
  let found = false;
  for (const step of timelineSteps) {
    const el = document.getElementById('step-' + step);
    if (!el) continue;
    if (step === activeStep) {
      el.className = 'timeline-step active';
      found = true;
    } else if (!found) {
      el.className = 'timeline-step completed';
    } else {
      el.className = 'timeline-step';
    }
  }
}

function resetTimeline() {
  for (const step of timelineSteps) {
    const el = document.getElementById('step-' + step);
    if (el) el.className = 'timeline-step';
  }
}

function setStatus(state, text) {
  if (statusDot) {
    statusDot.className = 'status-dot ' + (state || 'healthy');
  }
  if (statusText && text) {
    statusText.textContent = text;
  }
}

function updateTokenBar(tokens, budget) {
  const b = budget || 2000;
  const pct = Math.round((tokens / b) * 100);
  const fillPct = Math.min(100, Math.max(0, pct));
  if (tokenFill) {
    tokenFill.style.width = fillPct + '%';
    tokenFill.className = pct > 100 ? 'over-budget' : '';
  }
  if (tokenLabel) {
    tokenLabel.textContent = `${tokens} / ${b} est. tokens (${pct}%)`;
  }
}

function attachCopyButton(bubble) {
  if (bubble.querySelector('.copy-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.textContent = 'Copy';
  btn.title = 'Copy response';
  btn.setAttribute('aria-label', 'Copy response');
  btn.onclick = (e) => {
    e.stopPropagation();
    const clone = bubble.cloneNode(true);
    const cb = clone.querySelector('.copy-btn');
    if (cb) cb.remove();
    navigator.clipboard.writeText(clone.textContent.trim()).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  };
  bubble.appendChild(btn);
}

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
  resetTimeline();
  setTimelineStep('context');
  vscode.postMessage({ type: 'send', text });
}

sendBtn.onclick = send;
stopBtn.onclick = () => vscode.postMessage({ type: 'stop' });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });

// Quick action chips
const chips = document.querySelectorAll('.chip');
chips.forEach((chip) => {
  chip.onclick = () => {
    const prompt = chip.getAttribute('data-prompt') || chip.textContent.trim();
    input.value = prompt;
    input.focus();
    send();
  };
});

window.addEventListener('message', ({ data: m }) => {
  switch (m.type) {
    case 'userMessage':
      add('user', m.text);
      resetTimeline();
      setTimelineStep('context');
      break;
    case 'delta': {
      setTimelineStep('model');
      let el = bubbles.get(m.id);
      if (!el) {
        el = add('agent', '');
        bubbles.set(m.id, el);
      }
      el.textContent += m.text;
      attachCopyButton(el);
      log.scrollTop = log.scrollHeight;
      break;
    }
    case 'tool':
      setTimelineStep('tools');
      add('tool', 'tool call: ' + m.name);
      break;
    case 'diffPreview': {
      setTimelineStep('review');
      const card = document.createElement('div');
      card.className = 'msg preview-card';

      const head = document.createElement('div');
      head.className = 'preview-header';

      const title = document.createElement('div');
      title.className = 'preview-title';
      title.textContent = '\uD83D\uDCDD ' + m.path;
      head.appendChild(title);

      if (m.confidence) {
        const badge = document.createElement('span');
        badge.className = 'confidence-tag ' + (m.confidence.tag ? m.confidence.tag.toLowerCase() : 'medium');
        badge.textContent = `${m.confidence.tag} ${m.confidence.score}%`;
        head.appendChild(badge);
      }
      card.appendChild(head);

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
    case 'notice':
      add('notice', m.text);
      if (/fallback/i.test(m.text) || /primary unavailable/i.test(m.text)) {
        setStatus('fallback', 'gemini-3-5-flash (fallback)');
      }
      break;
    case 'session':
      add('notice', 'Session: ' + m.id);
      break;
    case 'done':
      setTimelineStep('done');
      if (m.status === 'error') {
        setStatus('error', 'Error');
        add('error', m.message || 'The request failed.');
      } else if (m.status === 'cancelled') {
        add('notice', m.message || 'Cancelled - no changes applied');
      }
      break;
    case 'context': {
      setTimelineStep('context');
      updateTokenBar(m.tokens, m.budget);
      const d = document.createElement('details');
      d.className = 'msg context-details';
      const sm = document.createElement('summary');
      sm.textContent = 'Context: ' + m.items.length + ' items, ' + m.tokens + ' of ' + m.budget + ' estimated tokens';
      d.append(sm);
      for (const it of m.items) {
        const r = document.createElement('div');
        r.className = 'context-item';
        r.textContent = it.label + ' (' + it.tokens + ' estimated tokens) - ' + it.reason;
        d.append(r);
      }
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
      break;
    }
    case 'suggestions':
      showSuggestions(m.items);
      break;
    case 'metrics': {
      if (metricsFooter && m.metrics) {
        const met = m.metrics;
        const ttft = met.timeToFirstTokenMs !== undefined ? `${met.timeToFirstTokenMs}ms` : 'n/a';
        const total = `${(met.totalTimeMs / 1000).toFixed(2)}s`;
        const agent = met.agentAnswered || 'primary';
        const text = `${agent} \u00B7 ${total} \u00B7 TTFT ${ttft} \u00B7 ${met.modelTurns} turns \u00B7 ~${met.estimatedTokensIn} in / ~${met.estimatedTokensOut} out`;
        metricsFooter.textContent = text;
        metricsFooter.title = text;
        if (met.agentAnswered) {
          if (met.agentAnswered.includes('fallback') || met.agentAnswered.includes('gemini')) {
            setStatus('fallback', met.agentAnswered);
          } else {
            setStatus('healthy', met.agentAnswered);
          }
        }
      }
      break;
    }
    case 'busy':
      sendBtn.disabled = m.value;
      stopBtn.disabled = !m.value;
      break;
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
  if (!tok || !items.length) {
    ac.style.display = 'none';
    return;
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'ac-item';
    row.textContent = it.label;
    row.onclick = () => {
      input.value = input.value.slice(0, tok.start) + it.insert + ' ' + input.value.slice(input.selectionStart);
      ac.style.display = 'none';
      input.focus();
    };
    ac.append(row);
  }
  ac.style.display = 'block';
}
input.addEventListener('input', () => {
  const tok = currentToken();
  if (tok) vscode.postMessage({ type: 'suggest', prefix: tok.text });
  else ac.style.display = 'none';
});
