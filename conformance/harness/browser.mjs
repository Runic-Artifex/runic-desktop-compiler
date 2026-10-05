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
import { copyFile, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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

/** Kit builds of this process, by fixture and source hash. */
const kitBuilds = new Map();

/** The files of a fixture directory (sources only), relative, sorted. */
async function sourceFiles(dir, rel = '') {
  const out = [];
  for (const entry of (await readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (['node_modules', '.svelte-kit', 'build', 'dist'].includes(entry.name)) continue;
    const r = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(dir, r)));
    else out.push(r);
  }
  return out;
}

/**
 * A SvelteKit fixture runs as the real Kit app: a copy of it (under
 * .cache/conformance/kit/) is built by Kit with the fixture's own Vite and
 * Svelte configs (adapter-static with an SPA fallback page), and the build
 * is served with that fallback for every path that is not a file.
 */
async function serveKitFixture(root, config) {
  const files = await sourceFiles(root);
  const digest = createHash('sha256');
  for (const f of files) digest.update(f).update(await readFile(path.join(root, f)));
  const key = `${root}\0${digest.digest('hex')}`;
  let site = kitBuilds.get(key);
  if (!site) {
    const work = path.join(repo, '.cache/conformance/kit', path.basename(root));
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    for (const f of files) {
      await mkdir(path.dirname(path.join(work, f)), { recursive: true });
      await copyFile(path.join(root, f), path.join(work, f));
    }
    // Kit reads svelte.config.js from the working directory.
    const r = spawnSync(process.execPath, [path.join(repo, 'node_modules/vite/bin/vite.js'), 'build'], {
      cwd: work,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    });
    if (r.status !== 0) throw new Error(`Kit build of ${root} failed:\n${r.stdout}\n${r.stderr}`);
    site = path.join(work, 'build');
    kitBuilds.set(key, site);
  }
  const types = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' };
  const server = createHttpServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(site, pathname);
    if (!file.startsWith(site)) file = path.join(site, 'index.html');
    let body;
    try {
      body = await readFile(file);
    } catch {
      file = path.join(site, 'index.html');
      body = await readFile(file);
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  });
  const port = await freePort();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}/`,
    framework: 'sveltekit',
    version: JSON.parse(await readFile(path.join(repo, 'node_modules/@sveltejs/kit/package.json'), 'utf8')).version,
    // The element Kit mounts in: app.html's <div …>%sveltekit.body%</div>.
    container: 'body > div',
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/** Starts a Vite dev server for an original fixture on a free loopback port. */
export async function serveFixture(fixture) {
  const root = await realpath(fixture);
  const config = JSON.parse(await readFile(path.join(root, 'runic.json'), 'utf8'));
  if (config.kit) return serveKitFixture(root, config);
  const tooling = await frontendTooling(root, config);
  const server = await createServer({
    root,
    cacheDir: path.join(repo, '.cache/vite-references', path.basename(root)),
    configFile: false,
    plugins: tooling.plugins,
    // A concrete port: the injected Vite client derives its WebSocket port
    // from the configured one, and port 0 would make it fail to connect.
    // forwardConsole off: Vite turns it on when it detects a coding agent in
    // the environment, wrapping console.warn/error in the page (the calls
    // would then come from Vite's client instead of the app).
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true, forwardConsole: false },
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

/**
 * The snapshot of the app's container (`#root`, or a SvelteKit app's
 * mount element, `container`). In a Kit container the bootstrap that
 * app.html's `%sveltekit.body%` became (a <script> element and the
 * whitespace around it, before the app's nodes) is Kit's static page,
 * not app DOM, and is left out; the native app has no such nodes.
 */
