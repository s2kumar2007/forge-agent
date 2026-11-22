import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Webview and ChatPanel assets', () => {
  it('main.css contains all required native VS Code variables, status indicator, timeline, and chips', () => {
    const cssPath = path.join(__dirname, '..', 'media', 'main.css');
    const css = fs.readFileSync(cssPath, 'utf8');

    expect(css).toContain('var(--vscode-font-family)');
    expect(css).toContain('.status-dot.healthy');
    expect(css).toContain('.status-dot.fallback');
    expect(css).toContain('.status-dot.error');
    expect(css).toContain('.timeline');
    expect(css).toContain('.timeline-step.active');
    expect(css).toContain('#token-bar-track');
    expect(css).toContain('#token-bar-fill');
    expect(css).toContain('.chip');
    expect(css).toContain('.copy-btn');
    expect(css).toContain('.confidence-tag.high');
    expect(css).toContain('.confidence-tag.medium');
    expect(css).toContain('.confidence-tag.low');
  });

  it('main.js handles message types for timeline progression, streaming preview, token bar, and copy buttons', () => {
    const jsPath = path.join(__dirname, '..', 'media', 'main.js');
    const js = fs.readFileSync(jsPath, 'utf8');

    expect(js).toContain("setTimelineStep('context')");
    expect(js).toContain("setTimelineStep('model')");
    expect(js).toContain("setTimelineStep('tools')");
    expect(js).toContain("setTimelineStep('review')");
    expect(js).toContain("setTimelineStep('done')");
    expect(js).toContain('updateTokenBar');
    expect(js).toContain('attachCopyButton');
    expect(js).toContain('diffPreview');
    expect(js).toContain('confidence-tag');
  });
});
