export type ForgeThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeColors {
  bg: string;
  fg: string;
  sidebarBg: string;
  widgetBg: string;
  widgetFg: string;
  border: string;
  inputBg: string;
  inputFg: string;
  inputBorder: string;
  focusBorder: string;
  buttonBg: string;
  buttonFg: string;
  descFg: string;
  userMsgBg: string;
  userMsgFg: string;
  agentMsgBg: string;
  agentMsgFg: string;
  toolMsgBg: string;
  noticeBg: string;
  errorBg: string;
  errorFg: string;
  warningFg: string;
  successFg: string;
  characterBody: string;
  characterHead: string;
  characterJoint: string;
  characterHammer: string;
}

/** WCAG relative luminance computation from hex color */
export function getLuminance(hex: string): number {
  const sanitized = hex.replace('#', '').trim();
  const r = parseInt(sanitized.slice(0, 2), 16) / 255;
  const g = parseInt(sanitized.slice(2, 4), 16) / 255;
  const b = parseInt(sanitized.slice(4, 6), 16) / 255;

  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const rLin = toLinear(r);
  const gLin = toLinear(g);
  const bLin = toLinear(b);

  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/** WCAG contrast ratio between two hex colors (e.g. 4.5:1 -> 4.5) */
export function getContrastRatio(fgHex: string, bgHex: string): number {
  const l1 = getLuminance(fgHex);
  const l2 = getLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export const LIGHT_THEME: ThemeColors = {
  bg: '#f8f9fa',
  fg: '#1f2328', // 13.9:1 against #f8f9fa
  sidebarBg: '#f0f2f5',
  widgetBg: '#ffffff',
  widgetFg: '#1f2328',
  border: '#d0d7de',
  inputBg: '#ffffff',
  inputFg: '#1f2328',
  inputBorder: '#d0d7de',
  focusBorder: '#0969da',
  buttonBg: '#0969da',
  buttonFg: '#ffffff',
  descFg: '#57606a', // 5.2:1 against #f8f9fa
  userMsgBg: '#0969da',
  userMsgFg: '#ffffff',
  agentMsgBg: '#ffffff',
  agentMsgFg: '#1f2328',
  toolMsgBg: '#eaeff5',
  noticeBg: '#ddf4ff',
  errorBg: '#ffebe9',
  errorFg: '#cf222e',
  warningFg: '#9a6700',
  successFg: '#1a7f37',
  characterBody: '#e2e8f0',
  characterHead: '#cbd5e1',
  characterJoint: '#94a3b8',
  characterHammer: '#475569',
};

export const DARK_THEME: ThemeColors = {
  bg: '#0b0b0c', // near-black surface
  fg: '#ededed', // 16.5:1 against #0b0b0c
  sidebarBg: '#111113',
  widgetBg: '#161618',
  widgetFg: '#ededed',
  border: '#2c2d30',
  inputBg: '#141416',
  inputFg: '#ededed',
  inputBorder: '#2c2d30',
  focusBorder: '#388bfd',
  buttonBg: '#1f6feb',
  buttonFg: '#ffffff',
  descFg: '#8b949e', // 5.4:1 against #0b0b0c
  userMsgBg: '#1f6feb',
  userMsgFg: '#ffffff',
  agentMsgBg: '#161618',
  agentMsgFg: '#ededed',
  toolMsgBg: '#1a1b1e',
  noticeBg: '#0c2d6b',
  errorBg: '#490202',
  errorFg: '#f85149',
  warningFg: '#d29922',
  successFg: '#3fb950',
  characterBody: '#222530',
  characterHead: '#1b1d26',
  characterJoint: '#383c4d',
  characterHammer: '#64748b',
};

export function resolveTheme(
  mode: ForgeThemeMode,
  bodyClassInput: string[] | string,
): { theme: ResolvedTheme; isHighContrast: boolean } {
  const classes = Array.isArray(bodyClassInput) ? bodyClassInput : (bodyClassInput || '').split(/\s+/);
  const isHighContrast = classes.some((c) => c === 'vscode-high-contrast' || c === 'vscode-high-contrast-light');

  if (isHighContrast) {
    // When high contrast is active, override is disabled
    const isLightHC = classes.includes('vscode-high-contrast-light');
    return { theme: isLightHC ? 'light' : 'dark', isHighContrast: true };
  }

  if (mode === 'light') {
    return { theme: 'light', isHighContrast: false };
  }
  if (mode === 'dark') {
    return { theme: 'dark', isHighContrast: false };
  }

  // Auto follows VS Code theme
  const isLight = classes.includes('vscode-light');
  return { theme: isLight ? 'light' : 'dark', isHighContrast: false };
}
