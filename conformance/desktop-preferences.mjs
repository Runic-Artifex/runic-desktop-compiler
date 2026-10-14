#!/usr/bin/env node
// Desktop preferences (CSS slice 2b): `prefers-reduced-motion` and
// `prefers-contrast` as Chromium 153 reads them on Linux, against the
// runtime's reading (runic_runtime::desktop).
//
// Each scenario is a test desktop: an XSETTINGS manager on Xvfb (X11), or a
// settings portal and matching GSettings (keyfile backend) under a headless
// KWin (Wayland), on a private session bus. Chromium runs headful in it with
// GTK 3 or GTK 4 (the dev shell's, found through XDG_DATA_DIRS, loaded as a
// distribution's Chromium loads them) and reports what its media queries
// match, before and after the scenario's changes; the runtime's reader runs
// in the same environment. A preference the runtime reads must equal every
// Chromium variant's; one it cannot read is reported natively (counted, with
// whether the Chromium variants disagree).
//
// usage: node conformance/desktop-preferences.mjs [scenario…] [--json out.json] [--keep]

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { repository, targetDir } from '../compiler/codegen.mjs';
import { pixelMAE } from './harness/compare.mjs';
import { buildProbe, runProbe } from './harness/native.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { json: { type: 'string' }, keep: { type: 'boolean' } },
});

// The GTK libraries of the dev shell (their GSettings schemas are on
// XDG_DATA_DIRS).
const gtk = {};
for (const dir of (process.env.XDG_DATA_DIRS ?? '').split(':')) {
  const m = /^(\/nix\/store\/[^/]+-(gtk\+3|gtk4)-[\d.]+)\/share\/gsettings-schemas\//.exec(dir);
  if (m) gtk[m[2] === 'gtk4' ? 4 : 3] = path.join(m[1], 'lib');
}

const I = 'org.gnome.desktop.interface';
const A = 'org.gnome.desktop.a11y.interface';
const xs = (anim, theme) => [
  ...(anim === undefined ? [] : [['Gtk/EnableAnimations', typeof anim === 'string' ? 'string' : 'int', anim]]),
  ...(theme === undefined ? [] : [['Net/ThemeName', typeof theme === 'number' ? 'int' : 'string', theme]]),
];
const gnome = (anim, theme, hc = false) => ({ [I]: { 'enable-animations': anim, 'gtk-theme': theme }, [A]: { 'high-contrast': hc } });

