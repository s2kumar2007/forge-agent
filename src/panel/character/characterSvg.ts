import { type CharacterState, STATE_CONFIGS } from './characterState';

/**
 * Generates an accessible, theme-aware 2D SVG avatar for the Forge character.
 * Used as the primary fallback whenever WebGL is unsupported or slow.
 */
export function renderCharacterSvg(state: CharacterState): string {
  const cfg = STATE_CONFIGS[state] || STATE_CONFIGS.idle;
  const visor = cfg.visorColor;
  const glow = cfg.glowColor;

  let stateIndicator = '';
  let expressionBadge = '';

  switch (state) {
    case 'idle':
      stateIndicator = `
        <circle cx="80" cy="80" r="3" fill="${visor}" opacity="0.8" />
      `;
      break;
    case 'listening':
      stateIndicator = `
        <path d="M 40 50 A 15 15 0 0 1 40 70" stroke="${visor}" stroke-width="2" fill="none" stroke-linecap="round" />
        <path d="M 120 50 A 15 15 0 0 0 120 70" stroke="${visor}" stroke-width="2" fill="none" stroke-linecap="round" />
      `;
      break;
    case 'thinking':
      stateIndicator = `
        <circle cx="70" cy="80" r="2.5" fill="${visor}" />
        <circle cx="80" cy="80" r="2.5" fill="${visor}" />
        <circle cx="90" cy="80" r="2.5" fill="${visor}" />
      `;
      break;
    case 'speaking':
      stateIndicator = `
        <line x1="68" y1="80" x2="68" y2="80" stroke="${visor}" stroke-width="3" stroke-linecap="round" />
        <line x1="74" y1="76" x2="74" y2="84" stroke="${visor}" stroke-width="3" stroke-linecap="round" />
        <line x1="80" y1="73" x2="80" y2="87" stroke="${visor}" stroke-width="3" stroke-linecap="round" />
        <line x1="86" y1="76" x2="86" y2="84" stroke="${visor}" stroke-width="3" stroke-linecap="round" />
        <line x1="92" y1="80" x2="92" y2="80" stroke="${visor}" stroke-width="3" stroke-linecap="round" />
      `;
      break;
    case 'reviewing':
      stateIndicator = `
        <circle cx="80" cy="80" r="6" stroke="${visor}" stroke-width="2" fill="none" />
        <line x1="84" y1="84" x2="89" y2="89" stroke="${visor}" stroke-width="2" stroke-linecap="round" />
      `;
      break;
    case 'alert':
      expressionBadge = `
        <polygon points="120,40 128,54 112,54" fill="${visor}" stroke="var(--vscode-editor-background, #1e1e1e)" stroke-width="1.5" />
        <text x="120" y="52" fill="#fff" font-size="9" font-weight="bold" text-anchor="middle">!</text>
      `;
      stateIndicator = `
        <line x1="72" y1="76" x2="88" y2="84" stroke="${visor}" stroke-width="2.5" stroke-linecap="round" />
        <line x1="72" y1="84" x2="88" y2="76" stroke="${visor}" stroke-width="2.5" stroke-linecap="round" />
      `;
      break;
    case 'success':
      expressionBadge = `
        <circle cx="120" cy="45" r="8" fill="${visor}" stroke="var(--vscode-editor-background, #1e1e1e)" stroke-width="1.5" />
        <polyline points="116,45 119,48 125,42" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      `;
      stateIndicator = `
        <polyline points="72,80 78,85 88,75" fill="none" stroke="${visor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      `;
      break;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160" role="img" aria-label="Forge Avatar - ${cfg.title}">
  <defs>
    <filter id="glow-${state}" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
    <linearGradient id="body-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="var(--vscode-button-background, #0e639c)" />
      <stop offset="100%" stop-color="var(--vscode-sideBar-background, #181824)" />
    </linearGradient>
    <linearGradient id="metal-grad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#4a4d5e" />
      <stop offset="100%" stop-color="#222430" />
    </linearGradient>
    <linearGradient id="gold-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fbbf24" />
      <stop offset="100%" stop-color="#b45309" />
    </linearGradient>
  </defs>

  <!-- Ground Shadow -->
  <ellipse cx="80" cy="148" rx="45" ry="6" fill="rgba(0,0,0,0.25)" />

  <!-- Anvil Base (Left) -->
  <path d="M 28 142 L 48 142 L 45 130 L 31 130 Z" fill="url(#metal-grad)" />
  <path d="M 25 130 L 52 130 L 48 122 L 28 122 Z" fill="#383a48" />
  <path d="M 20 122 L 54 122 L 51 116 L 24 116 Z" fill="#4f5263" />
  <polygon points="20,116 14,119 20,122" fill="#3a3c4a" />

  <!-- Torso & Shoulders -->
  <rect x="58" y="98" width="44" height="40" rx="6" fill="url(#body-grad)" stroke="var(--vscode-panel-border, #3a3f58)" stroke-width="1.5" />
  <!-- Chest Core Plate -->
  <circle cx="80" cy="116" r="8" fill="#1b1c26" stroke="${visor}" stroke-width="1.5" />
  <circle cx="80" cy="116" r="4" fill="${visor}" opacity="0.8" filter="url(#glow-${state})" />

  <!-- Neck -->
  <rect x="74" y="92" width="12" height="8" rx="2" fill="#2d303e" />

  <!-- Left Arm (Resting on Anvil) -->
  <path d="M 58 104 Q 42 110 38 120" stroke="url(#metal-grad)" stroke-width="6" stroke-linecap="round" fill="none" />

  <!-- Right Arm & Hammer (Raised/Ready) -->
  ${state === 'success'
    ? `<!-- Raised Hammer -->
       <path d="M 102 104 Q 116 92 120 74" stroke="url(#metal-grad)" stroke-width="6" stroke-linecap="round" fill="none" />
       <!-- Hammer Handle -->
       <line x1="114" y1="80" x2="132" y2="52" stroke="#a16207" stroke-width="3" stroke-linecap="round" />
       <!-- Hammer Head -->
       <polygon points="126,56 138,48 134,42 122,50" fill="url(#metal-grad)" stroke="#6b7280" stroke-width="1" />`
    : `<!-- Normal/Working Hammer Pose -->
       <path d="M 102 104 Q 118 116 110 132" stroke="url(#metal-grad)" stroke-width="6" stroke-linecap="round" fill="none" />
       <!-- Hammer Handle -->
       <line x1="108" y1="126" x2="94" y2="136" stroke="#a16207" stroke-width="3" stroke-linecap="round" />
       <!-- Hammer Head -->
       <rect x="88" y="132" width="8" height="12" rx="1" transform="rotate(-30 92 138)" fill="url(#metal-grad)" stroke="#6b7280" stroke-width="1" />`}

  <!-- Head Frame -->
  <rect x="52" y="58" width="56" height="38" rx="8" fill="#282a36" stroke="var(--vscode-focusBorder, #007acc)" stroke-width="1.5" />
  <!-- Ear Antenna Exhausts -->
  <rect x="46" y="68" width="6" height="14" rx="2" fill="#3f4254" />
  <rect x="108" y="68" width="6" height="14" rx="2" fill="#3f4254" />

  <!-- Visor Housing -->
  <rect x="58" y="68" width="44" height="18" rx="4" fill="#0f1015" />
  <!-- Glowing Visor Face -->
  <rect x="60" y="70" width="40" height="14" rx="3" fill="${visor}" opacity="0.3" />
  <rect x="62" y="72" width="36" height="10" rx="2" fill="${visor}" opacity="0.9" filter="url(#glow-${state})" />

  <!-- State Indicator Inside Visor -->
  ${stateIndicator}

  <!-- External State Badge (if any) -->
  ${expressionBadge}
</svg>`;
}
