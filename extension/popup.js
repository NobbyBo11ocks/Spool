import { formatBytes, formatDuration, filenameFromUrl, hostOf } from './lib/util.js';
import { el } from './lib/dom.js';
import { icon } from './lib/icons.js';

const params = new URLSearchParams(location.search);
const listEl = document.getElementById('list');
const notesEl = document.getElementById('notes');
let tabId = null;
let lastSignature = '';

async function resolveTabId() {
  if (params.has('tab')) return Number(params.get('tab')); // lets tests open this page in a normal tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

const send = (msg) => chrome.runtime.sendMessage(msg);

// ---- small helpers ---------------------------------------------------------------------------------------------

/** A square icon button. The label is both the tooltip and the accessible name. */
function iconButton(name, label, className = 'icon-btn') {
  return el('button', { class: className, type: 'button', title: label, ariaLabel: label }, icon(name));
}

/** Swaps a button's icon for a check mark for a moment, so a click visibly "took". Resolves when the icon is back. */
function confirmed(button, restore) {
  button.replaceChildren(icon('check'));
  return new Promise((resolve) =>
    setTimeout(() => {
      button.replaceChildren(icon(restore));
      resolve();
    }, 1500),
  );
}

/** Runs `action` on click with the button disabled meanwhile, so a double-click can't start it twice. */
function onClick(button, action) {
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await action();
    } finally {
      button.disabled = false;
    }
  });
}

// Items whose download was just requested. The list is rebuilt when anything about it changes, and a rebuilt button
// must not be clickable again while the first request is still being confirmed.
const busy = new Set();

// ---- one row per detected item ---------------------------------------------------------------------------------

function badgeFor(item) {
  if (item.kind === 'hls') return 'HLS';
  if (item.kind === 'dash') return 'DASH';
  return (item.ext || '').replace('.', '').toUpperCase() || (item.media === 'audio' ? 'AUDIO' : 'VIDEO');
}

function describe(item) {
  const facts = [];
  const info = item.info || {};
  let title;
  if (item.kind === 'file') {
    title = filenameFromUrl(item.url) || (item.media === 'audio' ? 'Audio file' : 'Video file');
    if (item.size) facts.push(formatBytes(item.size));
  } else {
    const label = item.kind === 'dash' ? 'DASH' : 'HLS';
    title = info.audioOnly ? `${label} audio stream` : `${label} stream`;
    if (info.maxHeight) facts.push(`up to ${info.maxHeight}p`);
    if ((info.playlist === 'master' || info.playlist === 'mpd') && info.variants > 1) facts.push(`${info.variants} qualities`);
    if (info.duration) facts.push(formatDuration(info.duration));
    if (info.live) facts.push('live');
    if (info.hiddenProtected) facts.push(`${info.hiddenProtected} DRM hidden`);
    if (info.drm) facts.push('DRM');
    else if (info.encryption && info.encryption !== 'NONE') facts.push(info.encryption);
  }
  return { title, meta: [...facts, hostOf(item.url)].filter(Boolean).join(' · ') };
}

function blockedReason(item) {
  if (item.info?.drm) {
    const systems = item.info.drmSystems?.length ? ` (${item.info.drmSystems.join(', ')})` : '';
    return `DRM-protected${systems}: this stream can't be downloaded.`;
  }
  if (item.info?.unsupported) return item.info.unsupported;
  return '';
}

