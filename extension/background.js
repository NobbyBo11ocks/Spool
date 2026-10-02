// Service worker: sniffs media responses per tab, keeps the list in chrome.storage.session (the worker is
// ephemeral), and starts downloads.

import { classifyResponse, classifyUrl, dedupeKey, MIN_FILE_BYTES } from './lib/detect.js';
import { probeFile } from './lib/probe.js';
import { parsePlaylist, summarizePlaylist } from './lib/hls.js';
import { parseMpd, summarizeMpd } from './lib/dash.js';
import { hashString, sanitizeFilename, filenameFromUrl, originOf, hostOf, safeUrl, sameSite } from './lib/util.js';
import { ensureExtensionHeaders, removeRulesForTab } from './lib/headers.js';

const MAX_ITEMS_PER_TAB = 40;
const MAX_CHILDREN_PER_TAB = 500;
const MAX_PLAYLIST_CHARS = 5_000_000;
const PLAYLIST_TIMEOUT_MS = 15_000;
const ENRICH_RETRY_MS = 10_000;
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_REJECTED_PER_TAB = 100;
const PROBE_CONCURRENCY = 3;
const ENRICH_CONCURRENCY = 3;
const MAX_PROBES_PER_TAB = 30;
const PENDING_MAX_MS = 20_000; // an unverified item that was never verified (worker restarted) appears anyway after this
const MAX_CLOSED_TABS = 500;
const MAX_URLS_PER_REPORT = 80;
// A finished Chrome download under 16 KB, or a textual one under 512 KB, is an error page sent instead of the video.
const ERROR_PAGE_BYTES = 16 * 1024;
const ERROR_PAGE_TEXT_BYTES = 512 * 1024;

// Chrome's download manager can't send the page's Referer (see lib/headers.js). When a server refuses it, the file is
// retried in the built-in downloader, which can, and the host is remembered so the next file goes there directly.
const RETRY_IN_PAGE = new Set(['SERVER_FORBIDDEN', 'SERVER_UNAUTHORIZED', 'SERVER_BAD_CONTENT', 'SERVER_FAILED']);
const REFUSED_NOTE =
  "Chrome's own downloader was refused by the server. Some sites only serve a file to their own pages; the built-in downloader sends the page's Referer and cookies. Press Download to retry.";
const ERROR_PAGE_NOTE =
  "Chrome's own downloader received an error page instead of the video, so that file was removed. Some sites only serve a file to their own pages; the built-in downloader sends the page's Referer and cookies.";
const KNOWN_REFUSAL_NOTE =
  "This site refused Chrome's own downloader earlier, so the built-in downloader is used (it sends the page's Referer and cookies).";

const tabKey = (tabId) => `tab:${tabId}`;
const HOSTS_KEY = 'refererHosts';
const LOG_KEY = 'log';
const MAX_LOG_ENTRIES = 80;
const newState = () => ({ items: [], children: [], rejected: [], flags: { drm: false, blob: false, videos: 0 } });

// ---- stored state --------------------------------------------------------------------------------------------

const locks = new Map();

/** Serialises read-modify-write cycles on one storage key (events arrive concurrently). */
function mutateStored(key, fallback, mutate) {
  const run = (locks.get(key) ?? Promise.resolve()).then(async () => {
    const value = (await chrome.storage.session.get(key))[key] ?? fallback();
    const result = await mutate(value);
    await chrome.storage.session.set({ [key]: value });
    return result;
  });
  locks.set(key, run.catch(() => {}));
  return run;
}

// Tab ids are never reused within a browser session, so a late event for a closed tab can be recognised and ignored
// instead of recreating the state that was just removed.
const closedTabs = new Set();
const withTab = (tabId, mutate) => (closedTabs.has(tabId) ? Promise.resolve() : mutateStored(tabKey(tabId), newState, mutate));

