// The service worker must never be able to cache personal data. Static checks on sw.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'sw.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pwa', 'manifest.webmanifest'), 'utf8'));

test('the shell list holds only scripts, styles, images and the two entry files', () => {
  const list = /const SHELL = \[([\s\S]*?)\];/.exec(src)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  for (const p of list) {
    assert.ok(/^\/($|index\.html$|manifest\.webmanifest$|css\/|js\/|img\/)/.test(p), `${p} is not shell`);
    assert.ok(!/^\/(api|files|sign)\//.test(p), `${p} would cache data`);
  }
});

test('data paths are explicitly excluded and non-GET requests never touch the cache', () => {
  assert.match(src, /\/\^\\\/api\\\/\//);
  assert.match(src, /\/\^\\\/files\\\/\//);
  assert.match(src, /\/\^\\\/sign\\\/\//);
  assert.match(src, /req\.method !== 'GET'\) return;/);
});

test('no inline-script tricks: no eval, no new Function, no importScripts from elsewhere', () => {
  assert.doesNotMatch(src, /\beval\(|new Function\(|importScripts\(/);
});

test('the manifest is standalone, en-GB, and has 192 and 512 icons', () => {
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.lang, 'en-GB');
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192'));
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));
});
