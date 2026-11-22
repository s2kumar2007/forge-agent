import { describe, it, expect, vi } from 'vitest';
import {
  resolveTheme,
  getLuminance,
  getContrastRatio,
  LIGHT_THEME,
  DARK_THEME,
} from '../src/panel/character/theme';
import { getConfig } from '../src/config';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, def: unknown) => def,
    }),
  },
}));

describe('Panel Theme Resolution & Contrast Verification', () => {
  it('has forge.panel.theme setting defaulting to auto in package.json and config', () => {
    const cfg = getConfig();
    expect(cfg.panelTheme).toBe('auto');

    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const prop = pkg.contributes.configuration.properties['forge.panel.theme'];
    expect(prop).toBeDefined();
    expect(prop.default).toBe('auto');
    expect(prop.enum).toEqual(['auto', 'light', 'dark']);
  });

  it('resolves Auto mode based on VS Code body classes', () => {
    expect(resolveTheme('auto', ['vscode-dark']).theme).toBe('dark');
    expect(resolveTheme('auto', ['vscode-light']).theme).toBe('light');
    expect(resolveTheme('auto', '').theme).toBe('dark'); // default dark fallback
  });

  it('forces light and dark themes regardless of VS Code theme when not high contrast', () => {
    expect(resolveTheme('light', ['vscode-dark']).theme).toBe('light');
    expect(resolveTheme('dark', ['vscode-light']).theme).toBe('dark');
  });

  it('disables overrides and flags isHighContrast when VS Code high contrast is active', () => {
    const resDarkHC = resolveTheme('light', ['vscode-high-contrast']);
    expect(resDarkHC.isHighContrast).toBe(true);
    expect(resDarkHC.theme).toBe('dark');

    const resLightHC = resolveTheme('dark', ['vscode-high-contrast-light']);
    expect(resLightHC.isHighContrast).toBe(true);
    expect(resLightHC.theme).toBe('light');
  });

  it('calculates WCAG relative luminance correctly', () => {
    expect(getLuminance('#000000')).toBeCloseTo(0, 4);
    expect(getLuminance('#ffffff')).toBeCloseTo(1, 4);
  });

  it('asserts Light (White) theme meets WCAG AA >= 4.5:1 text contrast and >= 3:1 UI borders', () => {
    // Primary foreground on surface
    const textRatio = getContrastRatio(LIGHT_THEME.fg, LIGHT_THEME.bg);
    expect(textRatio).toBeGreaterThanOrEqual(4.5);

    // Secondary / description text
    const descRatio = getContrastRatio(LIGHT_THEME.descFg, LIGHT_THEME.bg);
    expect(descRatio).toBeGreaterThanOrEqual(4.5);

    // Widget foreground on widget background
    const widgetTextRatio = getContrastRatio(LIGHT_THEME.widgetFg, LIGHT_THEME.widgetBg);
    expect(widgetTextRatio).toBeGreaterThanOrEqual(4.5);

    // Button foreground on button background
    const buttonTextRatio = getContrastRatio(LIGHT_THEME.buttonFg, LIGHT_THEME.buttonBg);
    expect(buttonTextRatio).toBeGreaterThanOrEqual(4.5);

    // UI Border contrast (focus border against surface >= 3:1)
    const focusRatio = getContrastRatio(LIGHT_THEME.focusBorder, LIGHT_THEME.bg);
    expect(focusRatio).toBeGreaterThanOrEqual(3.0);
  });

  it('asserts Dark (Black) theme meets WCAG AA >= 4.5:1 text contrast and >= 3:1 UI borders', () => {
    // Primary foreground on near-black surface (#0b0b0c)
    const textRatio = getContrastRatio(DARK_THEME.fg, DARK_THEME.bg);
    expect(textRatio).toBeGreaterThanOrEqual(4.5);

    // Secondary / description text on near-black surface
    const descRatio = getContrastRatio(DARK_THEME.descFg, DARK_THEME.bg);
    expect(descRatio).toBeGreaterThanOrEqual(4.5);

    // Widget text on widget background
    const widgetTextRatio = getContrastRatio(DARK_THEME.widgetFg, DARK_THEME.widgetBg);
    expect(widgetTextRatio).toBeGreaterThanOrEqual(4.5);

    // Button text on button background
    const buttonTextRatio = getContrastRatio(DARK_THEME.buttonFg, DARK_THEME.buttonBg);
    expect(buttonTextRatio).toBeGreaterThanOrEqual(4.5);

    // UI Border contrast (focus border against surface >= 3:1)
    const focusRatio = getContrastRatio(DARK_THEME.focusBorder, DARK_THEME.bg);
    expect(focusRatio).toBeGreaterThanOrEqual(3.0);
  });
});