/** Runs jobs with at most `limit` in flight; the rest wait their turn. A job that throws is logged and the queue carries on. */
function createQueue(limit, label) {
  const waiting = [];
  let active = 0;
  const pump = () => {
    while (active < limit && waiting.length) {
      active++;
      waiting
        .shift()()
        .catch((e) => logEvent('error', `${label}: ${e?.message || e}`))
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  return (job) => {
    waiting.push(job);
    pump();
  };
}

async function readState(tabId) {
  const key = tabKey(tabId);
  return (await chrome.storage.session.get(key))[key] ?? newState();
}

/**
 * Appends to a small event log kept in chrome.storage.session (this worker has no console you can open from the popup).
 * "Copy diagnostics" in the popup exports it. Messages must not contain query strings: pass URLs through safeUrl().
 */
function logEvent(level, message) {
  return mutateStored(LOG_KEY, () => [], (log) => {
    log.push({ t: new Date().toISOString(), level, message: String(message).slice(0, 300) });
    if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
  }).catch(() => {});
}

/** Listed in the popup: not folded under a master playlist, and not still waiting for its verification probe. */
const isVisible = (item) => !item.hidden && !(item.pending && Date.now() - item.seen < PENDING_MAX_MS);

async function updateBadge(tabId) {
  const state = await readState(tabId);
  const count = state.items.filter(isVisible).length;
  await chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
}

/**
 * A new document in the top frame starts a fresh list. What the new page already requested while the navigation was
 * committing (it is seen after the navigation started) is kept; everything older belonged to the previous page.
 */
async function resetTab(tabId, committedAt) {
  probeCounts.delete(tabId);
  await withTab(tabId, (state) => {
    const since = state.navStart ?? committedAt;
    const items = state.items.filter((i) => i.seen >= since);
    delete state.navStart;
    Object.assign(state, newState(), { items });
  });
  await updateBadge(tabId);
}

// ---- collecting media ----------------------------------------------------------------------------------------

/** Which entry to make room for a new one: a folded-away playlist first, then the oldest plain file, then the oldest. */
function evictionIndex(items) {
  return [(i) => i.hidden, (i) => i.kind === 'file', () => true].map((match) => items.findIndex(match)).find((index) => index >= 0);
}

/**
 * `candidate.source` says where the URL came from. Network responses and the page's own media elements are requests the
 * page really made. A link or meta tag only names a URL: when that belongs to another site it is listed, but this worker
 * never fetches it (a page must not be able to point the extension at addresses of its choosing).
 */
async function addItem(tabId, candidate) {
  if (closedTabs.has(tabId)) return;
  const key = dedupeKey(candidate.url);
  const id = hashString(key);
  const isFile = candidate.kind === 'file';
  const fetchable = !(candidate.source === 'link' || candidate.source === 'meta') || sameSite(candidate.url, candidate.initiator || '');
  // Players fetch stream fragments with XHR/fetch; a <video src> request is the element's own file. A size the response
  // didn't declare can't be trusted either, so those files are checked before they appear in the list.
  const fromPlayer = candidate.via === 'xmlhttprequest' || candidate.via === 'other';
  const suspicious = candidate.size == null || fromPlayer;
  const overBudget = (probeCounts.get(tabId) ?? 0) >= MAX_PROBES_PER_TAB;
  if (isFile && fromPlayer && overBudget) return; // a page streaming through hundreds of unknown requests: not worth listing
  const willProbe = isFile && suspicious && fetchable && !overBudget;
  const outcome = await withTab(tabId, (state) => {
    if (state.rejected?.includes(key)) return 'known'; // verified earlier: tiny, a stream fragment, or not media
    const existing = state.items.find((i) => i.id === id);
    if (existing) {
      if (candidate.size && !existing.size) existing.size = candidate.size;
      if (candidate.mime && !existing.mime) existing.mime = candidate.mime;
      // Signed URLs expire; the most recent one is the most likely to still work.
      if (existing.kind !== 'dash' || !existing.info) existing.url = candidate.url;
      // A manifest first seen as a bare link is read once the page itself requests it, and a failed read is retried.
      const unread = !existing.info && !existing.fetch && fetchable;
      const failed = existing.info?.error && Date.now() - (existing.infoAt || 0) > ENRICH_RETRY_MS;
      if (fetchable) existing.fetch = true;
      return !isFile && (unread || failed) ? 'retry' : 'known';
    }
    state.items.push({
      id,
      url: candidate.url,
      kind: candidate.kind,
      media: candidate.media,
      mime: candidate.mime,
      ext: candidate.ext,
      size: candidate.size,
      initiator: candidate.initiator || '',
      seen: Date.now(),
      hidden: state.children.includes(key),
      pending: willProbe,
      fetch: fetchable,
      info: null,
    });
    if (state.items.length > MAX_ITEMS_PER_TAB) state.items.splice(evictionIndex(state.items), 1);
    return 'created';
  });
  if (outcome === 'created') {
    logEvent('info', `+ ${candidate.kind} ${safeUrl(candidate.url)} via ${candidate.via ?? candidate.source ?? 'page'}${candidate.size != null ? `, ${candidate.size} bytes` : ', size unknown'}${willProbe ? ', verifying' : ''}`);
    await updateBadge(tabId);
  }
  // Queued, not awaited: reading a playlist or probing a file must not delay processing of the next URL.
  if (!isFile && fetchable && (outcome === 'created' || outcome === 'retry')) enrichQueue(() => enrichManifest(tabId, id));
  if (outcome === 'created' && willProbe) {
    probeCounts.set(tabId, (probeCounts.get(tabId) ?? 0) + 1); // a page with hundreds of media URLs: the cap stops the spending
    probeQueue(() => verifyFile(tabId, id));
  }
}

// ---- verifying files -----------------------------------------------------------------------------------------

const probeQueue = createQueue(PROBE_CONCURRENCY, 'verifyFile');
const enrichQueue = createQueue(ENRICH_CONCURRENCY, 'enrichManifest');

/** Cookies go only to the page's own site; a URL on any other host is asked for anonymously. */
const cookiesFor = (item) => (sameSite(item.url, item.initiator) ? 'include' : 'omit');
const probeCounts = new Map(); // tabId -> probes started for it (in memory: a restarted worker simply starts counting again)

/** Drops the item if it turns out to be tiny, a stream fragment or not media; otherwise fills in what the probe learned. */
async function verifyFile(tabId, id) {
  const item = (await readState(tabId)).items.find((i) => i.id === id);
  if (!item || item.kind !== 'file') return;
  let result = null;
  try {
    await ensureExtensionHeaders(item.url, item.initiator);
    result = await probeFile(item.url, { credentials: cookiesFor(item) });
  } catch (e) {
    // can't be reached from here (blocked, expired link...): keep the item as it is
    logEvent('warn', `could not verify ${safeUrl(item.url)}: ${e?.message || e}; keeping it`);
  }
  const reject = result && (result.notMedia || result.fragment || (result.size !== null && result.size < MIN_FILE_BYTES));
  if (reject) {
    const why = result.notMedia ? `not media (${result.mime})` : result.fragment ? 'a stream fragment' : `only ${result.size} bytes`;
    logEvent('info', `- rejected ${safeUrl(item.url)}: ${why}`);
  }
  await withTab(tabId, (state) => {
    const target = state.items.find((i) => i.id === id);
    if (!target) return;
    if (reject) {
      state.items = state.items.filter((i) => i.id !== id);
      (state.rejected ??= []).push(dedupeKey(target.url));
      if (state.rejected.length > MAX_REJECTED_PER_TAB) state.rejected.shift();
      return;
    }
    target.pending = false;
    if (result?.size != null && target.size == null) target.size = result.size;
    if (result?.mime && !target.mime) target.mime = result.mime;
  });
  await updateBadge(tabId);
}

// ---- HLS playlists and DASH manifests ------------------------------------------------------------------------

/** Reads a response body as text, giving up once it exceeds `maxChars` (a hostile server can't exhaust memory). */
async function readTextCapped(res, maxChars) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > maxChars) {
      await reader.cancel();
      throw new Error('Playlist is too large');
    }
  }
  return text + decoder.decode();
}

