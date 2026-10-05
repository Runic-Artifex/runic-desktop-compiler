// Generates tests/vectors/floating.json from the real @floating-ui/core 1.7.3
// (computePosition and the middleware offset, shift with limitShift, flip,
// size, arrow and hide, plus custom middleware), driven exactly as
// @floating-ui/dom 1.7.4's computePosition wrapper drives it: a fake platform
// with dom's method set and sync/async shapes (getElementRects is dom's async
// function) answers from fixed rectangles. Every platform call and callback is
// traced with the microtask tick it ran at, counted by a self-requeueing
// microtask queued immediately before computePosition is called (code that
// runs after k awaits sees tick k). Run in the dev shell:
//
//   node crates/runic-js/tests/vectors/floating.mjs
//
// Numbers: safe integers are JSON numbers; -0, NaN, ±Infinity and every
// other number are strings (`String(v)`, "-0"), which the test parses
// exactly. Elements are their ids; the window is "window". The top-level
// "fixture" is the default platform answers; each vector's "fixture" lists
// its overrides, and its trace holds every answer actually given.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  arrow,
  computePosition as coreComputePosition,
  flip,
  hide,
  limitShift,
  offset,
  shift,
  size,
} from '@floating-ui/core';

const here = dirname(fileURLToPath(import.meta.url));
const modules = join(here, '../../../../node_modules/@floating-ui');
const versions = {};
for (const [name, want] of [
  ['core', '1.7.3'],
  ['dom', '1.7.4'],
  ['utils', '0.2.10'],
]) {
  const { version } = JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8'));
  if (version !== want) throw new Error(`@floating-ui/${name} ${version}, expected ${want}`);
  versions[name] = version;
}

const num = v => (Object.is(v, -0) ? '-0' : Number.isSafeInteger(v) ? v : String(v));
function enc(v) {
  if (typeof v === 'number') return num(v);
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === 'object') {
    if ('__id' in v) return v.__id;
    const o = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = enc(v[k]);
    return o;
  }
  return v === undefined ? null : v;
}

const PLACEMENTS = ['top', 'right', 'bottom', 'left'].flatMap(s => [s, `${s}-start`, `${s}-end`]);

// ---------------------------------------------------------------------------
// One computePosition call.

