// Browser reference driver for the conformance harness (M1 spike).
//
// Runs an original framework fixture through Vite in headless Chromium from the
// Nix dev shell (PLAYWRIGHT_BROWSERS_PATH, playwright-core pinned to the
// nixpkgs playwright-driver version) and records, before and after every
// action, a normalized DOM tree under #root, border-box geometry of elements
// with ids and a screenshot.
//
// Settling: after each action the driver waits for two natural animation
// frames in the page. It never forces blur or mutates app state to settle.
import { createServer } from 'vite';
import { createServer as createNetServer } from 'node:net';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { frontendTooling } from '../../compiler/adapters/tooling.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function loadPlaywright() {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH)
    throw new Error(
      'PLAYWRIGHT_BROWSERS_PATH is unset; run inside the dev shell (nix develop . -c ...)',
    );
  const require = createRequire(import.meta.url);
  const { version } = require('playwright-core/package.json');
  const pinned = process.env.RUNIC_PLAYWRIGHT_VERSION;
  if (pinned && pinned !== version)
    throw new Error(
      `playwright-core ${version} does not match the Nix playwright-driver ${pinned}; ` +
        'its browser revisions would not be found',
    );
  return import('playwright-core');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Starts a Vite dev server for an original fixture on a free loopback port. */
export async function serveFixture(fixture) {
  const root = await realpath(fixture);
  const config = JSON.parse(await readFile(path.join(root, 'runic.json'), 'utf8'));
  const tooling = await frontendTooling(root, config);
  const server = await createServer({
    root,
    cacheDir: path.join(repo, '.cache/vite-references', path.basename(root)),
    configFile: false,
    plugins: tooling.plugins,
    // A concrete port: the injected Vite client derives its WebSocket port
    // from the configured one, and port 0 would make it fail to connect.
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
    logLevel: 'error',
  });
  await server.listen();
  const { port } = server.httpServer.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    framework: tooling.name,
    version: tooling.version,
    close: () => server.close(),
  };
}

// --- Page-side helpers (serialized into the page by Playwright) ---