const describeInfo = (info) =>
  info.error
    ? `error ${info.error}`
    : info.playlist === 'master'
      ? `master, ${info.variants} variants`
      : info.playlist === 'mpd'
        ? `mpd, ${info.variants} representations${info.live ? ', live' : ''}${info.drm ? ', DRM' : ''}`
        : `media, ${info.segments} segments${info.live ? ', live' : ''}`;

/**
 * Reads an HLS playlist or DASH manifest to label it, and hides the files that belong to it: the variant/audio playlists
 * of a master playlist, or the representation files a manifest points at.
 */
async function enrichManifest(tabId, id) {
  const item = (await readState(tabId)).items.find((i) => i.id === id);
  if (!item) return;
  let info;
  try {
    await ensureExtensionHeaders(item.url, item.initiator);
    const res = await fetch(item.url, { credentials: cookiesFor(item), signal: AbortSignal.timeout(PLAYLIST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await readTextCapped(res, MAX_PLAYLIST_CHARS);
    info = item.kind === 'dash' ? summarizeMpd(parseMpd(text, res.url || item.url)) : summarizePlaylist(parsePlaylist(text, res.url || item.url));
  } catch (e) {
    info = { error: String(e?.message || e) };
  }
  logEvent(info.error ? 'warn' : 'info', `${item.kind} ${safeUrl(item.url)}: ${describeInfo(info)}`);
  const { childUrls = [], ...rest } = info;
  await withTab(tabId, (state) => {
    const target = state.items.find((i) => i.id === id);
    if (target) {
      target.info = rest;
      target.infoAt = Date.now();
    }
    const known = new Set(state.children);
    for (const url of childUrls) {
      const key = dedupeKey(url);
      if (!known.has(key)) {
        known.add(key);
        state.children.push(key);
      }
    }
    if (state.children.length > MAX_CHILDREN_PER_TAB) state.children.splice(0, state.children.length - MAX_CHILDREN_PER_TAB);
    for (const other of state.items) if (other.id !== id && known.has(dedupeKey(other.url))) other.hidden = true;
  });
  await updateBadge(tabId);
}

// ---- network sniffing ----------------------------------------------------------------------------------------

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const info = classifyResponse(details);
    if (!info) return;
    addItem(details.tabId, {
      ...info,
      url: details.url,
      initiator: details.initiator || originOf(details.url),
      via: details.type,
    }).catch((e) => logEvent('error', `addItem ${safeUrl(details.url)}: ${e?.message || e}`));
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other', 'main_frame', 'sub_frame', 'object'] },
  ['responseHeaders'],
);

// A new document in the top frame starts a fresh list; History-API navigations don't. The list is cleared when the
// navigation commits, not when it starts: a navigation that is cancelled or turns into a download leaves the page (and
// its list) as it was. The start time is noted so that what the new page requests while committing is kept.
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  withTab(d.tabId, (state) => {
    state.navStart = d.timeStamp;
  }).catch(() => {});
});
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  resetTab(d.tabId, d.timeStamp).catch((e) => logEvent('error', `resetTab: ${e?.message || e}`));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  closedTabs.add(tabId);
  if (closedTabs.size > MAX_CLOSED_TABS) closedTabs.delete(closedTabs.values().next().value);
  probeCounts.delete(tabId);
  // After any write still in flight for this tab, so nothing is left behind in storage.
  const key = tabKey(tabId);
  (locks.get(key) ?? Promise.resolve())
    .then(() => chrome.storage.session.remove(key))
    .catch(() => {})
    .finally(() => locks.delete(key));
  removeRulesForTab(tabId).catch(() => {}); // header rules of a downloader tab
});

