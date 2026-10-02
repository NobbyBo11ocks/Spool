// Decides whether a network response (or a URL found in the DOM) is downloadable media.
// Pure functions: no chrome.* APIs, so they can be unit-tested in Node.

import { extFromMime } from './util.js';

const HLS_MIMES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
]);
const DASH_MIMES = new Set(['application/dash+xml']);
const GENERIC_MIMES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'text/plain',
  'application/force-download',
]);

const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'flv', 'avi', 'ogv', 'wmv', '3gp', 'mpg', 'mpeg']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba']);
// Pieces of a stream rather than a standalone file. HLS/DASH segments are handled via their manifest.
const SEGMENT_EXTS = new Set(['ts', 'm4s', 'cmfv', 'cmfa', 'cmft', 'aac', 'ac3', 'ec3', 'vtt', 'webvtt', 'srt']);
const SEGMENT_MIMES = new Set(['video/mp2t', 'video/iso.segment', 'audio/aac', 'audio/aacp']);

/** Responses smaller than this are UI sounds, thumbnails-as-video, tracking pixels etc. */
export const MIN_FILE_BYTES = 100 * 1024;

// YouTube serves adaptive-format byte ranges, so a single response is never a complete, playable file.
const IGNORED_HOSTS = /(^|\.)googlevideo\.com$/i;

// Pieces of a stream that some packagers give a .mp4 extension: init segments (init.mp4, init-s1080p-v1-a1.mp4) and
// numbered fragments (seg-12.mp4, chunk_0001.mp4, frag-5.mp4). They are a few KB of header or a few seconds of media,
// never the movie, so listing them would bury the real stream. Separators (start, - _ .) are required around the
// keyword so ordinary titles ("initiation.mp4", "Final Segment 2.mp4") are untouched.
const STREAM_PIECE = /(^|[-_.])init(ialization)?([-_.]|$)|(^|[-_.])(seg|segment|chunk|frag|fragment)[-_.]?\d/i;

export function looksLikeStreamPiece(pathname) {
  let name = pathname.split('/').filter(Boolean).pop() || '';
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep the raw name
  }
  return STREAM_PIECE.test(name.replace(/\.[a-z0-9]{2,5}$/i, ''));
}

/** URLs longer than this are ignored: a page could otherwise fill the extension's storage with a few huge links. */
export const MAX_URL_LENGTH = 4096;

// Query parameters that vary per request for the same underlying file: byte ranges, cache busters, and the signing/expiry
// parameters CDNs re-issue on every request. Anything else (an id, a video name) identifies the file and is kept.
const VOLATILE_PARAMS = new Set([
  'range', 'bytestart', 'byteend', 'bytes', 'rn', 'rbuf', '_', 'rnd', 'random', 'cb', 'nonce', 'ts', 'timestamp',
  'token', 'tokens', 'tok', 'sig', 'signature', 'expires', 'expire', 'expiry', 'exp', 'e', 'st', 'hash', 'md5', 'policy',
  'key-pair-id', 'hdnts', 'hdnea', 'auth', 'authtoken', 'auth_token', 'access_token', 'jwt', 'se', 'sp', 'sv', 'sr', 'spr',
  'skoid', 'sktid', 'skt', 'ske', 'sks', 'skv',
]);
const VOLATILE_PREFIXES = ['x-amz-', 'x-goog-', 'x-ms-'];
const isVolatile = (name) => {
  const n = name.toLowerCase();
  return VOLATILE_PARAMS.has(n) || VOLATILE_PREFIXES.some((p) => n.startsWith(p));
};

function headerValue(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return String(h.value ?? '');
  }
  return '';
}

function pathExt(pathname) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(pathname);
  return m ? m[1].toLowerCase() : '';
}

