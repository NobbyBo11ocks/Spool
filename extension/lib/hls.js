// HLS playlist parsing (RFC 8216). Pure functions only: no network, no DOM, no chrome.* APIs.

const MAX_LINES = 200_000;
const MAX_VARIANTS = 2_000;
const KEY_NAME = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Parses an attribute list such as `BANDWIDTH=800000,CODECS="avc1.4d401f,mp4a.40.2"`. Keys are upper-cased.
 * A single linear scan: an earlier regex-based version took quadratic time on a hostile line.
 */
export function parseAttributes(str) {
  const out = {};
  const n = str.length;
  let i = 0;
  while (i < n) {
    let eq = i;
    while (eq < n && str[eq] !== '=' && str[eq] !== ',') eq++;
    if (eq >= n || str[eq] === ',') {
      i = eq + 1; // a token without a value
      continue;
    }
    const key = str.slice(i, eq).trim();
    const valueStart = eq + 1;
    let value;
    if (str[valueStart] === '"') {
      const close = str.indexOf('"', valueStart + 1);
      const stop = close === -1 ? n : close;
      value = str.slice(valueStart + 1, stop);
      i = str.indexOf(',', stop);
      i = i === -1 ? n : i + 1;
    } else {
      let end = valueStart;
      while (end < n && str[end] !== ',') end++;
      value = str.slice(valueStart, end);
      i = end + 1;
    }
    if (KEY_NAME.test(key)) out[key.toUpperCase()] = value;
  }
  return out;
}

const DRM_SYSTEMS = {
  'com.apple.streamingkeydelivery': 'FairPlay',
  'urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
  'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
  'com.widevine': 'Widevine',
  'com.widevine.alpha': 'Widevine',
  'com.microsoft.playready': 'PlayReady',
  'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
};

/** Human name of a DRM key format ("FairPlay", "Widevine", ...), or the format itself when unknown. */
export function drmSystemName(keyFormat) {
  return DRM_SYSTEMS[String(keyFormat).toLowerCase()] ?? String(keyFormat).slice(0, 40);
}

function attrsOf(line) {
  return parseAttributes(line.slice(line.indexOf(':') + 1));
}