function pageSnapshot(container) {
  const root = container ? document.querySelector(container) : document.getElementById('root');
  const active = document.activeElement;
  const bootstrap = new Set();
  if (container)
    for (const c of root.childNodes) {
      if (c.nodeType === Node.ELEMENT_NODE && c.localName === 'script') bootstrap.add(c);
      else if (c.nodeType === Node.TEXT_NODE && !c.data.trim()) bootstrap.add(c);
      else if (c.nodeType !== Node.COMMENT_NODE) break;
    }
  const node = n => {
    if (bootstrap.has(n)) return null;
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
  // Content mounted in the body after the container (portals, M6): the
  // page's own scripts and whitespace are not app content.
  const after = [];
  for (let c = root.nextSibling; c; c = c.nextSibling) {
    if (c.nodeType === Node.ELEMENT_NODE && c.localName === 'script') continue;
    if (c.nodeType === Node.TEXT_NODE && !c.data.trim()) continue;
    const n = node(c);
    if (n) after.push(n);
  }
  const geometry = {};
  const portalElements = [];
  for (let c = root.nextElementSibling; c; c = c.nextElementSibling)
    if (c.localName !== 'script') portalElements.push(c, ...c.querySelectorAll('[id]'));
  for (const e of [root, ...root.querySelectorAll('[id]'), ...portalElements]) {
    if (!e.id) continue;
    const r = e.getBoundingClientRect();
    geometry[e.id] = { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  const html = Object.fromEntries(
    [...document.documentElement.attributes].map(a => [a.name, a.value]).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return {
    ...(Object.keys(html).length ? { document: html } : {}),
    dom: node(root),
    ...(after.length ? { portals: after } : {}),
    focused: active === document.body || !active ? null : active.id || active.localName,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    geometry,
  };
}

/** The location and history length (host snapshot fields; clipboard text is read separately), and the title where tracked. */
function pageLocation(title) {
  return {
    href: location.href.slice(location.origin.length),
    historyLength: history.length,
    ...(title ? { title: document.title } : {}),
  };
}

/**
 * Whether a script URL is the app's own source (not the framework's
 * dependencies or Vite's client): console lines and random values of app
 * code are the app's host effects.
 */
function appSource(url, origin) {
  try {
    const u = new URL(url);
    return (
      u.origin === origin &&
      !u.pathname.startsWith('/@') &&
      !u.pathname.includes('/node_modules/') &&
      !u.pathname.includes('/.cache/')
    );
  } catch {
    return false;
  }
}

/**
 * The host section of a step snapshot (docs/design/M5-PLATFORM.md): console
 * lines since the last step, clipboard text, location and history length,
 * each omitted at its default, in the order the probe and interpreter use.
 */
export function hostSnapshot({
  console: lines = [],
  clipboard = '',
  href = '/',
  historyLength = 1,
  title = '',
}) {
  const host = {};
  if (lines.length) host.console = lines;
  if (clipboard !== '') host.clipboard = clipboard;
  if (href !== '/') host.href = href;
  if (historyLength !== 1) host.historyLength = historyLength;
  // document.title (programs that set it; M6).
  if (title !== '') host.title = textJson(title);
  return Object.keys(host).length ? host : undefined;
}

/** Text as snapshot JSON: a string, or its UTF-16 code units when it holds a lone surrogate. */
const textJson = s =>
  s.isWellFormed() ? s : { units: Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)) };

/**
 * The seeded generator replacing `Math.random` and `crypto.randomUUID` for
 * app code (runic_js::random: SplitMix64; a number is the top 53 bits over
 * 2^53, a UUID two outputs big-endian with the version 4 and variant bits).
 * Calls from the framework's dependencies and Vite's client keep the real
 * functions, so they do not shift the app's sequence. An init script: the
 * emulation is part of the case environment, like the fake clock.
 */
function seedRandomness([seed, appSourceText]) {
  // eslint-disable-next-line no-new-func
  const appSource = new Function(`return (${appSourceText})`)();
  let state = BigInt.asUintN(64, BigInt(seed));
  const next = () => {
    state = BigInt.asUintN(64, state + 0x9e3779b97f4a7c15n);
    let z = state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return z ^ (z >> 31n);
  };
  // The first script frame with a URL above the replaced function.
  const fromApp = () => {
    for (const line of new Error().stack.split('\n').slice(1)) {
      const m = /(https?:\/\/[^\s()]+?):\d+:\d+\)?$/.exec(line.trim());
      if (m) return appSource(m[1], location.origin);
    }
    return false;
  };
  const random = Math.random;
  const randomUUID = crypto.randomUUID.bind(crypto);
  Math.random = function random_() {
    return fromApp() ? Number(next() >> 11n) / 2 ** 53 : random();
  };
  crypto.randomUUID = function randomUUID_() {
    if (!fromApp()) return randomUUID();
    const hex = (next().toString(16).padStart(16, '0') + next().toString(16).padStart(16, '0')).split('');
    hex[12] = '4';
    hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    const h = hex.join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
}

/**
 * Records the text of each fulfilled `navigator.clipboard.writeText`, from
 * the case's initial text: reading the clipboard needs a focused document,
 * and an app may move focus out of it (Tab past the last control). The
 * recorder adds one reaction ahead of the app's, which runs nothing the app
 * observes. Where the document has focus, the snapshot checks the record
 * against the clipboard (`clipboardState`).
 */
function trackClipboard(initial) {
  const clipboard = navigator.clipboard;
  const writeText = clipboard.writeText.bind(clipboard);
  window.__runicClipboard = String(initial).toWellFormed();
  Object.defineProperty(clipboard, 'writeText', {
    configurable: true,
    writable: true,
    value: function writeText_(data) {
      const p = writeText(data);
      // Chromium stores well-formed text (lone surrogates become U+FFFD).
      p.then(
        () => (window.__runicClipboard = String(data).toWellFormed()),
        () => {},
      );
      return p;
    },
  });
}

/** The clipboard text: the record, checked against the clipboard where it can be read. */
async function clipboardState() {
  const recorded = window.__runicClipboard;
  if (!document.hasFocus()) return { recorded };
  return { recorded, actual: await navigator.clipboard.readText() };
}

/** `Date.now()` at clock time 0 (shared with the probe and the interpreter). */
const CLOCK_ORIGIN = 1_767_225_600_000;

/** Clock time when the app starts (the probe's and the interpreter's `CLOCK_START`). */
const CLOCK_START = 1000;

/**
 * The page's CSS animations and transitions on virtual time
 * (docs/design/M6-LIBRARIES.md#animations). Playwright's fake clock does
 * not move Chromium's document timeline, which follows real frames, so the
 * harness stops the timeline (DevTools' `Animation.setPlaybackRate(0)`)
 * and seeks every animation to the virtual time since the harness first
 * saw it. Animations are looked for after the page loads and around every
 * action, and during waits at every frame (each multiple of 16 ms of
 * virtual time) when the page's CSS is time-based: the native probe
 * resolves styles at the same points, so both start an animation at the
 * same virtual time and sample it at the same times. `document.getAnimations()`
 * also brings styles up to date, which creates the transitions and
 * animations a style change starts.
 */
function seekAnimations(now) {
  const seen = (window.__runicAnimations ??= new WeakMap());
  const timeline = document.timeline.currentTime;
  if (window.__runicTimeline !== undefined && window.__runicTimeline !== timeline)
    throw new Error(`The document timeline moved (${window.__runicTimeline} to ${timeline}); it must stand still`);
  window.__runicTimeline = timeline;
  for (const a of document.getAnimations()) {
    if (!seen.has(a)) seen.set(a, now);
    a.currentTime = now - seen.get(a);
  }
}

/** Whether the page's stylesheets hold keyframes or animation or transition declarations. */
function timeBasedCss() {
  const rules = list =>
    [...list].some(
      r =>
        r instanceof CSSKeyframesRule ||
        (r.style && /(^|[\s;])(animation|transition)[\w-]*:/.test(r.style.cssText)) ||
        (r.cssRules && rules(r.cssRules)),
    );
  return [...document.styleSheets].some(s => rules(s.cssRules));
}

const twoFrames = () =>
  new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/**
 * A loaded document (the first load and every reload): the app has
 * rendered and its fonts are ready, and the caret is hidden with a head
 * stylesheet (Playwright's caret:'hide' leaves an empty style attribute on
 * the focused element). A reload used to skip this, so its snapshot could
 * catch the fallback font.
 */
async function loaded(page) {
  const container = page.__runicContainer;
  if (container)
    // A SvelteKit app: its first element besides Kit's bootstrap script.
    await page.waitForFunction(
      c => [...(document.querySelector(c)?.children ?? [])].some(e => e.localName !== 'script'),
      container,
    );
  else await page.waitForFunction(() => document.getElementById('root')?.childNodes.length > 0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.addStyleTag({ content: '* { caret-color: transparent !important; }' });
}

// --- Actions ---

async function perform(page, action, timeout, time) {
  const target = action.id
    ? page.locator('#' + CSS.escape(action.id))
    : action.selector
      ? page.locator(action.selector)
      : null;
  // Pointer actions aim at the element centre, or at `position` ({x, y}
  // from the top-left corner of the element's padding box, Playwright's
  // option; the probe computes the same point).
  const position = action.position;
  switch (action.kind) {
    case 'click': {
      // Real pointer input at the element centre. A disabled control is still
      // clicked (force skips Playwright's wait-for-enabled); the browser then
      // naturally ignores it, matching what a user would see.
      const force = await target.isDisabled({ timeout });
      await target.click({ force, timeout, position });
      break;
    }
    case 'dblclick':
    case 'contextmenu': {
      const force = await target.isDisabled({ timeout });
      if (action.kind === 'dblclick') await target.dblclick({ force, timeout, position });
      else await target.click({ button: 'right', force, timeout, position });
      break;
    }
    case 'hover': // The pointer moves to the element centre.
      await target.hover({ force: true, timeout, position });
      break;
    case 'wheel': // A wheel turn over the element centre.
      await target.hover({ force: true, timeout, position });
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
      await loaded(page);
      await time.loaded();
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
      await time.wait(action.ms);
      break;
    case 'focus':
      await target.evaluate(e => e.focus());
      break;
    case 'back': // The user traverses the session history.
      await page.goBack();
      break;
    case 'forward':
      await page.goForward();
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
        trackTitle = false,
        url = '/',
        clipboard = '',
        seed = 1,
      } = {},
    ) {
      const name = path.basename(path.resolve(fixture));
      const folder = path.resolve(
        out ?? path.join(repo, 'artifacts/harness', name, `${viewport.width}x${viewport.height}`),
      );
      await mkdir(folder, { recursive: true });
      if (!url.startsWith('/') || url.startsWith('//'))
        throw new Error(`The case url must be a path, found ${url}`);
      if (!Number.isSafeInteger(seed) || seed < 0)
        throw new Error(`The case seed must be a non-negative integer, found ${seed}`);
      const t0 = performance.now();
      const server = await serveFixture(fixture);
      const serveMs = performance.now() - t0;
      // The case's time zone and default locale (Date, Intl), as the probe
      // and the interpreter get them (docs/design/M5-PLATFORM.md); the app
      // may use the clipboard (a desktop app's permission).
      const context = await instance.newContext({
        viewport,
        deviceScaleFactor: 1,
        timezoneId: timezone,
        locale,
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      const errors = [];
      try {
        // Full Chromium requests a favicon the fixtures do not have; answer it
        // so real 404s still surface as console errors.
        await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
        // The clipboard is the browser's, shared by every run: it starts with
        // the case's text, written from a blank page of the app's origin.
        const blank = server.url + '__runic_clipboard';
        await context.route(blank, route =>
          route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }),
        );
        const seeder = await context.newPage();
        await seeder.goto(blank);
        await seeder.evaluate(text => navigator.clipboard.writeText(text), clipboard);
        await seeder.close();
        const page = await context.newPage();
        await page.addInitScript(seedRandomness, [seed, appSource.toString()]);
        await page.addInitScript(trackClipboard, clipboard);
        page.__runicContainer = server.container;
        // Fetches in flight (settling waits for them), counted without
        // changing the promise the app gets.
        if (server.container)
          await page.addInitScript(() => {
            const fetch = window.fetch;
            window.__runicFetches = 0;
            window.fetch = function fetch_(...args) {
              const p = fetch.apply(this, args);
              window.__runicFetches++;
              const done = () => {
                window.__runicFetches--;
              };
              p.then(done, done);
              return p;
            };
          });
        // localStorage items the case starts with.
        if (storage)
          await page.addInitScript(items => {
            // Once per tab: a reload keeps what the app stored.
            if (sessionStorage.getItem('runic-seeded')) return;
            sessionStorage.setItem('runic-seeded', '1');
            for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
          }, storage);
        // CSS animations on virtual time (seekAnimations): the document
        // timeline stands still, for this page's documents and reloads. The
        // Animation domain is not enabled: it is not needed for this, and
        // with it Playwright's clock installation below became slow enough
        // for real time to leak into the fake performance.now() (timers case).
        const cdp = await context.newCDPSession(page);
        await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
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
        const settleFrames = () =>
          clock ? new Promise(r => setTimeout(r, 50)) : page.evaluate(twoFrames);
        // A SvelteKit app may wait for a fetch (version.json before an
        // error page): settling also waits for the fetches in flight.
        const settle = async () => {
          await settleFrames();
          if (!server.container) return;
          let waited = false;
          while (await page.evaluate(() => window.__runicFetches > 0)) {
            waited = true;
            await new Promise(r => setTimeout(r, 10));
          }
          if (waited) await settleFrames();
        };
        const time = {
          now: CLOCK_START,
          stepped: false,
          seek() {
            return page.evaluate(seekAnimations, this.now);
          },
          /** A document loaded: its animations start now. */
          async loaded() {
            this.stepped = await page.evaluate(timeBasedCss);
            await this.seek();
          },
          /** Advance virtual time by `ms`, frame by frame when the CSS is time-based. */
          async wait(ms) {
            const to = this.now + ms;
            await this.seek();
            if (this.stepped)
              for (let frame = Math.floor(this.now / 16) * 16 + 16; frame <= to; frame += 16) {
                await page.clock.runFor(frame - this.now);
                this.now = frame;
                await this.seek();
              }
            // Also for no time left: a zero wait runs the timers due now.
            await page.clock.runFor(to - this.now);
            this.now = to;
            await this.seek();
          },
        };
        page.setDefaultTimeout(timeout);
        page.on('pageerror', e => errors.push({ kind: 'pageerror', message: e.message }));
        // Console lines of app code are host effects of the step (compared
        // like the DOM); other console errors (the framework's, failed
        // loads) remain harness errors.
        const origin = new URL(server.url).origin;
        const LEVELS = { log: 'log', info: 'info', warning: 'warn', error: 'error', debug: 'debug' };
        let lines = [];
        page.on('console', m => {
          if (appSource(m.location().url, origin))
            lines.push({ level: LEVELS[m.type()] ?? m.type(), text: textJson(m.text()) });
          else if (m.type() === 'error') errors.push({ kind: 'console', message: m.text() });
        });
        const t1 = performance.now();
        // The app's document replaces the new page's initial entry, so the
        // session history starts with one entry, as a native app's does.
        const start = new URL(url.slice(1), server.url).href;
        await page.evaluate(u => location.replace(u), start).catch(() => {});
        await page.waitForURL(u => u.origin === origin, { waitUntil: 'load' });
        await loaded(page);
        await time.loaded();
        await settle();
        const mountMs = performance.now() - t1;
        const steps = [];
        const observe = async (action, index, timing) => {
          let t = performance.now();
          const snapshot = await page.evaluate(pageSnapshot, server.container);
          const clip = await page.evaluate(clipboardState);
          if ('actual' in clip && clip.actual !== clip.recorded)
            throw new Error(
              `The clipboard holds ${JSON.stringify(clip.actual)}, not the recorded ${JSON.stringify(clip.recorded)}`,
            );
          const host = hostSnapshot({
            console: lines,
            clipboard: clip.recorded,
            ...(await page.evaluate(pageLocation, trackTitle)),
          });
          lines = [];
          if (host) snapshot.host = host;
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
          // Animations that started since the last step start at this time.
          await time.seek();
          await perform(page, action, timeout, time);
          // Those the action started (a wait has sought its own).
          if (action.kind !== 'wait') await time.seek();
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