function renderItem(item) {
  const { title, meta } = describe(item);
  const blocked = blockedReason(item);
  const problem = el('div', { class: 'problem', hidden: !blocked }, blocked);
  const showProblem = (message) => {
    problem.textContent = message;
    problem.classList.add('error'); // a real failure, unlike the standing "not supported" reasons
    problem.hidden = false;
  };

  const download = iconButton('download', 'Download', 'icon-btn primary');
  download.disabled = !!blocked || busy.has(item.id);
  onClick(download, async () => {
    busy.add(item.id);
    problem.hidden = true;
    problem.classList.remove('error');
    try {
      const res = await send({ type: 'download', tabId, itemId: item.id });
      if (res?.ok) await confirmed(download, 'download');
      else showProblem(res?.error || 'Could not start the download.');
    } catch {
      showProblem('Could not reach the extension. Reload the page and try again.');
    } finally {
      busy.delete(item.id);
    }
  });

  const copy = iconButton('copy', 'Copy link');
  onClick(copy, async () => {
    try {
      await navigator.clipboard.writeText(item.url);
      await confirmed(copy, 'copy');
    } catch {
      showProblem('Could not copy to the clipboard.');
    }
  });

  // Three fixed slots (download | copy | built-in downloader) so the same action is always in the same column.
  const actions = el('div', { class: 'actions' }, download, copy);
  if (item.kind === 'file') {
    const builtin = iconButton('open', 'Built-in downloader');
    onClick(builtin, async () => {
      try {
        const res = await send({ type: 'download', tabId, itemId: item.id, builtin: true });
        if (!res?.ok) showProblem(res?.error || 'Could not open the downloader.');
      } catch {
        showProblem('Could not reach the extension. Reload the page and try again.');
      }
    });
    actions.append(builtin);
  }

  return el(
    'section',
    { class: 'card', title: item.url },
    el('span', { class: 'chip' }, badgeFor(item)),
    el('div', { class: 'text' }, el('div', { class: 'title' }, title), el('div', { class: 'meta' }, meta)),
    actions,
    problem,
  );
}

// ---- list, notes, empty state ----------------------------------------------------------------------------------

function renderNotes(flags, hasItems) {
  notesEl.replaceChildren();
  if (flags.drm) {
    notesEl.append(el('div', { class: 'note' }, 'This page plays encrypted (DRM) media. Encrypted streams cannot be downloaded.'));
  } else if (flags.blob && !hasItems) {
    notesEl.append(el('div', { class: 'note' }, 'The video plays from a blob: source. Press play (or reload the page) so the underlying stream can be detected.'));
  }
}

function render(state) {
  const signature = JSON.stringify(state);
  if (signature === lastSignature) return;
  lastSignature = signature;
  renderNotes(state.flags, state.items.length > 0);
  if (!state.items.length) {
    listEl.replaceChildren(
      el(
        'div',
        { class: 'empty' },
        el('strong', {}, 'No videos detected yet.'),
        'Press play on the video, then rescan. If the page was open before Spool was installed, reload it first.',
      ),
    );
    return;
  }
  // Downloadable entries first; ones we can't download (DRM, DASH) after them. Newest first within each group.
  const rank = (item) => (blockedReason(item) ? 1 : 0);
  const items = [...state.items].sort((a, b) => rank(a) - rank(b) || b.seen - a.seen);
  listEl.replaceChildren(...items.map(renderItem));
}

async function refresh() {
  if (tabId == null) return;
  try {
    const state = await send({ type: 'getState', tabId });
    if (state?.ok) render(state);
  } catch {
    // the worker was restarting; the next tick asks again
  }
}

// ---- header actions --------------------------------------------------------------------------------------------

const diagnosticsButton = document.getElementById('diagnostics');
diagnosticsButton.replaceChildren(icon('clipboard'));
diagnosticsButton.addEventListener('click', async () => {
  const res = await send({ type: 'diagnostics', tabId });
  const original = diagnosticsButton.title;
  try {
    if (!res?.ok) throw new Error(res?.error);
    await navigator.clipboard.writeText(JSON.stringify({ ...res.diagnostics, browser: navigator.userAgent }, null, 2));
    confirmed(diagnosticsButton, 'clipboard');
  } catch {
    diagnosticsButton.title = 'Could not copy diagnostics';
    setTimeout(() => (diagnosticsButton.title = original), 2000);
  }
});

const rescanButton = document.getElementById('rescan');
rescanButton.replaceChildren(icon('refresh'));
onClick(rescanButton, async () => {
  await send({ type: 'rescan', tabId }).catch(() => {});
  setTimeout(refresh, 400);
});

tabId = await resolveTabId();
await refresh();
setInterval(refresh, 1500);
