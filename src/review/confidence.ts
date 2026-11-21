import type { Hunk } from './hunks';

export interface ConfidenceScore {
  score: number; // 0..100
  tag: 'HIGH' | 'MEDIUM' | 'LOW';
  reasons: string[];
}

export function computeChangeConfidence(params: {
  oldText: string;
  newText: string;
  hunks: Hunk[];
  isNew: boolean;
}): ConfidenceScore {
  let score = 85;
  const reasons: string[] = [];

  const totalLinesChanged = params.hunks.reduce((acc, h) => {
    const remLines = h.removed ? h.removed.split('\n').length : 0;
    const addLines = h.added ? h.added.split('\n').length : 0;
    return acc + remLines + addLines;
  }, 0);

  if (params.isNew) {
    score -= 10;
    reasons.push('New file creation');
  } else if (totalLinesChanged <= 25) {
    score += 10;
    reasons.push('Small, surgical edit (<=25 lines changed)');
  } else if (totalLinesChanged > 150) {
    score -= 25;
    reasons.push('Large modification (>150 lines changed)');
  }

  // Bracket/parenthesis sanity check
  let curly = 0;
  let paren = 0;
  let square = 0;
  for (const ch of params.newText) {
    if (ch === '{') curly++; else if (ch === '}') curly--;
    if (ch === '(') paren++; else if (ch === ')') paren--;
    if (ch === '[') square++; else if (ch === ']') square--;
  }

  if (curly !== 0 || paren !== 0 || square !== 0) {
    score -= 30;
    reasons.push('Unbalanced brackets or parentheses');
  } else {
    reasons.push('Balanced delimiters');
  }

  if (params.hunks.length > 5) {
    score -= 10;
    reasons.push('Spread across multiple hunks (>5)');
  }

  score = Math.max(0, Math.min(100, score));
  const tag: 'HIGH' | 'MEDIUM' | 'LOW' = score >= 80 ? 'HIGH' : score >= 50 ? 'MEDIUM' : 'LOW';

  return { score, tag, reasons };
}