// Pages that were open before the extension was installed or updated don't have the content script yet.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map((t) => injectContent(t.id)));
});
chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });

function injectContent(tabId) {
  return chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] })
    .catch(() => {}); // restricted pages (Web Store, chrome://) refuse injection
}

// ---- downloads -----------------------------------------------------------------------------------------------

function baseName(title, item) {
  const fromUrl = filenameFromUrl(item.url).replace(/\.[a-z0-9]{2,5}$/i, '');
  return sanitizeFilename((title || '').trim() || fromUrl || 'video');
}

async function pruneJobs() {
  const all = await chrome.storage.session.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith('job:') && Date.now() - (all[k].created || 0) > JOB_TTL_MS);
  if (stale.length) await chrome.storage.session.remove(stale);
}

async function openJob(item, tab, note = '') {
  await pruneJobs().catch(() => {});
  const jobId = hashString(`${item.id}:${Date.now()}:${Math.random()}`);
  await chrome.storage.session.set({
    [`job:${jobId}`]: { item, title: tab?.title || '', pageUrl: tab?.url || '', note, created: Date.now() },
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`downloader.html?job=${jobId}`), active: true });
}

const refererHosts = async () => new Set((await chrome.storage.session.get(HOSTS_KEY))[HOSTS_KEY] ?? []);
const rememberRefererHost = (url) =>
  mutateStored(HOSTS_KEY, () => [], (hosts) => {
    const host = hostOf(url);
    if (host && !hosts.includes(host)) hosts.push(host);
  });

