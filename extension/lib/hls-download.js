// Download engine for HLS media playlists and plain files. Free of DOM and chrome.* APIs: the caller
// supplies `fetchBytes`, a `sink` (where bytes go) and optionally mux.js' Transmuxer, so everything here
// can be tested in Node against real streams.

import { ivFromSequence } from './hls.js';
import { readTsStreams, describeStreamType, REMUXABLE_STREAM_TYPES } from './ts.js';

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

function abortError() {
  return new DOMException('Download cancelled', 'AbortError');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Thrown when a "video" response is really a web page, JSON or XML (an expired link, a login wall, an error page). */
export class NotMediaError extends Error {
  constructor(url) {
    super('The server returned a web page instead of video data. The link may have expired: reload the original page and try again.');
    this.name = 'NotMediaError';
    this.url = url;
  }
}

// What an HTML/XML/JSON body starts with. Real media (MPEG-TS 0x47, MP4 box sizes, ADTS 0xFF, ID3, WebM) never does.
const TEXT_START = /^\s*(?:<!doctype|<html|<head|<body|<\?xml|\{\s*"|\[\s*[{"])/i;

/** Throws NotMediaError if `bytes` begins like a text document. Only meaningful for unencrypted (or decrypted) data. */
export function assertMediaBytes(bytes, url = '') {
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 64); i++) head += String.fromCharCode(bytes[i]);
  if (TEXT_START.test(head)) throw new NotMediaError(url);
}

/**
 * Returns `fetchBytes(url, {range, signal, meta})` -> Uint8Array.
 *  - Retries network errors, timeouts and HTTP 408/429/5xx with exponential backoff; other 4xx fail immediately.
 *  - Every attempt has a deadline (`timeoutMs`), so a server that never answers can't freeze a download.
 *  - `range` is `{offset, length}` (EXT-X-BYTERANGE, DASH ranges); the response must have exactly that length.
 *  - `credentials` is 'include' | 'omit' | 'same-origin', or a function of the URL: cookies should only go to hosts
 *    related to the page the user is on, never to whatever URL a playlist happens to list.
 */