async function run(vector) {
  const fx = structuredClone(vector.fixture);
  const trace = [];
  const clock = { t: 0, done: false };
  const rec = (f, args, r) => {
    trace.push([clock.t, f, enc(args), enc(r)]);
    return r;
  };
  const elements = new Map();
  const client = (id, prop) => {
    const sizes = fx.client[id];
    return rec('clientSize', [id, prop], sizes ? sizes[prop] : undefined);
  };
  const WINDOW = {
    __id: 'window',
    get clientWidth() {
      return client('window', 'width');
    },
    get clientHeight() {
      return client('window', 'height');
    },
  };
  const el = id => {
    if (id === 'window') return WINDOW;
    if (!elements.has(id))
      elements.set(id, {
        __id: id,
        get clientWidth() {
          return client(id, 'width');
        },
        get clientHeight() {
          return client(id, 'height');
        },
      });
    return elements.get(id);
  };

  // dom's getRectRelativeToOffsetParent, called directly by getElementRects.
  const getRectRelativeToOffsetParent = (element, offsetParent, strategy) =>
    rec('getRectRelativeToOffsetParent', [element, offsetParent, strategy], {
      ...(strategy === 'fixed' && fx.referenceFixed ? fx.referenceFixed : fx.reference),
    });
  const intersect = rects => {
    const edges = r => ({ top: r.y, right: r.x + r.width, bottom: r.y + r.height, left: r.x });
    const acc = edges(rects[0]);
    for (const r of rects) {
      const e = edges(r);
      acc.top = Math.max(e.top, acc.top);
      acc.right = Math.min(e.right, acc.right);
      acc.bottom = Math.min(e.bottom, acc.bottom);
      acc.left = Math.max(e.left, acc.left);
    }
    return {
      width: acc.right - acc.left,
      height: acc.bottom - acc.top,
      x: acc.left,
      y: acc.top,
    };
  };
  const platform = {
    convertOffsetParentRelativeRectToViewportRelativeRect({
      elements,
      rect,
      offsetParent,
      strategy,
    }) {
      let r;
      if (offsetParent === WINDOW) {
        r =
          strategy === 'fixed'
            ? { ...rect }
            : { ...rect, x: rect.x - fx.scroll.x, y: rect.y - fx.scroll.y };
      } else {
        const s = fx.scale;
        r = {
          width: rect.width * s.x,
          height: rect.height * s.y,
          x: rect.x * s.x + fx.parentOrigin.x,
          y: rect.y * s.y + fx.parentOrigin.y,
        };
      }
      return rec(
        'convert',
        [elements.reference, elements.floating, rect, offsetParent, strategy],
        r,
      );
    },
    getDocumentElement() {
      throw new Error('getDocumentElement is only reached for virtual elements');
    },
    getClippingRect({ element, boundary, rootBoundary, strategy }) {
      const list =
        boundary === 'clippingAncestors'
          ? fx.ancestors[element.__id] || []
          : [].concat(boundary).map(e => fx.boundaries[e.__id]);
      const root =
        rootBoundary === 'viewport'
          ? strategy === 'fixed'
            ? fx.viewportFixed
            : fx.viewport
          : rootBoundary === 'document'
            ? fx.document
            : rootBoundary;
      return rec(
        'getClippingRect',
        [element, boundary, rootBoundary, strategy],
        intersect([...list, root]),
      );
    },
    getOffsetParent(element) {
      return el(rec('getOffsetParent', [element], fx.offsetParent[element.__id] || 'window'));
    },
    // dom 1.7.4's getElementRects, verbatim but for the fake rect function.
    getElementRects: async function (data) {
      const getOffsetParentFn = this.getOffsetParent || getOffsetParent;
      const getDimensionsFn = this.getDimensions;
      const floatingDimensions = await getDimensionsFn(data.floating);
      return {
        reference: getRectRelativeToOffsetParent(
          data.reference,
          await getOffsetParentFn(data.floating),
          data.strategy,
        ),
        floating: {
          x: 0,
          y: 0,
          width: floatingDimensions.width,
          height: floatingDimensions.height,
        },
      };
    },
    getClientRects() {
      throw new Error('getClientRects is only used by inline');
    },
    getDimensions(element) {
      return rec('getDimensions', [element], { ...fx.dims[element.__id] });
    },
    getScale(element) {
      return rec('getScale', [element], { ...fx.scale });
    },
    isElement(value) {
      return value !== WINDOW;
    },
    isRTL(element) {
      return rec('isRTL', [element], fx.rtl);
    },
  };
  const getOffsetParent = () => {
    throw new Error('unused');
  };

  // dom 1.7.4's computePosition wrapper.
  const computePosition = (reference, floating, options) => {
    const cache = new Map();
    const mergedOptions = { platform, ...options };
    const platformWithCache = { ...mergedOptions.platform, _c: cache };
    return coreComputePosition(reference, floating, {
      ...mergedOptions,
      platform: platformWithCache,
    });
  };

  const encState = s => ({
    x: s.x,
    y: s.y,
    initialPlacement: s.initialPlacement,
    placement: s.placement,
    strategy: s.strategy,
    rects: s.rects,
    middlewareData: s.middlewareData,
    elements: [s.elements.reference, s.elements.floating],
  });
  const middleware = vector.middleware.map(m =>
    buildMiddleware(m, { el, fx, rec, clock, trace, encState }),
  );

  const outcome = await new Promise(resolve => {
    const tick = () => {
      if (clock.done) return;
      clock.t++;
      queueMicrotask(tick);
    };
    queueMicrotask(tick);
    computePosition(el('reference'), el('floating'), {
      ...(vector.placement !== undefined && { placement: vector.placement }),
      ...(vector.strategy !== undefined && { strategy: vector.strategy }),
      middleware,
    }).then(
      r => {
        clock.done = true;
        resolve({ then: clock.t, result: r });
      },
      e => {
        clock.done = true;
        resolve({ then: clock.t, rejected: { name: e.name, message: e.message } });
      },
    );
  });
  return { trace, outcome: enc(outcome) };
}

