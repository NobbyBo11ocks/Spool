// Failure modes the engine must handle rather than silently produce a bad file: discontinuities, a format that changes
// mid-stream, web pages served instead of video, short ranged responses, silent servers and scoped credentials.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureFixtures, serve, probeDecode, loadMux, FIXTURE_DIR, SOURCE_FPS } from './helpers/fixtures.js';
import { parsePlaylist } from '../extension/lib/hls.js';
import {
  createFetcher, createSegmentLoader, downloadMedia, downloadFile, assertMediaBytes, NotMediaError, HttpError,
} from '../extension/lib/hls-download.js';

const mux = loadMux();
const outDir = mkdtempSync(join(tmpdir(), 'md-hard-'));
let server;

before(async () => {
  ensureFixtures();
  server = await serve(FIXTURE_DIR, {
    extraRoutes: (req, res, url, send) => {
      switch (url.pathname) {
        case '/html-segment/seg1.ts':
          return send(200, { 'Content-Type': 'video/mp2t' }, '<!DOCTYPE html><html><body>Please log in</body></html>'), true;
        case '/json-segment/seg1.ts':
          return send(200, { 'Content-Type': 'video/mp2t' }, '{"error":"token expired"}'), true;
        case '/silent/seg1.ts':
          return true; // never answers
        case '/short-range/all.ts':
          return send(206, { 'Content-Type': 'video/mp2t', 'Content-Range': 'bytes 0-9/100' }, Buffer.alloc(10)), true;
        case '/stall.mp4': {
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 5_000_000 });
          res.write(Buffer.alloc(300_000, 0x11));
          return true; // then silence
        }
        case '/fake.mp4':
          return send(200, { 'Content-Type': 'video/mp4' }, '<html><body>Sign in to watch</body></html>'.padEnd(400_000, ' ')), true;
        default:
          return false;
      }
    },
  });
});
after(() => server.close());

const memorySink = () => {
  const chunks = [];
  return { write: async (c) => void chunks.push(Buffer.from(c)), buffer: () => Buffer.concat(chunks) };
};
const playlist = async (path) => {
  const url = `${server.origin}/${path}`;
  return parsePlaylist(await (await fetch(url)).text(), url);
};
const run = async (path, opts = {}, fetcher = createFetcher({ baseDelayMs: 5 })) => {
  const pl = await playlist(path);
  const sink = memorySink();
  await downloadMedia(pl, { sink, loader: createSegmentLoader(pl, { fetchBytes: fetcher }), mux, ...opts });
  return sink.buffer();
};
const decode = (name, bytes) => {
  const file = join(outDir, name);
  writeFileSync(file, bytes);
  return probeDecode(file);
};

// ---- discontinuities -----------------------------------------------------------------------------------------------

test('EXT-X-DISCONTINUITY: raw TS output keeps every frame', async () => {
  const r = decode('discont.ts', await run('discont/index.m3u8'));
  assert.ok(r.ok, r.stderr);
  assert.equal(r.frames, 4 * 2 * SOURCE_FPS);
});

test('EXT-X-DISCONTINUITY: the MP4 conversion continues its timeline instead of dropping the second part', async () => {
  const bytes = await run('discont/index.m3u8', { remux: true });
  const r = decode('discont.mp4', bytes);
  assert.equal(r.frames, 4 * 2 * SOURCE_FPS, `frames (a converter that ignores the discontinuity yields ${3 * SOURCE_FPS})\n${r.stderr}`);
  assert.ok(Math.abs(r.seconds - 8) < 0.5, `duration ${r.seconds}s`);
});

test('a format change at a discontinuity cannot be one MP4: the conversion stops with a clear error, raw TS still works', async () => {
  await assert.rejects(run('ts-change/index.m3u8', { remux: true }), /changes format/);
  const raw = await run('ts-change/index.m3u8');
  assert.equal(raw.length, statSync(join(FIXTURE_DIR, 'ts', 'seg0.ts')).size + statSync(join(FIXTURE_DIR, 'ts180', 'seg0.ts')).size);
});

test('fMP4 whose init section changes partway is refused instead of writing two moov boxes', async () => {
  await assert.rejects(run('fmp4-change/index.m3u8'), /changes format/);
});

test('fMP4 that repeats an identical init section is written once', async () => {
  const pl = await playlist('fmp4/index.m3u8');
  // The same init section announced again after a discontinuity (a different URL with identical bytes).
  const again = { ...pl.segments[2].map, url: pl.segments[2].map.url };
  pl.segments[3] = { ...pl.segments[3], discontinuity: true, map: { ...again, byteRange: { offset: 0, length: statSync(join(FIXTURE_DIR, 'fmp4', 'init.mp4')).size } } };
  const sink = memorySink();
  await downloadMedia(pl, { sink, loader: createSegmentLoader(pl, { fetchBytes: createFetcher() }) });
  const initSize = statSync(join(FIXTURE_DIR, 'fmp4', 'init.mp4')).size;
  const out = sink.buffer();
  const count = (needle) => { let n = 0; for (let i = out.indexOf(needle); i !== -1; i = out.indexOf(needle, i + 1)) n++; return n; };
  assert.equal(count('moov'), 1, 'one moov box');
  assert.ok(out.length > initSize);
});

// ---- bodies that are not video -------------------------------------------------------------------------------------

