import { describe, it, expect } from 'vitest';
import { computeChangeConfidence } from '../src/review/confidence';
import type { Hunk } from '../src/review/hunks';

describe('computeChangeConfidence', () => {
  it('computes HIGH confidence for small, balanced edits', () => {
    const hunks: Hunk[] = [{
      id: 1,
      oldStart: 5,
      removed: 'val = 1;\n',
      added: 'val = 2;\n',
    }];

    const conf = computeChangeConfidence({
      oldText: 'val = 1;\n',
      newText: 'val = 2;\n',
      hunks,
      isNew: false,
    });

    expect(conf.tag).toBe('HIGH');
    expect(conf.score).toBeGreaterThanOrEqual(80);
    expect(conf.reasons).toContain('Small, surgical edit (<=25 lines changed)');
    expect(conf.reasons).toContain('Balanced delimiters');
  });

  it('computes LOW confidence when unbalanced brackets are introduced', () => {
    const hunks: Hunk[] = [{
      id: 1,
      oldStart: 1,
      removed: 'function test() {}\n',
      added: 'function test() { missing closing\n',
    }];

    const conf = computeChangeConfidence({
      oldText: 'function test() {}\n',
      newText: 'function test() { missing closing\n',
      hunks,
      isNew: false,
    });

    expect(conf.score).toBeLessThan(70);
    expect(conf.reasons).toContain('Unbalanced brackets or parentheses');
  });

  it('adjusts score for new file creation', () => {
    const hunks: Hunk[] = [{
      id: 1,
      oldStart: 1,
      removed: '',
      added: 'const x = 1;\n',
    }];

    const conf = computeChangeConfidence({
      oldText: '',
      newText: 'const x = 1;\n',
      hunks,
      isNew: true,
    });

    expect(conf.reasons).toContain('New file creation');
  });
});
