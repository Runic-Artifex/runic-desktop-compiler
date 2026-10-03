export const MODES = ['reverse', 'rotate-left', 'rotate-right', 'swap-ends', 'to-front', 'to-end', 'odd-first', 'interleave'];

/** The list after applying `mode`, triggered from item `id`. */
export function reorder(items: number[], mode: string, id: number): number[] {
  const a = [...items];
  const n = a.length;
  if (mode === 'reverse') return a.toReversed();
  if (mode === 'rotate-left') return [...a.slice(1), a[0]];
  if (mode === 'rotate-right') return [a[n - 1], ...a.slice(0, n - 1)];
  if (mode === 'swap-ends') return [a[n - 1], ...a.slice(1, n - 1), a[0]];
  if (mode === 'to-front') return [id, ...a.filter(x => x !== id)];
  if (mode === 'to-end') return [...a.filter(x => x !== id), id];
  if (mode === 'odd-first') return [...a.filter(x => x % 2 === 1), ...a.filter(x => x % 2 === 0)];
  const half = Math.ceil(n / 2);
  const out: number[] = [];
  for (let i = 0; i < half; i++) {
    out.push(a[i]);
    if (i + half < n) out.push(a[i + half]);
  }
  return out;
}