/** Total size of the resource if the response tells us, else null (never the size of a partial body). */
export function responseSize(statusCode, headers) {
  const range = headerValue(headers, 'content-range');
  const total = /\/(\d+)\s*$/.exec(range);
  if (total) return Number(total[1]);
  if (statusCode === 206) return null;
  const len = headerValue(headers, 'content-length');
  const n = Number(len);
  return len !== '' && Number.isFinite(n) ? n : null;
}

/**
 * @param {{url: string, statusCode: number, responseHeaders?: {name: string, value?: string}[]}} d
 * @returns {null | {kind: 'file'|'hls'|'dash', media: 'video'|'audio'|'stream', mime: string, ext: string, size: number|null}}
 */
export function classifyResponse(d) {
  if (d.statusCode !== 200 && d.statusCode !== 206) return null;
  if (String(d.url).length > MAX_URL_LENGTH) return null;
  let u;
  try {
    u = new URL(d.url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (IGNORED_HOSTS.test(u.hostname)) return null;

  const path = u.pathname.toLowerCase();
  const ext = pathExt(path);
  const mime = headerValue(d.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
  const size = responseSize(d.statusCode, d.responseHeaders);

  if (HLS_MIMES.has(mime) || (ext === 'm3u8' && (GENERIC_MIMES.has(mime) || mime.endsWith('mpegurl')))) {
    return { kind: 'hls', media: 'stream', mime, ext: '.m3u8', size };
  }
  if (DASH_MIMES.has(mime) || (ext === 'mpd' && (GENERIC_MIMES.has(mime) || mime.endsWith('xml')))) {
    return { kind: 'dash', media: 'stream', mime, ext: '.mpd', size };
  }

  if (SEGMENT_MIMES.has(mime) || SEGMENT_EXTS.has(ext)) return null;

  let media = null;
  if (mime.startsWith('video/')) media = 'video';
  else if (mime.startsWith('audio/')) media = 'audio';
  else if (GENERIC_MIMES.has(mime)) {
    if (VIDEO_EXTS.has(ext)) media = 'video';
    else if (AUDIO_EXTS.has(ext)) media = 'audio';
  }
  if (!media) return null;
  if (size !== null && size < MIN_FILE_BYTES) return null;
  if (looksLikeStreamPiece(u.pathname)) return null;

  // Only a known media extension may reach the file name: a hostile page can't turn "/payload.exe" into a download.
  const knownExt = VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext) ? `.${ext}` : '';
  return { kind: 'file', media, mime, ext: extFromMime(mime) || knownExt, size };
}

/** Classifies a URL found in the DOM (no response headers available). */
export function classifyUrl(url) {
  if (String(url).length > MAX_URL_LENGTH) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (IGNORED_HOSTS.test(u.hostname)) return null;
  const ext = pathExt(u.pathname.toLowerCase());
  if (ext === 'm3u8') return { kind: 'hls', media: 'stream', mime: '', ext: '.m3u8', size: null };
  if (ext === 'mpd') return { kind: 'dash', media: 'stream', mime: '', ext: '.mpd', size: null };
  if (SEGMENT_EXTS.has(ext) || looksLikeStreamPiece(u.pathname)) return null;
  if (VIDEO_EXTS.has(ext)) return { kind: 'file', media: 'video', mime: '', ext: `.${ext}`, size: null };
  if (AUDIO_EXTS.has(ext)) return { kind: 'file', media: 'audio', mime: '', ext: `.${ext}`, size: null };
  return null;
}

/**
 * Identity of a media resource: the URL without its fragment and without volatile query parameters (signing tokens,
 * expiry, cache busters, byte ranges), because CDNs re-issue those on every request for the same file. Parameters that
 * identify the file (`?id=1` vs `?id=2`) are kept, sorted so their order doesn't matter.
 */
export function dedupeKey(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const kept = [...u.searchParams].filter(([name]) => !isVolatile(name)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = kept.length ? `?${new URLSearchParams(kept)}` : '';
  return u.origin + u.pathname + query;
}
