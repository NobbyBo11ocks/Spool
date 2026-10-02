// Small pure helpers shared by the service worker, popup and downloader page.

/** 32-bit FNV-1a hash rendered in base36. Stable, not cryptographic. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Maps a string to a positive 31-bit integer (for declarativeNetRequest rule ids). */
export function hashToRuleId(str) {
  return (parseInt(hashString(str), 36) % 2_000_000_000) + 1;
}

/** Makes a string safe to use as a file name on Windows, macOS and Linux (no extension handling). */
export function sanitizeFilename(name, fallback = 'video') {
  let s = String(name ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (s.length > 120) s = s.slice(0, 120).trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
  return s || fallback;
}

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

const MIME_EXT = {
  'video/mp4': '.mp4',
  'video/x-m4v': '.m4v',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/x-flv': '.flv',
  'video/ogg': '.ogv',
  'video/3gpp': '.3gp',
  'video/mpeg': '.mpg',
  'video/x-msvideo': '.avi',
  'video/x-ms-wmv': '.wmv',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/webm': '.weba',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/flac': '.flac',
};

export function extFromMime(mime) {
  return MIME_EXT[String(mime || '').toLowerCase()] || '';
}

/** Returns the last path segment of a URL, decoded, or '' if there is none. */
export function filenameFromUrl(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(seg);
  } catch {
    return '';
  }
}

const IP_ADDRESS = /^(\d{1,3}\.){3}\d{1,3}$|^\[.*\]$/;

/** The part of a host that identifies who owns it ("a.b.example.com" -> "example.com", "x.example.co.uk" -> "example.co.uk"). */
function registrableDomain(host) {
  if (IP_ADDRESS.test(host)) return host;
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  // Without a public-suffix list: two-letter country codes under short second-level labels (co.uk, com.au, ac.jp) take three labels.
  const [second, last] = [labels.at(-2), labels.at(-1)];
  return (last.length === 2 && second.length <= 3 ? labels.slice(-3) : labels.slice(-2)).join('.');
}

/**
 * True when two URLs belong to the same owner (same registrable domain). Used to decide where cookies may be sent:
 * a playlist can list any URL, but the user's cookies should only go to hosts related to the page they are on.
 */
export function sameSite(a, b) {
  try {
    return registrableDomain(new URL(a).hostname) === registrableDomain(new URL(b).hostname);
  } catch {
    return false;
  }
}

/** `origin + path` of a URL, without the query string and fragment (they often carry session tokens). */
export function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return String(url).split(/[?#]/)[0];
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function originOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : '';
  } catch {
    return '';
  }
}
