// The spreadsheet model of 7GUIs Cells, shared by the framework versions:
// formulas, their evaluation and change propagation.
//
// A formula is empty, a number (`3`, `-1.5`, `1e3`), text, or `=` followed by
// an expression: numbers, cell references (`A1`, `b12`), `+ - * /`, unary
// minus, parentheses and functions over values and ranges (`sum(A1:B3)`,
// `prod`, `avg`, `min`, `max`, `count`). Errors show as a marker: `#ERROR!`
// (syntax), `#NAME?` (unknown function or reference), `#VALUE!` (text in
// arithmetic), `#DIV/0!` and `#CYCLE!` (a cell on or behind a cycle of
// references). A cell reading an error shows that error.
//
// Differences from the 7GUIs task (https://eugenkiss.github.io/7guis/tasks):
// every cell is a text input showing its value, so a click (rather than a
// double click) or Tab edits the formula in place; Enter or leaving the
// cell commits it. The full grid (A–Z, 0–99) is rendered.

export const COLUMNS = 26;
export const ROWS = 100;

export type Kind = 'empty' | 'number' | 'text' | 'error';

export interface Cell {
  formula: string;
  kind: Kind;
  num: number;
  /** The text of a text cell, or the marker of an error. */
  text: string;
  /** The cells the formula reads, once each (ranges expanded). */
  refs: number[];
}

/** The numbers 0 to n - 1. */
const count = (n: number): number[] =>
  '.'
    .repeat(n)
    .split('')
    .map((_, i) => i);

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const columns: number[] = count(COLUMNS);
export const rows: number[] = count(ROWS);
export const columnName = (c: number): string => LETTERS.charAt(c);
export const cellName = (index: number): string =>
  columnName(index % COLUMNS) + String(Math.floor(index / COLUMNS));

export function emptySheet(): Cell[] {
  return count(COLUMNS * ROWS).map((): Cell => ({
    formula: '',
    kind: 'empty',
    num: 0,
    text: '',
    refs: [],
  }));
}

/** The text a cell shows. */
export function display(cell: Cell): string {
  if (cell.kind === 'number') return String(cell.num);
  return cell.text;
}

interface Parser {
  src: string;
  pos: number;
  cells: Cell[];
  /** The cells read so far. */
  refs: Set<number>;
  /** The first error, or empty. */
  error: string;
}

function fail(p: Parser, error: string): number {
  if (p.error === '') p.error = error;
  return 0;
}

/** The next character after spaces, or empty at the end. */
function peek(p: Parser): string {
  while (p.src.charAt(p.pos) === ' ') p.pos += 1;
  return p.src.charAt(p.pos);
}

const isDigit = (c: string): boolean => c !== '' && c >= '0' && c <= '9';
const isLetter = (c: string): boolean =>
  c !== '' && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'));

/** A cell reference at the parser's position (advancing past it), or -1. */
function reference(p: Parser): number {
  peek(p);
  const start = p.pos;
  const letter = p.src.charAt(start).toUpperCase();
  let end = start + 1;
  while (isDigit(p.src.charAt(end))) end += 1;
  if (!isLetter(letter) || end === start + 1 || end > start + 3 || isLetter(p.src.charAt(end)))
    return -1;
  p.pos = end;
  const row = Number(p.src.slice(start + 1, end));
  return row * COLUMNS + LETTERS.indexOf(letter);
}

/** The value of a referenced cell in arithmetic (an empty cell is 0). */
function read(p: Parser, index: number): number {
  p.refs.add(index);
  const cell = p.cells[index];
  if (cell.kind === 'error') return fail(p, cell.text);
  if (cell.kind === 'text') return fail(p, '#VALUE!');
  return cell.num;
}

function expression(p: Parser): number {
  let value = term(p);
  for (;;) {
    const c = peek(p);
    if (c === '+') {
      p.pos += 1;
      value = value + term(p);
    } else if (c === '-') {
      p.pos += 1;
      value = value - term(p);
    } else return value;
  }
}

function term(p: Parser): number {
  let value = factor(p);
  for (;;) {
    const c = peek(p);
    if (c === '*') {
      p.pos += 1;
      value = value * factor(p);
    } else if (c === '/') {
      p.pos += 1;
      const divisor = factor(p);
      if (divisor === 0) return fail(p, '#DIV/0!');
      value = value / divisor;
    } else return value;
  }
}

function factor(p: Parser): number {
  const c = peek(p);
  if (c === '-') {
    p.pos += 1;
    return -factor(p);
  }
  if (c === '(') {
    p.pos += 1;
    const value = expression(p);
    if (peek(p) !== ')') return fail(p, '#ERROR!');
    p.pos += 1;
    return value;
  }
  if (isDigit(c) || c === '.') {
    const start = p.pos;
    while (isDigit(p.src.charAt(p.pos))) p.pos += 1;
    if (p.src.charAt(p.pos) === '.') p.pos += 1;
    while (isDigit(p.src.charAt(p.pos))) p.pos += 1;
    const value = Number(p.src.slice(start, p.pos));
    return Number.isNaN(value) ? fail(p, '#ERROR!') : value;
  }
  if (isLetter(c)) {
    const start = p.pos;
    while (isLetter(p.src.charAt(p.pos))) p.pos += 1;
    const name = p.src.slice(start, p.pos).toLowerCase();
    if (peek(p) === '(') {
      p.pos += 1;
      return call(p, name);
    }
    p.pos = start;
    const index = reference(p);
    if (index < 0) {
      while (isLetter(p.src.charAt(p.pos)) || isDigit(p.src.charAt(p.pos))) p.pos += 1;
      return fail(p, '#NAME?');
    }
    return read(p, index);
  }
  return fail(p, '#ERROR!');
}

