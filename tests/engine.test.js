// End-to-end tests of the HLS engine against real ffmpeg-generated streams served over HTTP.
// Output files are decoded with ffmpeg: "it decodes cleanly with the right frame count" is the pass criterion.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureFixtures, serve, probeDecode, loadMux, SOURCE_SECONDS, SOURCE_FPS, FIXTURE_DIR,
} from './helpers/fixtures.js';
import { parsePlaylist, inspectEncryption, detectContainer } from '../extension/lib/hls.js';
import {
  createFetcher, createSegmentLoader, downloadMedia, downloadFile, probeRemux, runOrdered, HttpError, Mp4Remuxer,
} from '../extension/lib/hls-download.js';
import { readTsStreams } from '../extension/lib/ts.js';

const EXPECTED_FRAMES = SOURCE_SECONDS * SOURCE_FPS;
const mux = loadMux();
const outDir = mkdtempSync(join(tmpdir(), 'md-out-'));
let server;
let log;

before(async () => {
  ensureFixtures();
  log = [];
  server = await serve(FIXTURE_DIR, { log, failFirst: (p) => p === '/ts/seg2.ts' });
});
after(() => server.close());

function memorySink() {
  const chunks = [];
  return { chunks, write: async (c) => void chunks.push(Buffer.from(c)), buffer: () => Buffer.concat(chunks) };
}

async function loadPlaylist(path) {
  const url = `${server.origin}/${path}`;
  return parsePlaylist(await (await fetch(url)).text(), url);
}

async function download(path, opts = {}) {
  const playlist = await loadPlaylist(path);
  const loader = createSegmentLoader(playlist, { fetchBytes: createFetcher({ baseDelayMs: 5 }), signal: opts.signal });
  const sink = memorySink();
  const progress = [];
  await downloadMedia(playlist, { sink, loader, mux, onProgress: (p) => progress.push(p), ...opts });
  return { playlist, bytes: sink.buffer(), progress, loader };
}

function save(name, bytes) {
  const file = join(outDir, name);
  writeFileSync(file, bytes);
  return file;
}

function assertPlayable(file, { frames = EXPECTED_FRAMES, seconds = SOURCE_SECONDS } = {}) {
  const r = probeDecode(file);
  assert.ok(r.ok, `ffmpeg reported decode problems:\n${r.stderr}`);
  assert.equal(r.frames, frames, 'frame count');
  assert.ok(Math.abs(r.seconds - seconds) < 0.6, `duration ${r.seconds}s, expected ~${seconds}s`);
}

test('clear TS -> raw .ts is playable and complete (also exercises a retried 503)', async () => {
  const { bytes, playlist, progress } = await download('ts/index.m3u8');
  assert.equal(detectContainer(playlist), 'ts');
  assert.equal(bytes[0], 0x47, 'starts with a TS sync byte');
  assertPlayable(save('clear.ts', bytes));
  assert.equal(progress.at(-1).done, 6);
  assert.deepEqual(progress.map((p) => p.done), [1, 2, 3, 4, 5, 6], 'progress is reported in order');
  assert.equal(log.filter((e) => e.path === '/ts/seg2.ts').map((e) => e.status).join(), '503,200', 'segment retried once');
});

test('clear TS -> MP4 remux is playable, has the right duration, and plays from t=0', async () => {
  const { bytes } = await download('ts/index.m3u8', { remux: true });
  assert.equal(Buffer.from(bytes.subarray(4, 8)).toString(), 'ftyp', 'starts with an ftyp box');
  assertPlayable(save('remuxed.mp4', bytes));
});