function detectOptions(o, el) {
  const out = { ...o };
  if (Array.isArray(out.boundary)) out.boundary = out.boundary.map(el);
  return out;
}

const customBehaviours = {
  // bits-ui 2.19.2's transformOrigin (use-floating-layer.svelte.js), verbatim.
  transformOrigin(data, options) {
    const { placement, rects, middlewareData } = data;
    const cannotCenterArrow = middlewareData.arrow?.centerOffset !== 0;
    const isArrowHidden = cannotCenterArrow;
    const arrowWidth = isArrowHidden ? 0 : options.arrowWidth;
    const arrowHeight = isArrowHidden ? 0 : options.arrowHeight;
    const [placedSide, placedAlign] = getSideAndAlignFromPlacement(placement);
    const noArrowAlign = { start: '0%', center: '50%', end: '100%' }[placedAlign];
    const arrowXCenter = (middlewareData.arrow?.x ?? 0) + arrowWidth / 2;
    const arrowYCenter = (middlewareData.arrow?.y ?? 0) + arrowHeight / 2;
    let x = '';
    let y = '';
    if (placedSide === 'bottom') {
      x = isArrowHidden ? noArrowAlign : `${arrowXCenter}px`;
      y = `${-arrowHeight}px`;
    } else if (placedSide === 'top') {
      x = isArrowHidden ? noArrowAlign : `${arrowXCenter}px`;
      y = `${rects.floating.height + arrowHeight}px`;
    } else if (placedSide === 'right') {
      x = `${-arrowHeight}px`;
      y = isArrowHidden ? noArrowAlign : `${arrowYCenter}px`;
    } else if (placedSide === 'left') {
      x = `${rects.floating.width + arrowHeight}px`;
      y = isArrowHidden ? noArrowAlign : `${arrowYCenter}px`;
    }
    return { data: { x, y } };
  },
  resetPlacement(state, o) {
    if (state.middlewareData[o.name]?.done) return {};
    return { data: { done: true }, reset: { placement: o.placement } };
  },
  resetOnce(state, o) {
    if (state.middlewareData[o.name]?.done) return { data: { seen: state.placement } };
    return { data: { done: true }, reset: o.reset };
  },
  alwaysReset(state, o) {
    return { data: { n: (state.middlewareData[o.name]?.n ?? 0) + 1 }, reset: true };
  },
  move(state) {
    return { x: state.x + 2.5, y: null, data: { moved: true } };
  },
  noData() {
    return {};
  },
  throws() {
    throw new Error('custom middleware failed');
  },
};

function getSideAndAlignFromPlacement(placement) {
  const [side, align = 'center'] = placement.split('-');
  return [side, align];
}

const applyBehaviours = {
  record() {},
  // A CSS max-width/max-height: the next getDimensions sees the clamp.
  clamp(state, fx) {
    const d = fx.dims.floating;
    fx.dims.floating = {
      width: Math.min(d.width, state.availableWidth),
      height: Math.min(d.height, state.availableHeight),
    };
  },
  grow(state, fx) {
    if (fx.grown) return;
    fx.grown = true;
    const d = fx.dims.floating;
    fx.dims.floating = { width: d.width + 10.5, height: d.height - 20 };
  },
  flicker(state, fx) {
    const d = fx.dims.floating;
    fx.dims.floating = { width: d.width + 1, height: d.height };
  },
  throws() {
    throw new Error('apply failed');
  },
};

