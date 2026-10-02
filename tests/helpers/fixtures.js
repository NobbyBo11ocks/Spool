// Generates real media fixtures (HLS in several flavours) with ffmpeg and serves them over HTTP.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize, sep } from 'node:path';
import { createRequire } from 'node:module';
import { createCipheriv } from 'node:crypto';

const require = createRequire(import.meta.url);
// ffmpeg generates the fixtures and decodes the output. FFMPEG_PATH picks a system build instead of the bundled static one:
// on GitHub's Linux runners the bundled binary was observed to die with SIGSEGV when decoding MPEG-TS, so CI uses the distro's.
export const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');

export const FIXTURE_DIR = join(tmpdir(), 'moviedownloader-fixtures-v7');
export const SOURCE_SECONDS = 12;
export const SOURCE_FPS = 25;

export function ffmpeg(args, cwd) {
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed:\n${r.stderr}`);
  return r;
}

/** Decodes a file completely; returns {ok, frames, seconds, stderr}. `ok` means no decode errors. */
export function probeDecode(file) {
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-v', 'error', '-stats', '-i', file, '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  const frames = [...r.stderr.matchAll(/frame=\s*(\d+)/g)].pop()?.[1];
  const time = [...r.stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)].pop();
  const errors = r.stderr
    .split(/\r|\n/)
    .filter((l) => l && !/^(frame|size)=/.test(l.trim()) && !/^\[out#/.test(l) && !/^\s*$/.test(l));
  // A failure with no message of its own (a crash, a spawn error) must still say what happened.
  const exit = r.status === 0 ? '' : `\n[ffmpeg exit status ${r.status}, signal ${r.signal}${r.error ? `, ${r.error.message}` : ''}]`;
  return {
    ok: r.status === 0 && errors.length === 0,
    frames: frames ? Number(frames) : 0,
    seconds: time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : 0,
    stderr: r.stderr + exit,
  };
}

const marker = join(FIXTURE_DIR, '.complete');

const lock = join(FIXTURE_DIR, '.building');
const STALE_LOCK_MS = 10 * 60 * 1000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Builds all fixtures once and returns the directory. Test files run in parallel processes and each one calls this: the
 * first takes a lock (mkdir is atomic) and builds, the others wait for it. Without the lock they all wrote the same
 * files at the same time on a fresh machine, and ffmpeg failed with "No such file or directory".
 */
export function ensureFixtures() {
  if (existsSync(marker)) return FIXTURE_DIR;
  mkdirSync(FIXTURE_DIR, { recursive: true });
  try {
    mkdirSync(lock);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    while (!existsSync(marker)) {
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        return ensureFixtures(); // the builder finished or gave up between our checks
      }
      if (age > STALE_LOCK_MS) {
        rmSync(lock, { recursive: true, force: true }); // a build that was killed halfway
        return ensureFixtures();
      }
      sleep(250);
    }
    return FIXTURE_DIR;
  }
  try {
    return buildFixtures();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function buildFixtures() {
  const d = FIXTURE_DIR;

  // Source: 12 s, 25 fps, 640x360 H.264 + AAC with a keyframe every 2 s.
  const lavfi = [
    '-f', 'lavfi', '-i', `testsrc=duration=${SOURCE_SECONDS}:size=640x360:rate=${SOURCE_FPS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SOURCE_SECONDS}`,
  ];
  const h264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(SOURCE_FPS * 2), '-keyint_min', String(SOURCE_FPS * 2), '-sc_threshold', '0', '-c:a', 'aac', '-shortest'];
  ffmpeg([...lavfi, ...h264, join(d, 'source.mp4')]);

  const hls = (dir, extra, input = join(d, 'source.mp4'), codec = ['-c', 'copy']) => {
    mkdirSync(join(d, dir), { recursive: true });
    ffmpeg(['-i', input, ...codec, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', ...extra, 'index.m3u8'], join(d, dir));
  };

  hls('ts', ['-hls_segment_filename', 'seg%d.ts']);
  hls('fmp4', ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'seg%d.m4s']);
  hls('byterange', ['-hls_flags', 'single_file', '-hls_segment_filename', 'all.ts']);

  // AES-128 with an explicit IV, produced by ffmpeg.
  mkdirSync(join(d, 'aes-iv'), { recursive: true });
  writeFileSync(join(d, 'aes-iv', 'enc.key'), Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
  writeFileSync(join(d, 'aes-iv', 'key.info'), ['enc.key', join(d, 'aes-iv', 'enc.key'), '0123456789abcdef0123456789abcdef'].join('\n'));
  hls('aes-iv', ['-hls_key_info_file', 'key.info', '-hls_segment_filename', 'seg%d.ts']);

  // AES-128 with the *implicit* IV (RFC 8216 4.3.2.4: the media sequence number, big-endian, in 16 bytes).
  // ffmpeg always writes an explicit IV, so encrypt the clear segments ourselves, starting at sequence 7.
  mkdirSync(join(d, 'aes-seq'), { recursive: true });
  const seqKey = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex');
  writeFileSync(join(d, 'aes-seq', 'enc.key'), seqKey);
  const firstSeq = 7;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${firstSeq}`, '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-KEY:METHOD=AES-128,URI="enc.key"'];
  for (let i = 0; i < 6; i++) {
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(firstSeq + i, 12);
    const cipher = createCipheriv('aes-128-cbc', seqKey, iv); // PKCS7 padding by default
    writeFileSync(join(d, 'aes-seq', `seg${i}.ts`), Buffer.concat([cipher.update(readFileSync(join(d, 'ts', `seg${i}.ts`))), cipher.final()]));
    lines.push('#EXTINF:2.000000,', `seg${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST', '');
  writeFileSync(join(d, 'aes-seq', 'index.m3u8'), lines.join('\n'));

  // HEVC in TS: not convertible by mux.js.
  hls('hevc', ['-hls_segment_filename', 'seg%d.ts'], join(d, 'source.mp4'), ['-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=none:keyint=50:min-keyint=50', '-c:a', 'aac']);

  // Second quality (320x180) for multi-quality masters.
  hls('ts180', ['-hls_segment_filename', 'seg%d.ts'], join(d, 'source.mp4'), ['-vf', 'scale=320:180', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(SOURCE_FPS * 2), '-keyint_min', String(SOURCE_FPS * 2), '-sc_threshold', '0', '-c:a', 'copy']);
  // Video-only and audio-only HLS, for masters that reference audio as a separate rendition.
  hls('video-only', ['-hls_segment_filename', 'seg%d.ts'], join(d, 'source.mp4'), ['-an', '-c:v', 'copy']);
  hls('audio-only', ['-hls_segment_filename', 'seg%d.ts'], join(d, 'source.mp4'), ['-vn', '-c:a', 'copy']);

  const master = (lines) => lines.concat(['']).join('\n');
  writeFileSync(join(d, 'master.m3u8'), master(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"', 'ts/index.m3u8']));
  writeFileSync(
    join(d, 'master-multi.m3u8'),
    master([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,CODECS="avc1.64000d,mp4a.40.2"',
      'ts180/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"',
      'ts/index.m3u8',
    ]),
  );
  // A master that advertises three common qualities; every variant points at the same small media playlist. Used by the
  // documentation screenshots (scripts/screenshots.mjs) so the UI shows realistic quality labels.
  writeFileSync(
    join(d, 'master-hd.m3u8'),
    master([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
      'ts/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
      'ts/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,CODECS="avc1.64001e,mp4a.40.2"',
      'ts/index.m3u8',
    ]),
  );
  writeFileSync(
    join(d, 'master-audio.m3u8'),
    master([
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio-only/index.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"',
      'video-only/index.m3u8',
    ]),
  );

  // ---- DASH ------------------------------------------------------------------------------------------------------
  const dash = (dir, extra, { input = join(d, 'source.mp4'), codec = ['-c', 'copy'], sets = 'id=0,streams=v id=1,streams=a', pre = [] } = {}) => {
    mkdirSync(join(d, dir), { recursive: true });
    ffmpeg([...pre, '-i', input, ...codec, '-f', 'dash', '-seg_duration', '2', ...extra, '-adaptation_sets', sets, 'index.mpd'], join(d, dir));
  };
  dash('dash-tpl', ['-use_template', '1', '-use_timeline', '1']); // SegmentTemplate + SegmentTimeline
  dash('dash-list', ['-use_template', '0', '-use_timeline', '0']); // SegmentList
  dash('dash-single', ['-single_file', '1', '-use_template', '0', '-use_timeline', '0']); // one file per stream, byte ranges
  // Two video qualities + audio.
  dash('dash-multi', ['-use_template', '1', '-use_timeline', '1'], {
    pre: [],
    codec: ['-filter_complex', '[0:v]split=2[a][b];[b]scale=320:180[c]', '-map', '[a]', '-map', '[c]', '-map', '0:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(SOURCE_FPS * 2), '-keyint_min', String(SOURCE_FPS * 2), '-sc_threshold', '0', '-c:a', 'aac'],
    sets: 'id=0,streams=0,1 id=1,streams=2',
  });
  // WebM segments: the container the extension can save but not merge.
  dash('dash-webm', ['-use_template', '1', '-use_timeline', '1', '-dash_segment_type', 'webm'], {
    codec: ['-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-g', String(SOURCE_FPS * 2), '-c:a', 'libopus'],
  });
  // Hand-written variants that reuse the dash-tpl segments.
  const tplMpd = readFileSync(join(d, 'dash-tpl', 'index.mpd'), 'utf8');
  writeFileSync(join(d, 'dash-tpl', 'live.mpd'), tplMpd.replace('type="static"', 'type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z" timeShiftBufferDepth="PT30S"'));
  // Widevine-protected: every AdaptationSet declares ContentProtection, so nothing in it can be downloaded.
  writeFileSync(
    join(d, 'dash-tpl', 'drm.mpd'),
    tplMpd.replace(/<AdaptationSet id="(\d)"([^>]*)>/g, '<AdaptationSet id="$1"$2><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>'),
  );
  // Partly protected: the 360p rendition is DRM-protected, the 180p one and the audio are clear.
  const multiMpd = readFileSync(join(d, 'dash-multi', 'index.mpd'), 'utf8');
  writeFileSync(
    join(d, 'dash-multi', 'partial-drm.mpd'),
    multiMpd.replace(/(<Representation id="0"[^>]*>)/, '$1<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/><ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>'),
  );
  writeFileSync(
    join(d, 'dash-tpl', 'number.mpd'),
    `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S"><Period><AdaptationSet contentType="video"><Representation id="0" mimeType="video/mp4" codecs="avc1.64001e" bandwidth="62321" width="640" height="360"><SegmentTemplate timescale="12800" duration="25600" startNumber="1" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s"/></Representation></AdaptationSet></Period></MPD>`,
  );

  // EXT-X-DISCONTINUITY: the same two segments played twice, so the timestamps jump back at the discontinuity.
  mkdirSync(join(d, 'discont'), { recursive: true });
  for (const name of ['a0', 'a1', 'b0', 'b1']) writeFileSync(join(d, 'discont', `${name}.ts`), readFileSync(join(d, 'ts', `seg${name.endsWith('0') ? 0 : 1}.ts`)));
  writeFileSync(
    join(d, 'discont', 'index.m3u8'),
    master(['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXTINF:2,', 'a0.ts', '#EXTINF:2,', 'a1.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:2,', 'b0.ts', '#EXTINF:2,', 'b1.ts', '#EXT-X-ENDLIST']),
  );
  // A discontinuity where the FORMAT changes (640x360 -> 320x180): one MP4 cannot hold that.
  hls('fmp4-180', ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'seg%d.m4s'], join(d, 'source.mp4'), ['-vf', 'scale=320:180', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(SOURCE_FPS * 2), '-keyint_min', String(SOURCE_FPS * 2), '-sc_threshold', '0', '-c:a', 'copy']);
  mkdirSync(join(d, 'ts-change'), { recursive: true });
  writeFileSync(
    join(d, 'ts-change', 'index.m3u8'),
    master(['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXTINF:2,', '../ts/seg0.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:2,', '../ts180/seg0.ts', '#EXT-X-ENDLIST']),
  );
  mkdirSync(join(d, 'fmp4-change'), { recursive: true });
  writeFileSync(
    join(d, 'fmp4-change', 'index.m3u8'),
    master(['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MAP:URI="../fmp4/init.mp4"', '#EXTINF:2,', '../fmp4/seg0.m4s', '#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="../fmp4-180/init.mp4"', '#EXTINF:2,', '../fmp4-180/seg0.m4s', '#EXT-X-ENDLIST']),
  );

  // A playlist that never ends (live), reusing the real segments.
  mkdirSync(join(d, 'live'), { recursive: true });
  for (const f of readdirSync(join(d, 'ts'))) if (f.endsWith('.ts')) writeFileSync(join(d, 'live', f), readFileSync(join(d, 'ts', f)));
  writeFileSync(join(d, 'live', 'index.m3u8'), readFileSync(join(d, 'ts', 'index.m3u8'), 'utf8').replace('#EXT-X-ENDLIST\n', '').replace('#EXT-X-PLAYLIST-TYPE:VOD\n', ''));

  // FairPlay-style DRM playlist (segments intentionally absent: nothing may ever try to fetch them).
  mkdirSync(join(d, 'drm'), { recursive: true });
  writeFileSync(
    join(d, 'drm', 'index.m3u8'),
    master(['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://assetid",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"', '#EXTINF:6,', 'enc0.ts', '#EXT-X-ENDLIST']),
  );

  // Minimal DASH manifest.
  writeFileSync(
    join(d, 'manifest.mpd'),
    '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="800000" width="640" height="360" codecs="avc1.64001e"><BaseURL>source.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>',
  );
  writeFileSync(marker, 'ok');
  return d;
}

const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.html': 'text/html; charset=utf-8',
  '.key': 'application/octet-stream',
};

/**
 * Static file server with Range support. Options:
 *  - requireReferer: respond 403 unless Referer starts with this value
 *  - refusal: {status, headers, body} sent instead of that 403 (a server that answers 200 with an error page)
 *  - failFirst(path): return true to answer the first request for that path with 503
 *  - log: array that receives {path, headers, status}
 *  - port: fixed port (default: any free one)
 *  - verbose: a label; when set, every finished request is printed with the headers that matter for auditing
 */
export function serve(root, { requireReferer = null, refusal = null, failFirst = () => false, extraRoutes = null, log = [], port = 0, verbose = '' } = {}) {
  const failed = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const entry = { path: url.pathname, headers: req.headers, status: 0, method: req.method };
    log.push(entry);
    if (verbose) {
      let bytes = 0;
      const write = res.write.bind(res);
      const end = res.end.bind(res);
      res.write = (chunk, ...rest) => ((bytes += chunk?.length ?? 0), write(chunk, ...rest));
      res.end = (chunk, ...rest) => ((bytes += typeof chunk === 'string' || chunk?.length ? chunk.length : 0), end(chunk, ...rest));
      res.on('close', () => {
        const h = req.headers;
        console.log(`[${verbose}] ${entry.status} ${req.method} ${url.pathname}${url.search} bytes=${bytes} range=${h.range ?? '-'} referer=${h.referer ?? '-'} origin=${h.origin ?? '-'} sec-fetch=${h['sec-fetch-site'] ?? '-'}/${h['sec-fetch-mode'] ?? '-'}/${h['sec-fetch-dest'] ?? '-'}`);
      });
    }
    const send = (status, headers = {}, body) => {
      entry.status = status;
      res.writeHead(status, { 'Access-Control-Allow-Origin': '*', ...headers });
      if (body !== undefined) res.end(body);
      return res;
    };
    if (extraRoutes) {
      const handled = extraRoutes(req, res, url, send);
      if (handled) return;
    }
    if (requireReferer && !(req.headers.referer || '').startsWith(requireReferer)) {
      return refusal ? send(refusal.status, refusal.headers, refusal.body) : send(403, {}, 'bad referer');
    }
    if (failFirst(url.pathname) && !failed.has(url.pathname)) {
      failed.add(url.pathname);
      return send(503, {}, 'try again');
    }
    const file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(normalize(root) + sep) && file !== normalize(root)) return send(403, {}, 'nope');
    if (!existsSync(file) || !statSync(file).isFile()) return send(404, {}, 'not found');
    const size = statSync(file).size;
    const type = MIME[extname(file)] || 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
      const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      send(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
      return createReadStream(file, { start, end }).pipe(res);
    }
    send(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        log,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

export function listFiles(dir) {
  return readdirSync(dir);
}

export function readFixture(...parts) {
  return readFileSync(join(FIXTURE_DIR, ...parts));
}

/**
 * Loads mux.js' mp4 build exactly the way an extension page does: as a plain script that sets `globalThis.muxjs`
 * (its UMD wrapper takes that branch when `module`/`exports`/`define` are absent). Returns the `muxjs` namespace.
 */
export function loadMux() {
  const code = readFileSync(new URL('../../extension/lib/vendor/mux-mp4.min.js', import.meta.url), 'utf8');
  const hadWindow = 'window' in globalThis;
  if (!hadWindow) globalThis.window = globalThis;
  try {
    new Function('module', 'exports', 'define', code).call(globalThis, undefined, undefined, undefined);
    // The standalone mux-mp4 build exposes Transmuxer/probe at the top level (the full build nests them under .mp4).
    return globalThis.muxjs;
  } finally {
    delete globalThis.muxjs;
    if (!hadWindow) delete globalThis.window;
  }
}
