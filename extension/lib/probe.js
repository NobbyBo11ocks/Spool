// Checks a candidate file before it is listed: how big is it really, and is it a standalone file at all?
// Needed for files whose size the response didn't declare (chunked responses, URLs found in the DOM), which would
// otherwise let a 2 KB init segment or an error page through as "Video file".

import { MIN_FILE_BYTES } from './detect.js';

/** Top-level MP4 boxes that mark a piece of a fragmented stream rather than a standalone file. */
const FRAGMENT_BOXES = new Set(['styp', 'moof', 'sidx']);

export function isFragmentStart(bytes) {
  if (bytes.length < 8) return false;
  return FRAGMENT_BOXES.has(String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]));
}

/** Mime types that can't be a video/audio file (error pages, JSON, images ...). Unknown types are given the benefit of the doubt. */
export function isNotMediaMime(mime) {
  return /^(text\/(html|css|javascript|xml)|image\/|application\/(json|javascript|xml|xhtml\+xml|pdf|zip))/.test(mime);
}

/**
 * Fetches the start of `url` (a Range request, so a server that supports it sends little) and reports
 * `{size, mime, fragment, notMedia}`. `size` is the full size when the server says so, the actual length when the body
 * ends within `minBytes` of a server without Range support, and `null` when it is larger than that or unknowable.
 * Rejects when the URL can't be fetched; callers should then keep the item as it is.
 */
export async function probeFile(url, { fetchImpl = globalThis.fetch.bind(globalThis), minBytes = MIN_FILE_BYTES, timeoutMs = 10_000, signal, credentials = 'omit' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    // No cookies: this runs on URLs a web page chose to mention, so it must not be a way to send the user's credentials anywhere.
    const res = await fetchImpl(url, { credentials, headers: { Range: `bytes=0-${minBytes}` }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const partial = res.status === 206;
    const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
    const declared = Number(res.headers.get('content-length'));
    let size = total ? Number(total[1]) : !partial && !res.headers.get('content-encoding') && declared > 0 ? declared : null;

    // Read just enough: the first bytes (to recognise the container) and, if no size is known, whether the body
    // runs past `minBytes`.
    const reader = res.body.getReader();
    let head = new Uint8Array(0);
    let seen = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        if (size === null && !partial) size = seen;
        break;
      }
      seen += value.byteLength;
      if (head.length < 8) {
        const merged = new Uint8Array(Math.min(8, head.length + value.length));
        merged.set(head);
        merged.set(value.subarray(0, merged.length - head.length), head.length);
        head = merged;
      }
      if (head.length >= 8 && (size !== null || seen > minBytes)) break;
    }
    await reader.cancel().catch(() => {});
    return { size, mime, fragment: isFragmentStart(head), notMedia: isNotMediaMime(mime) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}