function buildMiddleware(m, { el, fx, rec, clock, trace, encState }) {
  const [kind, o] = Object.entries(m)[0];
  switch (kind) {
    case 'offset':
      return o === null ? offset() : offset(o);
    case 'shift': {
      const { limiter, ...rest } = o;
      const options = detectOptions(rest, el);
      if (limiter === null) options.limiter = undefined;
      else if (limiter !== undefined)
        options.limiter = Object.keys(limiter).length ? limitShift(limiter) : limitShift();
      return shift(options);
    }
    case 'flip':
      return flip(detectOptions(o, el));
    case 'size': {
      const { apply, ...rest } = o;
      const options = detectOptions(rest, el);
      if (apply)
        options.apply = state => {
          const args = [apply.id, encState(state), state.availableWidth, state.availableHeight];
          try {
            applyBehaviours[apply.behaviour](state, fx);
          } catch (e) {
            trace.push([clock.t, 'apply', enc(args), { throw: e.message }]);
            throw e;
          }
          trace.push([clock.t, 'apply', enc(args), null]);
        };
      return size(options);
    }
    case 'arrow':
      return arrow({
        element: o.element === null ? null : el(o.element),
        ...(o.padding !== undefined && { padding: o.padding }),
      });
    case 'hide':
      return hide(detectOptions(o, el));
    case 'custom':
      return {
        name: o.name,
        options: o,
        fn(state) {
          const args = [o.id, encState(state)];
          let r;
          try {
            r = customBehaviours[o.behaviour](state, o);
          } catch (e) {
            trace.push([clock.t, 'custom', enc(args), { throw: e.message }]);
            throw e;
          }
          trace.push([clock.t, 'custom', enc(args), enc(r)]);
          return r;
        },
      };
  }
  throw new Error(`unknown middleware ${kind}`);
}

// ---------------------------------------------------------------------------
// Fixtures and cases.

const rect = (x, y, width, height) => ({ x, y, width, height });
function fixture(over = {}) {
  return {
    rtl: false,
    reference: rect(420.5, 300.25, 120.3, 36.7),
    dims: { floating: { width: 180.6, height: 140.1 }, arrow: { width: 10, height: 5 } },
    offsetParent: { floating: 'window', arrow: 'floating' },
    client: {
      floating: { width: 180, height: 140 },
      parent: { width: 900, height: 700 },
      zero: { width: 0, height: 0 },
    },
    scale: { x: 1, y: 1 },
    parentOrigin: { x: 0, y: 0 },
    scroll: { x: 0, y: 0 },
    viewport: rect(0, 0, 1024, 768),
    viewportFixed: rect(0, 0, 1024, 768),
    document: rect(0, 0, 1024, 2000),
    ancestors: {},
    boundaries: { box: rect(100, 100, 600, 400), strip: rect(0, 250, 1024, 200) },
    ...over,
  };
}
// Reference positions relative to a 1024x768 viewport.
const at = {
  center: rect(420.5, 300.25, 120.3, 36.7),
  top: rect(430, 12.5, 120.3, 36.7),
  bottom: rect(430, 728.75, 120.3, 36.7),
  left: rect(6.25, 320, 120.3, 36.7),
  right: rect(960.5, 320, 120.3, 36.7),
  topLeft: rect(6.25, 12.5, 120.3, 36.7),
  bottomRight: rect(960.5, 728.75, 60.3, 36.7),
  outsideTop: rect(430, -100, 120.3, 36.7),
  outsideRight: rect(1100, 320, 120.3, 36.7),
  tiny: rect(500, 400, 8, 8),
};
const atNames = ['center', 'top', 'bottom', 'left', 'right', 'topLeft', 'bottomRight'];

const vectors = [];
const add = (category, placement, middleware, over = {}, strategy) =>
  vectors.push({ category, placement, strategy, middleware, over, fixture: fixture(over) });

// Placements, strategies and direction with a plain offset; and no middleware.
for (const rtl of [false, true])
  for (const strategy of ['absolute', 'fixed'])
    for (const p of PLACEMENTS) add('placement', p, [{ offset: 6 }], { rtl }, strategy);
for (const p of PLACEMENTS) add('placement', p, [], { reference: at.tiny });
add('placement', undefined, [], {}); // default 'bottom' and 'absolute'

// Offset forms.
const offsetForms = [
  null,
  -5,
  { mainAxis: 4, crossAxis: 3 },
  { mainAxis: 4, alignmentAxis: 7 },
  { crossAxis: 2, alignmentAxis: -3.5 },
  { mainAxis: NaN, crossAxis: -0, alignmentAxis: null },
  {},
  0.1,
];
offsetForms.forEach((form, i) =>
  PLACEMENTS.forEach((p, j) => {
    if ((i + j) % 2 === 0 || form === null || typeof form === 'object')
      add('offset', p, [{ offset: form }], { rtl: (i + j) % 3 === 0 });
  }),
);