async function startDownload({ tabId, itemId, builtin = false }) {
  const item = (await readState(tabId)).items.find((i) => i.id === itemId);
  if (!item) throw new Error('This video is no longer available. Reload the page and play it again.');
  if (item.info?.drm) throw new Error('This stream is DRM-protected and cannot be downloaded.');
  if (item.info?.unsupported) throw new Error(item.info.unsupported);
  const tab = await chrome.tabs.get(tabId).catch(() => null);

  if (item.kind !== 'file' || builtin) {
    logEvent('info', `download ${safeUrl(item.url)} -> built-in downloader`);
    await openJob(item, tab);
    return { via: 'page' };
  }
  if ((await refererHosts()).has(hostOf(item.url))) {
    logEvent('info', `download ${safeUrl(item.url)} -> built-in downloader (host refused Chrome's downloader before)`);
    await openJob(item, tab, KNOWN_REFUSAL_NOTE);
    return { via: 'page' };
  }

  // item.ext only ever holds a known media extension (see lib/detect.js), so a hostile page can't pick e.g. ".exe".
  const ext = item.ext || (item.media === 'audio' ? '.mp3' : '.mp4');
  const downloadId = await chrome.downloads.download({
    url: item.url,
    filename: `${baseName(tab?.title, item)}${ext}`,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  await chrome.storage.session.set({ [`dl:${downloadId}`]: { item, title: tab?.title || '', pageUrl: tab?.url || '' } });
  logEvent('info', `download ${safeUrl(item.url)} -> Chrome downloads (#${downloadId})`);
  return { via: 'downloads', downloadId };
}

/**
 * A server that wants the page's Referer may answer Chrome's downloader with a small error page and a 200 status. Only
 * small files qualify, so a real video that happens to be served as text/plain is never mistaken for one and deleted.
 */
const isErrorPage = ({ mime = '', fileSize = -1 }) =>
  fileSize >= 0 && (fileSize < ERROR_PAGE_BYTES || (/^(text\/|application\/(json|xml|xhtml))/i.test(mime) && fileSize < ERROR_PAGE_TEXT_BYTES));

async function settleDownload(id, state) {
  const key = `dl:${id}`;
  let meta = (await chrome.storage.session.get(key))[key];
  if (!meta) {
    await new Promise((r) => setTimeout(r, 250)); // the mapping is written right after download() resolves
    meta = (await chrome.storage.session.get(key))[key];
  }
  if (!meta) return; // not one of ours
  await chrome.storage.session.remove(key);
  const [download] = await chrome.downloads.search({ id });
  if (!download) return;

  let note = REFUSED_NOTE;
  if (state === 'interrupted') {
    logEvent('warn', `Chrome download #${id} of ${safeUrl(meta.item.url)} failed: ${download.error}`);
    if (!RETRY_IN_PAGE.has(download.error)) return;
  } else {
    if (!isErrorPage(download)) return;
    logEvent('warn', `Chrome download #${id} of ${safeUrl(meta.item.url)} was ${download.mime || 'empty'}, ${download.fileSize} bytes: an error page, not the video`);
    await chrome.downloads.removeFile(id).catch(() => {}); // the leftover of our own failed request, not the user's file
    note = ERROR_PAGE_NOTE;
  }
  await chrome.downloads.erase({ id }); // don't leave a "Failed - Forbidden" or a 2 KB entry behind
  await rememberRefererHost(meta.item.url);
  await openJob(meta.item, { title: meta.title, url: meta.pageUrl }, note);
}

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== 'interrupted' && state !== 'complete') return;
  settleDownload(delta.id, state).catch((e) => logEvent('error', `download #${delta.id}: ${e?.message || e}`));
});

