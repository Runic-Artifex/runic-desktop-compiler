// Images as pinned build assets, step 2 (docs/design/M6-IMAGES.md):
// `runic images` fetches each remote image URL once into a committed record
// and files; builds check the record (stale, extra, altered, missing, unknown
// files) and resolve root-relative URLs in the app's static directory. No
// adapter yields image URLs yet, so the tests inject them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { check, emit } from '../compiler/codegen.mjs';
import { fetchImages, pinImages, RECORD, sniff } from '../compiler/images.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);
const SVG = Buffer.from(
  '<?xml version="1.0"?>\n<!-- x -->\n<svg xmlns="http://www.w3.org/2000/svg"/>',
);

let server;
let base;
let requests = [];
before(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url);
    const send = (type, body) => {
      res.writeHead(200, type ? { 'content-type': type } : {});
      res.end(body);
    };
    switch (req.url) {
      case '/a.png':
        return send('image/png', PNG);
      case '/b.jpg':
        return send('image/jpeg; charset=binary', JPEG);
      case '/untyped.png':
        return send('application/octet-stream', PNG);
      case '/missing.png':
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<p>not found</p>');
      case '/moved.png':
        res.writeHead(302, { location: '/a.png' });
        return res.end();
      case '/lying.png':
        return send('image/jpeg', PNG);
      case '/page.html':
        return send('text/html', '<!doctype html><p>no image</p>');
      case '/huge.png': {
        // No Content-Length: the limit applies while reading.
        res.writeHead(200, { 'content-type': 'image/png' });
        res.write(PNG);
        const chunk = Buffer.alloc(1 << 20);
        let sent = 0;
        const more = () => {
          while (sent < 6) {
            sent++;
            if (!res.write(chunk)) return res.once('drain', more);
          }
          res.end();
        };
        res.on('error', () => {});
        return more();
      }
      case '/declared-huge.png':
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(5 << 20) });
        res.on('error', () => {});
        return res.end(PNG);
      default:
        res.writeHead(500);
        return res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const source = (line = 1) => ({ file: 'src/App.svelte', line, column: 3 });
const urls = (...list) => list.map((url, i) => ({ url, source: source(i + 1) }));

