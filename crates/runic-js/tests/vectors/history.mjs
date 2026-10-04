// Generates tests/vectors/history.json from Chromium (not Node: the URLs of
// session history are the browser's): pushState URL resolution, the
// location.hash setter and whether a traversal between two entries fires
// hashchange. Run in the dev shell (Playwright's Chromium):
//
//   node crates/runic-js/tests/vectors/history.mjs
//
// Inputs are UTF-16 code unit arrays (they include lone surrogates).
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const units = s => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

const bases = ['/base/dir/page?x=1#f', '/', '/a/b/', '/q?', '/h#'];
const urlInputs = [
  '',
  '.',
  '..',
  './',
  '../',
  '../../../../x',
  'x',
  'x/y',
  './same',
  '../up',
  '/abs',
  '/a/./b/../c',
  '/a//b',
  '?',
  '?q',
  '?a b',
  '?a"b<c>d`e\'f{}|^',
  '?é',
  '?%41',
  '#',
  '#x',
  '#a b',
  '#a"b<c>d`e{}|^',
  '#é',
  '#😀',
  '#a#b',
  '/a b',
  '/é',
  '/😀',
  '/%41',
  '/a%2fb',
  '/a%zz',
  '/a"b<c>d`e{}|^[]',
  'a\\b',
  '\\abs',
  '/a\tb\nc',
  ' /lead ',
  'x?y#z',
  '/p?q#h',
  '/a/b/..',
  '/a/b/.',
  '/.%2e/x',
  '/%2e%2E/x',
  '/a;b',
  '/a?b?c',
  ' x',
  '/\ud800',
  '?\ud800',
  '#\ud800',
  '//host/x',
  'mailto:x',
  'http://example.com/',
  'javascript:1',
  '/a#',
  '/a?#',
  '\u0000x',
  '/a\u007fb',
  '?a\u0000',
  ' ',
  '\t',
  '\n ',
  '  #x',
];
// Every ASCII character inside a path segment, a query and a fragment.
for (let c = 0; c < 0x80; c++) {
  const ch = String.fromCharCode(c);
  urlInputs.push('/a' + ch + 'b', '?a' + ch + 'b', '#a' + ch + 'b');
}
const hashInputs = [
  '',
  '#',
  '##',
  'x',
  '#x',
  'f',
  '#f',
  'a b',
  '#a b',
  'é',
  '😀',
  '\ud800',
  '%41',
  'a#b',
  'a"b<c>d`e{}|^',
  '\t\n',
  ' x ',
  '/path?q',
  '\u0000',
  '\u007f',
];
const traversals = [
  ['/a', '/a#'],
  ['/a#', '/a'],
  ['/a#x', '/a#y'],
  ['/a?q#x', '/a#x'],
  ['/a', '/a'],
  ['/a#x', '/b#x'],
  ['/a#x', '/a?#x'],
  ['/a#x', '/a#x'],
  ['/a', '/a#x'],
  ['/a?', '/a?#'],
];

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><script>
window.where = () => ({ pathname: location.pathname, search: location.search, hash: location.hash, href: location.href.slice(location.origin.length) });
window.popped = 0; window.hashed = 0;
addEventListener('popstate', () => popped++);
addEventListener('hashchange', () => hashed++);
</script>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const page = await (await browser.newContext()).newPage();
await page.evaluate(u => location.replace(u), origin + '/').catch(() => {});
await page.waitForURL(u => u.origin === origin, { waitUntil: 'load' });
const str = u => String.fromCharCode(...u);
const out = { push: [], hash: [], traverse: [] };
for (const base of bases) {
  for (const input of urlInputs) {
    const r = await page.evaluate(
      ([base, input]) => {
        history.replaceState(null, '', base);
        try {
          history.pushState(null, '', String.fromCharCode(...input));
          return where();
        } catch (e) {
          return { error: e.name };
        }
      },
      [base, units(input)],
    );
    out.push.push({ base, input: units(input), ...r });
  }
  for (const input of hashInputs) {
    const r = await page.evaluate(
      ([base, input]) => {
        history.replaceState(null, '', base);
        popped = 0;
        location.hash = String.fromCharCode(...input);
        return { ...where(), navigated: popped === 1 };
      },
      [base, units(input)],
    );
    out.hash.push({ base, input: units(input), ...r });
  }
}
for (const [from, to] of traversals) {
  const r = await page.evaluate(
    async ([from, to]) => {
      history.pushState(null, '', from);
      history.pushState(null, '', to);
      popped = 0;
      hashed = 0;
      history.back();
      await new Promise(r => setTimeout(r, 200));
      return { popstate: popped, hashchange: hashed };
    },
    [from, to],
  );
  out.traverse.push({ from, to, ...r });
}
await browser.close();
server.close();
out.chromium = browser.version();
const file = join(dirname(fileURLToPath(import.meta.url)), 'history.json');
writeFileSync(file, JSON.stringify(out) + '\n');
console.log(
  `${out.push.length} push, ${out.hash.length} hash, ${out.traverse.length} traversal vectors (${str([0x43])}hromium ${out.chromium})`,
);