// Shift with and without limitShift.
const shiftForms = [
  [{ shift: {} }],
  [{ shift: { crossAxis: true } }],
  [{ shift: { mainAxis: false, crossAxis: true } }],
  [{ offset: 8 }, { shift: { limiter: {} } }],
  [
    { offset: { mainAxis: 8, crossAxis: 5 } },
    { shift: { crossAxis: true, limiter: { offset: 12 } } },
  ],
  [
    { offset: 3 },
    {
      shift: {
        crossAxis: true,
        limiter: { offset: { mainAxis: 5, crossAxis: 3 }, crossAxis: true },
      },
    },
  ],
  [{ shift: { padding: 10, limiter: { mainAxis: false } } }],
  [
    {
      shift: {
        padding: { top: 4, left: 9 },
        crossAxis: true,
        limiter: { offset: { crossAxis: -2 } },
      },
    },
  ],
];
shiftForms.forEach((form, i) =>
  atNames.forEach((pos, j) =>
    add('shift', PLACEMENTS[(i * 7 + j * 5) % 12], form, { reference: at[pos], rtl: j === 3 }),
  ),
);

// Flip.
const bitsDetect = { padding: 8, boundary: [], altBoundary: false };
const big = { floating: { width: 700, height: 600 }, arrow: { width: 10, height: 5 } };
const flipCases = [
  [{}, 'top', 'top'],
  [{}, 'bottom', 'bottom-start'],
  [{}, 'left', 'left-end'],
  [{}, 'right', 'right'],
  [{}, 'topLeft', 'top-start'],
  [{}, 'bottomRight', 'right-end'],
  [bitsDetect, 'top', 'top-end'],
  [bitsDetect, 'bottom', 'bottom'],
  [bitsDetect, 'left', 'left'],
  [bitsDetect, 'right', 'right-start'],
  [bitsDetect, 'topLeft', 'left-start'],
  [{ crossAxis: false }, 'topLeft', 'top-start'],
  [{ crossAxis: false }, 'right', 'bottom-end'],
  [{ crossAxis: 'alignment' }, 'topLeft', 'top-start'],
  [{ crossAxis: 'alignment' }, 'right', 'top-end'],
  [{ crossAxis: 'alignment', fallbackAxisSideDirection: 'end' }, 'top', 'top'],
  [{ fallbackPlacements: ['right', 'left-start'] }, 'top', 'top'],
  [{ fallbackPlacements: [] }, 'top', 'top'],
  [{ fallbackPlacements: ['bottom-end', 'top-start'] }, 'bottom', 'bottom-start'],
  [{ fallbackAxisSideDirection: 'start' }, 'top', 'top'],
  [{ fallbackAxisSideDirection: 'end' }, 'top', 'top-start'],
  [{ fallbackAxisSideDirection: 'start', flipAlignment: false }, 'left', 'left-end'],
  [{ fallbackAxisSideDirection: 'end' }, 'right', 'right-start'],
  [{ flipAlignment: false }, 'top', 'top-start'],
  [{ mainAxis: false }, 'right', 'top-end'],
  [{ mainAxis: false, crossAxis: false }, 'top', 'top'],
  [{ padding: { bottom: 50 } }, 'center', 'bottom'],
];
flipCases.forEach(([o, pos, p], i) =>
  add('flip', p, [{ flip: o }], { reference: at[pos], rtl: i % 4 === 3 }),
);
// No placement fits: the fallback strategies.
for (const [o, p] of [
  [{}, 'top'],
  [{}, 'right-start'],
  [{ fallbackStrategy: 'initialPlacement' }, 'top'],
  [{ fallbackStrategy: 'initialPlacement' }, 'left-end'],
  [{ fallbackAxisSideDirection: 'start' }, 'top-start'],
  [{ fallbackAxisSideDirection: 'end' }, 'left'],
  [{ crossAxis: 'alignment', fallbackAxisSideDirection: 'start' }, 'bottom'],
  [{ crossAxis: false }, 'bottom-end'],
])
  for (const rtl of [false, true])
    add('flip-fallback', p, [{ flip: o }], { dims: big, reference: at.topLeft, rtl });
add('flip', 'top', [{ shift: bitsDetect }, { flip: bitsDetect }], { reference: at.top });
add('flip', 'bottom-start', [{ offset: 10 }, { flip: {} }, { shift: {} }], {
  reference: at.bottomRight,
});