export function createFetcher({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  retries = 3,
  baseDelayMs = 400,
  timeoutMs = 45_000,
  credentials = 'include',
} = {}) {
  // `meta`, if given, receives `{url}`: the final URL after redirects (relative playlist URIs resolve against it).
  return async function fetchBytes(url, { range = null, signal, meta = null } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        if (signal?.aborted) throw abortError();
        const deadline = AbortSignal.timeout(timeoutMs);
        const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : undefined;
        const res = await fetchImpl(url, {
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
          credentials: typeof credentials === 'function' ? credentials(url) : credentials,
          headers,
        });
        if (!res.ok) throw new HttpError(res.status, url);
        if (meta) meta.url = res.url || url;
        let bytes = new Uint8Array(await res.arrayBuffer());
        // A server that ignores Range answers 200 with the whole resource.
        if (range && res.status === 200) bytes = bytes.subarray(range.offset, range.offset + range.length);
        if (range && bytes.byteLength !== range.length) throw new Error(`Incomplete response for a byte range (${bytes.byteLength} of ${range.length} bytes)`);
        return bytes;
      } catch (e) {
        if (signal?.aborted || e?.name === 'AbortError') throw e;
        const retryable = e instanceof HttpError ? e.status >= 500 || e.status === 429 || e.status === 408 : true;
        if (!retryable || attempt >= retries) {
          if (e?.name === 'TimeoutError') throw new Error(`The server did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
          throw e;
        }
        await sleep(baseDelayMs * 2 ** attempt, signal);
      }
    }
  };
}

/**
 * Runs `produce(i)` for i in [0, total) with bounded parallelism and feeds the results to `consume(i, value)`
 * strictly in index order. At most `ahead` items are buffered beyond the one being consumed, which bounds memory.
 */
export async function runOrdered({ total, produce, consume, concurrency = 6, ahead = 12, signal }) {
  const ready = new Map();
  const waiters = [];
  let nextProduce = 0;
  let nextConsume = 0;
  let failure = null;

  const wake = () => {
    while (waiters.length) waiters.pop()();
  };
  const wait = () => new Promise((resolve) => waiters.push(resolve));
  const stopped = () => failure !== null || signal?.aborted === true;
  signal?.addEventListener('abort', wake);

  async function worker() {
    while (!stopped()) {
      if (nextProduce >= total) return;
      if (nextProduce - nextConsume >= ahead) {
        await wait();
        continue;
      }
      const i = nextProduce++;
      try {
        ready.set(i, await produce(i));
      } catch (e) {
        failure ??= e;
      }
      wake();
    }
  }

  async function consumer() {
    while (nextConsume < total) {
      if (stopped()) return;
      if (!ready.has(nextConsume)) {
        await wait();
        continue;
      }
      const value = ready.get(nextConsume);
      ready.delete(nextConsume);
      try {
        await consume(nextConsume, value);
      } catch (e) {
        failure ??= e;
        wake();
        return;
      }
      nextConsume++;
      wake();
    }
  }

  try {
    await Promise.all([...Array.from({ length: Math.min(concurrency, total) }, worker), consumer()]);
  } finally {
    signal?.removeEventListener('abort', wake);
  }
  if (failure) throw failure;
  if (signal?.aborted) throw abortError();
}

/**
 * Feeds MPEG-TS segments to mux.js (`mux` is the `muxjs` namespace) and yields fragmented-MP4 chunks
 * (init segment first, exactly once). After an EXT-X-DISCONTINUITY the stream's timestamps restart, so the caller
 * starts a fresh remuxer with `baseMediaDecodeTime` (90 kHz ticks) set to the media already written and `emitInit: false`
 * (the init segment is already in the file; `initSegment` is still captured so it can be compared).
 */
export class Mp4Remuxer {
  constructor(mux, { baseMediaDecodeTime = 0, emitInit = true } = {}) {
    this.transmuxer = new mux.Transmuxer({ baseMediaDecodeTime });
    this.pending = [];
    this.initSegment = null;
    this.bytes = 0;
    this.transmuxer.on('data', (segment) => {
      if (!this.initSegment && segment.initSegment?.byteLength) {
        this.initSegment = segment.initSegment;
        if (emitInit) this.pending.push(segment.initSegment);
      }
      if (segment.data?.byteLength) this.pending.push(segment.data);
    });
  }

  push(tsBytes) {
    this.transmuxer.push(tsBytes);
    this.transmuxer.flush();
    const out = this.pending;
    this.pending = [];
    for (const chunk of out) this.bytes += chunk.byteLength;
    return out;
  }
}

/**
 * Fetches (and decrypts) the pieces of a media playlist. A decrypted segment can be seeded with `seed()`
 * so work done while probing isn't repeated.
 */
export function createSegmentLoader(playlist, { fetchBytes, signal, subtle = globalThis.crypto?.subtle }) {
  const segments = playlist.segments;
  let currentSignal = signal;
  const keyCache = new Map();
  const seeded = new Map();
  let fetched = 0;

  const fetchPart = async (url, range) => {
    const bytes = await fetchBytes(url, { range, signal: currentSignal });
    fetched += bytes.byteLength;
    return bytes;
  };

  const importKey = (keyInfo) => {
    let promise = keyCache.get(keyInfo.url);
    if (!promise) {
      promise = fetchPart(keyInfo.url, null).then((raw) => {
        if (raw.byteLength !== 16) throw new Error(`Unexpected AES-128 key length (${raw.byteLength} bytes)`);
        return subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
      });
      keyCache.set(keyInfo.url, promise);
    }
    return promise;
  };

  const decrypt = async (bytes, keyInfo, sequence) => {
    const key = await importKey(keyInfo);
    const iv = keyInfo.iv ?? ivFromSequence(sequence);
    try {
      return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, key, bytes));
    } catch {
      throw new Error('Could not decrypt a segment: the key is wrong, or the link has expired and the server sent something else.');
    }
  };

  /** Decrypts if needed, then refuses data that is plainly a web page/JSON/XML (it would leave a hole in the video). */
  const finish = async (bytes, key, sequence, url) => {
    const plain = key ? await decrypt(bytes, key, sequence) : bytes;
    assertMediaBytes(plain, url);
    return plain;
  };

  return {
    get bytesFetched() {
      return fetched;
    },
    seed(index, bytes) {
      seeded.set(index, bytes);
    },
    /** Lets a loader that was used for probing be reused for a cancellable download. */
    setSignal(next) {
      currentSignal = next;
    },
    async loadSegment(index) {
      if (seeded.has(index)) {
        const bytes = seeded.get(index);
        seeded.delete(index);
        return bytes;
      }
      const seg = segments[index];
      return finish(await fetchPart(seg.url, seg.byteRange), seg.key, seg.sequence, seg.url);
    },
    async loadMap(seg) {
      return finish(await fetchPart(seg.map.url, seg.map.byteRange), seg.map.key, seg.sequence, seg.map.url);
    },
  };
}

/**
 * Decides whether the TS segments of a playlist can be converted to MP4 by mux.js (H.264 + AAC only).
 * Looks at which streams the first segment really contains, converts it, and checks that the result has the
 * same tracks, because mux.js silently drops streams it doesn't understand. The decrypted first segment is
 * seeded into `loader` so it isn't downloaded twice.
 */
export async function probeRemux(loader, mux) {
  if (!mux?.Transmuxer) return { ok: false, reason: 'MP4 converter is not available.' };
  const first = await loader.loadSegment(0);
  loader.seed(0, first);

  const ts = readTsStreams(first);
  if (!ts) return { ok: false, reason: 'Segments are not MPEG-TS.' };
  const unsupported = ts.streams.filter((s) => !REMUXABLE_STREAM_TYPES.has(s.type));
  if (unsupported.length) {
    const names = [...new Set(unsupported.map((s) => describeStreamType(s.type).label))].join(', ');
    return { ok: false, reason: `This stream contains ${names}, which can't be converted to MP4.` };
  }

  let remuxer;
  try {
    remuxer = new Mp4Remuxer(mux);
    remuxer.push(first);
  } catch (e) {
    return { ok: false, reason: `Conversion failed: ${e.message}` };
  }
  if (remuxer.bytes === 0 || !remuxer.initSegment) {
    return { ok: false, reason: 'The converter produced no output for this stream.' };
  }

  const tracks = mux.probe?.tracks?.(remuxer.initSegment);
  if (tracks) {
    const kinds = new Set(ts.streams.map((s) => describeStreamType(s.type).kind));
    for (const kind of ['video', 'audio']) {
      if (kinds.has(kind) && !tracks.some((t) => t.type === kind)) {
        return { ok: false, reason: `Conversion would lose the ${kind} track.` };
      }
    }
  }
  return { ok: true, reason: '' };
}

const sameBytes = (a, b) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

const FORMAT_CHANGE =
  'The stream changes format partway through (for example at an ad break), so it cannot be saved as one file in this format. Save it as .ts instead.';

/**
 * Downloads every segment of `playlist` into `sink` in order.
 * Output is the raw concatenation of segments (TS, fMP4 with its init segment, AAC, ...) unless `remux` is true, in
 * which case TS segments are converted to a fragmented MP4 with mux.js.
 *
 * EXT-X-DISCONTINUITY restarts the timestamps inside the stream. Raw output doesn't care; the MP4 conversion continues
 * its timeline from the media already written (a fresh converter per discontinuity). If the stream's format changes at
 * a discontinuity (a different init section), one MP4/fMP4 cannot represent it and the download stops with a clear error
 * instead of writing a file that plays only partly.
 */
export async function downloadMedia(playlist, o) {
  const { sink, loader, signal, onProgress = () => {}, mux = null, remux = false, concurrency = 6 } = o;
  const segments = playlist.segments;
  const total = segments.length;
  if (!total) throw new Error('The playlist has no segments.');

  let remuxer = remux ? new Mp4Remuxer(mux) : null;
  let firstInit = null; // the init segment that was written (remux) ...
  let checked = true; // ... and whether the current converter's init segment has been compared with it yet
  let firstMap = null; // fMP4 passthrough: the first EXT-X-MAP bytes
  let lastMapId = null;
  let elapsed = 0; // seconds of media written so far

  await runOrdered({
    total,
    concurrency,
    ahead: concurrency * 2,
    signal,
    produce: (i) => loader.loadSegment(i),
    consume: async (i, bytes) => {
      const seg = segments[i];
      if (remuxer) {
        if (seg.discontinuity && i > 0) {
          remuxer = new Mp4Remuxer(mux, { baseMediaDecodeTime: Math.round(elapsed * 90_000), emitInit: false });
          checked = false;
        }
        const chunks = remuxer.push(bytes);
        if (!firstInit && remuxer.initSegment) firstInit = remuxer.initSegment;
        if (!checked && remuxer.initSegment) {
          if (!sameBytes(firstInit, remuxer.initSegment)) throw new Error(FORMAT_CHANGE);
          checked = true;
        }
        for (const chunk of chunks) await sink.write(chunk);
      } else {
        if (seg.map) {
          const id = `${seg.map.url}|${seg.map.byteRange?.offset ?? ''}|${seg.map.byteRange?.length ?? ''}`;
          if (id !== lastMapId) {
            lastMapId = id;
            const map = await loader.loadMap(seg);
            if (firstMap && !sameBytes(firstMap, map)) throw new Error(FORMAT_CHANGE);
            if (!firstMap) {
              firstMap = map;
              await sink.write(map);
            }
          }
        }
        await sink.write(bytes);
      }
      elapsed += seg.duration;
      onProgress({ done: i + 1, total, bytes: loader.bytesFetched });
    },
  });

  if (remuxer && !firstInit) throw new Error('Conversion to MP4 produced no output.');
}

/**
 * Streams a single file into `sink`, reporting progress. A server that stops sending for `stallMs` aborts the download
 * (instead of hanging for ever), and a body that begins like a web page or JSON is refused.
 */
export async function downloadFile(url, { sink, signal, onProgress = () => {}, fetchImpl = globalThis.fetch.bind(globalThis), credentials = 'include', stallMs = 30_000 }) {
  const stall = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(), stallMs);
  };
  arm();
  try {
    const res = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, stall.signal]) : stall.signal, credentials });
    if (!res.ok) throw new HttpError(res.status, url);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.startsWith('text/html')) throw new NotMediaError(url);
    // Content-Length counts encoded bytes when a Content-Encoding applies, so it can't validate the decoded body.
    const total = res.headers.get('content-encoding') ? null : Number(res.headers.get('content-length')) || null;
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      arm();
      if (done) break;
      if (received === 0) assertMediaBytes(value, url);
      await sink.write(value);
      received += value.byteLength;
      onProgress({ received, total });
    }
    if (total !== null && received !== total) {
      throw new Error(`Incomplete download (${received} of ${total} bytes).`);
    }
  } catch (e) {
    if (stall.signal.aborted && !signal?.aborted) throw new Error(`The server stopped sending data for ${Math.round(stallMs / 1000)} seconds.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
