// Canonical comparison of browser and native traces.
//
// Both sides produce the snapshot format of browser.mjs. Canonicalisation
// merges adjacent text nodes (frameworks split text differently), drops the
// `value` and `checked` attributes of inputs (the live properties of inputs,
// text areas and selects are compared instead)
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
  if ('value' in node && ['input', 'textarea', 'select'].includes(node.tag)) out.value = node.value;
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

/**
 * The host section of a snapshot (docs/design/M5-PLATFORM.md) in a fixed
 * key order: console lines ({ level, text }), clipboard text, location
 * relative to the origin, history length and title; absent fields are defaults.
 */
export function canonicalHost(host = {}) {
  const out = {};
  if (host.console?.length) out.console = host.console.map(({ level, text }) => ({ level, text }));
  if (host.clipboard !== undefined) out.clipboard = host.clipboard;
  if (host.href !== undefined) out.href = host.href;
  if (host.historyLength !== undefined) out.historyLength = host.historyLength;
  if (host.title !== undefined) out.title = host.title;
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

/** Mean absolute error of two screenshots (0–255), of the whole image or the `crop` rectangle of both. */
export function pixelMAE(a, b, crop) {
  const region = crop ? `[${crop.width}x${crop.height}+${crop.x}+${crop.y}]` : '';
  const r = spawnSync('magick', ['compare', '-metric', 'MAE', a + region, b + region, 'null:'], {
    encoding: 'utf8',
  });
  const m = r.stderr.match(/\(([0-9.e+-]+)\)/);
  if (!m) throw new Error('ImageMagick compare failed: ' + r.stderr);
  return Number(m[1]) * 255;
}

/** Compare step lists; returns { steps: [...], passed: {...} }. */
export function compareTraces(browser, native, { pixels = false, pixelRegions = [] } = {}) {
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
    // Content mounted in the body after the container (portals, M6).
    if (b.portals || nv.portals)
      diffTree(
        canonical({ tag: 'body', children: b.portals ?? [] }),
        canonical({ tag: 'body', children: nv.portals ?? [] }),
        'portals',
        step.dom,
      );
    // The document element's attributes (theming: class, data-*, style).
    if (JSON.stringify(b.document ?? {}) !== JSON.stringify(nv.document ?? {}))
      step.dom.push({ at: 'document', browser: b.document ?? {}, native: nv.document ?? {} });
    if ((b.focused ?? null) !== (nv.focused ?? null)) step.focus = { browser: b.focused, native: nv.focused };
    // Host effects: console lines, clipboard, location, history length.
    if (JSON.stringify(canonicalHost(b.host)) !== JSON.stringify(canonicalHost(nv.host)))
      step.host = { browser: b.host ?? {}, native: nv.host ?? {} };
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
      // Regions of the case (its animated areas, which are small in the
      // viewport): the same tolerance, over the element's box in Chromium.
      for (const id of pixelRegions) {
        const r = b.geometry?.[id];
        if (!r) continue;
        const x = Math.max(0, Math.floor(r.x));
        const y = Math.max(0, Math.floor(r.y));
        const right = Math.min(b.viewport.width, Math.ceil(r.x + r.width));
        const bottom = Math.min(b.viewport.height, Math.ceil(r.y + r.height));
        if (right <= x || bottom <= y) continue;
        const crop = { x, y, width: right - x, height: bottom - y };
        (step.regionMAE ??= {})[id] = +pixelMAE(b.screenshotPath, nv.screenshotPath, crop).toFixed(3);
      }
    }
    steps.push(step);
  }
  const ok = s => !s.missing && !s.dom.length && !s.focus && !s.host;
  return {
    steps,
    passed: {
      semantics: steps.every(ok),
      geometry: steps.every(s => !s.missing && !s.geometry.length),
      pixels: pixels
        ? steps.every(
            s =>
              s.pixelMAE !== undefined &&
              s.pixelMAE <= PIXEL_MAE_TOLERANCE &&
              Object.values(s.regionMAE ?? {}).every(m => m <= PIXEL_MAE_TOLERANCE),
          )
        : null,
    },
  };
}
