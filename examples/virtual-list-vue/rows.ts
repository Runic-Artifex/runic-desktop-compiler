// The list's data: 10,000 rows, and the virtual window over them.
export interface Row {
  id: number;
  label: string;
  kind: string;
}

/** Row height in pixels (whole pixels: Chromium lays out in 1/64 px). */
export const ROW = 24;
/** Rows rendered above and below the visible ones. */
export const OVERSCAN = 3;
const KINDS = ['alpha', 'beta', 'gamma', 'delta'];

function generate(count: number): Row[] {
  const rows: Row[] = [];
  for (let i = 1; i <= count; i++) rows.push({ id: i, label: `Row ${i}`, kind: KINDS[i % 4] });
  return rows;
}

export const ALL = generate(10000);

export function matching(filter: string): Row[] {
  return filter === '' ? ALL : ALL.filter(r => r.label.includes(filter) || r.kind.includes(filter));
}

/**
 * The scroll position the window uses: the browser clamps the scroll
 * position when the list shrinks (and then sends a scroll event), so until
 * that event the window uses the clamped value.
 */
export function clamp(scrollTop: number, count: number, height: number): number {
  return Math.min(scrollTop, Math.max(0, count * ROW - height));
}

/** The first row to render. */
export function first(top: number): number {
  return Math.max(0, Math.floor(top / ROW) - OVERSCAN);
}

/** The row after the last one to render. */
export function last(top: number, height: number, count: number): number {
  return Math.min(count, Math.ceil((top + height) / ROW) + OVERSCAN);
}

/** The status line's description of the selected row. */
export function describe(selected: number | null): string {
  const row = ALL.find(r => r.id === selected);
  return row ? `Selected: ${row.label} (${row.kind})` : 'Nothing selected';
}
