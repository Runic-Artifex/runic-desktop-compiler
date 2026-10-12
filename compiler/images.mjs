// Images as pinned build assets (docs/design/M6-IMAGES.md).
//
// `runic images <app>` (fetchImages) fetches every remote image URL the
// program can load once and records the result in `<app>/runic.images.json`,
// the bytes in `<app>/images/<sha256>.<ext>`; both are committed with the app.
// Builds (pinImages) read only the record and the files, never the network.
// Root-relative URLs name files of the app's static directory (Vite's
// `public/`, SvelteKit's `static/`) and need no record; one naming no file
// there is accepted only as a pinned missing file, an explicit
// `{ "url": "/x.png", "status": 404 }` entry of the record (what a static
// server answers), which `runic images` keeps while the program loads the URL.
import { readFile, readdir, realpath, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Diagnostic, hash } from './collect.mjs';

export const RECORD = 'runic.images.json';
export const RECORD_FORMAT = 1;
export const IMAGES_DIR = 'images';
/** The validator's limits (crates/runic-ir/src/validate.rs). */
export const MAX_IMAGE_BYTES = 4 << 20;
export const MAX_PROGRAM_BYTES = 32 << 20;
const FETCH_TIMEOUT_MS = 30_000;
/** File extensions of the accepted image types. */
const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};
/** The names `runic images` gives pinned files. */
const PINNED_FILE = /^[0-9a-f]{64}\.(?:png|jpg|webp|gif|svg)$/;
/** Content-Type spellings of the accepted types. */
const MIME_ALIASES = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
};
/** Content-Types that say nothing about the bytes. */
const UNTYPED = new Set(['application/octet-stream', 'binary/octet-stream']);

const byUrl = (a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
const command = root => {
  const relative = path.relative(process.cwd(), root) || '.';
  return `node compiler/cli.mjs images ${relative.startsWith('..') ? root : relative}`;
};
const at = file => ({ file, line: 1, column: 1 });

/** The image type of `bytes` from their signature, or undefined. */
export function sniff(bytes) {
  const starts = (sig, offset = 0) =>
    bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38]) && (starts([0x37, 0x61], 4) || starts([0x39, 0x61], 4)))
    return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  // SVG: an `<svg` root after an optional BOM, XML declaration, comments and
  // doctype.
  let text = bytes.subarray(0, 4096).toString('utf8').replace(/^﻿/, '');
  for (;;) {
    const rest = text.replace(/^\s+/, '');
    const skip = /^(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\s+svg\b[^>]*>)/i.exec(rest);
    if (!skip) {
      text = rest;
      break;
    }
    text = rest.slice(skip[0].length);
  }
  if (/^<svg[\s>]/.test(text)) return 'image/svg+xml';
  return undefined;
}

/** `remote` (http/https), `local` (a root-relative path) or undefined. */
function kind(url) {
  if (/^https?:\/\//i.test(url)) {
    try {
      new URL(url);
      return 'remote';
    } catch {
      return undefined;
    }
  }
  if (url.startsWith('/') && !url.startsWith('//')) return 'local';
  return undefined;
}

function unsupportedUrl(url, source) {
  return new Diagnostic(
    'E_ASSET',
    `Image URL ${JSON.stringify(url)} is not supported: images are http(s) URLs pinned by \`runic images\` or root-relative paths of the app's static directory (data:, relative and protocol-relative URLs and other schemes are not)`,
    source,
  );
}

/** The distinct URLs of `imageUrls`, each with its first source location. */
function distinct(imageUrls) {
  const urls = new Map();
  for (const { url, source } of imageUrls) if (!urls.has(url)) urls.set(url, source);
  return urls;
}

/** The location of `url`'s entry in the record's text. */
function entryLocation(text, url) {
  const index = text.indexOf(JSON.stringify(url));
  if (index < 0) return at(RECORD);
  const before = text.slice(0, index).split('\n');
  return { file: RECORD, line: before.length, column: before.at(-1).length + 1 };
}

/**
 * The record of `root` (`{ text, images }`), checked for shape, or undefined
 * when there is none.
 */
