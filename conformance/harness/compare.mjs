// Canonical comparison of browser and native traces.
//
// Both sides produce the snapshot format of browser.mjs. Canonicalisation
// merges adjacent text nodes (frameworks split text differently), drops the
// `value` and `checked` attributes of inputs (the live properties are compared instead)
// and ignores selection direction. Tolerances are unchanged from Phases 1-4:
// geometry 2 px per coordinate, pixels mean absolute error <= 3/255.
import { spawnSync } from 'node:child_process';

export const GEOMETRY_TOLERANCE = 2;
export const PIXEL_MAE_TOLERANCE = 3;

export function canonical(node) {
  if (!node) return null;
  if ('text' in node) return { text: node.text };
  const out = { tag: node.tag };
  const attrs = { ...(node.attributes ?? {}) };
  if (node.tag === 'input') {
    delete attrs.value;
    delete attrs.checked;
  }
  if (Object.keys(attrs).length) out.attributes = Object.fromEntries(Object.entries(attrs).sort());
  for (const k of ['disabled', 'focused', 'readOnly', 'checked']) if (node[k]) out[k] = true;
  if ('value' in node && node.tag === 'input') out.value = node.value;
  if (node.selection) out.selection = node.selection.slice(0, 2);
  const children = [];
  for (const c of (node.children ?? []).map(canonical).filter(Boolean)) {
    const last = children.at(-1);
    if ('text' in c && last && 'text' in last) last.text += c.text;
    else children.push(c);
  }
  const kept = children.filter(c => !('text' in c) || c.text !== '');
  if (kept.length) out.children = kept;
  return out;
}

function diffTree(a, b, at, out) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja === jb) return;
  if (!a || !b || 'text' in a || 'text' in b || a.tag !== b.tag) {
    out.push({ at, browser: a, native: b });
    return;
  }
  const { children: ca = [], ...ra } = a;
  const { children: cb = [], ...rb } = b;
  if (JSON.stringify(ra) !== JSON.stringify(rb)) out.push({ at, browser: ra, native: rb });
  const n = Math.max(ca.length, cb.length);
  for (let i = 0; i < n; i++) diffTree(ca[i], cb[i], `${at}/${a.tag}[${i}]`, out);
}

export function pixelMAE(a, b) {
  const r = spawnSync('magick', ['compare', '-metric', 'MAE', a, b, 'null:'], { encoding: 'utf8' });
  const m = r.stderr.match(/\(([0-9.e+-]+)\)/);
  if (!m) throw new Error('ImageMagick compare failed: ' + r.stderr);
  return Number(m[1]) * 255;
}

/** Compare step lists; returns { steps: [...], passed: {...} }. */
export function compareTraces(browser, native, { pixels = false } = {}) {
  const steps = [];
  const n = Math.max(browser.length, native.length);
  for (let i = 0; i < n; i++) {
    const b = browser[i];
    const nv = native[i];
    const step = { index: i, action: b?.action ?? nv?.action, dom: [], focus: null, geometry: [] };
    if (!b || !nv) {
      step.missing = !b ? 'browser' : 'native';
      steps.push(step);
      continue;
    }
    diffTree(canonical(b.dom), canonical(nv.dom), '', step.dom);
    if ((b.focused ?? null) !== (nv.focused ?? null)) step.focus = { browser: b.focused, native: nv.focused };
    for (const [id, rb] of Object.entries(b.geometry ?? {})) {
      const rn = nv.geometry?.[id];
      if (!rn) {
        step.geometry.push({ id, browser: rb, native: null });
        continue;
      }
      const delta = Object.fromEntries(['x', 'y', 'width', 'height'].map(k => [k, +(rn[k] - rb[k]).toFixed(3)]));
      if (Object.values(delta).some(d => Math.abs(d) > GEOMETRY_TOLERANCE)) step.geometry.push({ id, delta });
    }
    for (const id of Object.keys(nv.geometry ?? {}))
      if (!(id in (b.geometry ?? {}))) step.geometry.push({ id, browser: null, native: nv.geometry[id] });
    if (pixels && b.screenshotPath && nv.screenshotPath) {
      step.pixelMAE = +pixelMAE(b.screenshotPath, nv.screenshotPath).toFixed(3);
    }
    steps.push(step);
  }
  const ok = s => !s.missing && !s.dom.length && !s.focus;
  return {
    steps,
    passed: {
      semantics: steps.every(ok),
      geometry: steps.every(s => !s.missing && !s.geometry.length),
      pixels: pixels ? steps.every(s => s.pixelMAE !== undefined && s.pixelMAE <= PIXEL_MAE_TOLERANCE) : null,
    },
  };
}
