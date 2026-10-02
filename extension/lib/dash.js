// MPEG-DASH manifest (MPD) parsing and segment resolution (ISO/IEC 23009-1). Pure functions: no network, no DOM,
// no chrome.* APIs, so the service worker, the downloader page and the tests all use the same code.
//
// Supported addressing: SegmentTemplate (with or without SegmentTimeline, $Number$/$Time$/$Bandwidth$/$RepresentationID$),
// SegmentList (including byte ranges) and a single file via BaseURL/SegmentBase. Static (VOD) presentations; a dynamic
// one only when its SegmentTimeline lists the segments. Anything with ContentProtection is DRM and is refused elsewhere.

import { parseXml, childOf, childrenOf } from './xml.js';

// ---- small parsers ---------------------------------------------------------------------------------------------

/** ISO 8601 duration ("PT1H2M3.5S", "P1DT2H") in seconds, or null. Years and months use 365 and 30 days. */
export function parseDuration(value) {
  if (typeof value !== 'string') return null;
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, w, d, h, mi, s] = m.slice(1).map((x) => (x ? Number(x) : 0));
  return y * 365 * 86400 + mo * 30 * 86400 + w * 7 * 86400 + d * 86400 + h * 3600 + mi * 60 + s;
}

/** "a-b" (inclusive byte positions) -> {offset, length}, or null. */
export function parseRange(value) {
  const m = /^(\d+)-(\d+)$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const offset = Number(m[1]);
  const end = Number(m[2]);
  return end >= offset ? { offset, length: end - offset + 1 } : null;
}

/** Expands $RepresentationID$, $Number$, $Bandwidth$, $Time$ (optionally "%05d" formatted) and "$$". */
export function expandTemplate(template, values) {
  return template.replace(/\$([A-Za-z]*)(?:%0(\d+)d)?\$/g, (whole, name, width) => {
    if (name === '') return '$';
    if (!(name in values) || values[name] == null) return whole;
    const text = String(values[name]);
    return width ? text.padStart(Number(width), '0') : text;
  });
}

/** A manifest can list at most this many segments per stream: a 300-byte `<S r="4000000"/>` must not become gigabytes. */
const MAX_SEGMENTS = 200_000;