async function readRecord(root) {
  let text;
  try {
    text = await readFile(path.join(root, RECORD), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
  const bad = (message, location = at(RECORD)) => {
    throw new Diagnostic('E_ASSET', `${RECORD}: ${message}; run \`${command(root)}\``, location);
  };
  let record;
  try {
    record = JSON.parse(text);
  } catch (e) {
    bad(`not valid JSON (${e.message})`);
  }
  if (
    !record ||
    typeof record !== 'object' ||
    Object.keys(record).sort().join() !== 'format,images' ||
    record.format !== RECORD_FORMAT ||
    !Array.isArray(record.images)
  )
    bad(`expected { "format": ${RECORD_FORMAT}, "images": [...] }`);
  const seen = new Set();
  for (const entry of record.images) {
    const keys = entry && typeof entry === 'object' ? Object.keys(entry).sort().join() : '';
    const url = typeof entry?.url === 'string' ? entry.url : undefined;
    const where = url ? entryLocation(text, url) : at(RECORD);
    if (!url || seen.has(url)) bad(`entries need distinct non-empty URLs`, where);
    seen.add(url);
    if (kind(url) === 'local') {
      // A root-relative URL's bytes are its static file; the record can only
      // pin it as missing.
      if (keys !== 'status,url' || entry.status !== 404)
        bad(
          `a root-relative URL (${url}) is pinned only as a missing file, with status 404`,
          where,
        );
    } else if (keys === 'bytes,mime,sha256,url') {
      if (
        !/^[0-9a-f]{64}$/.test(entry.sha256) ||
        !Number.isInteger(entry.bytes) ||
        entry.bytes < 1 ||
        entry.bytes > MAX_IMAGE_BYTES ||
        !EXTENSIONS[entry.mime]
      )
        bad(`invalid entry for ${url}`, where);
    } else if (keys === 'status,url') {
      if (
        !Number.isInteger(entry.status) ||
        entry.status < 100 ||
        entry.status > 599 ||
        (entry.status >= 200 && entry.status < 300)
      )
        bad(`invalid pinned failure for ${url} (a non-2xx HTTP status)`, where);
    } else bad(`invalid entry for ${url}`, where);
  }
  return { text, images: record.images };
}

/** The entries of `<root>/images/` (names), or [] when it does not exist. */
async function listImages(root) {
  try {
    return (await readdir(path.join(root, IMAGES_DIR), { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

const pinnedName = entry => `${entry.sha256}.${EXTENSIONS[entry.mime]}`;

/**
 * What the record and its files contribute to the collector's source hash
 * (compiler/collect.mjs), or undefined for an app without a record.
 */
export async function imageSourceInput(root) {
  let text;
  try {
    text = await readFile(path.join(root, RECORD));
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
  const files = [];
  for (const d of await listImages(root))
    files.push([
      d.name,
      d.isFile() ? hash(await readFile(path.join(root, IMAGES_DIR, d.name))) : 'not a file',
    ]);
  return { record: hash(text), files };
}

/**
 * The bytes and type of the static file a root-relative `url` names, or, with
 * `missing` (a pinned 404), undefined after checking that no such file exists.
 */
async function localImage(root, staticDir, url, source, missing = false) {
  const fail = message => {
    throw new Diagnostic('E_ASSET', `Image ${JSON.stringify(url)}: ${message}`, source);
  };
  if (/[?#\\]/.test(url))
    fail('root-relative image URLs with a query, a fragment or a backslash are not supported');
  let segments;
  try {
    segments = url.slice(1).split('/').map(decodeURIComponent);
  } catch {
    fail('invalid percent-encoding');
  }
  if (segments.some(s => s === '' || s === '.' || s === '..' || s.includes('/')))
    fail('the path must name a file without empty, "." or ".." segments');
  const named = path.posix.join(staticDir, ...segments);
  let file;
  try {
    file = await realpath(path.join(root, staticDir, ...segments));
  } catch {
    if (missing) return undefined;
    fail(
      `no file ${named} in the app (a URL the site serves no file for is pinned as { "url": ${JSON.stringify(url)}, "status": 404 } in ${RECORD})`,
    );
  }
  if (missing)
    fail(`${RECORD} pins it as missing (404), but ${named} exists; remove the entry or the file`);
  if (!file.startsWith(root + path.sep)) fail('the file is outside the app');
  const info = await stat(file);
  if (!info.isFile()) fail(`${path.relative(root, file)} is not a file`);
  if (info.size === 0 || info.size > MAX_IMAGE_BYTES)
    fail(`${path.relative(root, file)} must have 1 byte to 4 MiB`);
  const bytes = await readFile(file);
  const mime = sniff(bytes);
  if (!mime) fail(`${path.relative(root, file)} is not a PNG, JPEG, WebP, GIF or SVG image`);
  return { path: path.relative(root, file).split(path.sep).join('/'), bytes, mime };
}

/**
 * Pin the image URLs a lowered program can load (`imageUrls`: `{ url,
 * source }`): check the record and files for remote URLs and the static
 * files for root-relative ones, append the image assets to `ir.assets` (paths
 * relative to the app, one per path) and fill `ir.images` (sorted by URL).
 */
export async function pinImages(graph, ir, imageUrls = []) {
  const root = graph.root;
  const urls = distinct(imageUrls);
  const remote = [];
  const local = [];
  for (const [url, source] of urls) {
    const k = kind(url);
    if (!k) throw unsupportedUrl(url, source);
    (k === 'remote' ? remote : local).push(url);
  }
  const record = await readRecord(root);
  if (!record && !remote.length && !local.length) return;
  const images = [];
  const missing = new Set(
    (record?.images ?? []).filter(e => kind(e.url) === 'local').map(e => e.url),
  );
  if (record || remote.length) {
    if (!record)
      throw new Diagnostic(
        'E_ASSET',
        `Image ${JSON.stringify(remote[0])} is not pinned: the app has no ${RECORD}; run \`${command(root)}\``,
        urls.get(remote[0]),
      );
    const entries = new Map(record.images.map(e => [e.url, e]));
    for (const url of remote)
      if (!entries.has(url))
        throw new Diagnostic(
          'E_ASSET',
          `Image ${JSON.stringify(url)} is not pinned in ${RECORD}; run \`${command(root)}\``,
          urls.get(url),
        );
    const needed = new Set([...remote, ...local]);
    for (const entry of record.images)
      if (!needed.has(entry.url))
        throw new Diagnostic(
          'E_ASSET',
          `${RECORD} pins ${JSON.stringify(entry.url)}, which the program does not load; run \`${command(root)}\``,
          entryLocation(record.text, entry.url),
        );
    const named = new Set(record.images.filter(e => e.sha256).map(pinnedName));
    for (const d of await listImages(root))
      if (!named.has(d.name) || !d.isFile())
        throw new Diagnostic(
          'E_ASSET',
          `${IMAGES_DIR}/${d.name} is not named by ${RECORD}; run \`${command(root)}\`, or move the file`,
          at(`${IMAGES_DIR}/${d.name}`),
        );
    for (const entry of record.images) {
      if (missing.has(entry.url)) continue;
      if (!entry.sha256) {
        images.push({ url: entry.url, status: entry.status });
        continue;
      }
      const file = `${IMAGES_DIR}/${pinnedName(entry)}`;
      let bytes;
      try {
        bytes = await readFile(path.join(root, file));
      } catch {
        throw new Diagnostic(
          'E_ASSET',
          `${file}, pinned for ${JSON.stringify(entry.url)}, is missing; run \`${command(root)}\``,
          entryLocation(record.text, entry.url),
        );
      }
      if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256)
        throw new Diagnostic(
          'E_ASSET',
          `${file} was altered: it no longer has the size and SHA-256 ${RECORD} pins for ${JSON.stringify(entry.url)}; run \`${command(root)}\``,
          at(file),
        );
      if (sniff(bytes) !== entry.mime)
        throw new Diagnostic(
          'E_ASSET',
          `${file} is not the ${entry.mime} image ${RECORD} pins for ${JSON.stringify(entry.url)}; run \`${command(root)}\``,
          at(file),
        );
      images.push({
        url: entry.url,
        path: file,
        sha256: entry.sha256,
        bytes: entry.bytes,
        mime: entry.mime,
      });
    }
  }
  const staticDir = graph.kit ? 'static' : 'public';
  for (const url of local) {
    if (missing.has(url)) {
      await localImage(root, staticDir, url, urls.get(url), true);
      images.push({ url, status: 404 });
      continue;
    }
    const image = await localImage(root, staticDir, url, urls.get(url));
    images.push({
      url,
      path: image.path,
      sha256: hash(image.bytes),
      bytes: image.bytes.length,
      mime: image.mime,
    });
  }
  const indexes = new Map(ir.assets.map((a, i) => [a.path, i]));
  ir.images = images.sort(byUrl).map(image => {
    if (image.status !== undefined) return { url: image.url, status: image.status };
    if (!indexes.has(image.path)) {
      indexes.set(image.path, ir.assets.length);
      const { path: assetPath, sha256, bytes, mime } = image;
      ir.assets.push({ path: assetPath, sha256, bytes, mime });
    }
    return { url: image.url, asset: indexes.get(image.path) };
  });
  // The program changed after the adapter hashed it.
  if (ir.images.length) {
    const body = { ...ir };
    delete body.irHash;
    ir.irHash = hash(body);
  }
}

/**
 * Fetch `url` once: `{ url, status }` for a final non-2xx response, otherwise
 * `{ url, bytes, mime }`. A network error has no status to pin and fails.
 */
async function fetchImage(url, source, fetchImpl) {
  const fail = message => {
    throw new Diagnostic('E_ASSET', `Image ${JSON.stringify(url)}: ${message}`, source);
  };
  const networkError = e =>
    fail(
      `the fetch failed without an HTTP status (${e.cause?.message ?? e.message}); nothing was written`,
    );
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'follow', signal });
  } catch (e) {
    networkError(e);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { url, status: response.status };
  }
  const tooLarge = () => fail(`the image exceeds ${MAX_IMAGE_BYTES} bytes (4 MiB)`);
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => {});
    tooLarge();
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        networkError(e);
      }
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        tooLarge();
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.length) fail('the response is empty');
  const mime = sniff(bytes);
  const declared = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!mime)
    fail(
      `the response (Content-Type ${declared ?? 'none'}) is not a PNG, JPEG, WebP, GIF or SVG image`,
    );
  const said = MIME_ALIASES[declared] ?? declared;
  if (said && !UNTYPED.has(said) && said !== mime)
    fail(`the response's Content-Type ${declared} contradicts its bytes, which are ${mime}`);
  return { url, bytes, mime };
}

/**
 * `runic images <app>`: fetch the remote image URLs of the app's program (or
 * `options.imageUrls`, `{ url, source }`, which tests inject) once each and
 * write `images/<sha256>.<ext>` and the record, atomically. Pinned files the
 * new record no longer names are removed; anything else in `images/` fails the
 * command before it fetches. Without remote URLs the record is removed.
 * Returns a summary.
 */
export async function fetchImages(app, options = {}) {
  const root = await realpath(app);
  let imageUrls = options.imageUrls;
  if (!imageUrls) {
    const { collect } = await import('./collect.mjs');
    const { lower } = await import('./frontend.mjs');
    imageUrls = (await lower(await collect(root), { images: false })).imageUrls ?? [];
  }
  const urls = distinct(imageUrls);
  const remote = [];
  for (const [url, source] of urls) {
    const k = kind(url);
    if (!k) throw unsupportedUrl(url, source);
    if (k === 'remote') remote.push(url);
  }
  remote.sort();
  // Pinned missing static files the program still loads stay pinned (builds
  // check that their files are still absent).
  const kept = ((await readRecord(root))?.images ?? []).filter(
    e => kind(e.url) === 'local' && urls.has(e.url),
  );
  const listed = await listImages(root);
  for (const d of listed)
    if (!d.isFile() || !PINNED_FILE.test(d.name))
      throw new Diagnostic(
        'E_ASSET',
        `${IMAGES_DIR}/${d.name} is not a file runic images wrote; move it out of ${IMAGES_DIR}/ (it holds only pinned images)`,
        at(`${IMAGES_DIR}/${d.name}`),
      );
  const results = [];
  for (const url of remote)
    results.push(await fetchImage(url, urls.get(url), options.fetch ?? fetch));
  const files = new Map();
  for (const r of results)
    if (r.bytes) files.set(`${hash(r.bytes)}.${EXTENSIONS[r.mime]}`, r.bytes);
  const total = [...files.values()].reduce((sum, b) => sum + b.length, 0);
  if (total > MAX_PROGRAM_BYTES)
    throw new Diagnostic(
      'E_ASSET',
      `The pinned images have ${total} bytes together, more than ${MAX_PROGRAM_BYTES} (32 MiB); nothing was written`,
    );
  const dir = path.join(root, IMAGES_DIR);
  const temporary = name => path.join(dir, `.${name}.${process.pid}.tmp`);
  if (files.size) await mkdir(dir, { recursive: true });
  for (const [name, bytes] of files) {
    const existing = await readFile(path.join(dir, name)).catch(() => undefined);
    if (existing?.equals(bytes)) continue;
    await writeFile(temporary(name), bytes);
    await rename(temporary(name), path.join(dir, name));
  }
  const recordFile = path.join(root, RECORD);
  const pinned = remote.length || kept.length;
  if (pinned) {
    const record = {
      format: RECORD_FORMAT,
      images: results
        .map(r =>
          r.bytes
            ? { url: r.url, sha256: hash(r.bytes), bytes: r.bytes.length, mime: r.mime }
            : { url: r.url, status: r.status },
        )
        .concat(kept.map(e => ({ url: e.url, status: e.status })))
        .sort(byUrl),
    };
    const staged = path.join(root, `.${RECORD}.${process.pid}.tmp`);
    await writeFile(staged, JSON.stringify(record, null, 2) + '\n');
    await rename(staged, recordFile);
  } else await rm(recordFile, { force: true });
  const removed = [];
  for (const d of listed)
    if (!files.has(d.name)) {
      await rm(path.join(dir, d.name));
      removed.push(`${IMAGES_DIR}/${d.name}`);
    }
  if (!files.size && listed.length && !(await listImages(root)).length)
    await rm(dir, { recursive: true, force: true });
  return {
    record: pinned ? recordFile : undefined,
    pinned: results.filter(r => r.bytes).length,
    failed: results.filter(r => !r.bytes).length,
    local: urls.size - remote.length,
    removed,
  };
}