// kind: x11 | wayland; desktop: XDG_CURRENT_DESKTOP; gtk: Chromium variants
// (the GTK versions on its library path); states: the test desktop's
// settings, the first before Chromium starts, the others changes (X11:
// XSETTINGS; Wayland: GSettings, served by the desktop's GTK portal backend
// (portal "real"), or the portal's namespaces (portal "fake", with
// `gsettings` for GSettings), or no portal (portal "none")).
const SCENARIOS = {
  'x11-no-manager': { kind: 'x11', desktop: 'GNOME', gtk: [[3], [4]], states: [null] },
  'x11-reduce': { kind: 'x11', desktop: 'GNOME', gtk: [[3], [4]], states: [xs(0, 'Adwaita')] },
  'x11-high-contrast': { kind: 'x11', desktop: 'XFCE', gtk: [[3], [4]], states: [xs(1, 'HighContrast')] },
  'x11-contrast-high-inverse': { kind: 'x11', desktop: 'X-Cinnamon', gtk: [[3]], states: [xs(0, 'ContrastHighInverse')] },
  'x11-other-desktop': { kind: 'x11', desktop: 'i3', gtk: [[3]], states: [xs(0, 'HighContrast')] },
  'x11-integer-theme': { kind: 'x11', desktop: 'GNOME', gtk: [[3]], states: [xs(5, 7)] },
  'x11-string-animations': { kind: 'x11', desktop: 'GNOME', gtk: [[3]], states: [xs('0', 'Adwaita')] },
  'x11-without-keys': { kind: 'x11', desktop: 'GNOME', gtk: [[3]], states: [[['Net/IconThemeName', 'string', 'Adwaita']]] },
  'x11-invalid-theme': { kind: 'x11', desktop: 'GNOME', gtk: [[3]], states: [xs(1, 'a/HighContrast')] },
  'x11-changes': {
    kind: 'x11',
    desktop: 'GNOME',
    gtk: [[3], [4]],
    states: [xs(1, 'Adwaita'), xs(0, 'HighContrast'), xs(1, 'Adwaita')],
  },
  'x11-replaced-theme': {
    kind: 'x11',
    desktop: 'GNOME',
    gtk: [[3]],
    states: [xs(1, 'HighContrast'), xs(1, ''), xs(1, 'HighContrast')],
  },
  'x11-manager-leaves': { kind: 'x11', desktop: 'GNOME', gtk: [[3], [4]], states: [xs(0, 'HighContrast'), 'release'] },
  'x11-manager-arrives': { kind: 'x11', desktop: 'GNOME', gtk: [[3]], states: ['late', xs(0, 'HighContrast')] },
  'x11-kde': { kind: 'x11', desktop: 'KDE', gtk: [[3]], states: [xs(0, 'HighContrast')] },
  'wayland-gnome-reduce': { kind: 'wayland', portal: 'real', desktop: 'GNOME', gtk: [[3], [3, 4]], states: [gnome(false, 'Adwaita')] },
  'wayland-gnome-theme': { kind: 'wayland', portal: 'real', desktop: 'GNOME', gtk: [[3], [3, 4]], states: [gnome(true, 'HighContrast')] },
  'wayland-gnome-a11y-high-contrast': {
    kind: 'wayland',
    portal: 'real',
    desktop: 'GNOME',
    gtk: [[3], [3, 4]],
    states: [gnome(true, 'Adwaita', true)],
  },
  'wayland-gtk3-portal': {
    kind: 'wayland',
    portal: 'real',
    desktop: 'GNOME',
    env: { GTK_USE_PORTAL: '1' },
    gtk: [[3], [3, 4]],
    states: [gnome(true, 'Adwaita', true)],
  },
  'wayland-sway': { kind: 'wayland', portal: 'real', desktop: 'sway', gtk: [[3], [4]], states: [gnome(false, 'HighContrast')] },
  'wayland-no-portal': { kind: 'wayland', portal: 'none', desktop: 'GNOME', gtk: [[3], [3, 4]], states: [gnome(false, 'HighContrast')] },
  'wayland-appearance-only': {
    kind: 'wayland',
    portal: 'fake',
    desktop: 'GNOME',
    gtk: [[3], [3, 4]],
    states: [{ 'org.freedesktop.appearance': { 'color-scheme': 0 } }],
    gsettings: gnome(false, 'HighContrast'),
  },
  'wayland-changes': {
    kind: 'wayland',
    portal: 'real',
    desktop: 'GNOME',
    gtk: [[3], [3, 4]],
    states: [gnome(true, 'Adwaita'), gnome(false, 'HighContrast'), gnome(true, 'Adwaita')],
  },
};

// The session services a test desktop may start: the accessibility bus and
// dconf, and with a real portal the portal and its GTK backend.
const BUS_SERVICES = ['org.a11y.Bus', 'ca.desrt.dconf'];
const PORTAL_SERVICES = [
  'org.freedesktop.portal.Desktop',
  'org.freedesktop.impl.portal.desktop.gtk',
  'org.freedesktop.impl.portal.PermissionStore',
  'org.freedesktop.portal.Documents',
];

const selected = positionals.length ? positionals.filter(p => SCENARIOS[p]) : Object.keys(SCENARIOS);

const children = new Set();
function start(cmd, args, env, { lines = false } = {}) {
  const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  child.stderrText = '';
  child.stderr.on('data', d => (child.stderrText += d));
  if (lines) {
    child.lines = [];
    child.waiters = [];
    createInterface({ input: child.stdout }).on('line', l => {
      child.lines.push(l);
      for (const w of child.waiters.splice(0)) w();
    });
  }
  return child;
}
const stop = child => child && child.exitCode === null && child.kill('SIGTERM');
process.on('exit', () => children.forEach(c => c.kill('SIGKILL')));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function line(child, predicate = () => true, timeout = 10000) {
  const end = Date.now() + timeout;
  let seen = 0;
  for (;;) {
    for (; seen < child.lines.length; seen++) if (predicate(child.lines[seen])) return child.lines[seen];
    if (Date.now() > end) throw new Error(`timed out waiting for ${child.spawnfile}: ${child.stderrText.slice(-400)}`);
    await Promise.race([new Promise(r => child.waiters.push(r)), sleep(100)]);
  }
}
async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) return false;
    await sleep(50);
  }
  return true;
}

// The reader and the test desktop.
const build = spawnSync(
  'node',
  ['compiler/cargo.mjs', 'build', '--offline', '-p', 'runic-runtime', '--example', 'desktop-settings'],
  { cwd: repository, stdio: 'inherit' },
);
if (build.status !== 0) process.exit(1);
const tool = path.join(targetDir, 'debug', 'examples', 'desktop-settings');

