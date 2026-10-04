// Regular expression patterns: the facts the language layer needs about a
// pattern known at compile time (docs/IR.md, built-ins). The engine itself
// validates the pattern: V8 here, at compile time, and `regress` natively.

/** A pattern known at compile time. */
export interface RegexInfo {
  source: string;
  flags: string;
  /** The number of capture groups. */
  captures: number;
  /** Group names by capture index (1-based; index 0 is unused). */
  names: (string | undefined)[];
  /**
   * Whether capture `i` participates in every successful match (index 0,
   * the whole match, always does): it is not inside an alternative, a
   * group quantified with minimum 0 or a negative lookaround.
   */
  certain: boolean[];
}

/** The source and flags of a regular expression literal `/…/flags`. */
export function literalParts(text: string): { source: string; flags: string } {
  const end = text.lastIndexOf('/');
  return { source: text.slice(1, end), flags: text.slice(end + 1) };
}

/** The V8 syntax error of a pattern, or undefined when it is valid. */
export function syntaxError(source: string, flags: string): string | undefined {
  try {
    new RegExp(source, flags);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

interface Frame {
  parent?: Frame;
  /** Contains a `|` at its own level. */
  alternatives: boolean;
  /** Quantified with minimum 0, or a negative lookaround. */
  optional: boolean;
}

/** Captures, names and participation of a valid pattern. */
export function analyze(source: string, flags: string): RegexInfo {
  const root: Frame = { alternatives: false, optional: false };
  let frame = root;
  const groups: Frame[] = [];
  const names: (string | undefined)[] = [undefined];
  let i = 0;
  const quantifierMinZero = (at: number): boolean => {
    const c = source[at];
    if (c === '?' || c === '*') return true;
    if (c === '{') {
      const m = /^\{(\d+)(,\d*)?\}/.exec(source.slice(at));
      return !!m && Number(m[1]) === 0;
    }
    return false;
  };
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') {
      // A class: up to the first unescaped `]` after its first character.
      i++;
      if (source[i] === '^') i++;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '|') {
      frame.alternatives = true;
      i++;
      continue;
    }
    if (c === '(') {
      const next: Frame = { parent: frame, alternatives: false, optional: false };
      if (source[i + 1] !== '?') {
        groups.push(next);
        names.push(undefined);
        i++;
      } else if (source[i + 2] === '<' && source[i + 3] !== '=' && source[i + 3] !== '!') {
        const end = source.indexOf('>', i);
        groups.push(next);
        names.push(source.slice(i + 3, end));
        i = end + 1;
      } else {
        // (?: (?= (?! (?<= (?<! and modifiers (?i:…).
        next.optional = source[i + 2] === '!' || (source[i + 2] === '<' && source[i + 3] === '!');
        i += 2;
      }
      frame = next;
      continue;
    }
    if (c === ')') {
      const closed = frame;
      frame = frame.parent ?? root;
      i++;
      if (quantifierMinZero(i)) closed.optional = true;
      continue;
    }
    i++;
  }
  const certain = [true];
  for (const g of groups) {
    let ok = true;
    for (let f: Frame | undefined = g; f && f.parent; f = f.parent)
      if (f.optional || f.parent.alternatives) ok = false;
    certain.push(ok);
  }
  return { source, flags, captures: groups.length, names, certain };
}

/** Whether every capture of `info` participates in every match. */
export const allCertain = (info: RegexInfo) => info.certain.every(c => c);
