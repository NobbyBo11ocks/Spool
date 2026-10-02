import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse, classifyUrl, dedupeKey, responseSize, looksLikeStreamPiece, MIN_FILE_BYTES } from '../extension/lib/detect.js';
import { sanitizeFilename, formatBytes, formatDuration, extFromMime, filenameFromUrl, hashString, hashToRuleId, safeUrl } from '../extension/lib/util.js';

const resp = (url, type, extra = [], statusCode = 200) => ({
  url,
  statusCode,
  responseHeaders: [...(type === null ? [] : [{ name: 'Content-Type', value: type }]), ...extra],
});
const len = (n) => ({ name: 'Content-Length', value: String(n) });

test('video/* with a real size is a file', () => {
  const r = classifyResponse(resp('https://cdn.example.com/a/clip.mp4?token=x', 'video/mp4', [len(5_000_000)]));
  assert.deepEqual(r, { kind: 'file', media: 'video', mime: 'video/mp4', ext: '.mp4', size: 5_000_000 });
});

test('tiny media responses are ignored (UI sounds, probes)', () => {
  assert.equal(classifyResponse(resp('https://x.test/click.mp3', 'audio/mpeg', [len(MIN_FILE_BYTES - 1)])), null);
  assert.notEqual(classifyResponse(resp('https://x.test/song.mp3', 'audio/mpeg', [len(MIN_FILE_BYTES)])), null);
});

test('unknown size (chunked) is accepted', () => {
  assert.equal(classifyResponse(resp('https://x.test/v.webm', 'video/webm')).size, null);
});

test('206 responses report the total size from Content-Range, never the partial length', () => {
  const r = classifyResponse(resp('https://x.test/movie.mp4', 'video/mp4', [len(1_048_576), { name: 'Content-Range', value: 'bytes 0-1048575/734003200' }], 206));
  assert.equal(r.size, 734003200);
  // Partial body without a known total: size unknown rather than wrong.
  assert.equal(responseSize(206, [len(1000), { name: 'Content-Range', value: 'bytes 0-999/*' }]), null);
  assert.equal(responseSize(206, [len(1000)]), null);
});

test('HLS by mime type and by extension', () => {
  assert.equal(classifyResponse(resp('https://x.test/live/master.m3u8', 'application/vnd.apple.mpegurl')).kind, 'hls');
  assert.equal(classifyResponse(resp('https://x.test/live/master.m3u8', 'application/x-mpegURL; charset=utf-8')).kind, 'hls');
  assert.equal(classifyResponse(resp('https://x.test/p.m3u8?x=1', 'binary/octet-stream')).kind, 'hls');
  assert.equal(classifyResponse(resp('https://x.test/hls', 'application/vnd.apple.mpegurl')).kind, 'hls');
  // An HTML error page that happens to be at a .m3u8 URL is not a playlist.
  assert.equal(classifyResponse(resp('https://x.test/p.m3u8', 'text/html')), null);
});

test('DASH manifests are detected', () => {
  assert.equal(classifyResponse(resp('https://x.test/m.mpd', 'application/dash+xml')).kind, 'dash');
  assert.equal(classifyResponse(resp('https://x.test/m.mpd', 'application/octet-stream')).kind, 'dash');
});

test('stream segments are not listed as downloads', () => {
  for (const [url, type] of [
    ['https://x.test/seg1.ts', 'video/mp2t'],
    ['https://x.test/seg1.ts', 'application/octet-stream'],
    ['https://x.test/chunk-3.m4s', 'video/mp4'],
    ['https://x.test/a.aac', 'audio/aac'],
    ['https://x.test/s', 'video/mp2t'],
    ['https://x.test/s.vtt', 'text/vtt'],
  ]) {
    assert.equal(classifyResponse(resp(url, type, [len(900_000)])), null, `${url} ${type}`);
  }
});