// Size.
PLACEMENTS.forEach((p, i) => {
  const pos = atNames[i % atNames.length];
  add('size', p, [{ size: { apply: { id: 0, behaviour: 'record' } } }], {
    reference: at[pos],
    rtl: i % 3 === 1,
  });
  add(
    'size',
    p,
    [
      { shift: { crossAxis: i % 2 === 0 } },
      { size: { padding: 5, apply: { id: 1, behaviour: 'record' } } },
    ],
    { reference: at[atNames[(i + 3) % atNames.length]], rtl: i % 3 === 2 },
  );
});
add('size', 'bottom', [{ size: {} }], { reference: at.bottom });
add('size', 'top', [{ size: { apply: { id: 0, behaviour: 'clamp' } } }], { reference: at.top });
add('size', 'right-start', [{ shift: {} }, { size: { apply: { id: 0, behaviour: 'clamp' } } }], {
  reference: at.right,
});
add('size', 'bottom-end', [{ offset: 4 }, { size: { apply: { id: 7, behaviour: 'grow' } } }], {});
add('size', 'left', [{ size: { apply: { id: 0, behaviour: 'flicker' } } }], {});
add('size', 'top-start', [{ size: { apply: { id: 3, behaviour: 'throws' } } }], { rtl: true });
add('size', 'bottom', [{ size: { apply: { id: 0, behaviour: 'record' } } }], { dims: big });
add('size', 'right', [{ size: { apply: { id: 0, behaviour: 'record' } } }], { dims: big });

// Arrow.
PLACEMENTS.forEach((p, i) =>
  add(
    'arrow',
    p,
    [{ offset: 5 }, { arrow: { element: 'arrow', padding: i % 2 ? 4 : undefined } }],
    { rtl: i % 5 === 0 },
  ),
);
for (const p of ['top-start', 'bottom-end', 'left-start', 'right-end', 'top-end', 'bottom-start'])
  add('arrow', p, [{ offset: 5 }, { flip: {} }, { arrow: { element: 'arrow', padding: 6 } }], {
    reference: at.tiny,
  });
add('arrow', 'bottom', [{ arrow: { element: 'arrow', padding: { left: 80, right: 3 } } }], {
  reference: at.tiny,
});
add('arrow', 'right', [{ arrow: { element: 'arrow', padding: 200 } }], {});
add('arrow', 'top', [{ shift: {} }, { arrow: { element: 'arrow' } }], { reference: at.left });
add('arrow', 'bottom', [{ arrow: { element: 'arrow' } }], {
  offsetParent: { floating: 'window', arrow: 'window' },
});
add('arrow', 'left', [{ arrow: { element: 'arrow' } }], {
  offsetParent: { floating: 'window', arrow: 'zero' },
});
add('arrow', 'top-start', [{ arrow: { element: 'arrow' } }], {
  offsetParent: { floating: 'window', arrow: 'parent' },
  reference: at.tiny,
});
add('arrow', 'top', [{ arrow: { element: null } }], {});
add('arrow', 'bottom-start', [{ offset: 5 }, { arrow: { element: 'arrow', padding: 6 } }], {
  reference: at.tiny,
  client: { floating: { width: 0, height: 0 } },
});

// Hide.
for (const pos of ['center', 'top', 'outsideTop', 'outsideRight'])
  for (const list of [
    [{ hide: {} }],
    [{ hide: { strategy: 'escaped' } }],
    [
      { hide: { strategy: 'referenceHidden', padding: 4 } },
      { hide: { strategy: 'escaped', padding: 4 } },
    ],
  ])
    add('hide', 'bottom', [{ offset: 5 }, ...list], { reference: at[pos] });
add('hide', 'top', [{ hide: { boundary: ['box'], altBoundary: true } }], {});
add('hide', 'left', [{ hide: { strategy: 'escaped', boundary: ['strip'] } }], {});
add('hide', 'right-end', [{ hide: { strategy: 'escaped', elementContext: 'reference' } }], {
  reference: at.right,
});