test('remuxed MP4 has audio and video streams', async () => {
  const { bytes } = await download('ts/index.m3u8', { remux: true });
  const file = save('streams.mp4', bytes);
  const { spawnSync } = await import('node:child_process');
  const { ffmpegPath } = await import('./helpers/fixtures.js');
  const info = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
  assert.match(info, /Stream #0:\d.*Video: h264/);
  assert.match(info, /Stream #0:\d.*Audio: aac/);
});

test('AES-128 with an explicit IV decrypts correctly (raw and remuxed)', async () => {
  const raw = await download('aes-iv/index.m3u8');
  assertPlayable(save('aes-iv.ts', raw.bytes));
  const mp4 = await download('aes-iv/index.m3u8', { remux: true });
  assertPlayable(save('aes-iv.mp4', mp4.bytes));
});

test('AES-128 with the implicit IV (media sequence number, starting at 7) decrypts correctly', async () => {
  const pl = await loadPlaylist('aes-seq/index.m3u8');
  assert.equal(pl.segments[0].key.iv, null);
  assert.equal(pl.segments[0].sequence, 7);
  const { bytes } = await download('aes-seq/index.m3u8');
  assertPlayable(save('aes-seq.ts', bytes));
  // Decrypted output must equal the clear segments byte for byte.
  const clear = Buffer.concat([0, 1, 2, 3, 4, 5].map((i) => readFileSync(join(FIXTURE_DIR, 'ts', `seg${i}.ts`))));
  assert.ok(bytes.equals(clear), 'decrypted bytes differ from the original');
});

test('the implicit IV really is the media sequence number: using the index instead corrupts block 0', async () => {
  const pl = await loadPlaylist('aes-seq/index.m3u8');
  const clear = readFileSync(join(FIXTURE_DIR, 'ts', 'seg1.ts'));
  const right = await createSegmentLoader(pl, { fetchBytes: createFetcher() }).loadSegment(1);
  assert.ok(Buffer.from(right).equals(clear));
  // CBC with a wrong IV garbles only the first 16-byte block: the rest decrypts fine.
  const wrongPl = { ...pl, segments: pl.segments.map((s) => ({ ...s, sequence: s.index })) };
  const wrong = Buffer.from(await createSegmentLoader(wrongPl, { fetchBytes: createFetcher() }).loadSegment(1));
  assert.ok(!wrong.subarray(0, 16).equals(clear.subarray(0, 16)));
  assert.ok(wrong.subarray(16).equals(clear.subarray(16)));
});

test('fMP4 (EXT-X-MAP) is written as init segment + fragments and plays', async () => {
  const { bytes, playlist } = await download('fmp4/index.m3u8');
  assert.equal(detectContainer(playlist), 'fmp4');
  assert.equal(Buffer.from(bytes.subarray(4, 8)).toString(), 'ftyp');
  assertPlayable(save('fmp4.mp4', bytes));
});

test('EXT-X-BYTERANGE single-file stream is fetched with Range requests and plays', async () => {
  const before = log.length;
  const { bytes } = await download('byterange/index.m3u8');
  assertPlayable(save('byterange.ts', bytes));
  const ranged = log.slice(before).filter((e) => e.path === '/byterange/all.ts');
  assert.equal(ranged.length, 6);
  assert.ok(ranged.every((e) => /^bytes=\d+-\d+$/.test(e.headers.range)));
});

test('a server that ignores Range (answers 200 + whole file) still yields the correct slice', async () => {
  const plain = await serve(FIXTURE_DIR, {
    extraRoutes: (req, res, url, send) => {
      if (url.pathname !== '/byterange/all.ts') return false;
      const body = readFileSync(join(FIXTURE_DIR, 'byterange', 'all.ts'));
      send(200, { 'Content-Type': 'video/mp2t', 'Content-Length': body.length }, body);
      return true;
    },
  });
  try {
    const url = `${plain.origin}/byterange/index.m3u8`;
    const playlist = parsePlaylist(await (await fetch(url)).text(), url);
    const loader = createSegmentLoader(playlist, { fetchBytes: createFetcher() });
    const sink = memorySink();
    await downloadMedia(playlist, { sink, loader });
    assertPlayable(save('byterange-norange.ts', sink.buffer()));
  } finally {
    await plain.close();
  }
});

test('HEVC in TS cannot be converted: probeRemux says so, and raw .ts still works', async () => {
  const playlist = await loadPlaylist('hevc/index.m3u8');
  const loader = createSegmentLoader(playlist, { fetchBytes: createFetcher() });
  const probe = await probeRemux(loader, mux);
  assert.equal(probe.ok, false);
  assert.match(probe.reason, /HEVC/);
  const sink = memorySink();
  await downloadMedia(playlist, { sink, loader });
  assertPlayable(save('hevc.ts', sink.buffer()));
});

test('why probeRemux inspects the TS program map: mux.js silently drops HEVC video instead of failing', async () => {
  const playlist = await loadPlaylist('hevc/index.m3u8');
  const loader = createSegmentLoader(playlist, { fetchBytes: createFetcher() });
  const remuxer = new Mp4Remuxer(mux);
  remuxer.push(await loader.loadSegment(0));
  assert.ok(remuxer.bytes > 0, 'mux.js happily produced output');
  const tracks = mux.probe.tracks(remuxer.initSegment).map((t) => t.type);
  assert.deepEqual(tracks, ['audio'], 'but the video track is gone');
});

test('readTsStreams reports the elementary streams of real segments', async () => {
  const streams = (dir) => readTsStreams(new Uint8Array(readFileSync(join(FIXTURE_DIR, dir, 'seg0.ts')))).streams.map((s) => s.type).sort((a, b) => a - b);
  assert.deepEqual(streams('ts'), [0x0f, 0x1b]); // AAC + H.264
  assert.deepEqual(streams('hevc'), [0x0f, 0x24]); // AAC + HEVC
  assert.equal(readTsStreams(new Uint8Array([1, 2, 3])), null);
  assert.equal(readTsStreams(new Uint8Array(readFileSync(join(FIXTURE_DIR, 'source.mp4')).subarray(0, 4000))), null);
});

test('probeRemux succeeds for H.264+AAC, and the probed segment is not fetched twice', async () => {
  const playlist = await loadPlaylist('ts/index.m3u8');
  const loader = createSegmentLoader(playlist, { fetchBytes: createFetcher() });
  const probe = await probeRemux(loader, mux);
  assert.deepEqual(probe, { ok: true, reason: '' });
  const mark = log.length;
  await downloadMedia(playlist, { sink: memorySink(), loader, remux: true, mux });
  assert.equal(log.slice(mark).filter((e) => e.path === '/ts/seg0.ts').length, 0, 'seg0 came from the probe');
  assert.equal(log.slice(mark).filter((e) => e.path.startsWith('/ts/seg')).length, 5);
});

test('probeRemux without a Transmuxer degrades gracefully', async () => {
  const playlist = await loadPlaylist('ts/index.m3u8');
  const loader = createSegmentLoader(playlist, { fetchBytes: createFetcher() });
  assert.equal((await probeRemux(loader, null)).ok, false);
});

test('inspectEncryption on real playlists', async () => {
  assert.equal(inspectEncryption(await loadPlaylist('aes-iv/index.m3u8')).supported, true);
  assert.equal(inspectEncryption(await loadPlaylist('ts/index.m3u8')).method, 'NONE');
});

test('HTTP 404 on a segment fails fast without retrying', async () => {
  const playlist = await loadPlaylist('ts/index.m3u8');
  playlist.segments[3] = { ...playlist.segments[3], url: `${server.origin}/ts/missing.ts` };
  const loader = createSegmentLoader(playlist, { fetchBytes: createFetcher({ baseDelayMs: 1 }) });
  const mark = log.length;
  await assert.rejects(downloadMedia(playlist, { sink: memorySink(), loader }), (e) => e instanceof HttpError && e.status === 404);
  assert.equal(log.slice(mark).filter((e) => e.path === '/ts/missing.ts').length, 1, 'no retry on 4xx');
});

test('persistent 503 gives up after the retry budget', async () => {
  const flaky = await serve(FIXTURE_DIR, { extraRoutes: (req, res, url, send) => (url.pathname === '/ts/seg1.ts' ? (send(503, {}, 'x'), true) : false) });
  try {
    const url = `${flaky.origin}/ts/index.m3u8`;
    const playlist = parsePlaylist(await (await fetch(url)).text(), url);
    const loader = createSegmentLoader(playlist, { fetchBytes: createFetcher({ retries: 2, baseDelayMs: 1 }) });
    await assert.rejects(downloadMedia(playlist, { sink: memorySink(), loader }), (e) => e.status === 503);
    assert.equal(flaky.log.filter((e) => e.path === '/ts/seg1.ts').length, 3, '1 try + 2 retries');
  } finally {
    await flaky.close();
  }
});

test('cancelling mid-download rejects with AbortError and stops fetching', async () => {
  const slow = await serve(FIXTURE_DIR, {
    extraRoutes: (req, res, url, send) => {
      if (!url.pathname.endsWith('.ts')) return false;
      setTimeout(() => send(200, { 'Content-Type': 'video/mp2t' }, readFileSync(join(FIXTURE_DIR, 'ts', 'seg0.ts'))), 150);
      return true;
    },
  });
  try {
    const url = `${slow.origin}/ts/index.m3u8`;
    const playlist = parsePlaylist(await (await fetch(url)).text(), url);
    const ac = new AbortController();
    const loader = createSegmentLoader(playlist, { fetchBytes: createFetcher(), signal: ac.signal });
    const done = downloadMedia(playlist, { sink: memorySink(), loader, signal: ac.signal, concurrency: 2 });
    setTimeout(() => ac.abort(), 60);
    await assert.rejects(done, (e) => e.name === 'AbortError');
    const requestsAtAbort = slow.log.length;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(slow.log.length, requestsAtAbort, 'no new requests after abort');
  } finally {
    await slow.close();
  }
});

test('a sink that throws (disk full) aborts the whole download with that error', async () => {
  const playlist = await loadPlaylist('aes-iv/index.m3u8');
  const loader = createSegmentLoader(playlist, { fetchBytes: createFetcher() });
  let n = 0;
  const sink = { write: async () => { if (++n === 3) throw new Error('disk full'); } };
  await assert.rejects(downloadMedia(playlist, { sink, loader }), /disk full/);
});

test('a wrong AES key length is reported clearly', async () => {
  const playlist = await loadPlaylist('aes-iv/index.m3u8');
  const loader = createSegmentLoader(playlist, {
    fetchBytes: async (url, o) => (url.endsWith('.key') ? new Uint8Array(5) : createFetcher()(url, o)),
  });
  await assert.rejects(downloadMedia(playlist, { sink: memorySink(), loader }), /key length/);
});

test('runOrdered consumes strictly in order and never buffers more than `ahead` items', async () => {
  const order = [];
  let maxBuffered = 0;
  let produced = 0;
  let consumed = 0;
  await runOrdered({
    total: 60,
    concurrency: 8,
    ahead: 10,
    produce: async (i) => {
      await new Promise((r) => setTimeout(r, Math.random() * 15));
      produced++;
      maxBuffered = Math.max(maxBuffered, produced - consumed);
      return i;
    },
    consume: async (i, v) => {
      assert.equal(i, v);
      order.push(i);
      consumed++;
      await new Promise((r) => setTimeout(r, Math.random() * 3));
    },
  });
  assert.deepEqual(order, Array.from({ length: 60 }, (_, i) => i));
  assert.ok(maxBuffered <= 10 + 8, `buffered ${maxBuffered}`);
});

test('runOrdered propagates a producer failure and settles', async () => {
  await assert.rejects(
    runOrdered({ total: 20, concurrency: 4, produce: async (i) => { if (i === 7) throw new Error('boom'); return i; }, consume: async () => {} }),
    /boom/,
  );
});

test('downloadFile streams a file, reports progress and verifies the length', async () => {
  const sink = memorySink();
  const seen = [];
  await downloadFile(`${server.origin}/source.mp4`, { sink, onProgress: (p) => seen.push(p) });
  assert.ok(sink.buffer().equals(readFileSync(join(FIXTURE_DIR, 'source.mp4'))));
  assert.equal(seen.at(-1).received, seen.at(-1).total);
  assertPlayable(save('direct.mp4', sink.buffer()));
});

test('downloadFile rejects HTML error pages and truncated bodies', async () => {
  const bad = await serve(FIXTURE_DIR, {
    extraRoutes: (req, res, url, send) => {
      if (url.pathname === '/page.mp4') return send(200, { 'Content-Type': 'text/html' }, '<html>login</html>'), true;
      if (url.pathname === '/short.mp4') {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 1000 });
        res.write(Buffer.alloc(300));
        setTimeout(() => res.destroy(), 20);
        return true;
      }
      return false;
    },
  });
  try {
    await assert.rejects(downloadFile(`${bad.origin}/page.mp4`, { sink: memorySink() }), /web page/);
    await assert.rejects(downloadFile(`${bad.origin}/short.mp4`, { sink: memorySink() }));
  } finally {
    await bad.close();
  }
});