test('octet-stream is accepted only when the URL looks like media', () => {
  assert.equal(classifyResponse(resp('https://x.test/dl/video.mkv', 'application/octet-stream', [len(9_000_000)])).media, 'video');
  assert.equal(classifyResponse(resp('https://x.test/dl/archive.zip', 'application/octet-stream', [len(9_000_000)])), null);
  assert.equal(classifyResponse(resp('https://x.test/dl/video.mp4', null, [len(9_000_000)])).kind, 'file');
});

test('non-2xx, non-http, images, html and YouTube chunks are ignored', () => {
  assert.equal(classifyResponse(resp('https://x.test/a.mp4', 'video/mp4', [len(9e6)], 404)), null);
  assert.equal(classifyResponse(resp('https://x.test/a.mp4', 'video/mp4', [len(9e6)], 304)), null);
  assert.equal(classifyResponse(resp('blob:https://x.test/uuid', 'video/mp4', [len(9e6)])), null);
  assert.equal(classifyResponse(resp('https://x.test/p.png', 'image/png', [len(9e6)])), null);
  assert.equal(classifyResponse(resp('https://x.test/watch', 'text/html')), null);
  assert.equal(classifyResponse(resp('https://rr1---sn-abc.googlevideo.com/videoplayback?id=1', 'video/mp4', [len(9e6)])), null);
});

test('classifyUrl for DOM-discovered URLs', () => {
  assert.equal(classifyUrl('https://x.test/a.m3u8?t=1').kind, 'hls');
  assert.equal(classifyUrl('https://x.test/a.mpd').kind, 'dash');
  assert.equal(classifyUrl('https://x.test/a.webm').media, 'video');
  assert.equal(classifyUrl('https://x.test/a.mp3').media, 'audio');
  assert.equal(classifyUrl('https://x.test/a.ts'), null);
  assert.equal(classifyUrl('https://x.test/a.html'), null);
  assert.equal(classifyUrl('data:video/mp4;base64,AAAA'), null);
  assert.equal(classifyUrl('not a url'), null);
});

test('dedupeKey ignores per-request tokens for files but keeps identity for others', () => {
  assert.equal(dedupeKey('https://cdn.test/v/a.mp4?token=1&exp=2#t=3'), dedupeKey('https://cdn.test/v/a.mp4?token=9&exp=8'));
  assert.notEqual(dedupeKey('https://cdn.test/v/a.mp4'), dedupeKey('https://cdn.test/v/b.mp4'));
  assert.notEqual(dedupeKey('https://cdn.test/v/a.mp4'), dedupeKey('https://other.test/v/a.mp4'));
  assert.equal(dedupeKey('https://cdn.test/live/index.m3u8?sig=a'), dedupeKey('https://cdn.test/live/index.m3u8?sig=b'));
  // Extension-less endpoints: the query identifies the video, but range noise doesn't.
  assert.notEqual(dedupeKey('https://cdn.test/stream?id=1'), dedupeKey('https://cdn.test/stream?id=2'));
  assert.equal(dedupeKey('https://cdn.test/stream?id=1&range=0-99'), dedupeKey('https://cdn.test/stream?id=1&range=100-199'));
});

test('sanitizeFilename produces safe names on every OS', () => {
  assert.equal(sanitizeFilename('Movie: The "Sequel" <2024> | HD?'), 'Movie The Sequel 2024 HD');
  assert.equal(sanitizeFilename('a/b\\c'), 'a b c');
  assert.equal(sanitizeFilename('  ...hidden. '), 'hidden');
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('lpt1'), '_lpt1');
  assert.equal(sanitizeFilename(''), 'video');
  assert.equal(sanitizeFilename('???'), 'video');
  assert.equal(sanitizeFilename(null, 'x'), 'x');
  assert.equal(sanitizeFilename('x'.repeat(300)).length, 120);
  assert.equal(sanitizeFilename('tab\tand\nnewline\u0000nul'), 'tab and newline nul');
  assert.equal(sanitizeFilename('日本語のタイトル'), '日本語のタイトル');
});