const scratch = mkdtempSync(path.join(os.tmpdir(), 'runic-desktop-'));
let display = 0;

function keyfile(dir, settings) {
  // GIO's keyfile backend: one group per schema path, GVariant text values.
  const groups = Object.entries(settings ?? {})
    .filter(([ns]) => ns.startsWith('org.gnome.'))
    .map(
      ([ns, keys]) =>
        `[${ns.replaceAll('.', '/')}]\n` +
        Object.entries(keys)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? `'${v}'` : v}`)
          .join('\n'),
    );
  mkdirSync(path.join(dir, 'glib-2.0', 'settings'), { recursive: true });
  writeFileSync(path.join(dir, 'glib-2.0', 'settings', 'keyfile'), groups.join('\n\n') + '\n');
}

async function desktopFor(name, scenario) {
  const dir = mkdtempSync(path.join(scratch, `${name}-`));
  const config = path.join(dir, 'config');
  mkdirSync(config, { recursive: true });
  const wayland = scenario.kind === 'wayland';
  const socket = `wayland-runic-${process.pid}-${display}`;
  const x = 140 + display++;
  const base = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    XDG_DATA_DIRS: process.env.XDG_DATA_DIRS,
    XDG_CONFIG_HOME: config,
    FONTCONFIG_FILE: process.env.FONTCONFIG_FILE,
    XDG_CURRENT_DESKTOP: scenario.desktop,
    NO_AT_BRIDGE: '1',
    ...(wayland
      ? { WAYLAND_DISPLAY: socket, XDG_SESSION_TYPE: 'wayland', GSETTINGS_BACKEND: 'keyfile' }
      : { DISPLAY: `:${x}`, XDG_SESSION_TYPE: 'x11' }),
    ...scenario.env,
  };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  // A private session bus that activates only the listed services (the
  // desktop's own would answer otherwise); they inherit its environment.
  const services = path.join(dir, 'services');
  mkdirSync(services);
  for (const data of (process.env.XDG_DATA_DIRS ?? '').split(':'))
    for (const service of [...BUS_SERVICES, ...(scenario.portal === 'real' ? PORTAL_SERVICES : [])]) {
      const file = path.join(data, 'dbus-1', 'services', `${service}.service`);
      if (existsSync(file) && !existsSync(path.join(services, `${service}.service`)))
        copyFileSync(file, path.join(services, `${service}.service`));
    }
  const busConfig = path.join(dir, 'bus.conf');
  writeFileSync(
    busConfig,
    `<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen><auth>EXTERNAL</auth><servicedir>${services}</servicedir>` +
      '<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>',
  );
  const bus = start('dbus-daemon', ['--config-file=' + busConfig, '--nofork', '--print-address=1'], base, { lines: true });
  const env = { ...base, DBUS_SESSION_BUS_ADDRESS: await line(bus) };
  const procs = [bus];
  let fake = null;
  if (!wayland) {
    procs.push(start('Xvfb', [`:${x}`, '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], process.env));
    if (!(await until(() => existsSync(`/tmp/.X11-unix/X${x}`)))) throw new Error('Xvfb did not start');
    if (scenario.states[0] !== null) {
      fake = start(tool, ['xsettings'], env, { lines: true });
      procs.push(fake);
    }
  } else {
    const kwin = start(
      'kwin_wayland',
      ['--virtual', '--width', '1024', '--height', '768', '--socket', socket, '--no-lockscreen', '--no-global-shortcuts'],
      env,
    );
    procs.push(kwin);
    if (!(await until(() => existsSync(path.join(process.env.XDG_RUNTIME_DIR, socket)), 15000)))
      throw new Error(`KWin did not start: ${kwin.stderrText.slice(-400)}`);
    if (scenario.portal === 'fake') {
      fake = start(tool, ['portal'], env, { lines: true });
      procs.push(fake);
    }
  }
  let applied = 0;
  const apply = async state => {
    if (wayland) {
      keyfile(config, scenario.portal === 'fake' ? scenario.gsettings : state);
      // GIO's keyfile backend notices the change through a file monitor.
      if (!fake) return sleep(500);
    }
    if (!fake) return;
    fake.stdin.write(JSON.stringify(state) + '\n');
    applied++;
    await line(fake, () => fake.lines.length >= applied);
  };
  if (scenario.states[0] !== 'late') await apply(scenario.states[0]);
  else if (!fake) throw new Error('late needs a manager');
  return { env, apply, close: () => procs.reverse().forEach(stop) };
}

async function chromiumRun(d, scenario, versions) {
  const env = { ...d.env, LD_LIBRARY_PATH: versions.map(v => gtk[v]).join(':') };
  const browser = await chromium.launch({ headless: false, channel: 'chromium', env, timeout: 30000 });
  try {
    // Playwright emulates no preference unless told not to emulate.
    const context = await browser.newContext({ reducedMotion: null, contrast: null, forcedColors: null, colorScheme: null });
    const page = await context.newPage();
    await page.setContent('<p>preferences</p>');
    const read = () =>
      page.evaluate(() => ({
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        contrastMore: matchMedia('(prefers-contrast: more)').matches,
      }));
    const readings = [await read()];
    for (const state of scenario.states.slice(1)) {
      await d.apply(state);
      // Chromium applies a change through GTK's notification and an IPC to
      // the renderer: give it time to settle.
      await sleep(1500);
      readings.push(await read());
    }
    return readings;
  } finally {
    await browser.close();
  }
}

async function runicRun(d, scenario) {
  const follow = (scenario.states.length - 1) * 1500 + 500;
  const reader = start(tool, ['read', String(follow)], d.env, { lines: true });
  await line(reader);
  const readings = [JSON.parse(reader.lines.at(-1))];
  for (const state of scenario.states.slice(1)) {
    await d.apply(state);
    await sleep(1500);
    readings.push(JSON.parse(reader.lines.at(-1)));
  }
  await new Promise(r => (reader.exitCode !== null ? r() : reader.on('exit', r)));
  return readings;
}

const results = {};
let passed = 0;
let reported = 0;
let failed = 0;
let incomplete = 0;
for (const name of selected) {
  const scenario = SCENARIOS[name];
  const row = (results[name] = { chromium: {}, runic: null, verdict: [] });
  try {
    // The runtime's reading, then each Chromium variant, each in a fresh
    // test desktop (a replaced theme name stays replaced per process).
    let d = await desktopFor(name, scenario);
    try {
      row.runic = await runicRun(d, scenario);
    } finally {
      d.close();
    }
    for (const versions of scenario.gtk) {
      const label = `gtk${versions.join('+')}`;
      if (versions.some(v => !gtk[v])) {
        row.chromium[label] = 'incomplete: GTK not found on XDG_DATA_DIRS';
        continue;
      }
      d = await desktopFor(name, scenario);
      try {
        row.chromium[label] = await chromiumRun(d, scenario, versions);
      } catch (e) {
        row.chromium[label] = `incomplete: ${String(e?.message ?? e).split('\n')[0]}`;
        const crash = /Received signal \d+ \S+/.exec(String(e?.message));
        if (crash) row.chromium[label] += ` (${crash[0]})`;
      } finally {
        d.close();
      }
    }
  } catch (e) {
    row.error = String(e?.stack ?? e);
    incomplete++;
    console.log(`${name}: INCOMPLETE ${row.error.slice(0, 3000)}`);
    continue;
  }
  // Compare per state and feature.
  for (const [label, r] of Object.entries(row.chromium))
    if (!Array.isArray(r)) {
      row.verdict.push(`Chromium ${label}: ${r}`);
      incomplete++;
    }
  for (const [i, runic] of row.runic.entries()) {
    for (const feature of ['reducedMotion', 'contrastMore']) {
      const browsers = Object.entries(row.chromium)
        .filter(([, r]) => Array.isArray(r))
        .map(([label, r]) => [label, r[i][feature]]);
      const ours = runic[feature];
      const tag = `state ${i} ${feature}`;
      if (!browsers.length) {
        row.verdict.push(`${tag}: incomplete`);
        incomplete++;
      } else if (typeof ours === 'object') {
        const differ = new Set(browsers.map(b => b[1])).size > 1;
        row.verdict.push(`${tag}: reported (${ours.unknown})${differ ? '; Chromium variants differ: ' + browsers.map(b => b.join('=')).join(', ') : '; Chromium ' + browsers[0][1]}`);
        reported++;
      } else if (browsers.every(b => b[1] === ours)) {
        row.verdict.push(`${tag}: ${ours} as Chromium`);
        passed++;
      } else {
        row.verdict.push(`${tag}: FAIL runtime ${ours}, Chromium ${browsers.map(b => b.join('=')).join(', ')}`);
        failed++;
      }
    }
  }
  console.log(`${name}:\n  ${row.verdict.join('\n  ')}`);
}

// End to end: the media-preferences fixture as a native app in a test
// desktop (its window grabbed from Xvfb) against its probe with the same
// preferences emulated (the probe against Chromium: run.mjs
// media-preferences --pixels); a report for each rule natively where a
// preference cannot be read, none where it can.
const NATIVE = {
  'native-x11-changes': {
    states: [xs(1, 'Adwaita'), xs(0, 'HighContrast'), xs(1, 'Adwaita')],
    emulated: [{}, { reducedMotion: 'reduce', contrast: 'more' }, { reducedMotion: 'no-preference', contrast: 'no-preference' }],
    reports: 0,
  },
  'native-x11-reduce-only': {
    states: [xs(0)],
    emulated: [{ reducedMotion: 'reduce' }],
    // The three rules on prefers-contrast that match an element.
    reports: 3,
  },
  'native-x11-no-manager': { states: [null], emulated: [{}], reports: 7 },
};
const nativeSelected = positionals.length ? positionals.filter(p => NATIVE[p]) : Object.keys(NATIVE);
if (nativeSelected.length) {
  const { binary } = await buildProbe(path.join(repository, 'fixtures/media-preferences-svelte'));
  for (const name of nativeSelected) {
    const n = NATIVE[name];
    const row = (results[name] = { verdict: [] });
    const shots = mkdtempSync(path.join(scratch, `${name}-`));
    try {
      const probe = path.join(shots, 'probe');
      runProbe(binary, {
        actions: n.emulated.slice(1).map(e => ({ kind: 'emulate', ...e })),
        out: probe,
      });
      // A first emulation, where the initial state has a preference.
      if (n.emulated[0].reducedMotion || n.emulated[0].contrast)
        runProbe(binary, { actions: [{ kind: 'emulate', ...n.emulated[0] }], out: path.join(shots, 'probe-first') });
      const d = await desktopFor(name, { kind: 'x11', desktop: 'GNOME', states: n.states });
      try {
        // The dev shell's libraries (X11, xkbcommon) that winit loads.
        const app = start(binary, ['--x11'], { ...d.env, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH });
        const grab = async i => {
          const file = path.join(shots, `native-${i}.png`);
          const shoot = () => {
            const r = spawnSync('magick', ['import', '-display', d.env.DISPLAY, '-window', 'root', '-crop', '800x600+0+0', '+repage', file]);
            if (r.status !== 0) throw new Error(`import failed: ${r.stderr}`);
            const mean = spawnSync('magick', [file, '-format', '%[fx:mean]', 'info:'], { encoding: 'utf8' });
            return Number(mean.stdout);
          };
          // The first frame (a debug build), then a frame after the change.
          if (i === 0) {
            const end = Date.now() + 30000;
            while (!(shoot() > 0)) {
              if (Date.now() > end) throw new Error(`no window: ${app.stderrText.slice(-400)}`);
              await sleep(500);
            }
          }
          await sleep(2000);
          shoot();
          return file;
        };
        for (const [i, state] of n.states.entries()) {
          if (i > 0) await d.apply(state);
          const native = await grab(i);
          const expected =
            i === 0
              ? n.emulated[0].reducedMotion || n.emulated[0].contrast
                ? path.join(shots, 'probe-first', 'step-001.png')
                : path.join(probe, 'step-000.png')
              : path.join(probe, `step-${String(i).padStart(3, '0')}.png`);
          const mae = pixelMAE(native, expected);
          row.verdict.push(`state ${i}: pixel MAE ${mae.toFixed(3)} against the probe emulating ${JSON.stringify(n.emulated[i])}`);
          if (mae === 0) passed++;
          else failed++;
        }
        stop(app);
        await new Promise(r => (app.exitCode !== null || app.signalCode ? r() : app.on('exit', r)));
        const reports = app.stderrText.split('\n').filter(l => /runic: unsupported: .*desktop/.test(l));
        row.reports = reports;
        row.verdict.push(`${reports.length} desktop preference reports (expected ${n.reports})`);
        if (reports.length === n.reports) passed++;
        else failed++;
      } finally {
        d.close();
      }
    } catch (e) {
      row.error = String(e?.stack ?? e);
      row.verdict.push(`INCOMPLETE ${row.error.split('\n')[0]}`);
      incomplete++;
    }
    console.log(`${name}:\n  ${row.verdict.join('\n  ')}`);
  }
}

console.log(`\n${passed} as Chromium (or as the emulating probe), ${reported} reported, ${failed} failed, ${incomplete} incomplete`);
if (values.json) writeFileSync(values.json, JSON.stringify(results, null, 2));
if (values.keep) console.log(`kept ${scratch}`);
else rmSync(scratch, { recursive: true, force: true });
process.exit(failed || incomplete ? 1 : 0);