function pageSnapshot() {
  const root = document.getElementById('root');
  const active = document.activeElement;
  const node = n => {
    if (n.nodeType === Node.TEXT_NODE) return n.data === '' ? null : { text: n.data };
    if (n.nodeType !== Node.ELEMENT_NODE) return null; // framework comment anchors
    const attributes = Object.fromEntries(
      [...n.attributes].map(a => [a.name, a.value]).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    const out = { tag: n.localName };
    if (n.id) out.id = n.id;
    if (Object.keys(attributes).length) out.attributes = attributes;
    if (n.matches(':disabled')) out.disabled = true;
    if (n === active) out.focused = true;
    if (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement) {
      out.value = n.value;
      if (['checkbox', 'radio'].includes(n.type)) out.checked = n.checked;
      else if (n.selectionStart !== null)
        out.selection = [n.selectionStart, n.selectionEnd, n.selectionDirection];
      if (n.readOnly) out.readOnly = true;
    } else if (n instanceof HTMLSelectElement) out.value = n.value;
    const children = [...n.childNodes].map(node).filter(Boolean);
    if (children.length) out.children = children;
    return out;
  };
  const geometry = {};
  for (const e of [root, ...root.querySelectorAll('[id]')]) {
    const r = e.getBoundingClientRect();
    geometry[e.id] = { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  const html = Object.fromEntries(
    [...document.documentElement.attributes].map(a => [a.name, a.value]).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return {
    ...(Object.keys(html).length ? { document: html } : {}),
    dom: node(root),
    focused: active === document.body || !active ? null : active.id || active.localName,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    geometry,
  };
}

/** `Date.now()` at clock time 0 (shared with the probe and the interpreter). */
const CLOCK_ORIGIN = 1_767_225_600_000;

const twoFrames = () =>
  new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

// --- Actions ---

async function perform(page, action, timeout) {
  const target = action.id
    ? page.locator('#' + CSS.escape(action.id))
    : action.selector
      ? page.locator(action.selector)
      : null;
  switch (action.kind) {
    case 'click': {
      // Real pointer input at the element centre. A disabled control is still
      // clicked (force skips Playwright's wait-for-enabled); the browser then
      // naturally ignores it, matching what a user would see.
      const force = await target.isDisabled({ timeout });
      await target.click({ force, timeout });
      break;
    }
    case 'dblclick':
    case 'contextmenu': {
      const force = await target.isDisabled({ timeout });
      if (action.kind === 'dblclick') await target.dblclick({ force, timeout });
      else await target.click({ button: 'right', force, timeout });
      break;
    }
    case 'hover': // The pointer moves to the element centre.
      await target.hover({ force: true, timeout });
      break;
    case 'wheel': // A wheel turn over the element centre.
      await target.hover({ force: true, timeout });
      await page.mouse.wheel(action.deltaX ?? 0, action.deltaY ?? 0);
      break;
    case 'type': // Trusted key events into the focused element.
      // Plain element.focus(): Playwright's locator.focus() leaves an empty
      // style attribute behind, which would be a harness-made DOM difference.
      if (action.id) await target.evaluate(e => e.focus());
      await page.keyboard.type(action.text);
      break;
    case 'choose': // Pick an option (input and change are dispatched).
      await target.selectOption(action.value, { timeout });
      break;
    case 'press':
      await page.keyboard.press(action.key);
      break;
    case 'reload': // The app starts again on the same localStorage.
      await page.reload({ waitUntil: 'load' });
      break;
    case 'resize': // The viewport changes size.
      await page.setViewportSize({ width: action.width, height: action.height });
      break;
    case 'emulate': // User preferences change (prefers-color-scheme, -reduced-motion, -contrast).
      await page.emulateMedia({
        ...(action.colorScheme && { colorScheme: action.colorScheme }),
        ...(action.reducedMotion && { reducedMotion: action.reducedMotion }),
        ...(action.contrast && { contrast: action.contrast }),
      });
      break;
    case 'wait': // Virtual time (the fake clock is installed for such cases).
      await page.clock.runFor(action.ms);
      break;
    case 'focus':
      await target.evaluate(e => e.focus());
      break;
    case 'blur': // An explicit scripted step, never used to settle focus.
      await target.blur({ timeout });
      break;
    case 'select':
      await target.evaluate((e, [s, end]) => e.setSelectionRange(s, end), [
        action.start,
        action.end,
      ]);
      break;
    default:
      throw new Error('Unknown action kind: ' + action.kind);
  }
}
const CSS = { escape: s => s.replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c) };

/**
 * Owns one Chromium instance for many runs. It uses the full Chromium build in
 * new headless mode (channel 'chromium'), not Playwright's default
 * chromium-headless-shell: the shell rounds glyph advances to whole pixels
 * (e.g. the editor's Clear button is 72 px wide instead of 70.625 px), while
 * full Chromium matches the historical headed Chromium references.
 */
export async function createBrowserHarness() {
  const { chromium } = await loadPlaywright();
  const started = performance.now();
  const instance = await chromium.launch({
    headless: true,
    channel: 'chromium',
  });
  const launchMs = performance.now() - started;
  return {
    launchMs,
    browserVersion: instance.version(),
    close: () => instance.close(),
    /**
     * Returns { steps: [{ action, dom, focused, geometry, screenshotPath, ms }] }
     * where step 0 is the initial state after mount.
     */
    async run(
      fixture,
      {
        viewport = { width: 800, height: 600 },
        actions = [],
        out,
        timeout = 5000,
        storage,
        timezone = 'UTC',
        locale = 'en-US',
        clock: fakeClock = false,
      } = {},
    ) {
      const name = path.basename(path.resolve(fixture));
      const folder = path.resolve(
        out ?? path.join(repo, 'artifacts/harness', name, `${viewport.width}x${viewport.height}`),
      );
      await mkdir(folder, { recursive: true });
      const t0 = performance.now();
      const server = await serveFixture(fixture);
      const serveMs = performance.now() - t0;
      // The case's time zone and default locale (Date, Intl), as the probe
      // and the interpreter get them (docs/design/M5-PLATFORM.md).
      const context = await instance.newContext({
        viewport,
        deviceScaleFactor: 1,
        timezoneId: timezone,
        locale,
      });
      const errors = [];
      try {
        // Full Chromium requests a favicon the fixtures do not have; answer it
        // so real 404s still surface as console errors.
        await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
        const page = await context.newPage();
        // localStorage items the case starts with.
        if (storage)
          await page.addInitScript(items => {
            // Once per tab: a reload keeps what the app stored.
            if (sessionStorage.getItem('runic-seeded')) return;
            sessionStorage.setItem('runic-seeded', '1');
            for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
          }, storage);
        // Cases with `wait` actions (or `clock: true`) run on Playwright's fake
        // clock, paused at the shared origin and advanced to 1000 ms before the
        // page loads (the native probe and the interpreter start their virtual
        // clocks there). Time then only advances through `wait`.
        const clock = fakeClock || actions.some(a => a.kind === 'wait');
        if (clock) {
          // pauseAt first: the clock starts paused at tick 0 (an install call
          // before it would let real time leak into the ticks when Playwright
          // replays its log in the page), then 1000 ms of virtual time.
          await page.clock.pauseAt(CLOCK_ORIGIN);
          await page.clock.runFor(1000);
        }
        // With the fake clock, animation frames only run in virtual time, so
        // settling waits for real rendering instead.
        const settle = () =>
          clock ? new Promise(r => setTimeout(r, 50)) : page.evaluate(twoFrames);
        page.setDefaultTimeout(timeout);
        page.on('pageerror', e => errors.push({ kind: 'pageerror', message: e.message }));
        page.on('console', m => m.type() === 'error' && errors.push({ kind: 'console', message: m.text() }));
        const t1 = performance.now();
        await page.goto(server.url, { waitUntil: 'load' });
        await page.waitForFunction(() => document.getElementById('root')?.childNodes.length > 0);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        // Hide the caret with a head stylesheet: Playwright's caret:'hide'
        // leaves an empty style attribute on the focused element.
        await page.addStyleTag({ content: '* { caret-color: transparent !important; }' });
        await settle();
        const mountMs = performance.now() - t1;
        const steps = [];
        const observe = async (action, index, timing) => {
          let t = performance.now();
          const snapshot = await page.evaluate(pageSnapshot);
          timing.snapshotMs = performance.now() - t;
          const screenshotPath = path.join(folder, `step-${String(index).padStart(3, '0')}.png`);
          t = performance.now();
          await page.screenshot({ path: screenshotPath, caret: 'initial' });
          timing.screenshotMs = performance.now() - t;
          steps.push({ action, ...snapshot, screenshotPath, timing });
        };
        await observe(null, 0, {});
        for (const [i, action] of actions.entries()) {
          let t = performance.now();
          await perform(page, action, timeout);
          const actionMs = performance.now() - t;
          t = performance.now();
          await settle();
          await observe(action, i + 1, { actionMs, settleMs: performance.now() - t });
        }
        return {
          fixture: name,
          framework: server.framework,
          frameworkVersion: server.version,
          browserVersion: instance.version(),
          viewport,
          timings: { serveMs, mountMs },
          errors,
          steps,
        };
      } finally {
        await context.close();
        await server.close();
      }
    },
  };
}

/** One-shot convenience: launch, run one fixture, clean up. */
export async function runFixture(fixture, options = {}) {
  const harness = await createBrowserHarness(options);
  try {
    const result = await harness.run(fixture, options);
    result.timings.launchMs = harness.launchMs;
    return result;
  } finally {
    await harness.close();
  }
}

// CLI: node conformance/harness/browser.mjs <fixture> [--actions JSON] [--viewport WxH]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => {
    const i = args.indexOf('--' + name);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  const actionsArg = option('actions'),
    viewportArg = option('viewport') ?? '800x600';
  const fixture = args[0];
  if (!fixture) {
    console.error('usage: browser.mjs <fixture> [--actions JSON] [--viewport WxH]');
    process.exit(2);
  }
  const [width, height] = viewportArg.split('x').map(Number);
  // Default: click the first button under #root.
  const actions = actionsArg
    ? JSON.parse(actionsArg)
    : [{ kind: 'click', selector: '#root button >> nth=0' }];
  const stop = () => process.exit(130);
  process.once('SIGINT', stop).once('SIGTERM', stop);
  console.log(
    JSON.stringify(
      await runFixture(fixture, { viewport: { width, height }, actions }),
      null,
      2,
    ),
  );
}