test('audio-only TS (separate audio rendition) converts to a playable audio-only MP4', async () => {
  const { bytes, playlist } = await download('audio-only/index.m3u8', { remux: true });
  assert.equal(detectContainer(playlist), 'ts');
  const probe = await probeRemux(createSegmentLoader(playlist, { fetchBytes: createFetcher() }), mux);
  assert.deepEqual(probe, { ok: true, reason: '' });
  const file = save('audio-only.m4a', bytes);
  assertPlayable(file, { frames: 0, seconds: SOURCE_SECONDS });
  const { spawnSync } = await import('node:child_process');
  const { ffmpegPath } = await import('./helpers/fixtures.js');
  const info = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
  assert.match(info, /Audio: aac/);
  assert.doesNotMatch(info, /Video:/);
});

test('video-only TS converts to MP4 with all frames', async () => {
  const { bytes } = await download('video-only/index.m3u8', { remux: true });
  assertPlayable(save('video-only.mp4', bytes));
});

test('a playlist without EXT-X-ENDLIST is reported as live; one with a FairPlay key is flagged as DRM', async () => {
  const live = await loadPlaylist('live/index.m3u8');
  assert.equal(live.endList, false);
  const drm = inspectEncryption(await loadPlaylist('drm/index.m3u8'));
  assert.equal(drm.supported, false);
  assert.equal(drm.drm, true);
});