// Custom middleware.
const origin = { arrowWidth: 10, arrowHeight: 5 };
for (const p of ['top', 'right-start', 'bottom-end', 'left', 'bottom', 'top-start'])
  add('custom', p, [
    { offset: 5 },
    { arrow: { element: 'arrow' } },
    { custom: { name: 'transformOrigin', id: 0, behaviour: 'transformOrigin', ...origin } },
  ]);
for (const p of ['top-end', 'left-start'])
  add('custom', p, [
    { custom: { name: 'transformOrigin', id: 0, behaviour: 'transformOrigin', ...origin } },
  ]);
add('custom', 'top', [
  { offset: 4 },
  { custom: { name: 'resetter', id: 1, behaviour: 'resetPlacement', placement: 'left-end' } },
]);
add('custom', 'bottom', [
  { custom: { name: 'r', id: 2, behaviour: 'resetOnce', reset: { rects: true } } },
]);
add('custom', 'bottom', [
  { offset: 2 },
  {
    custom: {
      name: 'r',
      id: 2,
      behaviour: 'resetOnce',
      reset: { rects: { reference: rect(10, 20, 30, 40), floating: rect(0, 0, 50.5, 60) } },
    },
  },
]);
add('custom', 'right', [
  { offset: 2 },
  { custom: { name: 'r', id: 2, behaviour: 'resetOnce', reset: {} } },
]);
add('custom', 'right', [
  { offset: 2 },
  { custom: { name: 'r', id: 2, behaviour: 'resetOnce', reset: true } },
]);
add('custom', 'left', [
  { offset: 2 },
  {
    custom: { name: 'r', id: 2, behaviour: 'resetOnce', reset: { placement: 'top', rects: true } },
  },
]);
add('custom', 'top', [{ custom: { name: 'loop', id: 3, behaviour: 'alwaysReset' } }]);
add('custom', 'top', [{ custom: { name: 'move', id: 4, behaviour: 'move' } }, { offset: 1 }]);
add('custom', 'top', [{ offset: 3 }, { custom: { name: 'boom', id: 5, behaviour: 'throws' } }]);
add('custom', 'top', [
  { custom: { name: 'same', id: 6, behaviour: 'move' } },
  { custom: { name: 'same', id: 7, behaviour: 'noData' } },
  { custom: { name: 'empty', id: 8, behaviour: 'noData' } },
]);

// An arrow entry with both axes (a reset to the other axis after it ran),
// and NaN flowing through the coordinates.
add('custom', 'top', [
  { arrow: { element: 'arrow' } },
  { custom: { name: 'resetter', id: 1, behaviour: 'resetPlacement', placement: 'left-start' } },
]);
add('offset', 'bottom-start', [{ offset: NaN }, { shift: {} }, { flip: {} }, { size: {} }]);

// bits-ui 2.19.2's middleware list (FloatingContentState.middleware).
function bitsList({
  sideOffset,
  alignOffset,
  avoidCollisions,
  sticky,
  arrowEl,
  hideWhenDetached,
  padding,
}) {
  const arrowHeight = arrowEl ? 5 : 0;
  const arrowWidth = arrowEl ? 10 : 0;
  const det = { padding, boundary: [], altBoundary: false };
  return [
    { offset: { mainAxis: sideOffset + arrowHeight, alignmentAxis: alignOffset } },
    avoidCollisions && {
      shift: {
        mainAxis: true,
        crossAxis: false,
        limiter: sticky === 'partial' ? {} : null,
        ...det,
      },
    },
    avoidCollisions && { flip: { ...det } },
    { size: { ...det, apply: { id: 0, behaviour: 'record' } } },
    arrowEl && { arrow: { element: 'arrow', padding: 0 } },
    {
      custom: {
        name: 'transformOrigin',
        id: 1,
        behaviour: 'transformOrigin',
        arrowWidth,
        arrowHeight,
      },
    },
    hideWhenDetached && { hide: { strategy: 'referenceHidden', ...det } },
  ].filter(Boolean);
}
const bitsConfigs = [
  {
    sideOffset: 4,
    alignOffset: 0,
    avoidCollisions: true,
    sticky: 'partial',
    arrowEl: true,
    hideWhenDetached: true,
    padding: 8,
  },
  {
    sideOffset: 0,
    alignOffset: 0,
    avoidCollisions: true,
    sticky: 'partial',
    arrowEl: false,
    hideWhenDetached: false,
    padding: 0,
  },
  {
    sideOffset: 8,
    alignOffset: -4,
    avoidCollisions: true,
    sticky: 'always',
    arrowEl: true,
    hideWhenDetached: false,
    padding: 10,
  },
  {
    sideOffset: 6,
    alignOffset: 3,
    avoidCollisions: false,
    sticky: 'partial',
    arrowEl: false,
    hideWhenDetached: true,
    padding: 0,
  },
];
bitsConfigs.forEach((config, i) =>
  PLACEMENTS.forEach((p, j) => {
    const pos = j % 3 === 0 ? 'center' : atNames[(i + j) % atNames.length];
    add('bits-ui', p, bitsList(config), { reference: at[pos], rtl: (i + j) % 7 === 0 });
  }),
);
add('bits-ui', 'bottom', bitsList(bitsConfigs[0]), { reference: at.outsideTop });
add('bits-ui', 'top-start', bitsList(bitsConfigs[0]), { reference: at.tiny });
add('bits-ui', 'bottom', bitsList(bitsConfigs[2]), { dims: big, reference: at.topLeft });