test('formatting helpers', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(734003200), '700 MB');
  assert.equal(formatBytes(null), '');
  assert.equal(formatDuration(59), '0:59');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(0), '');
  assert.equal(extFromMime('video/webm'), '.webm');
  assert.equal(extFromMime('application/x-unknown'), '');
  assert.equal(filenameFromUrl('https://x.test/a/My%20Video.mp4'), 'My Video.mp4');
});

test('hashing helpers are deterministic and in range', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
  const id = hashToRuleId('ext:example.com');
  assert.ok(Number.isInteger(id) && id >= 1 && id < 2_147_483_647);
});

test('file extensions come only from the known media list, so a page cannot pick e.g. ".exe" for the saved file', () => {
  assert.equal(classifyResponse(resp('https://x.test/payload.exe', 'video/x-weird', [len(9e6)])).ext, '');
  assert.equal(classifyResponse(resp('https://x.test/run.bat', 'audio/x-weird', [len(9e6)])).ext, '');
  assert.equal(classifyResponse(resp('https://x.test/clip.webm', 'video/x-weird', [len(9e6)])).ext, '.webm');
  assert.equal(classifyResponse(resp('https://x.test/anything.exe', 'video/mp4', [len(9e6)])).ext, '.mp4');
  assert.equal(classifyUrl('https://x.test/clip.mkv').ext, '.mkv');
});

test('stream pieces named like init segments or fragments are not offered as video files', () => {
  // The real-world case: a fragmented-MP4 stream's init segment (a few KB of ftyp+moov) with a .mp4 extension.
  const pieces = ['init-s1080p-v1-a1.mp4', 'init.mp4', 'video-init.mp4', 'audio_init.m4a', 'init_0.mp4', 'seg-1-v1-a1.mp4', 'segment_12.mp4', 'chunk-0001.mp4', 'frag-5.mp4', 'fragment_3.mp4', 'seg1.mp4'];
  for (const name of pieces) {
    const url = `https://cdn.test/v/${name}`;
    assert.equal(looksLikeStreamPiece(new URL(url).pathname), true, name);
    assert.equal(classifyUrl(url), null, `classifyUrl ${name}`);
    // Even with an unknown size (chunked response / DOM discovery) and a video mime type:
    assert.equal(classifyResponse(resp(url, 'video/mp4')), null, `classifyResponse ${name}`);
    assert.equal(classifyResponse(resp(url, 'video/mp4', [len(5_000_000)])), null, `classifyResponse (big) ${name}`);
  }
});

test('ordinary file names are not mistaken for stream pieces', () => {
  for (const name of ['intro.mp4', 'my movie.mp4', 'initiation.mp4', 'Inception (2010).mp4', 'segment anything demo.mp4', 'reinitialize.mp4', 'Final Segment 2.mp4', 'chunky.mp4', 'fragile.mp4', 'seg.mp4', 'initial-d.mp4']) {
    assert.equal(looksLikeStreamPiece(`/v/${encodeURIComponent(name)}`), false, name);
    assert.notEqual(classifyUrl(`https://cdn.test/v/${encodeURIComponent(name)}`), null, name);
  }
  assert.equal(looksLikeStreamPiece('/%E0%A4%A'), false, 'malformed escapes do not throw');
});

test('safeUrl keeps origin and path, and drops the query string and fragment (they can carry tokens)', () => {
  assert.equal(safeUrl('https://cdn.test/v/master.m3u8?token=SECRET&exp=1#frag'), 'https://cdn.test/v/master.m3u8');
  assert.equal(safeUrl('http://127.0.0.1:4174/a/b.mp4'), 'http://127.0.0.1:4174/a/b.mp4');
  assert.equal(safeUrl('not a url?x=1'), 'not a url');
});
