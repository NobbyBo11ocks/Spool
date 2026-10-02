// DASH end to end in Node: real ffmpeg-generated streams are served over HTTP, downloaded with the engine, and the
// result is decoded with ffmpeg. "Decodes cleanly with the right frames, streams and duration" is the pass criterion.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureFixtures, serve, probeDecode, ffmpegPath, FIXTURE_DIR, SOURCE_FPS, SOURCE_SECONDS } from './helpers/fixtures.js';
import { parseMpd, videoRepresentations, audioRepresentations } from '../extension/lib/dash.js';
import { downloadDash, canMerge, planFor } from '../extension/lib/dash-download.js';
import { createFetcher } from '../extension/lib/hls-download.js';
import { mergeInit, rewriteSegment, readBoxes } from '../extension/lib/fmp4.js';

const FRAMES = SOURCE_SECONDS * SOURCE_FPS;
const outDir = mkdtempSync(join(tmpdir(), 'md-dash-'));
let server;
let log;

before(async () => {
  ensureFixtures();
  log = [];
  server = await serve(FIXTURE_DIR, { log });
});
after(() => server.close());

const memorySink = () => {
  const chunks = [];
  return { write: async (c) => void chunks.push(Buffer.from(c)), buffer: () => Buffer.concat(chunks) };
};

async function load(dir, name = 'index.mpd') {
  const url = `${server.origin}/${dir}/${name}`;
  return parseMpd(await (await fetch(url)).text(), url);
}

async function run(mpd, { video, audio, merge }, opts = {}) {
  const sink = memorySink();
  const progress = [];
  await downloadDash({
    mpdType: mpd.type,
    video,
    audio,
    merge,
    sink,
    fetchBytes: createFetcher({ baseDelayMs: 5 }),
    onProgress: (p) => progress.push(p),
    ...opts,
  });
  return { bytes: sink.buffer(), progress };
}

function check(name, bytes, { frames = FRAMES, seconds = SOURCE_SECONDS } = {}) {
  const file = join(outDir, name);
  writeFileSync(file, bytes);
  const r = probeDecode(file);
  assert.ok(r.ok, `${name} has decode problems:\n${r.stderr}`);
  assert.equal(r.frames, frames, `${name} frame count`);
  assert.ok(Math.abs(r.seconds - seconds) < 0.7, `${name} duration ${r.seconds}s`);
  return spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
}

// ---- merged video + audio ----------------------------------------------------------------------------------------

for (const [dir, label] of [['dash-tpl', 'SegmentTemplate + timeline'], ['dash-list', 'SegmentList'], ['dash-single', 'single file with byte ranges']]) {
  test(`${label}: video and audio merge into one playable MP4`, async () => {
    const mpd = await load(dir);
    const video = videoRepresentations(mpd)[0];
    const audio = audioRepresentations(mpd)[0];
    assert.equal(canMerge(video, audio, mpd.type), true);
    const { bytes, progress } = await run(mpd, { video, audio, merge: true });
    const info = check(`${dir}-merged.mp4`, bytes);
    assert.match(info, /Video: h264.*640x360/);
    assert.match(info, /Audio: aac/);
    assert.equal(progress.at(-1).done, progress.at(-1).total);
    assert.deepEqual(progress.map((p) => p.done), progress.map((_, i) => i + 1), 'progress is reported in order');
  });
}

