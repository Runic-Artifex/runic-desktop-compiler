// The model of 7GUIs Circle Drawer, shared by the framework versions.
//
// Differences from the 7GUIs task (https://eugenkiss.github.io/7guis/tasks):
// - The diameter is adjusted with − and + buttons (4 px steps, 8 to 120 px)
//   instead of a slider: <input type="range"> is not supported (Blitz draws
//   nothing for it, and Chromium's slider metrics, painting and keyboard and
//   pointer behaviour would have to be reproduced in the runtime).
// - The popup menu and the adjust dialog are drawn in the page (a menu over
//   the canvas, a panel below it) rather than as separate windows. While the
//   dialog is open the canvas ignores clicks and Undo/Redo are disabled (the
//   dialog is modal); Done closes it. A click on the canvas while the menu
//   is open only closes the menu.
// - Circles are absolutely positioned elements with border-radius (no
//   canvas element). The selection is computed from the pointer position,
//   not by hit testing, so where circles overlap the one whose centre is
//   nearest is selected.

export interface Circle {
  id: number;
  /** The centre, relative to the canvas's padding box. */
  x: number;
  y: number;
  /** The diameter. */
  d: number;
}

export interface Point {
  x: number;
  y: number;
}

export const DIAMETER = 40;
export const STEP = 4;
export const MIN_DIAMETER = 8;
export const MAX_DIAMETER = 120;

/** The circle nearest to `p` whose area contains it (the selected one), or -1. */
export function nearest(circles: Circle[], p: Point): number {
  let best = -1;
  let bestDistance = Infinity;
  for (const c of circles) {
    const distance = Math.hypot(c.x - p.x, c.y - p.y);
    if (distance < c.d / 2 && distance < bestDistance) {
      best = c.id;
      bestDistance = distance;
    }
  }
  return best;
}

/** Where the context menu opens for a click at `p`: there, but inside the canvas. */
export const menuPosition = (p: Point): Point => ({
  x: Math.min(p.x, 148),
  y: Math.min(p.y, 174),
});

/** The circles with circle `id` grown or shrunk by `delta`, within the limits. */
export function resize(circles: Circle[], id: number, delta: number): Circle[] {
  return circles.map((c): Circle =>
    c.id === id
      ? { id: c.id, x: c.x, y: c.y, d: Math.min(MAX_DIAMETER, Math.max(MIN_DIAMETER, c.d + delta)) }
      : c,
  );
}

/** The diameter of circle `id`. */
export const diameter = (circles: Circle[], id: number): number =>
  circles.find(c => c.id === id)?.d ?? 0;

/** The position of circle `id` as text. */
export function centre(circles: Circle[], id: number): string {
  const c = circles.find(x => x.id === id);
  return c === undefined ? '' : `(${c.x}, ${c.y})`;
}
