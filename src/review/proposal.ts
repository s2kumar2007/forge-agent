import { normalizeEol } from './hunks';

function lineSimilarity(a: string, b: string): number {
  const ta = a.trim();
  const tb = b.trim();
  if (!ta && !tb) return 1;
  if (!ta || !tb) return 0;
  if (ta === tb) return 2.0;
  if (ta.includes(tb) || tb.includes(ta)) return 1.5;
  const wordsA = new Set(ta.split(/\W+/).filter(Boolean));
  const wordsB = new Set(tb.split(/\W+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return common / (wordsA.size + wordsB.size - common);
}

export function findClosestCandidateLines(cLines: string[], nLines: string[]): string[] {
  if (cLines.length === 0) return [];
  const maxLines = Math.min(5, Math.min(cLines.length, Math.max(1, nLines.length)));
  let bestScore = -1;
  let bestIndex = 0;

  for (let i = 0; i <= cLines.length - maxLines; i++) {
    let score = 0;
    for (let j = 0; j < maxLines; j++) {
      score += lineSimilarity(cLines[i + j] ?? '', nLines[j] ?? '');
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return cLines.slice(bestIndex, bestIndex + maxLines);
}

function zeroMatchError(cLines: string[], nLines: string[]): Error {
  const closest = findClosestCandidateLines(cLines, nLines);
  const snippet = closest.length > 0 ? closest.join('\n') : '(empty file)';
  return new Error(`Exact edit text matched zero times. Closest candidate lines:\n${snippet}`);
}

function severalMatchError(count: number): Error {
  return new Error(`Exact edit text matched several times (${count} occurrences); include a larger unique anchor.`);
}

/** Builds a candidate only; the normal review permit still controls every write. */
export function materializeWrite(existing: string | undefined, args: Record<string, unknown>): string {
  const full = args.new_content !== undefined ? args.new_content : args.newContent;
  const isFull = full !== undefined;
  const isLineRange = args.startLine !== undefined && args.endLine !== undefined;
  const isSearchReplace = args.search !== undefined || (args.old_text !== undefined && args.edits === undefined);
  const isEdits = args.edits !== undefined;

  const modeCount = (isFull ? 1 : 0) + (isLineRange ? 1 : 0) + (isSearchReplace ? 1 : 0) + (isEdits ? 1 : 0);
  if (modeCount !== 1) {
    throw new Error('Provide exactly one edit mode: new_content, edits, search/replace, or line range.');
  }

  if (isFull) {
    if (typeof full !== 'string') throw new Error('new_content must be a string.');
    return full;
  }

  if (existing === undefined) {
    throw new Error('Exact edits require an existing file; use new_content to create one.');
  }

  if (isLineRange) {
    const start = Number(args.startLine);
    const end = Number(args.endLine);
    const rep = String(args.newText ?? args.new_text ?? '');
    const lines = existing.split(/\r?\n/);
    if (isNaN(start) || isNaN(end) || start < 1 || start > lines.length + 1 || end < start - 1 || end > lines.length) {
      throw new Error(`Invalid line range: lines ${start}-${end} out of bounds (file has ${lines.length} lines).`);
    }
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    const repLines = rep.length > 0 ? rep.split(/\r?\n/) : [];
    lines.splice(start - 1, end - start + 1, ...repLines);
    return lines.join(eol);
  }

  let editsList: any[];
  if (isSearchReplace) {
    const search = args.search !== undefined ? args.search : args.old_text;
    const replace = args.replace !== undefined ? args.replace : (args.new_text ?? '');
    editsList = [{ old_text: search, new_text: replace }];
  } else {
    if (!Array.isArray(args.edits) || args.edits.length === 0 || args.edits.length > 20) {
      throw new Error('Provide between 1 and 20 exact edits.');
    }
    editsList = args.edits;
  }

  let candidate = existing;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';

  for (const edit of editsList) {
    if (typeof edit !== 'object' || edit === null) {
      throw new Error('Each edit must be an object.');
    }
    if (edit.startLine !== undefined && edit.endLine !== undefined) {
      const start = Number(edit.startLine);
      const end = Number(edit.endLine);
      const rep = String(edit.newText ?? edit.new_text ?? '');
      const cLines = candidate.split(/\r?\n/);
      if (isNaN(start) || isNaN(end) || start < 1 || start > cLines.length + 1 || end < start - 1 || end > cLines.length) {
        throw new Error(`Invalid line range: lines ${start}-${end} out of bounds.`);
      }
      const repLines = rep.length > 0 ? rep.split(/\r?\n/) : [];
      cLines.splice(start - 1, end - start + 1, ...repLines);
      candidate = cLines.join(eol);
      continue;
    }

    const oldText = edit.search !== undefined ? edit.search : edit.old_text;
    const newText = edit.replace !== undefined ? edit.replace : edit.new_text;

    if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') {
      throw new Error('Each edit requires nonempty old_text and string new_text.');
    }

    const needle = normalizeEol(existing, oldText);
    const replacement = normalizeEol(existing, newText);

    // 1. Direct exact substring match
    let exactCount = 0;
    let pos = candidate.indexOf(needle);
    while (pos !== -1) {
      exactCount++;
      pos = candidate.indexOf(needle, pos + 1);
    }
    if (exactCount === 1) {
      const first = candidate.indexOf(needle);
      candidate = candidate.slice(0, first) + replacement + candidate.slice(first + needle.length);
      continue;
    }
    if (exactCount > 1) {
      throw severalMatchError(exactCount);
    }

    // 2. Line-trimmed contiguous match fallback
    const cLines = candidate.split(/\r?\n/);
    const nRawLines = needle.split(/\r?\n/);
    const nLines = (nRawLines.length > 1 && nRawLines[nRawLines.length - 1] === '')
      ? nRawLines.slice(0, -1)
      : nRawLines;

    const trimmedN = nLines.map(l => l.trim());
    if (trimmedN.every(l => l.length === 0)) {
      throw zeroMatchError(cLines, nLines);
    }

    const matches: number[] = [];
    for (let i = 0; i <= cLines.length - trimmedN.length; i++) {
      let match = true;
      for (let j = 0; j < trimmedN.length; j++) {
        if ((cLines[i + j] ?? '').trim() !== trimmedN[j]) {
          match = false;
          break;
        }
      }
      if (match) matches.push(i);
    }

    if (matches.length === 0 && trimmedN.length === 1 && (trimmedN[0]?.length ?? 0) >= 10) {
      const prefix = trimmedN[0]!.slice(0, 25);
      for (let i = 0; i < cLines.length; i++) {
        if ((cLines[i] ?? '').trim().startsWith(prefix)) matches.push(i);
      }
    }

    if (matches.length === 0) {
      throw zeroMatchError(cLines, nLines);
    }
    if (matches.length > 1) {
      throw severalMatchError(matches.length);
    }

    const startLine = matches[0]!;
    const matchLineCount = trimmedN.length;

    const candIndentMatch = (cLines[startLine] ?? '').match(/^[ \t]*/);
    const candIndent = candIndentMatch ? candIndentMatch[0] : '';
    const needleIndentMatch = (nLines[0] ?? '').match(/^[ \t]*/);
    const needleIndent = needleIndentMatch ? needleIndentMatch[0] : '';

    const repRawLines = replacement.split(/\r?\n/);
    const repLines = (repRawLines.length > 1 && repRawLines[repRawLines.length - 1] === '')
      ? repRawLines.slice(0, -1)
      : repRawLines;

    let adjustedRepLines = repLines;
    if (candIndent.length > needleIndent.length) {
      const extra = candIndent.slice(needleIndent.length);
      adjustedRepLines = repLines.map(line => {
        if (!line.trim()) return line;
        return line.startsWith(candIndent) ? line : (extra + line);
      });
    }

    cLines.splice(startLine, matchLineCount, ...adjustedRepLines);
    candidate = cLines.join(eol);
  }

  return candidate;
}
