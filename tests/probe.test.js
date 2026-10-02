import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureFixtures, serve, FIXTURE_DIR } from './helpers/fixtures.js';
import { probeFile, isFragmentStart, isNotMediaMime } from '../extension/lib/probe.js';
import { MIN_FILE_BYTES } from '../extension/lib/detect.js';

let server;
const source = () => readFileSync(join(FIXTURE_DIR, 'source.mp4'));

/** A box header (size + type) followed by padding, as it appears at the start of a media segment. */
const boxed = (type, total) => {
  const b = Buffer.alloc(total, 0x11);
  b.writeUInt32BE(24, 0);
  b.write(type, 4, 'latin1');
  return b;
};

before(async () => {
  ensureFixtures();
  server = await serve(FIXTURE_DIR, {
    extraRoutes: (req, res, url, send) => {
      const chunked = (body, type = 'video/mp4') => {
        // No Content-Length and the Range header is ignored: Node falls back to chunked transfer encoding.
        res.writeHead(200, { 'Content-Type': type });
        res.write(body.subarray(0, Math.floor(body.length / 2)));
        setTimeout(() => res.end(body.subarray(Math.floor(body.length / 2))), 10);
        return true;
      };
      switch (url.pathname) {
        case '/tiny-chunked.mp4':
          return chunked(boxed('ftyp', 2000));
        case '/big-chunked.mp4':
          return chunked(source());
        case '/fragment.mp4':
          return send(200, { 'Content-Type': 'video/mp4', 'Content-Length': 300_000 }, boxed('styp', 300_000)), true;
        case '/moof.mp4':
          return chunked(boxed('moof', 400_000));
        case '/error-page.mp4':
          return send(200, { 'Content-Type': 'text/html', 'Content-Length': 12 }, '<html></html>'.slice(0, 12)), true;
        case '/small-no-range.mp4':
          return send(200, { 'Content-Type': 'video/mp4', 'Content-Length': 1500 }, boxed('ftyp', 1500)), true;
        case '/unknown-total.mp4':
          return send(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-1999/*', 'Content-Length': 2000 }, boxed('ftyp', 2000)), true;
        case '/hang.mp4':
          return true; // never answers
        default:
          return false;
      }
    },
  });
});
after(() => server.close());

const probe = (path, opts) => probeFile(`${server.origin}${path}`, opts);

test('a server with Range support reports the full size from Content-Range', async () => {
  const r = await probe('/source.mp4');
  assert.equal(r.size, source().length);
  assert.equal(r.mime, 'video/mp4');
  assert.equal(r.fragment, false);
  assert.equal(r.notMedia, false);
});

test('a tiny chunked response (no Content-Length, no Range) is measured by reading it to the end', async () => {
  const r = await probe('/tiny-chunked.mp4');
  assert.equal(r.size, 2000);
  assert.ok(r.size < MIN_FILE_BYTES);
});

test('a big chunked response is left with an unknown size after reading just past the threshold', async () => {
  const r = await probe('/big-chunked.mp4');
  assert.equal(r.size, null);
  assert.equal(r.fragment, false);
});

test('a media segment (styp / moof first) is recognised as a fragment, whatever its size', async () => {
  assert.equal((await probe('/fragment.mp4')).fragment, true);
  const moof = await probe('/moof.mp4');
  assert.equal(moof.fragment, true);
  assert.equal(moof.size, null);
  assert.equal(isFragmentStart(Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])), false, 'ftyp is a normal file start');
  assert.equal(isFragmentStart(new Uint8Array(3)), false);
});

test('an HTML error page served for a .mp4 URL is flagged as not media', async () => {
  const r = await probe('/error-page.mp4');
  assert.equal(r.notMedia, true);
  assert.equal(isNotMediaMime('application/json'), true);
  assert.equal(isNotMediaMime('video/mp4'), false);
  assert.equal(isNotMediaMime('application/octet-stream'), false);
  assert.equal(isNotMediaMime(''), false);
});

test('a 200 response to a Range request uses its Content-Length', async () => {
  assert.equal((await probe('/small-no-range.mp4')).size, 1500);
});

test('a 206 with an unknown total never reports the partial length as the size', async () => {
  assert.equal((await probe('/unknown-total.mp4')).size, null);
});

test('HTTP errors and unresponsive servers reject, so the caller keeps the item untouched', async () => {
  await assert.rejects(probe('/does-not-exist.mp4'), /HTTP 404/);
  await assert.rejects(probe('/hang.mp4', { timeoutMs: 150 }), (e) => e.name === 'AbortError');
});

test('the request asks for only the start of the file', async () => {
  server.log.length = 0;
  await probe('/source.mp4');
  const entry = server.log.find((e) => e.path === '/source.mp4');
  assert.equal(entry.headers.range, `bytes=0-${MIN_FILE_BYTES}`);
});