/** A fresh app directory (only what images need), removed afterwards. */
async function withApp(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'runic-images-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const failWith = (file, pattern, line) => e =>
  (e instanceof Diagnostic &&
    e.code === 'E_ASSET' &&
    e.source?.file === file &&
    (line === undefined || e.source.line === line) &&
    pattern.test(e.message)) ||
  assert.fail(
    `expected E_ASSET in ${file}, got ${e.code} ${JSON.stringify(e.source)}: ${e.message}`,
  );

const font = { path: 'assets/f.woff2', sha256: 'f'.repeat(64), bytes: 4, mime: 'font/woff2' };
const program = () => ({ assets: [{ ...font }], images: [], irHash: 'adapter' });

test('sniffs the accepted image types from their bytes', () => {
  assert.equal(sniff(PNG), 'image/png');
  assert.equal(sniff(JPEG), 'image/jpeg');
  assert.equal(sniff(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniff(SVG), 'image/svg+xml');
  assert.equal(sniff(Buffer.from('<!doctype html><svg>')), undefined);
  assert.equal(sniff(Buffer.from('BM....')), undefined);
});

test('runic images pins each URL once, deterministically, and builds check the record', () =>
  withApp(async root => {
    const list = urls(
      `${base}/moved.png`,
      `${base}/a.png`,
      `${base}/b.jpg`,
      `${base}/missing.png`,
      `${base}/untyped.png`,
      `${base}/a.png`,
    );
    requests = [];
    const summary = await fetchImages(root, { imageUrls: list });
    assert.deepEqual(
      requests.sort(),
      ['/a.png', '/a.png', '/b.jpg', '/missing.png', '/moved.png', '/untyped.png'],
      'each URL once (the redirect fetches its target)',
    );
    assert.deepEqual(
      { ...summary, record: path.basename(summary.record) },
      { record: RECORD, pinned: 4, failed: 1, local: 0, removed: [] },
    );
    const text = await readFile(path.join(root, RECORD), 'utf8');
    const png = { sha256: sha256(PNG), bytes: PNG.length, mime: 'image/png' };
    const jpeg = { sha256: sha256(JPEG), bytes: JPEG.length, mime: 'image/jpeg' };
    assert.equal(
      text,
      JSON.stringify(
        {
          format: 1,
          images: [
            { url: `${base}/a.png`, ...png },
            { url: `${base}/b.jpg`, ...jpeg },
            { url: `${base}/missing.png`, status: 404 },
            { url: `${base}/moved.png`, ...png },
            { url: `${base}/untyped.png`, ...png },
          ],
        },
        null,
        2,
      ) + '\n',
    );
    assert.deepEqual((await readdir(path.join(root, 'images'))).sort(), [
      `${sha256(JPEG)}.jpg`,
      `${sha256(PNG)}.png`,
    ]);
    // Again: identical bytes, nothing removed.
    const again = await fetchImages(root, { imageUrls: [...list].reverse() });
    assert.deepEqual(again.removed, []);
    assert.equal(await readFile(path.join(root, RECORD), 'utf8'), text);

    // The build: image assets after the fonts, one per file, sorted URLs.
    const ir = program();
    await pinImages({ root }, ir, list);
    const pngPath = `images/${sha256(PNG)}.png`;
    assert.deepEqual(ir.assets, [
      font,
      { path: pngPath, ...png },
      { path: `images/${sha256(JPEG)}.jpg`, ...jpeg },
    ]);
    assert.deepEqual(ir.images, [
      { url: `${base}/a.png`, asset: 1 },
      { url: `${base}/b.jpg`, asset: 2 },
      { url: `${base}/missing.png`, status: 404 },
      { url: `${base}/moved.png`, asset: 1 },
      { url: `${base}/untyped.png`, asset: 1 },
    ]);
    assert.match(ir.irHash, /^[0-9a-f]{64}$/);

    // Stale: the program loads a URL the record does not pin.
    await assert.rejects(
      pinImages({ root }, program(), urls(`${base}/a.png`, `${base}/new.png`)),
      failWith(
        'src/App.svelte',
        /not pinned in runic\.images\.json; run `node compiler\/cli\.mjs images /,
        2,
      ),
    );
    // Extra: the record pins URLs the program no longer loads (at the entry).
    await assert.rejects(
      pinImages({ root }, program(), list.slice(1, 4)),
      failWith(RECORD, /pins ".*\/moved\.png", which the program does not load/),
    );
    await assert.rejects(pinImages({ root }, program(), []), failWith(RECORD, /does not load/));
    // Unknown files in images/.
    await writeFile(path.join(root, 'images/notes.txt'), 'x');
    await assert.rejects(
      pinImages({ root }, program(), list),
      failWith('images/notes.txt', /not named by runic\.images\.json/),
    );
    await rm(path.join(root, 'images/notes.txt'));
    // Altered and missing files.
    const altered = Buffer.from(PNG);
    altered[40] ^= 1;
    await writeFile(path.join(root, pngPath), altered);
    await assert.rejects(pinImages({ root }, program(), list), failWith(pngPath, /was altered/));
    await rm(path.join(root, pngPath));
    await assert.rejects(pinImages({ root }, program(), list), failWith(RECORD, /is missing/, 5));

    // runic images restores the file; with fewer URLs it removes the pinned
    // file no URL needs any more.
    await fetchImages(root, { imageUrls: list });
    const fewer = await fetchImages(root, { imageUrls: urls(`${base}/a.png`) });
    assert.deepEqual(fewer.removed, [`images/${sha256(JPEG)}.jpg`]);
    assert.deepEqual(await readdir(path.join(root, 'images')), [`${sha256(PNG)}.png`]);
    // Without remote URLs the record and its files go.
    const none = await fetchImages(root, { imageUrls: [] });
    assert.deepEqual(none, {
      record: undefined,
      pinned: 0,
      failed: 0,
      local: 0,
      removed: [`images/${sha256(PNG)}.png`],
    });
    assert.equal(existsSync(path.join(root, RECORD)), false);
    assert.equal(existsSync(path.join(root, 'images')), false);
  }));

test('a record whose MIME type disagrees with the bytes fails the build', () =>
  withApp(async root => {
    const url = `${base}/a.png`;
    await mkdir(path.join(root, 'images'));
    await writeFile(path.join(root, `images/${sha256(JPEG)}.png`), JPEG);
    await writeFile(
      path.join(root, RECORD),
      JSON.stringify({
        format: 1,
        images: [{ url, sha256: sha256(JPEG), bytes: JPEG.length, mime: 'image/png' }],
      }),
    );
    await assert.rejects(
      pinImages({ root }, program(), urls(url)),
      failWith(`images/${sha256(JPEG)}.png`, /is not the image\/png image/),
    );
    await writeFile(path.join(root, RECORD), '{"format": 2, "images": []}');
    await assert.rejects(pinImages({ root }, program(), urls(url)), failWith(RECORD, /expected/));
    await writeFile(
      path.join(root, RECORD),
      '{"format": 1, "images": [{"url": "x", "status": 200}]}',
    );
    await assert.rejects(pinImages({ root }, program(), []), failWith(RECORD, /non-2xx/));
  }));

test('runic images fails without writing on bad responses and network errors', () =>
  withApp(async root => {
    const writesNothing = async (url, pattern) => {
      await assert.rejects(
        fetchImages(root, { imageUrls: urls(`${base}/a.png`, url) }),
        failWith('src/App.svelte', pattern, 2),
      );
      assert.deepEqual(await readdir(root), []);
    };
    await writesNothing(`${base}/huge.png`, /exceeds 4194304 bytes/);
    await writesNothing(`${base}/declared-huge.png`, /exceeds 4194304 bytes/);
    await writesNothing(
      `${base}/lying.png`,
      /Content-Type image\/jpeg contradicts its bytes, which are image\/png/,
    );
    await writesNothing(`${base}/page.html`, /Content-Type text\/html\) is not a PNG/);
    // A closed port: no HTTP status to pin.
    const closed = http.createServer();
    await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    const port = closed.address().port;
    await new Promise(resolve => closed.close(resolve));
    await writesNothing(`http://127.0.0.1:${port}/a.png`, /without an HTTP status/);
    // Unsupported URL forms fail at their source, before any fetch.
    for (const url of ['data:image/png;base64,AAAA', 'a.png', '//host/a.png', 'ftp://host/a.png'])
      await writesNothing(url, /is not supported/);
    // Files in images/ that runic images did not write are never deleted.
    await mkdir(path.join(root, 'images'));
    await writeFile(path.join(root, 'images/logo.png'), PNG);
    requests = [];
    await assert.rejects(
      fetchImages(root, { imageUrls: urls(`${base}/a.png`) }),
      failWith('images/logo.png', /is not a file runic images wrote/),
    );
    assert.deepEqual(requests, []);
    assert.deepEqual(await readdir(path.join(root, 'images')), ['logo.png']);
  }));

test('root-relative URLs resolve in public/ (Vite) or static/ (SvelteKit) without a record', () =>
  withApp(async root => {
    await mkdir(path.join(root, 'public/img'), { recursive: true });
    await mkdir(path.join(root, 'static'));
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'public/img/logo one.png'), PNG);
    await writeFile(path.join(root, 'public/img/dup.png'), PNG);
    await writeFile(path.join(root, 'static/icon.svg'), SVG);
    await writeFile(path.join(root, 'src/secret.png'), PNG);
    await writeFile(path.join(root, 'public/notes.txt'), 'text');

    const ir = program();
    await pinImages(
      { root },
      ir,
      urls('/img/logo%20one.png', '/img/dup.png', '/img/logo%20one.png'),
    );
    assert.deepEqual(ir.assets.slice(1), [
      { path: 'public/img/dup.png', sha256: sha256(PNG), bytes: PNG.length, mime: 'image/png' },
      {
        path: 'public/img/logo one.png',
        sha256: sha256(PNG),
        bytes: PNG.length,
        mime: 'image/png',
      },
    ]);
    assert.deepEqual(ir.images, [
      { url: '/img/dup.png', asset: 1 },
      { url: '/img/logo%20one.png', asset: 2 },
    ]);

    const kit = program();
    await pinImages({ root, kit: {} }, kit, urls('/icon.svg'));
    assert.deepEqual(kit.assets[1], {
      path: 'static/icon.svg',
      sha256: sha256(SVG),
      bytes: SVG.length,
      mime: 'image/svg+xml',
    });
    await assert.rejects(
      pinImages({ root }, program(), urls('/icon.svg')),
      failWith('src/App.svelte', /no file public\/icon\.svg/),
    );

    // Paths that would leave the static directory, files outside the app,
    // other types, queries.
    await assert.rejects(
      pinImages({ root }, program(), urls('/../src/secret.png')),
      failWith('src/App.svelte', /segments/),
    );
    await symlink(path.join(tmpdir()), path.join(root, 'public/outside'));
    await assert.rejects(
      pinImages({ root }, program(), urls('/outside')),
      failWith('src/App.svelte', /outside the app/),
    );
    await assert.rejects(
      pinImages({ root }, program(), urls('/notes.txt')),
      failWith('src/App.svelte', /is not a PNG, JPEG/),
    );
    await assert.rejects(
      pinImages({ root }, program(), urls('/img/dup.png?v=2')),
      failWith('src/App.svelte', /query/),
    );
    await assert.rejects(
      pinImages({ root }, program(), urls('img/dup.png')),
      failWith('src/App.svelte', /is not supported/),
    );

    // No URLs and no record: nothing changes.
    const untouched = program();
    await pinImages({ root }, untouched, []);
    assert.deepEqual(untouched, program());
  }));

test('the record feeds the source hash; the backend embeds checked image bytes', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/images-'));
  try {
    await cp('fixtures/counter-svelte', root, { recursive: true });
    const before = (await collect(root)).hash;
    const url = `${base}/a.png`;
    await fetchImages(root, { imageUrls: urls(url) });
    const graph = await collect(root);
    assert.notEqual(graph.hash, before, 'the record and files change the source hash');
    // No adapter yields image URLs yet: the record pins one the program does not load.
    await assert.rejects(lower(graph), failWith(RECORD, /does not load/));
    // Pin the URL as an adapter will report it, then validate and emit.
    const { ir } = await lower(graph, { images: false });
    await pinImages(graph, ir, urls(url));
    check(ir);
    const out = path.join(root, '.crate');
    emit(ir, out, true, root);
    const index = ir.images[0].asset;
    assert.deepEqual(await readFile(path.join(out, 'images', String(index))), PNG);
    assert.ok(
      (await readFile(path.join(out, 'src/app.rs'), 'utf8')).includes(
        `const IMAGES: &'static [runic_runtime::images::PinnedImage] = &[runic_runtime::images::PinnedImage { url: "${url}", image: Ok(("image/png", include_bytes!("../images/${index}"))) }, ];`,
      ),
    );
    // The backend rechecks the bytes it reads from the app.
    await writeFile(path.join(root, ir.assets[index].path), Buffer.concat([PNG, Buffer.from([0])]));
    assert.throws(
      () => emit(ir, path.join(root, '.crate2'), true, root),
      e => e.code === 'E_ASSET' && /changed size/.test(e.message),
    );
    assert.throws(
      () => emit(ir, path.join(root, '.crate3')),
      e => e.code === 'E_ASSET' && /--asset-root/.test(e.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
