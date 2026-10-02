// Content script (all frames): reports media URLs the page has, plus whether it plays encrypted media.
// Network sniffing in the service worker finds most streams; this adds <video src>, links, and requests the
// page made before the extension was loaded (via the Resource Timing buffer).
//
// Instances can pile up in one isolated world: the extension can be injected into a page that already has a copy
// (install/update/rescan), and after an extension reload the old copy is orphaned but still running. A new instance
// therefore always disposes of its predecessor, so exactly one working instance remains.

(() => {
  const previous = globalThis.__movieDownloader;
  if (previous) previous.destroy();

  const MEDIA_PATH = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|flv|mp3|m4a|ogg|oga|opus|wav|flac)$/i;
  const MAX_URLS = 60;
  const MAX_LINKS = 20;
  const LINK_SCAN_INTERVAL_MS = 5000; // scanning every <a> on a big page is the costly part; do it sparingly
  const flags = { drm: false, blob: false, videos: 0 };
  const cleanups = [];
  let lastSignature = '';
  let timer = null;
  let dead = false;
  let lastLinkScan = 0;
  let linkUrls = [];

  const absolute = (u) => {
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return null;
    }
  };
  const isMediaUrl = (u) => {
    try {
      return MEDIA_PATH.test(new URL(u).pathname);
    } catch {
      return false;
    }
  };

  // Where a URL came from decides how far the service worker trusts it: the page really requested what its media
  // elements play and what the Resource Timing buffer lists; links and meta tags only name a URL.
  const SOURCE_RANK = { element: 3, timing: 2, link: 1, meta: 1 };

  function collect(force) {
    const found = new Map(); // url -> most trusted source
    const add = (url, source) => {
      if (url && (SOURCE_RANK[source] > (SOURCE_RANK[found.get(url)] ?? 0))) found.set(url, source);
    };
    const elements = document.querySelectorAll('video, audio');
    flags.videos = Math.max(flags.videos, elements.length);
    for (const el of elements) {
      if (el.mediaKeys) flags.drm = true;
      const srcs = [el.currentSrc, el.getAttribute('src'), ...Array.from(el.querySelectorAll('source'), (s) => s.getAttribute('src'))];
      for (const src of srcs) {
        if (!src) continue;
        if (src.startsWith('blob:')) {
          flags.blob = true;
          continue;
        }
        add(absolute(src), 'element');
      }
    }
    for (const entry of performance.getEntriesByType('resource')) {
      if (isMediaUrl(entry.name)) add(entry.name, 'timing');
    }
    if (force || Date.now() - lastLinkScan > LINK_SCAN_INTERVAL_MS) {
      lastLinkScan = Date.now();
      linkUrls = [];
      for (const a of document.querySelectorAll('a[href]')) {
        if (linkUrls.length >= MAX_LINKS) break;
        if (isMediaUrl(a.href)) linkUrls.push(a.href);
      }
    }
    for (const url of linkUrls) add(url, 'link');
    add(absolute(document.querySelector('meta[name="twitter:player:stream"]')?.content), 'meta');
    return [...found].slice(0, MAX_URLS).map(([url, source]) => ({ url, source }));
  }

  function destroy() {
    dead = true;
    clearTimeout(timer);
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // an orphaned context may refuse; the DOM-side cleanups still ran
      }
    }
  }

  function scan(force = false) {
    if (dead) return;
    const urls = collect(force);
    const signature = JSON.stringify([urls, flags]);
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    try {
      chrome.runtime.sendMessage({ type: 'content', urls, flags: { ...flags } }).catch(() => {});
    } catch {
      destroy(); // the extension was reloaded or updated: this copy is orphaned
    }
  }

  function schedule() {
    if (timer || dead) return;
    timer = setTimeout(() => {
      timer = null;
      scan();
    }, 800);
  }

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  // Media events don't bubble, so listen in the capture phase.
  for (const type of ['loadedmetadata', 'playing', 'durationchange']) listen(document, type, schedule, true);
  listen(
    document,
    'encrypted',
    () => {
      flags.drm = true;
      schedule();
    },
    true,
  );
  // A page restored from the back/forward cache is not reloaded, but the list was cleared when it was navigated back to.
  listen(window, 'pageshow', (event) => event.persisted && scan(true));
  const observer = new MutationObserver(schedule);
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  cleanups.push(() => observer.disconnect());

  try {
    const onMessage = (msg) => {
      if (msg?.type === 'scan') scan(true);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    cleanups.push(() => chrome.runtime.onMessage.removeListener(onMessage));
  } catch {
    // orphaned from the start
  }

  for (const delay of [2500, 7000]) {
    const id = setTimeout(() => scan(), delay);
    cleanups.push(() => clearTimeout(id));
  }

  globalThis.__movieDownloader = { scan, destroy, generation: (previous?.generation ?? 0) + 1 };
  scan(true);
})();
