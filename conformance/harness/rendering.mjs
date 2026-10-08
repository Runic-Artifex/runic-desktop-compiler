// Pure HTML/CSS rendering oracle shared by layout and paint case families.
import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pixelMAE } from './compare.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Hold the same PID lock as native compiler builds while building and observing
// the probe: another worktree's claim can otherwise remove this binary mid-run.
const { targetDir } = await import('../../compiler/codegen.mjs');
const { withSharedTarget } = await import('../../compiler/target.mjs');
export async function runRenderingCases(cases, actions = {}, outName = 'tables', baseStyle = '') {
  for (const name of process.argv.slice(2)) {
    if (!Object.hasOwn(cases, name)) throw new Error(`Unknown rendering case ${name}`);
  }
  const out = path.join(root, 'artifacts', outName);
  await mkdir(out, { recursive: true });
  const font = (
    await readFile(path.join(root, 'fixtures/counter-svelte/assets/DejaVuSans.woff2'))
  ).toString('base64');
  const base = `<style>@font-face{font-family:Test;src:url(data:font/woff2;base64,${font})}body{margin:0;background:white;font:16px/20px Test}${baseStyle}</style>`;
  await withSharedTarget(async () => {
    const build = spawnSync(
      'cargo',
      ['build', '--offline', '-p', 'runic-blitz-probes', '--bin', 'table-probe'],
      {
        cwd: root,
        env: { ...process.env, CARGO_TARGET_DIR: targetDir },
        encoding: 'utf8',
      },
    );
    await writeFile(path.join(out, 'oracle-build.log'), build.stdout + build.stderr);
    if (build.status !== 0) throw new Error(`table probe build failed: ${build.stderr}`);
    const browser = await chromium.launch({ headless: true, channel: 'chromium' });
    let page = await browser.newPage({
      viewport: { width: 640, height: 300 },
      deviceScaleFactor: 1,
    });
    const sha256 = data => createHash('sha256').update(data).digest('hex');
    const repositories = new Set([root]);
    const manifest = await readFile(path.join(root, 'Cargo.toml'), 'utf8');
    for (const [, dependencyPath] of manifest.matchAll(/path\s*=\s*"([^"]+)"/g)) {
      const resolved = path.resolve(root, dependencyPath);
      const result = spawnSync('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      });
      if (result.status === 0) repositories.add(result.stdout.trim());
    }
    const source = [];
    for (const repository of [...repositories].sort()) {
      const git = args => spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
      const files = git(['ls-files', '--others', '--exclude-standard', '-z'])
        .stdout.split('\0')
        .filter(Boolean)
        .sort();
      const untracked = [];
      for (const file of files)
        untracked.push([file, sha256(await readFile(path.join(repository, file)))]);
      source.push({
        repository,
        revision: git(['rev-parse', 'HEAD']).stdout.trim(),
        diffSHA256: sha256(git(['diff', 'HEAD', '--binary']).stdout),
        untracked,
      });
    }
    await writeFile(
      path.join(out, 'metadata.json'),
      JSON.stringify(
        {
          chromium: browser.version(),
          viewport: [640, 300],
          deviceScaleFactor: 1,
          renderer: 'cpu',
          screenshotCaret: 'initial',
          fontSHA256: sha256(Buffer.from(font, 'base64')),
          cargoLockSHA256: sha256(await readFile(path.join(root, 'Cargo.lock'))),
          nativeBinarySHA256: sha256(await readFile(path.join(targetDir, 'debug/table-probe'))),
          geometryTolerance: 0.125,
          pixelMAEThreshold: 3,
          source,
        },
        null,
        2,
      ),
    );
    const results = [];
    async function reference() {
      return page.evaluate(() => {
        const elements = [...document.querySelectorAll('[id]')];
        return {
          lineWidths: Object.fromEntries(
            elements
              .filter(el => el.hasAttribute('data-line-widths'))
              .map(el => {
                const style = getComputedStyle(el);
                return [
                  el.id,
                  [
                    'borderTopWidth',
                    'borderRightWidth',
                    'borderBottomWidth',
                    'borderLeftWidth',
                    'outlineWidth',
                  ].map(property => parseFloat(style[property])),
                ];
              }),
          ),
          editors: Object.fromEntries(
            elements
              .filter(
                el =>
                  (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
                  el.selectionStart !== null,
              )
              .map(el => [
                el.id,
                [el.value, el.selectionStart, el.selectionEnd, document.activeElement === el],
              ]),
          ),
          scroll: Object.fromEntries(
            elements
              .filter(el => el.hasAttribute('data-scroll'))
              .map(el => [
                el.id,
                [
                  el.scrollLeft,
                  el.scrollTop,
                  el.scrollWidth,
                  el.scrollHeight,
                  el.clientWidth,
                  el.clientHeight,
                ],
              ]),
          ),
          rects: Object.fromEntries(
            elements.map(el => {
              const r = el.getBoundingClientRect();
              return [el.id, [r.x, r.y, r.width, r.height]];
            }),
          ),
          hits: Object.fromEntries(
            elements.map(el => {
              const r = el.getBoundingClientRect();
              return [
                el.id,
                [
                  [r.width / 2, r.height / 2],
                  [1, 1],
                  [r.width - 1, r.height - 1],
                ].map(
                  ([x, y]) =>
                    document.elementFromPoint(r.x + x, r.y + y)?.closest('[id]')?.id ?? null,
                ),
              ];
            }),
          ),
        };
      });
    }
    try {
      for (const [name, entry] of Object.entries(cases)) {
        if (process.argv.slice(2).length && !process.argv.slice(2).includes(name)) continue;
        const config = typeof entry === 'string' ? { html: entry } : entry;
        for (const [width, height, dpr = 1] of config.viewports ?? [[640, 300]]) {
          if (page.__oracleDPR !== dpr) {
            await page.close();
            page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
            page.__oracleDPR = dpr;
          }
          await page.setViewportSize({ width, height });
          const suffix = width === 640 && height === 300 ? '' : `-${width}x${height}`;
          const fileName = name + suffix + (dpr === 1 ? '' : `-dpr${dpr}`);
          const html =
            (config.doctype ?? (config.standards ? '<!doctype html>' : '')) + base + config.html;
          const input = path.join(out, `${fileName}.html`),
            nativePng = path.join(out, `${fileName}-native.png`);
          await writeFile(input, html);
          const mutations = config.actions ?? config.timeline ?? actions[name] ?? [];
          const proc = spawnSync(
            path.join(targetDir, 'debug/table-probe'),
            [
              input,
              nativePng,
              String(width),
              String(height),
              JSON.stringify(mutations),
              String(dpr),
            ],
            { encoding: 'utf8' },
          );
          if (proc.status !== 0) throw new Error(`${name}: ${proc.stderr}`);
          const observations = JSON.parse(proc.stdout.trim().split('\n').at(-1));
          await writeFile(
            path.join(out, `${fileName}-native.json`),
            JSON.stringify(observations, null, 2),
          );
          await page.setContent(html);
          await page.evaluate(() => document.fonts.ready);
          for (const requirement of config.browserStyleRequirements ?? []) {
            const value = await page.evaluate(
              ({ selector, property }) =>
                getComputedStyle(document.querySelector(selector))[property],
              requirement,
            );
            if (value !== requirement.value)
              throw new Error(`${name}: browser prerequisite ${requirement.property} was ${value}`);
          }
          if (config.timeline)
            await page.evaluate(() => {
              window.__oracleTime = 0;
              window.__oracleBirth = new WeakMap();
              for (const animation of document.getAnimations()) {
                window.__oracleBirth.set(animation, 0);
                animation.pause();
                animation.currentTime = 0;
              }
            });
          for (let step = 0; step <= mutations.length; step++) {
            if (step && mutations[step - 1].kind.startsWith('pointer')) {
              const action = mutations[step - 1];
              const rect = await page.locator(action.selector).boundingBox();
              if (!rect) throw new Error(`${name}: pointer target has no box`);
              await page.mouse.move(rect.x + action.x, rect.y + action.y);
              if (action.kind === 'pointerDown') await page.mouse.down();
              else if (action.kind === 'pointerUp') await page.mouse.up();
              else if (action.kind !== 'pointerMove')
                throw new Error(`Unknown renderer action ${action.kind}`);
            } else if (step)
              await page.evaluate(
                action => {
                  const el = document.querySelector(action.selector ?? 'html');
                  if (action.at !== undefined) window.__oracleTime = action.at;
                  if (action.kind === 'time' || action.kind === 'observe') {
                  } else if (action.kind === 'style') el.setAttribute('style', action.value);
                  else if (action.kind === 'html') el.innerHTML = action.value;
                  else if (action.kind === 'attribute') el.setAttribute(action.name, action.value);
                  else if (action.kind === 'scroll') el.scrollTo(action.x ?? 0, action.y ?? 0);
                  else if (action.kind === 'focus') el.focus({ preventScroll: true });
                  else if (action.kind === 'selection')
                    el.setSelectionRange(action.start, action.end);
                  else if (action.kind === 'scrollIntoView')
                    el.scrollIntoView({
                      block: action.block ?? 'nearest',
                      inline: action.inline ?? 'nearest',
                      behavior: 'instant',
                    });
                  else throw new Error(`Unknown renderer action ${action.kind}`);
                  if (window.__oracleBirth) {
                    // Resolve the mutation first: new CSSAnimation objects begin
                    // at this action's clock; surviving ones keep their start.
                    void el.offsetWidth;
                    for (const animation of document.getAnimations()) {
                      if (!window.__oracleBirth.has(animation))
                        window.__oracleBirth.set(animation, window.__oracleTime);
                      animation.pause();
                      animation.currentTime =
                        window.__oracleTime - window.__oracleBirth.get(animation);
                    }
                  }
                },
                mutations[step - 1],
              );
            const browserPng = path.join(out, `${fileName}-chrome${step ? `-${step}` : ''}.png`);
            const nativeScreenshot = step ? nativePng.replace('.png', `-${step}.png`) : nativePng;
            await page.screenshot({ path: browserPng, caret: 'initial' });
            const expected = await reference(),
              observation = observations[step];
            await writeFile(
              path.join(out, `${fileName}-chrome${step ? `-${step}` : ''}.json`),
              JSON.stringify(expected, null, 2),
            );
            const differences = [];
            const lineWidthDifferences = Object.entries(expected.lineWidths)
              .filter(
                ([id, values]) =>
                  !observation.lineWidths?.[id] ||
                  values.some((v, i) => Math.abs(v - observation.lineWidths[id][i]) > 0.02),
              )
              .map(([id, reference]) => ({ id, reference, native: observation.lineWidths?.[id] }));
            for (const [id, rect] of Object.entries(expected.rects)) {
              if (!observation.rects[id]) {
                differences.push({ id, missing: true });
                continue;
              }
              const error = Math.max(...rect.map((v, i) => Math.abs(v - observation.rects[id][i])));
              if (error > 0.125)
                differences.push({ id, reference: rect, native: observation.rects[id], error });
            }
            const hitDifferences = Object.entries(expected.hits)
              .filter(
                ([id, value]) => JSON.stringify(value) !== JSON.stringify(observation.hits[id]),
              )
              .map(([id, reference]) => ({ id, reference, native: observation.hits[id] }));
            const scrollDifferences = Object.entries(expected.scroll)
              .filter(
                ([id, values]) =>
                  !observation.scroll[id] ||
                  values.some((v, i) => Math.abs(v - observation.scroll[id][i]) > 0.125),
              )
              .map(([id, reference]) => ({ id, reference, native: observation.scroll[id] }));
            const editorDifferences = [
              ...new Set([...Object.keys(expected.editors), ...Object.keys(observation.editors)]),
            ]
              .filter(
                id =>
                  JSON.stringify(expected.editors[id]) !== JSON.stringify(observation.editors[id]),
              )
              .map(id => ({
                id,
                reference: expected.editors[id],
                native: observation.editors[id],
              }));
            // Include a local metric so white page area cannot conceal table paint errors.
            const tableRect = expected.rects[config.region ?? 'table'],
              nativeRect = observation.rects[config.region ?? 'table'];
            const cropWidth = Math.min(
              width,
              Math.ceil(Math.max(tableRect[0] + tableRect[2], nativeRect[0] + nativeRect[2])) + 2,
            );
            const cropHeight = Math.min(
              height,
              Math.ceil(Math.max(tableRect[1] + tableRect[3], nativeRect[1] + nativeRect[3])) + 2,
            );
            const cropped = [];
            for (const file of [browserPng, nativeScreenshot]) {
              const crop = file.replace('.png', '-crop.png');
              const result = spawnSync(
                'magick',
                [
                  file,
                  '-crop',
                  `${Math.ceil(cropWidth * dpr)}x${Math.ceil(cropHeight * dpr)}+0+0`,
                  '+repage',
                  crop,
                ],
                { encoding: 'utf8' },
              );
              if (result.status) throw new Error(result.stderr);
              cropped.push(crop);
            }
            const mae = pixelMAE(browserPng, nativeScreenshot),
              tablePixelMAE = pixelMAE(...cropped);
            const localPixelMAEs = {};
            for (const id of config.regions ?? []) {
              const a = expected.rects[id],
                b = observation.rects[id];
              if (!a || !b) throw new Error(`Missing pixel region ${id}`);
              const x = Math.max(0, Math.floor(Math.min(a[0], b[0]) * dpr));
              const y = Math.max(0, Math.floor(Math.min(a[1], b[1]) * dpr));
              const right = Math.min(
                Math.round(width * dpr),
                Math.ceil(Math.max(a[0] + a[2], b[0] + b[2]) * dpr),
              );
              const bottom = Math.min(
                Math.round(height * dpr),
                Math.ceil(Math.max(a[1] + a[3], b[1] + b[3]) * dpr),
              );
              if (right <= x || bottom <= y) {
                localPixelMAEs[id] = null;
                continue;
              }
              const pair = [browserPng, nativeScreenshot].map(file => {
                const crop = file.replace('.png', `-region-${id}.png`);
                const result = spawnSync(
                  'magick',
                  [file, '-crop', `${right - x}x${bottom - y}+${x}+${y}`, '+repage', crop],
                  { encoding: 'utf8' },
                );
                if (result.status) throw new Error(result.stderr);
                return crop;
              });
              localPixelMAEs[id] = pixelMAE(...pair);
            }
            const result = {
              name,
              viewport: [width, height],
              deviceScaleFactor: dpr,
              suite:
                config.suite ??
                (name.startsWith('glyph_')
                  ? 'glyphs'
                  : name.startsWith('border_')
                    ? 'borders'
                    : 'tables'),
              inputSHA256: sha256(html),
              step,
              geometry: differences.length === 0,
              pixelMAE: mae,
              tablePixelMAE,
              localPixelMAEs,
              differences,
              hitDifferences,
              editorDifferences,
              scrollDifferences,
              lineWidthDifferences,
            };
            results.push(result);
            console.log(JSON.stringify(result));
          }
        }
      }
    } finally {
      await browser.close();
    }
    await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
    if (
      results.some(
        r =>
          !r.geometry ||
          r.tablePixelMAE > 3 ||
          Object.values(r.localPixelMAEs).some(v => v > 3) ||
          r.hitDifferences.length ||
          r.editorDifferences.length ||
          r.scrollDifferences.length ||
          r.lineWidthDifferences.length,
      )
    )
      process.exitCode = 1;
  });
}