/** Resolves a playlist URI. Only http(s) is ever fetched, so other schemes (file:, data:, blob:, ...) are an error. */
function resolve(uri, base) {
  const url = new URL(uri, base);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported URL scheme in playlist: ${url.protocol}`);
  return url.href;
}

/** Like resolve(), but null instead of an error: DRM key URIs are legitimately skd:// or data: URIs. */
function tryResolve(uri, base) {
  try {
    return resolve(uri, base);
  } catch {
    return null;
  }
}

/** `0x1A2B...` -> 16-byte Uint8Array (left-padded), or null when absent/invalid. */
export function parseIV(hex) {
  if (!hex) return null;
  const digits = hex.replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,32}$/i.test(digits)) return null;
  const padded = digits.padStart(32, '0');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Default IV: the media sequence number as a big-endian 128-bit integer (RFC 8216 4.3.2.4). */
export function ivFromSequence(seq) {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setUint32(12, seq >>> 0);
  view.setUint32(8, Math.floor(seq / 2 ** 32) >>> 0);
  return out;
}

function parseByteRange(value) {
  const [len, off] = value.split('@');
  const length = Number(len);
  if (!Number.isFinite(length)) return null;
  return { length, offset: off === undefined ? null : Number(off) };
}

/**
 * Parses a playlist. Returns `{type: 'master', variants, media, sessionKeys}` or
 * `{type: 'media', segments, endList, playlistType, ...}`. Throws if the text is not HLS.
 */
export function parsePlaylist(text, baseUrl) {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > MAX_LINES) throw new Error('Playlist is too large');
  if (!lines[0] || !lines[0].startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines, base) {
  const variants = [];
  const media = [];
  const sessionKeys = [];
  let pending = null;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = attrsOf(line);
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attrsOf(line);
      media.push({
        type: a.TYPE,
        groupId: a['GROUP-ID'],
        name: a.NAME || '',
        language: a.LANGUAGE || '',
        default: a.DEFAULT === 'YES',
        autoselect: a.AUTOSELECT === 'YES',
        url: a.URI ? resolve(a.URI, base) : null,
      });
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      const a = attrsOf(line);
      sessionKeys.push({ method: a.METHOD, keyFormat: a.KEYFORMAT || 'identity' });
    } else if (!line.startsWith('#') && pending) {
      if (variants.length >= MAX_VARIANTS) continue;
      const res = /^(\d+)x(\d+)$/i.exec(pending.RESOLUTION || '');
      variants.push({
        url: resolve(line, base),
        bandwidth: Number(pending.BANDWIDTH) || 0,
        avgBandwidth: Number(pending['AVERAGE-BANDWIDTH']) || 0,
        width: res ? Number(res[1]) : 0,
        height: res ? Number(res[2]) : 0,
        frameRate: Number(pending['FRAME-RATE']) || 0,
        codecs: pending.CODECS || '',
        audioGroup: pending.AUDIO || null,
        subtitleGroup: pending.SUBTITLES || null,
      });
      pending = null;
    }
  }
  return { type: 'master', variants, media, sessionKeys };
}

function parseMedia(lines, base) {
  let mediaSequence = 0;
  let targetDuration = 0;
  let endList = false;
  let playlistType = null;
  let map = null;
  let discontinuity = false;
  let pending = null;
  // RFC 8216 4.3.2.4: several EXT-X-KEY tags with different KEYFORMATs can apply to the same segments (a stream may offer
  // a plain AES-128 key next to FairPlay or Widevine). The client uses the one it supports, so keep one key per format:
  // `key` is the plain ("identity") one, `drm` lists the DRM-only alternatives.
  const keys = new Map(); // keyFormat -> key
  const identityKey = () => keys.get('identity') ?? null;
  const drmKeys = () => [...keys.values()].filter((k) => k.keyFormat !== 'identity');
  const nextOffset = new Map(); // resource URL -> next implicit byte offset
  const segments = [];

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      pending = pending || {};
      pending.duration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pending = pending || {};
      pending.range = parseByteRange(line.slice(line.indexOf(':') + 1));
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.slice(line.indexOf(':') + 1), 10) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(line.slice(line.indexOf(':') + 1), 10) || 0;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice(line.indexOf(':') + 1).trim();
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = attrsOf(line);
      const keyFormat = a.KEYFORMAT || 'identity';
      if (a.METHOD === 'NONE') {
        keys.delete(keyFormat);
      } else {
        keys.set(keyFormat, {
          method: a.METHOD,
          // Only a plain key is ever fetched, so only its URI must be http(s); DRM URIs are skd://, data:, ...
          url: a.URI ? (keyFormat === 'identity' ? tryResolve(a.URI, base) : a.URI) : null,
          iv: parseIV(a.IV),
          keyFormat,
        });
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrsOf(line);
      map = a.URI
        ? {
            url: resolve(a.URI, base),
            byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE) : null,
            key: identityKey(),
            drm: drmKeys(),
          }
        : null;
      if (map?.byteRange && map.byteRange.offset == null) map.byteRange.offset = 0;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (!line.startsWith('#')) {
      const url = resolve(line, base);
      let byteRange = null;
      if (pending?.range) {
        const offset = pending.range.offset ?? nextOffset.get(url) ?? 0;
        byteRange = { offset, length: pending.range.length };
        nextOffset.set(url, offset + pending.range.length);
      }
      segments.push({
        index: segments.length,
        sequence: mediaSequence + segments.length,
        url,
        duration: pending?.duration ?? 0,
        byteRange,
        key: identityKey(),
        drm: drmKeys(),
        map,
        discontinuity,
      });
      discontinuity = false;
      pending = null;
    }
  }

  return {
    type: 'media',
    segments,
    endList,
    playlistType,
    targetDuration,
    mediaSequence,
    duration: segments.reduce((sum, s) => sum + s.duration, 0),
  };
}

/**
 * Inspects the encryption used by a media playlist.
 * Returns `{method, supported, drm, systems, reason}`; `method` is 'NONE' when segments are clear.
 *
 * Supported: AES-128 with the plain ("identity") key format, where the key is an ordinary URL. If a stream offers that
 * next to a DRM key format (FairPlay, Widevine, PlayReady ...), the plain key is used: it is not DRM-protected.
 * DRM only: every segment is covered by DRM key formats alone, so it can only be decrypted by a licensed player.
 * That is reported (with the system's name) and never worked around. Other plain methods (SAMPLE-AES) are unsupported.
 */
export function inspectEncryption(media) {
  const plain = new Map();
  const systems = new Set();
  let drmOnly = false;
  const consider = (key, drm) => {
    if (key) plain.set(`${key.method}|${key.url}`, key);
    else if (drm?.length) {
      drmOnly = true;
      for (const d of drm) systems.add(drmSystemName(d.keyFormat));
    }
  };
  for (const seg of media.segments) {
    consider(seg.key, seg.drm);
    if (seg.map) consider(seg.map.key, seg.map.drm);
  }

  if (drmOnly) {
    const names = [...systems].join(', ');
    return {
      method: 'DRM',
      supported: false,
      drm: true,
      systems: [...systems],
      reason: `DRM-protected (${names}): this stream can only be played by a licensed player and cannot be downloaded.`,
    };
  }
  if (plain.size === 0) return { method: 'NONE', supported: true, drm: false, systems: [], reason: '' };
  for (const k of plain.values()) {
    if (k.method !== 'AES-128') {
      return { method: k.method, supported: false, drm: false, systems: [], reason: `Unsupported encryption method ${k.method}.` };
    }
    if (!k.url) {
      return { method: k.method, supported: false, drm: false, systems: [], reason: 'Encrypted stream without a usable key URI.' };
    }
  }
  return { method: 'AES-128', supported: true, drm: false, systems: [], reason: '' };
}

const VIDEO_CODEC_RE = /^(avc[1-4]|hvc1|hev1|dvh[1e]|vp0?[89]|av01|mp4v)/i;
const REMUXABLE_AUDIO_RE = /^mp4a\.40\./i;
const REMUXABLE_VIDEO_RE = /^avc[1-4]/i;

export function hasVideo(variant) {
  if (variant.height || variant.width) return true;
  // RESOLUTION and CODECS are both optional: with neither there is nothing to say it is audio, so assume video.
  if (!variant.codecs) return true;
  return variant.codecs.split(',').some((c) => VIDEO_CODEC_RE.test(c.trim()));
}

/** True if every codec in a CODECS string is one mux.js can remux from TS to MP4 (H.264 + AAC). */
export function codecsRemuxable(codecs) {
  if (!codecs) return true; // unknown: probe the first segment instead
  return codecs
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .every((c) => REMUXABLE_VIDEO_RE.test(c) || REMUXABLE_AUDIO_RE.test(c));
}

export function variantLabel(v) {
  const parts = [];
  if (v.height) parts.push(`${v.height}p`);
  else if (!hasVideo(v)) parts.push('Audio only');
  if (v.frameRate && v.frameRate > 30) parts.push(`${Math.round(v.frameRate)}fps`);
  const bw = v.avgBandwidth || v.bandwidth;
  if (bw) parts.push(`${bw >= 1e6 ? (bw / 1e6).toFixed(1) + ' Mbps' : Math.round(bw / 1e3) + ' kbps'}`);
  return parts.join(' · ') || 'Default';
}

/** Highest-quality first. */
export function sortVariants(variants) {
  return [...variants].sort(
    (a, b) => b.height - a.height || (b.avgBandwidth || b.bandwidth) - (a.avgBandwidth || a.bandwidth),
  );
}

/** External (separate-playlist) audio renditions that a variant refers to, default first. */
export function externalAudioFor(master, variant) {
  if (!variant.audioGroup) return [];
  return master.media
    .filter((m) => m.type === 'AUDIO' && m.groupId === variant.audioGroup && m.url)
    .sort((a, b) => Number(b.default) - Number(a.default));
}

/**
 * Container the segments are stored in:
 * 'fmp4' (ISO BMFF with EXT-X-MAP or .m4s/.mp4 segments), 'aac'/'mp3'/'ac3' (raw audio) or 'ts'.
 */
export function detectContainer(media) {
  const first = media.segments[0];
  if (!first) return 'ts';
  if (first.map) return 'fmp4';
  const path = new URL(first.url).pathname.toLowerCase();
  if (/\.(m4s|mp4|m4v|m4a|cmfv|cmfa)$/.test(path)) return 'fmp4';
  if (/\.aac$/.test(path)) return 'aac';
  if (/\.mp3$/.test(path)) return 'mp3';
  if (/\.ac3$/.test(path)) return 'ac3';
  return 'ts';
}

/** Summary used by the popup list. Cheap, derived from an already-parsed playlist. */
const MAX_CHILD_URLS = 500;

export function summarizePlaylist(p) {
  if (p.type === 'master') {
    const heights = p.variants.map((v) => v.height).filter(Boolean);
    const childUrls = [
      ...p.variants.map((v) => v.url),
      ...p.media.filter((m) => m.url).map((m) => m.url),
    ].slice(0, MAX_CHILD_URLS);
    // A session key is only a hint for preloading; the media playlists decide. DRM only if every session key is DRM.
    const drm = p.sessionKeys.length > 0 && p.sessionKeys.every((k) => k.keyFormat !== 'identity');
    return {
      playlist: 'master',
      variants: p.variants.length,
      maxHeight: heights.length ? Math.max(...heights) : null,
      audioOnly: p.variants.length > 0 && p.variants.every((v) => !hasVideo(v)),
      drm,
      drmSystems: drm ? [...new Set(p.sessionKeys.map((k) => drmSystemName(k.keyFormat)))] : [],
      childUrls,
    };
  }
  const enc = inspectEncryption(p);
  return {
    playlist: 'media',
    segments: p.segments.length,
    duration: p.duration,
    live: !p.endList,
    encryption: enc.method,
    drm: enc.drm,
    drmSystems: enc.systems,
    unsupported: enc.supported ? '' : enc.reason,
    childUrls: [],
  };
}