test('merged output: two tracks, strictly increasing moof sequence numbers, track IDs 1 and 2, no styp/sidx left', async () => {
  const mpd = await load('dash-tpl');
  const { bytes } = await run(mpd, { video: videoRepresentations(mpd)[0], audio: audioRepresentations(mpd)[0], merge: true });
  const u32 = (o) => bytes.readUInt32BE(o);
  const top = [...readBoxes(bytes)];
  assert.deepEqual(top.slice(0, 2).map((b) => b.type), ['ftyp', 'moov']);
  const moov = top[1];
  const traks = [...readBoxes(bytes, moov.payload, moov.end)].filter((b) => b.type === 'trak');
  assert.equal(traks.length, 2);
  const ids = traks.map((t) => {
    const tkhd = [...readBoxes(bytes, t.payload, t.end)].find((b) => b.type === 'tkhd');
    return u32(tkhd.payload + (bytes[tkhd.payload] === 1 ? 20 : 12));
  });
  assert.deepEqual(ids.sort(), [1, 2], 'distinct track IDs even though both source streams used track 1');
  const mvhd = [...readBoxes(bytes, moov.payload, moov.end)].find((b) => b.type === 'mvhd');
  assert.equal(u32(mvhd.payload + (bytes[mvhd.payload] === 1 ? 108 : 96)), 3, 'next_track_ID');
  const mvex = [...readBoxes(bytes, moov.payload, moov.end)].find((b) => b.type === 'mvex');
  assert.equal([...readBoxes(bytes, mvex.payload, mvex.end)].filter((b) => b.type === 'trex').length, 2);

  const rest = top.slice(2);
  assert.ok(rest.every((b) => b.type === 'moof' || b.type === 'mdat'), `unexpected boxes: ${[...new Set(rest.map((b) => b.type))]}`);
  const moofs = rest.filter((b) => b.type === 'moof');
  const seqs = moofs.map((m) => u32([...readBoxes(bytes, m.payload, m.end)].find((b) => b.type === 'mfhd').payload + 4));
  assert.deepEqual(seqs, moofs.map((_, i) => i + 1));
  const trackOf = (m) => {
    const traf = [...readBoxes(bytes, m.payload, m.end)].find((b) => b.type === 'traf');
    const tfhd = [...readBoxes(bytes, traf.payload, traf.end)].find((b) => b.type === 'tfhd');
    return u32(tfhd.payload + 4);
  };
  assert.deepEqual([...new Set(moofs.map(trackOf))].sort(), [1, 2]);
  // Interleaved, not video-then-audio: the track alternates near the start of the file.
  assert.ok(moofs.slice(0, 4).map(trackOf).includes(2), 'audio appears among the first fragments');
  assert.equal(moofs.length, 6 + 7);
});

test('several video qualities: the chosen one is the one that is saved', async () => {
  const mpd = await load('dash-multi');
  const [hi, lo] = videoRepresentations(mpd);
  const audio = audioRepresentations(mpd)[0];
  const low = await run(mpd, { video: lo, audio, merge: true });
  assert.match(check('multi-180.mp4', low.bytes), /Video: h264.*320x180/);
  const high = await run(mpd, { video: hi, audio, merge: true });
  assert.match(check('multi-360.mp4', high.bytes), /Video: h264.*640x360/);
  assert.ok(high.bytes.length > low.bytes.length);
});

// ---- one stream on its own -----------------------------------------------------------------------------------------

test('video only, audio only, and the number-addressed manifest', async () => {
  const mpd = await load('dash-tpl');
  const v = await run(mpd, { video: videoRepresentations(mpd)[0] });
  const vInfo = check('video-only.mp4', v.bytes);
  assert.match(vInfo, /Video: h264/);
  assert.doesNotMatch(vInfo, /Audio:/);
  const a = await run(mpd, { audio: audioRepresentations(mpd)[0] });
  const aInfo = check('audio-only.m4a', a.bytes, { frames: 0 });
  assert.match(aInfo, /Audio: aac/);
  assert.doesNotMatch(aInfo, /Video:/);

  const numbered = await load('dash-tpl', 'number.mpd');
  const n = await run(numbered, { video: videoRepresentations(numbered)[0] });
  check('number.mp4', n.bytes);
});