// Platform variants: element offset parents with a scale, fixed viewports,
// clipping ancestors, root boundaries and element contexts.
const scaled = {
  offsetParent: { floating: 'parent', arrow: 'floating' },
  scale: { x: 2, y: 0.5 },
  parentOrigin: { x: 30.5, y: -12 },
};
add('platform', 'bottom', [{ offset: 4 }, { shift: { crossAxis: true } }, { flip: {} }], scaled);
add(
  'platform',
  'right-end',
  [{ size: { apply: { id: 0, behaviour: 'record' } } }, { hide: {} }],
  scaled,
);
add('platform', 'top', bitsList(bitsConfigs[0]), { ...scaled, reference: at.right });
add(
  'platform',
  'left-start',
  [{ shift: {} }, { flip: {} }],
  { viewportFixed: rect(0, 40, 800, 600), referenceFixed: at.left },
  'fixed',
);
add('platform', 'top', [{ shift: {} }], { scroll: { x: 15, y: 220 } });
add('platform', 'bottom', [{ flip: {} }, { shift: {} }], {
  ancestors: { floating: [rect(300, 200, 400, 250)] },
});
add('platform', 'bottom', [{ flip: { rootBoundary: 'document' } }], { reference: at.bottom });
add('platform', 'bottom', [{ flip: { rootBoundary: rect(50, 60, 700, 500) } }], {
  reference: at.bottom,
});
add('platform', 'top', [{ shift: { elementContext: 'reference', crossAxis: true } }], {
  reference: at.topLeft,
});
add(
  'platform',
  'left',
  [{ shift: { altBoundary: true } }, { flip: { boundary: ['box', 'strip'] } }],
  { ancestors: { reference: [rect(0, 0, 500, 500)] } },
);
add('platform', 'right', [{ shift: { boundary: ['box'], padding: { right: 12 } } }], {});

// ---------------------------------------------------------------------------

const out = [];
for (const v of vectors) {
  const { trace, outcome } = await run(v);
  out.push({
    category: v.category,
    placement: v.placement ?? null,
    strategy: v.strategy ?? null,
    middleware: enc(v.middleware),
    fixture: enc(v.over),
    trace,
    outcome,
  });
}
const lines = ['{', `  "node": ${JSON.stringify(process.version)},`];
lines.push(
  `  "versions": ${JSON.stringify(versions)},`,
  `  "fixture": ${JSON.stringify(enc(fixture()))},`,
  '  "vectors": [',
);
out.forEach((v, i) => lines.push(`    ${JSON.stringify(v)}${i + 1 < out.length ? ',' : ''}`));
lines.push('  ]', '}', '');
writeFileSync(join(here, 'floating.json'), lines.join('\n'));
const counts = {};
for (const v of out) counts[v.category] = (counts[v.category] || 0) + 1;
console.log(
  Object.entries(counts)
    .map(([k, n]) => `${k}: ${n}`)
    .join('\n'),
);
console.log(`total: ${out.length}`);
