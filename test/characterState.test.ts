import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, def: unknown) => def,
    }),
  },
}));

import {
  mapEventToState,
  getStateAriaAnnouncement,
  redactCharacterSpeech,
  STATE_CONFIGS,
  type CharacterState,
} from '../src/panel/character/characterState';
import { renderCharacterSvg } from '../src/panel/character/characterSvg';
import { getConfig } from '../src/config';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Forge Character State Machine & Safety', () => {
  it('is off by default in configuration', () => {
    const cfg = getConfig();
    expect(cfg.guideCharacter3d).toBe(false);

    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const prop = pkg.contributes.configuration.properties['forge.guide.character3d'];
    expect(prop).toBeDefined();
    expect(prop.type).toBe('boolean');
    expect(prop.default).toBe(false);
  });

  it('maps tool execution events correctly to thinking or reviewing', () => {
    expect(mapEventToState({ type: 'tool', name: 'read_file' }, 'idle')).toBe('thinking');
    expect(mapEventToState({ type: 'tool', name: 'search_workspace' }, 'idle')).toBe('thinking');
    expect(mapEventToState({ type: 'tool', name: 'list_dir' }, 'idle')).toBe('thinking');
    expect(mapEventToState({ type: 'tool', name: 'run_tests' }, 'idle')).toBe('thinking');

    expect(mapEventToState({ type: 'tool', name: 'propose_write' }, 'thinking')).toBe('reviewing');
    expect(mapEventToState({ type: 'tool', name: 'propose_changes' }, 'thinking')).toBe('reviewing');
  });

  it('maps diffPreview events to reviewing', () => {
    expect(mapEventToState({ type: 'diffPreview', text: 'src/flask/cli.py' }, 'thinking')).toBe('reviewing');
  });

  it('maps streaming deltas to speaking', () => {
    expect(mapEventToState({ type: 'delta', text: 'hello' }, 'idle')).toBe('speaking');
    expect(mapEventToState({ type: 'delta', text: 'world' }, 'thinking')).toBe('speaking');
  });

  it('maps notices (failover, error, success) correctly', () => {
    expect(mapEventToState({ type: 'notice', text: 'Primary unavailable, using fallback' }, 'thinking')).toBe('alert');
    expect(mapEventToState({ type: 'notice', text: 'Circuit breaker tripped' }, 'idle')).toBe('alert');
    expect(mapEventToState({ type: 'notice', text: 'Changes applied successfully' }, 'reviewing')).toBe('success');
  });

  it('maps done events according to terminal status', () => {
    expect(mapEventToState({ type: 'done', status: 'ok' }, 'speaking')).toBe('success');
    expect(mapEventToState({ type: 'done', status: 'error' }, 'thinking')).toBe('alert');
    expect(mapEventToState({ type: 'done', status: 'cancelled' }, 'thinking')).toBe('idle');
  });

  it('maps explicit mic events to listening, but inputFocus does not trigger listening', () => {
    // FIX: inputFocus must NOT trigger listening
    expect(mapEventToState({ type: 'inputFocus' }, 'idle')).toBe('idle');
    // Explicit micActive triggers listening
    expect(mapEventToState({ type: 'micActive' }, 'idle')).toBe('listening');
    expect(mapEventToState({ type: 'micInactive' }, 'listening')).toBe('idle');
  });

  it('handles busy toggling between idle and thinking', () => {
    expect(mapEventToState({ type: 'busy', value: true }, 'idle')).toBe('thinking');
    expect(mapEventToState({ type: 'busy', value: false }, 'thinking')).toBe('idle');
    expect(mapEventToState({ type: 'busy', value: false }, 'reviewing')).toBe('reviewing');
    expect(mapEventToState({ type: 'busy', value: false }, 'alert')).toBe('alert');
  });

  it('redacts secret files and paths from character speech bubbles', () => {
    const raw = 'Reading config from .env and checking id_rsa.pub and certs/server.key and cert.pem and .git/config';
    const scrubbed = redactCharacterSpeech(raw);

    expect(scrubbed).not.toContain('.env');
    expect(scrubbed).not.toContain('id_rsa');
    expect(scrubbed).not.toContain('server.key');
    expect(scrubbed).not.toContain('cert.pem');
    expect(scrubbed).not.toContain('.git');
    expect(scrubbed).toContain('[REDACTED_SECRET_FILE]');
    expect(scrubbed).toContain('Reading config from');
  });

  it('preserves legitimate non-secret text and filenames in speech bubbles', () => {
    const text = 'Editing helpers.py and adding flask config CLI';
    expect(redactCharacterSpeech(text)).toBe(text);
  });

  it('provides distinct, accessible aria-live announcements for all 7 states', () => {
    const states: CharacterState[] = [
      'idle',
      'listening',
      'thinking',
      'speaking',
      'reviewing',
      'alert',
      'success',
    ];

    const announcements = new Set<string>();
    for (const st of states) {
      const msg = getStateAriaAnnouncement(st);
      expect(msg.length).toBeGreaterThan(10);
      expect(announcements.has(msg)).toBe(false);
      announcements.add(msg);
    }
    expect(announcements.size).toBe(7);
  });

  it('renders valid 2D SVG avatar fallback with state-specific indicators for all 7 states', () => {
    const states: CharacterState[] = [
      'idle',
      'listening',
      'thinking',
      'speaking',
      'reviewing',
      'alert',
      'success',
    ];

    for (const st of states) {
      const svg = renderCharacterSvg(st);
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
      expect(svg).toContain('viewBox="0 0 160 160"');
      expect(svg).toContain(STATE_CONFIGS[st].visorColor);
      expect(svg).toContain(`aria-label="Forge Avatar - ${STATE_CONFIGS[st].title}"`);
    }
  });
});