test('WebM segments are saved as they are, and are never offered for merging', async () => {
  const mpd = await load('dash-webm');
  const video = videoRepresentations(mpd)[0];
  const audio = audioRepresentations(mpd)[0];
  assert.equal(canMerge(video, audio, mpd.type), false);
  const v = await run(mpd, { video });
  assert.match(check('webm-video.webm', v.bytes), /Video: vp9/);
  const a = await run(mpd, { audio });
  assert.match(check('webm-audio.weba', a.bytes, { frames: 0 }), /Audio: opus/);
});

// ---- failure and control paths -------------------------------------------------------------------------------------

test('DRM and unsupported live manifests are refused with a message, before any download', async () => {
  const drm = await load('dash-tpl', 'drm.mpd');
  assert.equal(drm.protected, true);
  const live = parseMpd(
    '<MPD type="dynamic"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="1"><SegmentTemplate duration="2" media="s$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>',
    `${server.origin}/live.mpd`,
  );
  assert.throws(() => planFor(videoRepresentations(live)[0], live.type), /wall-clock/);
  await assert.rejects(run(live, { video: videoRepresentations(live)[0] }), /wall-clock/);
});

test('merging a stream that is not fragmented fails with a clear error (the caller then saves the streams separately)', async () => {
  const mpd = await load('dash-tpl');
  const video = videoRepresentations(mpd)[0];
  const plan = planFor(video, mpd.type);
  const init = new Uint8Array(await (await fetch(plan.init.url)).arrayBuffer());
  // A plain MP4 (moov without mvex) from the fixtures.
  const progressive = new Uint8Array(await (await fetch(`${server.origin}/source.mp4`)).arrayBuffer());
  assert.throws(() => mergeInit(progressive, init), /not a fragmented MP4/i);
  assert.throws(() => mergeInit(init, progressive), /not a fragmented MP4/i);
});

test('segments with an explicit base_data_offset are refused (their offsets would point into the wrong file)', () => {
  // moof { mfhd, traf { tfhd with flag 0x1 } } followed by an empty mdat.
  const be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const box = (type, ...payload) => {
    const body = payload.flat();
    return [...be(8 + body.length), ...type.split('').map((c) => c.charCodeAt(0)), ...body];
  };
  const tfhd = box('tfhd', ...be(0x000001), ...be(1), 0, 0, 0, 0, 0, 0, 0, 0);
  const moof = box('moof', box('mfhd', ...be(0), ...be(1)), box('traf', tfhd));
  const bytes = Uint8Array.from([...moof, ...box('mdat')]);
  assert.throws(() => rewriteSegment(bytes, new Map(), 1), /base data offset/);
});

test('a missing segment fails the download fast with its HTTP status', async () => {
  const mpd = await load('dash-tpl');
  const video = videoRepresentations(mpd)[0];
  const broken = { ...video, _base: `${server.origin}/dash-tpl/nonexistent/` };
  await assert.rejects(run(mpd, { video: broken }), (e) => e.status === 404);
});

test('cancelling stops the download with an AbortError and no further requests', async () => {
  const slow = await serve(FIXTURE_DIR, {
    extraRoutes: (req, res, url, send) => {
      if (!url.pathname.endsWith('.m4s')) return false;
      const timer = setTimeout(() => send(200, { 'Content-Type': 'video/mp4' }, Buffer.alloc(100)), 200);
      res.on('close', () => clearTimeout(timer));
      return true;
    },
  });
  try {
    const url = `${slow.origin}/dash-tpl/index.mpd`;
    const mpd = parseMpd(await (await fetch(url)).text(), url);
    const ac = new AbortController();
    const done = downloadDash({ mpdType: 'static', video: videoRepresentations(mpd)[0], sink: memorySink(), fetchBytes: createFetcher(), signal: ac.signal, concurrency: 2 });
    setTimeout(() => ac.abort(), 80);
    await assert.rejects(done, (e) => e.name === 'AbortError');
    const seen = slow.log.length;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(slow.log.length, seen, 'no requests after the abort');
  } finally {
    await slow.close();
  }
});