test('assertMediaBytes recognises web pages, JSON and XML but never real media', () => {
  const text = (s) => new TextEncoder().encode(s);
  for (const bad of ['<!DOCTYPE html><html>', '  <html><body>', '<?xml version="1.0"?>', '{"error":1}', '[{"a":1}]', '\n\n<head>']) {
    assert.throws(() => assertMediaBytes(text(bad)), NotMediaError, bad);
  }
  for (const good of [Uint8Array.of(0x47, 0x40, 0x00, 0x10), Uint8Array.of(0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70), Uint8Array.of(0xff, 0xf1, 0x50), text('ID3\x04'), Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3), new Uint8Array(0)]) {
    assertMediaBytes(good);
  }
  assertMediaBytes(readFileSync(join(FIXTURE_DIR, 'ts', 'seg0.ts')));
  assertMediaBytes(readFileSync(join(FIXTURE_DIR, 'source.mp4')));
});

test('a login page or JSON error served in place of a segment fails the download instead of leaving a hole', async () => {
  for (const dir of ['html-segment', 'json-segment']) {
    const ts = await playlist('ts/index.m3u8');
    ts.segments = ts.segments.slice(0, 3).map((s, i) => ({ ...s, url: i === 1 ? `${server.origin}/${dir}/seg1.ts` : s.url }));
    const sink = memorySink();
    await assert.rejects(
      downloadMedia(ts, { sink, loader: createSegmentLoader(ts, { fetchBytes: createFetcher({ baseDelayMs: 1 }) }) }),
      (e) => e instanceof NotMediaError && /web page instead of video/.test(e.message),
      dir,
    );
  }
});

test('an HTML page served with a video content type is refused by downloadFile, and nothing is written', async () => {
  const sink = memorySink();
  await assert.rejects(downloadFile(`${server.origin}/fake.mp4`, { sink }), NotMediaError);
  assert.equal(sink.buffer().length, 0);
});

test('a decrypt failure says so (wrong key / expired link) rather than leaking a WebCrypto OperationError', async () => {
  const pl = await playlist('aes-iv/index.m3u8');
  const fetcher = async (url, o) => (url.endsWith('.key') ? new Uint8Array(16) : createFetcher()(url, o)); // wrong key
  await assert.rejects(downloadMedia(pl, { sink: memorySink(), loader: createSegmentLoader(pl, { fetchBytes: fetcher }) }), /Could not decrypt/);
});

// ---- timing and size -----------------------------------------------------------------------------------------------

test('a byte range answered with fewer bytes than asked fails (after retries) instead of truncating the file', async () => {
  const fetchBytes = createFetcher({ baseDelayMs: 1, retries: 1 });
  await assert.rejects(fetchBytes(`${server.origin}/short-range/all.ts`, { range: { offset: 0, length: 100 } }), /Incomplete response for a byte range \(10 of 100 bytes\)/);
});

test('a server that never answers times out and the error says so (no frozen "2 / 6")', async () => {
  const ts = await playlist('ts/index.m3u8');
  ts.segments = ts.segments.slice(0, 3).map((s, i) => ({ ...s, url: i === 1 ? `${server.origin}/silent/seg1.ts` : s.url }));
  const started = Date.now();
  await assert.rejects(
    downloadMedia(ts, { sink: memorySink(), loader: createSegmentLoader(ts, { fetchBytes: createFetcher({ baseDelayMs: 1, retries: 1, timeoutMs: 250 }) }) }),
    /did not answer/,
  );
  assert.ok(Date.now() - started < 3000, `gave up after ${Date.now() - started} ms`);
});

test('cancelling still wins over a timeout: AbortError, not a timeout message', async () => {
  const ts = await playlist('ts/index.m3u8');
  ts.segments = ts.segments.slice(0, 3).map((s, i) => ({ ...s, url: i === 1 ? `${server.origin}/silent/seg1.ts` : s.url }));
  const ac = new AbortController();
  const done = downloadMedia(ts, { sink: memorySink(), signal: ac.signal, loader: createSegmentLoader(ts, { fetchBytes: createFetcher({ timeoutMs: 5000 }), signal: ac.signal }) });
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(done, (e) => e.name === 'AbortError');
});

test('a file download that stalls mid-body is aborted with a clear message', async () => {
  const sink = memorySink();
  const t0 = Date.now();
  await assert.rejects(downloadFile(`${server.origin}/stall.mp4`, { sink, stallMs: 300 }), /stopped sending data/);
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(sink.buffer().length >= 300_000, 'bytes received before the stall were passed on (the caller discards the file)');
});

// ---- credentials ---------------------------------------------------------------------------------------------------

test('credentials can be decided per URL, so cookies only go to hosts related to the page', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.credentials]);
    return new Response(new Uint8Array([0x47, 0, 0]), { status: 200 });
  };
  const fetchBytes = createFetcher({ fetchImpl, credentials: (u) => (new URL(u).hostname === 'cdn.example.com' ? 'include' : 'omit') });
  await fetchBytes('https://cdn.example.com/a.ts');
  await fetchBytes('https://bank.example.net/transfer?x=1');
  assert.deepEqual(seen, [['https://cdn.example.com/a.ts', 'include'], ['https://bank.example.net/transfer?x=1', 'omit']]);
});

test('non-retryable HTTP errors still fail immediately with their status', async () => {
  await assert.rejects(createFetcher({ baseDelayMs: 1 })(`${server.origin}/nope.ts`), (e) => e instanceof HttpError && e.status === 404);
});
