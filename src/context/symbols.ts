export interface TopSymbol { name: string; line: number; signature: string }

const PY = /^(?:async\s+)?(?:def|class)\s+(\w+)/;
const JS = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|enum|type|const|let)\s+(\w+)/;
const GENERIC = /^(?:pub\s+)?(?:fn|func|struct|impl|trait|def|class)\s+(\w+)/;

/**
 * Top-level (column 0) symbols by regex. Used when no language server answers (e.g. Python without
 * the Python extension) and as the cheap path for ranking; one line each, so cheap to pack.
 */
export function topLevelSymbols(text: string, filePath: string): TopSymbol[] {
  const re = filePath.endsWith('.py') ? PY : /\.(?:[cm]?[jt]sx?)$/.test(filePath) ? JS : GENERIC;
  const out: TopSymbol[] = [];
  text.split('\n').forEach((line, i) => {
    const m = re.exec(line);
    if (m?.[1]) out.push({ name: m[1], line: i + 1, signature: line.replace(/\s*[{:]\s*$/, '').trim().slice(0, 160) });
  });
  return out;
}

export interface OutlineEntry {
  name: string;
  kind: string;
  line: number;
}

/**
 * Extracts top-level and class-level definitions (functions, classes, methods, interfaces, etc.)
 * from file text using regex-based extraction.
 */
export function extractOutline(text: string, filePath: string): OutlineEntry[] {
  const isPy = filePath.endsWith('.py');
  const isJs = /\.(?:[cm]?[jt]sx?)$/.test(filePath);
  const lines = text.split('\n');
  const out: OutlineEntry[] = [];

  if (isPy) {
    let inClass = false;
    let classIndent = 0;
    let methodIndent: number | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
      if (indent === 0) {
        const topMatch = /^(?:async\s+)?(def|class)\s+(\w+)/.exec(line);
        if (topMatch?.[1] && topMatch[2]) {
          const kind = topMatch[1];
          const name = topMatch[2];
          inClass = (kind === 'class');
          classIndent = 0;
          methodIndent = null;
          out.push({ name, kind, line: i + 1 });
        } else {
          inClass = false;
          methodIndent = null;
        }
      } else if (inClass && indent > classIndent) {
        const m = /^[ \t]+(?:async\s+)?(def|class)\s+(\w+)/.exec(line);
        if (m?.[1] && m[2]) {
          if (methodIndent === null) {
            methodIndent = indent;
          }
          if (indent === methodIndent) {
            out.push({ name: m[2], kind: m[1], line: i + 1 });
          }
        }
      }
    }
  } else if (isJs) {
    let braceDepth = 0;
    let classBraceDepth = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;

      if (braceDepth === 0) {
        const topMatch = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|enum|type|const|let)\s+(\w+)/.exec(trimmed);
        if (topMatch?.[1] && topMatch[2]) {
          out.push({ name: topMatch[2], kind: topMatch[1], line: i + 1 });
          if (topMatch[1] === 'class') {
            classBraceDepth = braceDepth + (line.includes('{') ? 1 : 0);
          }
        }
      } else if (classBraceDepth === braceDepth) {
        const memberMatch = /^(?:(?:public|private|protected|static|readonly|abstract|async|override)\s+)*(?:(?:get|set)\s+)?(\w+)\s*(?:\([^)]*\)|:)/.exec(trimmed);
        if (memberMatch?.[1] && !['if', 'for', 'while', 'switch', 'catch'].includes(memberMatch[1])) {
          out.push({ name: memberMatch[1], kind: memberMatch[1] === 'constructor' ? 'constructor' : 'method', line: i + 1 });
        }
      }

      for (const char of line) {
        if (char === '{') braceDepth++;
        else if (char === '}') {
          if (braceDepth === classBraceDepth) classBraceDepth = -1;
          braceDepth--;
        }
      }
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = /^\s*(?:pub\s+)?(?:async\s+)?(fn|func|struct|impl|trait|def|class)\s+(\w+)/.exec(line);
      if (m?.[1] && m[2]) out.push({ name: m[2], kind: m[1], line: i + 1 });
    }
  }
  return out;
}