/** A function of its arguments: values, and ranges (`A1:B3`) expanded. */
function call(p: Parser, name: string): number {
  const values: number[] = [];
  if (peek(p) === ')') p.pos += 1;
  else
    for (;;) {
      const start = p.pos;
      const from = reference(p);
      if (from >= 0 && peek(p) === ':') {
        p.pos += 1;
        const to = reference(p);
        if (to < 0) return fail(p, '#ERROR!');
        for (const v of range(p, from, to)) values.push(v);
      } else {
        p.pos = start;
        values.push(expression(p));
      }
      const c = peek(p);
      p.pos += 1;
      if (c === ')') break;
      if (c !== ',') return fail(p, '#ERROR!');
    }
  if (name === 'sum') return values.reduce((a, b) => a + b, 0);
  if (name === 'prod') return values.reduce((a, b) => a * b, 1);
  if (name === 'count') return values.length;
  if (name === 'avg')
    return values.length === 0
      ? fail(p, '#DIV/0!')
      : values.reduce((a, b) => a + b, 0) / values.length;
  if (name === 'min') return values.reduce((a, b) => Math.min(a, b), Infinity);
  if (name === 'max') return values.reduce((a, b) => Math.max(a, b), -Infinity);
  return fail(p, '#NAME?');
}

/** The numbers in a rectangle of cells (empty and text cells are skipped). */
function range(p: Parser, from: number, to: number): number[] {
  const out: number[] = [];
  const top = Math.min(Math.floor(from / COLUMNS), Math.floor(to / COLUMNS));
  const bottom = Math.max(Math.floor(from / COLUMNS), Math.floor(to / COLUMNS));
  const left = Math.min(from % COLUMNS, to % COLUMNS);
  const right = Math.max(from % COLUMNS, to % COLUMNS);
  for (let r = top; r <= bottom; r++)
    for (let c = left; c <= right; c++) {
      const index = r * COLUMNS + c;
      p.refs.add(index);
      const cell = p.cells[index];
      if (cell.kind === 'error') fail(p, cell.text);
      else if (cell.kind === 'number') out.push(cell.num);
    }
  return out;
}

/** A cell holding `formula`, evaluated against the current values of `cells`. */
function evaluate(cells: Cell[], formula: string): Cell {
  const p: Parser = { src: formula, pos: 1, cells, refs: new Set<number>(), error: '' };
  if (formula.trim() === '') return { formula, kind: 'empty', num: 0, text: '', refs: [] };
  if (formula.charAt(0) !== '=') {
    const num = Number(formula);
    if (Number.isNaN(num)) return { formula, kind: 'text', num: 0, text: formula, refs: [] };
    return { formula, kind: 'number', num, text: '', refs: [] };
  }
  const num = expression(p);
  if (peek(p) !== '') fail(p, '#ERROR!');
  const refs = Array.from(p.refs);
  if (p.error !== '') return { formula, kind: 'error', num: 0, text: p.error, refs };
  return { formula, kind: 'number', num, text: '', refs };
}

const same = (a: Cell, b: Cell): boolean =>
  a.kind === b.kind &&
  (a.num === b.num || (Number.isNaN(a.num) && Number.isNaN(b.num))) &&
  a.text === b.text;

/**
 * The sheet after cell `index` gets `formula`. The cell is evaluated, then
 * the cells depending on it, each after the cells it reads and only when one
 * of those changed its value (change propagation; the rest of the sheet is
 * not evaluated). Cells on a cycle of references, or depending on one,
 * become `#CYCLE!`. The result is a new array; unchanged cells keep their
 * identity.
 */
export function commit(cells: Cell[], index: number, formula: string): Cell[] {
  const next = cells.slice();
  next[index] = evaluate(next, formula);
  // Who reads whom.
  const dependents = new Map<number, Set<number>>();
  next.forEach((cell, i) => {
    for (const r of cell.refs) {
      const readers = dependents.get(r);
      if (readers === undefined) dependents.set(r, new Set<number>().add(i));
      else readers.add(i);
    }
  });
  const none = new Set<number>();
  // The cells reachable from the edited one.
  const affected = new Set<number>();
  affected.add(index);
  const queue = [index];
  while (queue.length > 0) {
    const i = queue.shift() ?? index;
    for (const d of dependents.get(i) ?? none)
      if (!affected.has(d)) {
        affected.add(d);
        queue.push(d);
      }
  }
  // Kahn's order over the affected cells: a cell is ready when the affected
  // cells it reads are done.
  const waiting = new Map<number, number>();
  for (const i of affected) waiting.set(i, next[i].refs.filter(r => affected.has(r)).length);
  const ready: number[] = [];
  for (const i of affected) if (waiting.get(i) === 0) ready.push(i);
  const changed = new Set<number>();
  while (ready.length > 0) {
    const i = ready.shift() ?? index;
    waiting.delete(i);
    if (i === index || next[i].refs.some(r => changed.has(r))) {
      next[i] = evaluate(next, next[i].formula);
      if (i === index || !same(cells[i], next[i])) changed.add(i);
    }
    for (const d of dependents.get(i) ?? none) {
      const n = waiting.get(d);
      if (n !== undefined) {
        waiting.set(d, n - 1);
        if (n === 1) ready.push(d);
      }
    }
  }
  // What is still waiting is on a cycle or behind one.
  for (const i of affected)
    if (waiting.has(i)) {
      const cell = next[i];
      next[i] = { formula: cell.formula, kind: 'error', num: 0, text: '#CYCLE!', refs: cell.refs };
    }
  return next;
}