// ---- messages from the popup and content scripts -------------------------------------------------------------

const SOURCES = new Set(['element', 'timing', 'link', 'meta']); // see content.js; anything else counts as a bare link
const EXTENSION_ORIGIN = chrome.runtime.getURL('');
/** Popup/downloader pages only: content scripts live in web pages and must not be able to start downloads. */
const fromExtensionPage = (sender) => sender.id === chrome.runtime.id && (sender.url || '').startsWith(EXTENSION_ORIGIN);

async function handleMessage(msg, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('Unknown sender');
  switch (msg?.type) {
    case 'content': {
      const tabId = sender.tab?.id;
      if (tabId == null || tabId < 0) return {};
      const initiator = originOf(sender.url || '');
      for (const entry of Array.isArray(msg.urls) ? msg.urls.slice(0, MAX_URLS_PER_REPORT) : []) {
        const url = entry?.url;
        const info = typeof url === 'string' ? classifyUrl(url) : null;
        if (!info) continue;
        try {
          await addItem(tabId, { ...info, url, initiator, source: SOURCES.has(entry.source) ? entry.source : 'link' });
        } catch (e) {
          // one bad URL must not stop the rest of the report (or the flags below)
          await logEvent('error', `addItem ${safeUrl(url)}: ${e?.message || e}`);
        }
      }
      const f = msg.flags || {};
      await withTab(tabId, (state) => {
        state.flags.drm ||= !!f.drm;
        state.flags.blob ||= !!f.blob;
        state.flags.videos = Math.max(state.flags.videos, Number(f.videos) || 0);
      });
      return {};
    }
    case 'getState': {
      if (!fromExtensionPage(sender)) throw new Error('Not allowed');
      const state = await readState(msg.tabId);
      return { items: state.items.filter(isVisible).sort((a, b) => b.seen - a.seen), flags: state.flags };
    }
    case 'diagnostics': {
      if (!fromExtensionPage(sender)) throw new Error('Not allowed');
      const state = await readState(msg.tabId);
      const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
      return {
        diagnostics: {
          extension: { version: chrome.runtime.getManifest().version },
          tab: { id: msg.tabId, origin: originOf(tab?.url || '') }, // the page title and full URL are left out on purpose
          flags: state.flags,
          // Query strings and fragments are removed everywhere: they often carry session tokens.
          items: state.items.map((i) => ({
            kind: i.kind,
            media: i.media,
            url: safeUrl(i.url),
            size: i.size,
            mime: i.mime,
            ext: i.ext,
            hidden: !!i.hidden,
            pending: !!i.pending,
            initiator: i.initiator,
            ageMs: Date.now() - i.seen,
            info: i.info,
          })),
          rejected: (state.rejected ?? []).map(safeUrl),
          hlsChildren: (state.children ?? []).map(safeUrl),
          hostsRefusingChromeDownloads: [...(await refererHosts())],
          log: (await chrome.storage.session.get(LOG_KEY))[LOG_KEY] ?? [],
        },
      };
    }
    case 'download':
      if (!fromExtensionPage(sender)) throw new Error('Not allowed');
      return startDownload(msg);
    case 'rescan': {
      if (!fromExtensionPage(sender)) throw new Error('Not allowed');
      try {
        await chrome.tabs.sendMessage(msg.tabId, { type: 'scan' });
      } catch {
        await injectContent(msg.tabId); // no listener: page predates the extension
      }
      return {};
    }
    default:
      return {};
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(
    (result) => sendResponse({ ok: true, ...result }),
    (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
  );
  return true; // async response
});