/** Resolves a manifest URL. Only http(s) is ever fetched, so any other scheme is an error. */
function resolveUrl(reference, base) {
  const url = new URL(reference, base);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported URL scheme in manifest: ${url.protocol}`);
  return url.href;
}

const DRM_SYSTEMS = {
  'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
  'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
  'urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
  'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e': 'ClearKey',
  'urn:uuid:5e629af5-38da-4063-8977-97ffbd9902d4': 'Marlin',
  'urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'CENC',
  'urn:mpeg:dash:mp4protection:2011': 'CENC',
};

/** Names of the DRM systems a set of elements declares through ContentProtection ("CENC" only if nothing more specific). */
function protectionSystems(elements) {
  const names = new Set();
  for (const el of elements) {
    for (const cp of childrenOf(el, 'ContentProtection')) {
      const id = String(cp.attrs.schemeIdUri ?? '').toLowerCase();
      names.add(DRM_SYSTEMS[id] ?? (id.slice(0, 40) || 'DRM'));
    }
  }
  if (names.size > 1) names.delete('CENC');
  return [...names];
}

// ---- manifest model --------------------------------------------------------------------------------------------

/** Attributes of the closest enclosing element that has the child `name`, merged from outermost to innermost. */
function inherited(name, levels) {
  const found = levels.map((level) => childOf(level, name)).filter(Boolean);
  if (!found.length) return null;
  const merged = { attrs: {}, element: found.at(-1), levels: found };
  for (const el of found) Object.assign(merged.attrs, el.attrs);
  return merged;
}

/** The nearest level (innermost first) that actually carries `childName` below the merged element. */
function innermostChild(merged, childName) {
  for (let i = merged.levels.length - 1; i >= 0; i--) {
    const c = childOf(merged.levels[i], childName);
    if (c) return c;
  }
  return null;
}

function baseChain(mpdUrl, elements) {
  let base = mpdUrl;
  for (const el of elements) {
    const text = childOf(el, 'BaseURL')?.text.trim();
    if (text) base = resolveUrl(text, base);
  }
  return base;
}

function containerOf(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  if (/mp4|iso/.test(m)) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('mp2t')) return 'ts';
  return 'other';
}

/**
 * @typedef {object} Representation
 * @property {string} id
 * @property {'video'|'audio'|'text'|'other'} type
 * @property {string} mimeType @property {string} codecs @property {number} bandwidth
 * @property {number} width @property {number} height @property {string} lang
 * @property {'mp4'|'webm'|'ts'|'other'} container
 * @property {boolean} protected  has ContentProtection (DRM)
 * @property {number} set  index of its AdaptationSet
 */

/**
 * @returns {{type: 'static'|'dynamic', duration: number|null, periods: {index: number, start: number, duration: number|null, representations: Representation[]}[], protected: boolean}}
 */
export function parseMpd(text, mpdUrl) {
  const root = parseXml(text);
  if (root.name !== 'MPD') throw new Error('Not a DASH manifest');
  const type = root.attrs.type === 'dynamic' ? 'dynamic' : 'static';
  const total = parseDuration(root.attrs.mediaPresentationDuration);

  const periodEls = childrenOf(root, 'Period');
  let cursor = 0;
  const periods = periodEls.map((period, index) => {
    const start = parseDuration(period.attrs.start) ?? cursor;
    const nextStart = periodEls[index + 1] ? parseDuration(periodEls[index + 1].attrs.start) : null;
    const duration = parseDuration(period.attrs.duration) ?? (nextStart != null ? nextStart - start : total != null ? total - start : null);
    cursor = start + (duration ?? 0);
    const representations = [];
    childrenOf(period, 'AdaptationSet').forEach((set, setIndex) => {
      for (const rep of childrenOf(set, 'Representation')) {
        const chain = [root, period, set, rep];
        const attr = (k) => rep.attrs[k] ?? set.attrs[k];
        const mimeType = attr('mimeType') ?? '';
        const kind = attr('contentType') ?? mimeType.split('/')[0];
        const guess = /ttml|vtt|text|subtitle/i.test(mimeType) || kind === 'text' ? 'text' : kind;
        representations.push({
          id: rep.attrs.id ?? '',
          type: guess === 'video' || guess === 'audio' || guess === 'text' ? guess : 'other',
          mimeType,
          codecs: attr('codecs') ?? '',
          bandwidth: Number(rep.attrs.bandwidth) || 0,
          width: Number(attr('width')) || 0,
          height: Number(attr('height')) || 0,
          lang: attr('lang') ?? '',
          container: containerOf(mimeType),
          protected: [period, set, rep].some((el) => childrenOf(el, 'ContentProtection').length > 0),
          drmSystems: protectionSystems([period, set, rep]),
          set: setIndex,
          // Internal: what segment resolution needs.
          _base: baseChain(mpdUrl, chain),
          _levels: [period, set, rep],
          _period: { start, duration },
        });
      }
    });
    return { index, start, duration, representations };
  });
  // DRM only decides when it covers everything that could be downloaded. A manifest that protects just its HD renditions
  // still has clear ones: those stay available, and the protected ones are left out (never worked around).
  const downloadable = periods.flatMap((p) => p.representations).filter((r) => r.type === 'video' || r.type === 'audio');
  const protectedReps = downloadable.filter((r) => r.protected);
  return {
    type,
    duration: total,
    periods,
    protected: downloadable.length > 0 && protectedReps.length === downloadable.length,
    hiddenProtected: protectedReps.length === downloadable.length ? 0 : protectedReps.length,
    drmSystems: [...new Set(protectedReps.flatMap((r) => r.drmSystems))],
  };
}

/** The period to download: the longest one (ad breaks and bumpers are short). */
export function mainPeriod(mpd) {
  return [...mpd.periods].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0] ?? null;
}

const bandwidthDesc = (a, b) => b.bandwidth - a.bandwidth;

/** Video representations that can be downloaded (DRM-protected ones are never offered), best first. */
export function videoRepresentations(mpd) {
  const reps = (mainPeriod(mpd)?.representations ?? []).filter((r) => r.type === 'video' && !r.protected);
  return reps.sort((a, b) => b.height - a.height || bandwidthDesc(a, b));
}

/** Audio representations without DRM: adaptation-set order first (the first is usually the default language), best bitrate first inside. */
export function audioRepresentations(mpd) {
  const reps = (mainPeriod(mpd)?.representations ?? []).filter((r) => r.type === 'audio' && !r.protected);
  return reps.sort((a, b) => a.set - b.set || bandwidthDesc(a, b));
}

export function representationLabel(rep) {
  const bits = [];
  if (rep.type === 'video') {
    bits.push(rep.height ? `${rep.height}p` : 'Video');
    if (rep.bandwidth) bits.push(rep.bandwidth >= 1e6 ? `${(rep.bandwidth / 1e6).toFixed(1)} Mbps` : `${Math.round(rep.bandwidth / 1e3)} kbps`);
  } else {
    if (rep.lang && rep.lang !== 'und') bits.push(rep.lang);
    const codec = rep.codecs.split('.')[0];
    if (codec) bits.push(codec);
    if (rep.bandwidth) bits.push(`${Math.round(rep.bandwidth / 1e3)} kbps`);
    if (!bits.length) bits.push('Audio');
  }
  return bits.join(' · ');
}

/** File extension for a representation saved on its own. */
export function representationExtension(rep) {
  if (rep.container === 'webm') return rep.type === 'audio' ? '.weba' : '.webm';
  if (rep.container === 'ts') return '.ts';
  return rep.type === 'audio' ? '.m4a' : '.mp4';
}

// ---- segment resolution ----------------------------------------------------------------------------------------

/**
 * @typedef {{url: string, range: {offset: number, length: number}|null}} Resource
 * @typedef {Resource & {start: number, duration: number, number: number}} Segment
 * @returns {{single: boolean, url?: string, init: Resource|null, segments: Segment[], error?: string, openEnded?: boolean}}
 */
export function resolveSegments(rep, mpdType = 'static') {
  const base = rep._base;
  const levels = rep._levels;
  const periodSeconds = rep._period.duration;

  const template = inherited('SegmentTemplate', levels);
  const list = inherited('SegmentList', levels);

  if (template) return fromTemplate(rep, template, base, periodSeconds, mpdType);
  if (list) return fromList(list, base);
  // SegmentBase, or nothing but a BaseURL: the representation is one file.
  return { single: true, url: base, init: null, segments: [] };
}

function fromTemplate(rep, template, base, periodSeconds, mpdType) {
  const a = template.attrs;
  const timescale = Number(a.timescale) || 1;
  const startNumber = a.startNumber != null ? Number(a.startNumber) : 1;
  const pto = Number(a.presentationTimeOffset) || 0;
  const fixed = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
  const mediaTemplate = a.media;
  if (!mediaTemplate) return { single: true, url: base, init: null, segments: [] };

  const initTemplate = a.initialization ?? childOf(template.element, 'Initialization')?.attrs.sourceURL;
  const init = initTemplate ? { url: resolveUrl(expandTemplate(initTemplate, fixed), base), range: null } : null;

  const timelineEl = innermostChild(template, 'SegmentTimeline');
  const entries = [];
  let openEnded = false;

  if (timelineEl) {
    const periodTicks = periodSeconds != null ? periodSeconds * timescale + pto : null;
    const s = childrenOf(timelineEl, 'S');
    let time = 0;
    let number = startNumber;
    s.forEach((el, i) => {
      const t = el.attrs.t != null ? Number(el.attrs.t) : time;
      const d = Number(el.attrs.d);
      if (!(d > 0)) throw new Error('Invalid SegmentTimeline entry');
      let repeat = el.attrs.r != null ? Number(el.attrs.r) : 0;
      if (!Number.isFinite(repeat)) repeat = 0;
      if (repeat < 0) {
        const nextT = s[i + 1]?.attrs.t != null ? Number(s[i + 1].attrs.t) : periodTicks;
        if (nextT == null) {
          repeat = 0;
          openEnded = true;
        } else {
          repeat = Math.max(0, Math.ceil((nextT - t) / d) - 1);
        }
      }
      if (entries.length + repeat + 1 > MAX_SEGMENTS) throw new Error('The manifest lists too many segments');
      for (let k = 0; k <= repeat; k++) entries.push({ time: t + k * d, ticks: d, number: number++ });
      time = t + (repeat + 1) * d;
    });
  } else if (a.duration) {
    const d = Number(a.duration);
    if (!(d > 0)) throw new Error('Invalid SegmentTemplate duration');
    if (periodSeconds == null || mpdType === 'dynamic') {
      return { single: false, init, segments: [], error: 'This live stream addresses segments by wall-clock time, which is not supported.' };
    }
    const count = Math.ceil((periodSeconds * timescale) / d);
    if (count > MAX_SEGMENTS) throw new Error('The manifest lists too many segments');
    for (let i = 0; i < count; i++) entries.push({ time: i * d + pto, ticks: d, number: startNumber + i });
  } else {
    return { single: false, init, segments: [], error: 'The SegmentTemplate has neither a SegmentTimeline nor a duration.' };
  }

  const segments = entries.map((e) => ({
    url: resolveUrl(expandTemplate(mediaTemplate, { ...fixed, Number: e.number, Time: e.time }), base),
    range: null,
    start: (e.time - pto) / timescale,
    duration: e.ticks / timescale,
    number: e.number,
  }));
  return { single: false, init, segments, openEnded };
}

function fromList(list, base) {
  const a = list.attrs;
  const timescale = Number(a.timescale) || 1;
  const startNumber = a.startNumber != null ? Number(a.startNumber) : 1;
  const uniform = a.duration ? Number(a.duration) / timescale : null;

  const initEl = innermostChild(list, 'Initialization');
  const init = initEl ? { url: initEl.attrs.sourceURL ? resolveUrl(initEl.attrs.sourceURL, base) : base, range: parseRange(initEl.attrs.range) } : null;

  const timelineEl = innermostChild(list, 'SegmentTimeline');
  const durations = [];
  if (timelineEl) {
    for (const el of childrenOf(timelineEl, 'S')) {
      const d = Number(el.attrs.d);
      const repeat = el.attrs.r != null && Number.isFinite(Number(el.attrs.r)) ? Math.max(0, Number(el.attrs.r)) : 0;
      if (durations.length + repeat + 1 > MAX_SEGMENTS) throw new Error('The manifest lists too many segments');
      for (let k = 0; k <= repeat; k++) durations.push(d / timescale);
    }
  }

  let urlElements = [];
  for (const level of list.levels) {
    const found = childrenOf(level, 'SegmentURL');
    if (found.length) urlElements = found; // the innermost level that lists segments wins
  }
  if (urlElements.length > MAX_SEGMENTS) throw new Error('The manifest lists too many segments');
  let start = 0;
  const segments = urlElements.map((el, i) => {
    const duration = durations[i] ?? uniform ?? 0;
    const segment = {
      url: el.attrs.media ? resolveUrl(el.attrs.media, base) : base,
      range: parseRange(el.attrs.mediaRange),
      start,
      duration,
      number: startNumber + i,
    };
    start += duration;
    return segment;
  });
  return { single: false, init, segments };
}

// ---- summary for the popup -------------------------------------------------------------------------------------

/** Cheap digest used for the popup row and by the service worker; mirrors summarizePlaylist() for HLS. */
export function summarizeMpd(mpd) {
  const video = videoRepresentations(mpd);
  const audio = audioRepresentations(mpd);
  const period = mainPeriod(mpd);
  const heights = video.map((r) => r.height).filter(Boolean);
  const reps = [...video, ...audio];

  let unsupported = '';
  if (mpd.protected) {
    unsupported = `DRM-protected (${mpd.drmSystems.join(', ') || 'DRM'}): this stream can only be played by a licensed player and cannot be downloaded.`;
  } else if (!reps.length) {
    unsupported = 'This manifest lists no downloadable video or audio.';
  } else {
    try {
      const probe = resolveSegments(video[0] ?? audio[0], mpd.type);
      if (probe.error) unsupported = probe.error;
    } catch (e) {
      unsupported = `Could not read the manifest: ${e.message}`;
    }
  }

  // Files a manifest points at that would otherwise show up as separate downloads. Template-addressed segments are
  // ignored by detection anyway, so only single files and byte-ranged lists are looked up (and never expanded twice).
  const childUrls = [];
  for (const rep of reps.slice(0, 100)) {
    if (inherited('SegmentTemplate', rep._levels)) continue;
    try {
      const resolved = resolveSegments(rep, mpd.type);
      if (resolved.single) childUrls.push(resolved.url);
      else if (resolved.segments[0]?.range) childUrls.push(resolved.segments[0].url);
    } catch {
      // unreadable representation: nothing to hide
    }
  }

  return {
    playlist: 'mpd',
    variants: video.length || audio.length,
    maxHeight: heights.length ? Math.max(...heights) : null,
    audioOnly: video.length === 0 && audio.length > 0,
    duration: period?.duration ?? mpd.duration ?? null,
    live: mpd.type === 'dynamic',
    drm: mpd.protected,
    drmSystems: mpd.protected ? mpd.drmSystems : [],
    hiddenProtected: mpd.hiddenProtected,
    unsupported,
    periods: mpd.periods.length,
    childUrls,
  };
}
