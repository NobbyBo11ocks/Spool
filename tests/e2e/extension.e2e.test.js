// End-to-end: loads the unpacked extension into Chrome for Testing (branded Chrome 137+ ignores --load-extension)
// and drives real pages. The "gated" CDN refuses requests that lack the page's Referer, which is what hotlink-protected
// video hosts do. Run with CHROME_FOR_TESTING=<path to chrome.exe> (see README), otherwise Playwright's Chromium is used.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureFixtures, serve, probeDecode, ffmpegPath, FIXTURE_DIR, SOURCE_FPS, SOURCE_SECONDS } from '../helpers/fixtures.js';
import { formatBytes } from '../../extension/lib/util.js';
import { pieceRoutes, writePages } from '../helpers/pages.js';

const EXT = resolve(import.meta.dirname, '../../extension');
const FRAMES = SOURCE_FPS * SOURCE_SECONDS;
const work = mkdtempSync(join(tmpdir(), 'md-e2e-'));
const pagesDir = join(work, 'pages');
mkdirSync(pagesDir, { recursive: true });

let ctx, extId, anchor, pageServer, gated, open, htmlGate, gatedLog, openLog, htmlLog, pageLog, pageOrigin;
const webErrors = [];
let counter = 0;

// ---- helpers -------------------------------------------------------------------------------------------------------

/** Stand-in for the native save dialog (which can't be automated): hands out files in the origin-private file system. */
const MOCK_PICKER = () => {
  window.showSaveFilePicker = async (opts) => {
    window.__picker = opts;
    const root = await navigator.storage.getDirectory();
    return root.getFileHandle(opts.suggestedName, { create: true });
  };
};

async function sw() {
  for (let i = 0; i < 30; i++) {
    const [worker] = ctx.serviceWorkers();
    if (worker) return worker;
    if (i === 0 && extId) {
      // The worker was evicted: any message from an extension page wakes it.
      const p = await ctx.newPage();
      await p.goto(`chrome-extension://${extId}/popup.html?tab=0`).catch(() => {});
      await p.close();
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('extension service worker is not running');
}

const pageUrl = (name) => `${pageOrigin}/${name}?n=${++counter}`;

async function openPage(name) {
  const url = pageUrl(name);
  const page = await ctx.newPage();
  await page.goto(url);
  return { page, url };
}

async function openPopup(url) {
  const tabId = await (await sw()).evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
  assert.ok(tabId != null, `no tab for ${url}`);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
  return popup;
}

/** Opens the popup for a page and waits until its first card's text includes `text`. */
async function popupWith(url, text = '') {
  const popup = await openPopup(url);
  try {
    await popup.waitForFunction((t) => document.querySelector('.card')?.innerText.includes(t), text, { timeout: 15000 });
  } catch (e) {
    // Say what the popup showed instead, so a failure explains itself.
    throw new Error(`${e.message}\nexpected a first card containing "${text}"; the popup shows: ${JSON.stringify(await popup.locator('body').innerText())}`);
  }
  return popup;
}

async function openDownloaderFrom(popup, buttonSelector = '.card button.primary') {
  const [dl] = await Promise.all([
    ctx.waitForEvent('page', { predicate: (p) => p.url().includes('downloader.html'), timeout: 20000 }),
    popup.locator(buttonSelector).first().click(),
  ]);
  await dl.waitForLoadState();
  await dl.evaluate(MOCK_PICKER);
  return dl;
}

const track = (dl, heading) => dl.locator('section.track').filter({ has: dl.getByRole('heading', { name: heading, exact: true }) });
const waitReady = (t) => t.locator('button.primary:enabled').waitFor({ timeout: 25000 });
const statusOf = (t) => t.locator('.track-status');
/** The DASH "Audio" selector of a panel (getByLabel('Audio') would also match "Save as": its option text says audio). */
const audioSelectOf = (t) => t.locator('label').filter({ hasText: /^Audio/ }).locator('select');

/** Clicks Download on a track and returns the saved file name once the status says "Saved <name>". */
async function saveAndWait(t, pattern = /^Saved /) {
  await t.locator('button.primary').click();
  // Wait for success or for a failure message, so a broken download fails the test with its real error text.
  await t.locator('.track-status', { hasText: new RegExp(`${pattern.source}|^Failed|^Could not`) }).waitFor({ timeout: 40000 });
  const text = await statusOf(t).innerText();
  assert.match(text, pattern, `download did not succeed: ${text}`);
  return text.replace(/^Saved /, '');
}

async function readOpfs(page, name) {
  const b64 = await page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory();
    const buf = new Uint8Array(await (await (await root.getFileHandle(n)).getFile()).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, name);
  return Buffer.from(b64, 'base64');
}

/** Writes bytes to disk, decodes them with ffmpeg, checks for errors/frames/duration, and returns ffmpeg's stream info. */
function decode(name, bytes, expect = {}) {
  const file = join(work, name);
  writeFileSync(file, bytes);
  const r = probeDecode(file);
  assert.ok(r.ok, `${name} has decode problems:\n${r.stderr}`);
  if (expect.frames !== undefined) assert.equal(r.frames, expect.frames, `${name} frame count`);
  assert.ok(Math.abs(r.seconds - SOURCE_SECONDS) < 0.7, `${name} duration ${r.seconds}s`);
  return spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
}

async function waitForChromeDownload(urlPart) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const items = await (await sw()).evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'] }));
    const item = items.find((i) => i.url.includes(urlPart));
    if (item && item.state !== 'in_progress') return item;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`no finished Chrome download for ${urlPart}`);
}

// ---- setup ---------------------------------------------------------------------------------------------------------

before(async () => {
  ensureFixtures();
  pageLog = [];
  pageServer = await serve(pagesDir, { log: pageLog });
  pageOrigin = `http://localhost:${pageServer.port}`; // media is on 127.0.0.1: a different host, like a real CDN
  gatedLog = [];
  openLog = [];
  htmlLog = [];
  gated = await serve(FIXTURE_DIR, { requireReferer: pageOrigin, log: gatedLog });
  open = await serve(FIXTURE_DIR, { log: openLog, extraRoutes: pieceRoutes });
  // Answers 200 with a small HTML page (not 403) to requests without the page's Referer.
  htmlGate = await serve(FIXTURE_DIR, {
    requireReferer: pageOrigin,
    refusal: { status: 200, headers: { 'Content-Type': 'text/html' }, body: '<!doctype html><title>Access denied</title><p>Access denied</p>' },
    log: htmlLog,
  });
  writePages(pagesDir, { G: gated.origin, O: open.origin, H: htmlGate.origin });

  // Playwright redirects browser downloads into its own temp "artifacts" folder (files get GUID names), so nothing
  // lands in the real Downloads folder.
  const userData = join(work, 'profile');
  mkdirSync(userData, { recursive: true });

  const exe = process.env.CHROME_FOR_TESTING;
  ctx = await chromium.launchPersistentContext(userData, {
    ...(exe ? { executablePath: exe } : { channel: 'chromium' }),
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  ctx.on('weberror', (e) => webErrors.push(e.error().message));
  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  extId = new URL(worker.url()).host;
  anchor = await ctx.newPage(); // keeps the browser alive while tests open and close their own pages
});

afterEach(async () => {
  for (const p of ctx.pages()) if (p !== anchor) await p.close().catch(() => {});
});

after(async () => {
  await ctx?.close();
  await pageServer?.close();
  await gated?.close();
  await open?.close();
  await htmlGate?.close();
});

// ---- tests ---------------------------------------------------------------------------------------------------------

test('the extension loads: MV3 service worker runs and the manifest is as expected', async () => {
  const manifest = await (await sw()).evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['declarativeNetRequestWithHostAccess', 'downloads', 'scripting', 'storage', 'webNavigation', 'webRequest']);
});

test('<video src=mp4> is detected with its size; Chrome downloads it when the host needs no Referer', async () => {
  const { url } = await openPage('direct-open.html');
  const popup = await popupWith(url, 'MP4');
  const card = await popup.locator('.card').first().innerText();
  assert.match(card, /source\.mp4/);
  assert.ok(card.includes(formatBytes(statSync(join(FIXTURE_DIR, 'source.mp4')).size)), `size missing in: ${card}`);
  assert.equal(await popup.locator('.card').count(), 1);
  const badge = await (await sw()).evaluate(async (u) => chrome.action.getBadgeText({ tabId: (await chrome.tabs.query({})).find((t) => t.url === u).id }), url);
  assert.equal(badge, '1');

  // Playwright renames downloaded files, so record what the extension asked Chrome to save.
  await (await sw()).evaluate(() => {
    self.__dl = [];
    const original = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = (options, callback) => (self.__dl.push(options), original(options, callback));
  });
  await popup.locator('.card button.primary').click();
  const done = await waitForChromeDownload(`:${open.port}/source.mp4`);
  assert.equal(done.state, 'complete', `${done.state} ${done.error ?? ''}`);
  assert.ok(readFileSync(done.filename).equals(readFileSync(join(FIXTURE_DIR, 'source.mp4'))), 'downloaded bytes are identical');
  const [call] = await (await sw()).evaluate(() => self.__dl);
  assert.equal(call.filename, 'Open Movie.mp4', 'file named after the page title');
  assert.equal(call.conflictAction, 'uniquify');
  assert.equal(call.saveAs, false);
});

test("Referer-gated file: Chrome's own download is refused, the failed entry is erased, the built-in downloader takes over, and the host is remembered", async () => {
  await (await sw()).evaluate(() => chrome.storage.session.remove('refererHosts'));
  const { url } = await openPage('direct.html');
  const popup = await popupWith(url, 'MP4');
  const dl = await openDownloaderFrom(popup); // opened automatically after the refusal
  await dl.waitForFunction(() => document.querySelector('#notice') && !document.querySelector('#notice').hidden);
  assert.match(await dl.locator('#notice').innerText(), /refused by the server/);

  const remaining = await (await sw()).evaluate(() => chrome.downloads.search({}));
  assert.deepEqual(remaining.filter((i) => i.url.includes(`:${gated.port}/source.mp4`)), [], 'the failed Chrome download was erased');
  const refusals = () => gatedLog.filter((e) => e.path === '/source.mp4' && e.status === 403 && e.headers.referer === undefined);
  assert.ok(refusals().length >= 1, "Chrome's download manager was refused (it sends no Referer)");

  const t = track(dl, 'Video file');
  await waitReady(t);
  const saved = await saveAndWait(t);
  assert.equal(saved, 'Gated Movie.mp4');
  assert.ok((await readOpfs(dl, 'Gated Movie.mp4')).equals(readFileSync(join(FIXTURE_DIR, 'source.mp4'))));
  const ok = gatedLog.filter((e) => e.path === '/source.mp4' && e.status === 200);
  assert.ok(ok.length >= 1);
  assert.equal(ok.at(-1).headers.referer, `${pageOrigin}/`, 'the built-in downloader sent the page Referer');
  assert.equal(ok.at(-1).headers.origin, pageOrigin);

  // Second file from the same host: straight to the built-in downloader, Chrome is not asked (and refused) again.
  const refusedBefore = refusals().length;
  const second = await openPage('direct.html');
  const popup2 = await popupWith(second.url, 'MP4');
  const dl2 = await openDownloaderFrom(popup2);
  await dl2.waitForFunction(() => document.querySelector('#notice') && !document.querySelector('#notice').hidden);
  assert.match(await dl2.locator('#notice').innerText(), /refused Chrome's own downloader earlier/);
  assert.equal(refusals().length, refusedBefore, 'Chrome was not asked again');
});

test('"Built-in downloader" button saves a plain file through the picker', async () => {
  const { url } = await openPage('direct-open.html');
  const popup = await popupWith(url, 'MP4');
  const dl = await openDownloaderFrom(popup, '.card button[title="Built-in downloader"]');
  const t = track(dl, 'Video file');
  await waitReady(t);
  assert.equal(await saveAndWait(t), 'Open Movie.mp4');
  decode('builtin-direct.mp4', await readOpfs(dl, 'Open Movie.mp4'), { frames: FRAMES });
});

test('stream pieces (init segment, tiny files, fragments) are not offered; a real file of unknown size is, and the list shows no flicker', async () => {
  const { page, url } = await openPage('pieces.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, 'big-chunked.mp4');
  await new Promise((r) => setTimeout(r, 1500)); // let every probe finish and the popup poll again
  const cards = await popup.locator('.card').allInnerTexts();
  assert.equal(cards.length, 1, `expected only the real file, got: ${JSON.stringify(cards)}`);
  assert.match(cards[0], /big-chunked\.mp4/);
  const badge = await (await sw()).evaluate(async (u) => chrome.action.getBadgeText({ tabId: (await chrome.tabs.query({})).find((t) => t.url === u).id }), url);
  assert.equal(badge, '1');
  // The pieces were rejected by name (init) or by probing (tiny, styp, moof) and are remembered, not re-listed.
  const probed = openLog.filter((e) => e.headers.range && /^bytes=0-\d+$/.test(e.headers.range)).map((e) => e.path);
  for (const piece of ['/tiny-chunked.mp4', '/fragment.mp4', '/xhr-fragment.mp4']) assert.ok(probed.includes(piece), `${piece} was verified`);
  assert.ok(!probed.includes('/init-s1080p-v1-a1.mp4'), 'the init segment was rejected by name, without a request');
});

test('HLS: master + variant playlists collapse into one entry labelled from the playlist (extension fetch carries the Referer)', async () => {
  const { page, url } = await openPage('hls.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, '360p');
  assert.equal(await popup.locator('.card').count(), 1, 'the variant playlist must be hidden behind the master');
  const text = await popup.locator('.card').first().innerText();
  assert.match(text, /HLS/);
  assert.match(text, /up to 360p/);
});

test('HLS download (gated CDN): MP4 conversion and original TS both play, every request carried the Referer', async () => {
  const { page, url } = await openPage('hls.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, '360p');
  const dl = await openDownloaderFrom(popup);
  const video = track(dl, 'Video');
  await waitReady(video);
  assert.deepEqual(await video.getByLabel('Save as').locator('option').allInnerTexts(), ['MP4 (converted)', 'TS (original, no conversion)']);
  assert.equal(await dl.title(), 'Streamed Movie – Spool');
  assert.equal(await dl.locator('section.track:not([hidden])').count(), 1, 'no separate audio row for a muxed stream');

  assert.equal(await saveAndWait(video), 'Streamed Movie 360p.mp4');
  const info = decode('hls.mp4', await readOpfs(dl, 'Streamed Movie 360p.mp4'), { frames: FRAMES });
  assert.match(info, /Video: h264.*640x360/);
  assert.match(info, /Audio: aac/);

  await video.getByLabel('Save as').selectOption({ label: 'TS (original, no conversion)' });
  assert.equal(await saveAndWait(video, /^Saved .*\.ts$/), 'Streamed Movie 360p.ts');
  decode('hls.ts', await readOpfs(dl, 'Streamed Movie 360p.ts'), { frames: FRAMES });

  const segs = gatedLog.filter((e) => /^\/ts\/seg\d\.ts$/.test(e.path));
  assert.ok(segs.length >= 6);
  assert.ok(segs.every((e) => e.status === 200), `refused: ${segs.filter((e) => e.status !== 200).map((e) => e.status)}`);
  assert.ok(segs.every((e) => e.headers.referer === `${pageOrigin}/` && e.headers.origin === pageOrigin), 'Referer and Origin are the page origin');
});

test('multi-quality master: qualities are listed best first and switching quality downloads that quality', async () => {
  const { page, url } = await openPage('hls-multi.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, '2 qualities');
  const dl = await openDownloaderFrom(popup);
  const video = track(dl, 'Video');
  await waitReady(video);
  assert.deepEqual(await video.getByLabel('Quality').locator('option').allInnerTexts(), ['360p · 800 kbps', '180p · 300 kbps']);

  await video.getByLabel('Quality').selectOption({ label: '180p · 300 kbps' });
  await waitReady(video);
  assert.equal(await saveAndWait(video), 'Multi Movie 180p.mp4');
  const info = decode('multi180.mp4', await readOpfs(dl, 'Multi Movie 180p.mp4'), { frames: FRAMES });
  assert.match(info, /Video: h264.*320x180/);
});

test('separate audio rendition: its own row, video and audio downloaded as two playable files', async () => {
  const { page, url } = await openPage('hls-audio.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, 'HLS');
  assert.equal(await popup.locator('.card').count(), 1, 'variant and audio playlists are hidden behind the master');
  const dl = await openDownloaderFrom(popup);
  const video = track(dl, 'Video');
  const audio = track(dl, 'Audio (separate stream)');
  await waitReady(video);
  await waitReady(audio);
  assert.equal(await audio.isVisible(), true);
  assert.deepEqual(await audio.getByLabel('Track').locator('option').allInnerTexts(), ['English · en']);

  assert.equal(await saveAndWait(video), 'Split Movie 360p.mp4');
  const vInfo = decode('split-video.mp4', await readOpfs(dl, 'Split Movie 360p.mp4'), { frames: FRAMES });
  assert.match(vInfo, /Video: h264/);
  assert.doesNotMatch(vInfo, /Audio:/);

  assert.equal(await saveAndWait(audio), 'Split Movie (audio).m4a');
  const aInfo = decode('split-audio.m4a', await readOpfs(dl, 'Split Movie (audio).m4a'), { frames: 0 });
  assert.match(aInfo, /Audio: aac/);
  assert.doesNotMatch(aInfo, /Video:/);
});

test('AES-128 stream with the implicit IV: key is fetched with the Referer, output decrypts and plays', async () => {
  const { page, url } = await openPage('hls-aes.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, 'AES-128');
  const dl = await openDownloaderFrom(popup);
  const t = track(dl, 'Video');
  await waitReady(t);
  assert.equal(await saveAndWait(t), 'Encrypted Movie.mp4');
  decode('aes.mp4', await readOpfs(dl, 'Encrypted Movie.mp4'), { frames: FRAMES });
  const key = gatedLog.filter((e) => e.path === '/aes-seq/enc.key');
  assert.ok(key.length >= 1 && key.every((e) => e.status === 200 && e.headers.referer === `${pageOrigin}/`));
});

test('HEVC in TS: offers .ts only, explains why, and the .ts plays', async () => {
  const { page, url } = await openPage('hls-hevc.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, 'HLS');
  const dl = await openDownloaderFrom(popup);
  const t = track(dl, 'Video');
  await waitReady(t);
  assert.deepEqual(await t.getByLabel('Save as').locator('option').allInnerTexts(), ['TS (original, no conversion)']);
  assert.match(await dl.locator('#notice').innerText(), /HEVC/);
  assert.equal(await saveAndWait(t, /^Saved .*\.ts$/), 'HEVC Movie.ts');
  decode('hevc.ts', await readOpfs(dl, 'HEVC Movie.ts'), { frames: FRAMES });
});

test('live playlist: labelled live in the popup and warned about in the downloader', async () => {
  const { page, url } = await openPage('hls-live.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, 'live');
  const dl = await openDownloaderFrom(popup);
  await waitReady(track(dl, 'Video'));
  assert.match(await dl.locator('#notice').innerText(), /live stream/);
});

test('DRM-protected HLS is refused up front and its segments are never requested', async () => {
  const { page, url } = await openPage('hls-drm.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, 'HLS');
  await popup.waitForSelector('.problem:not([hidden])');
  assert.match(await popup.locator('.problem').first().innerText(), /DRM/);
  assert.equal(await popup.locator('.card button.primary').isDisabled(), true);
  assert.deepEqual(gatedLog.filter((e) => e.path.includes('enc0.ts')), []);
});

test('DASH (SegmentTemplate + timeline): labelled in the popup, downloaded as ONE MP4 with video and audio', async () => {
  const { page, url } = await openPage('dash.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, 'up to 360p');
  const card = await popup.locator('.card').first().innerText();
  assert.match(card, /DASH stream/);
  assert.equal(await popup.locator('.card button.primary').isEnabled(), true);
  assert.equal(await popup.locator('.card .problem:not([hidden])').count(), 0);

  const dl = await openDownloaderFrom(popup);
  const video = track(dl, 'Video');
  await waitReady(video);
  assert.deepEqual(await audioSelectOf(video).locator('option').allInnerTexts(), ['mp4a · 69 kbps', 'None (video only)']);
  assert.deepEqual(await video.getByLabel('Save as').locator('option').allInnerTexts(), ['MP4 (video + audio)']);
  assert.equal(await dl.locator('section.track:not([hidden])').count(), 1, 'audio is merged, so there is no separate audio panel');
  assert.equal(await saveAndWait(video), 'Dash Movie 360p.mp4');
  const info = decode('dash.mp4', await readOpfs(dl, 'Dash Movie 360p.mp4'), { frames: FRAMES });
  assert.match(info, /Video: h264.*640x360/);
  assert.match(info, /Audio: aac/);
  const segs = gatedLog.filter((e) => /^\/dash-tpl\/(init|chunk)-stream\d/.test(e.path) && e.headers.origin === pageOrigin);
  assert.ok(segs.length >= 15 && segs.every((e) => e.status === 200 && e.headers.referer === `${pageOrigin}/`), 'segments carried the page Referer');
});

test('DASH: "None (video only)" saves the video without an audio track', async () => {
  const { page, url } = await openPage('dash.html');
  await page.waitForFunction(() => window.__done === true);
  const dl = await openDownloaderFrom(await popupWith(url, 'DASH'));
  const video = track(dl, 'Video');
  await waitReady(video);
  await audioSelectOf(video).selectOption({ label: 'None (video only)' });
  assert.deepEqual(await video.getByLabel('Save as').locator('option').allInnerTexts(), ['MP4 (video only)']);
  assert.equal(await saveAndWait(video), 'Dash Movie 360p.mp4');
  const info = decode('dash-video-only.mp4', await readOpfs(dl, 'Dash Movie 360p.mp4'), { frames: FRAMES });
  assert.match(info, /Video: h264/);
  assert.doesNotMatch(info, /Audio:/);
});

test('DASH with several qualities: best first, and the chosen quality is the one saved', async () => {
  const { page, url } = await openPage('dash-multi.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, '2 qualities');
  const dl = await openDownloaderFrom(popup);
  const video = track(dl, 'Video');
  await waitReady(video);
  const qualities = await video.getByLabel('Quality').locator('option').allInnerTexts();
  assert.match(qualities[0], /^360p/);
  assert.match(qualities[1], /^180p/);
  await video.getByLabel('Quality').selectOption({ index: 1 });
  assert.equal(await saveAndWait(video), 'Multi Dash 180p.mp4');
  assert.match(decode('dash-180.mp4', await readOpfs(dl, 'Multi Dash 180p.mp4'), { frames: FRAMES }), /Video: h264.*320x180/);
});

test('DASH as byte ranges of one file per stream merges too', async () => {
  const { page, url } = await openPage('dash-single.html');
  await page.waitForFunction(() => window.__done === true);
  const dl = await openDownloaderFrom(await popupWith(url, 'DASH'));
  const video = track(dl, 'Video');
  await waitReady(video);
  assert.equal(await saveAndWait(video), 'Ranged Dash 360p.mp4');
  const info = decode('dash-ranged.mp4', await readOpfs(dl, 'Ranged Dash 360p.mp4'), { frames: FRAMES });
  assert.match(info, /Video: h264/);
  assert.match(info, /Audio: aac/);
  const ranged = gatedLog.filter((e) => e.path === '/dash-single/index-stream0.mp4' && e.headers.range);
  assert.ok(ranged.length >= 7, 'segments were fetched with Range requests');
});

test('DASH in WebM cannot be merged: video saved as .webm and the audio gets its own panel', async () => {
  const { page, url } = await openPage('dash-webm.html');
  await page.waitForFunction(() => window.__done === true);
  const dl = await openDownloaderFrom(await popupWith(url, 'DASH'));
  const video = track(dl, 'Video');
  const audio = track(dl, 'Audio (separate stream)');
  await waitReady(video);
  await waitReady(audio);
  assert.deepEqual(await video.getByLabel('Save as').locator('option').allInnerTexts(), ['WEBM (video only)']);
  assert.equal(await audio.isVisible(), true);
  assert.match(await dl.locator('#notice').innerText(), /can't be merged/);
  assert.equal(await saveAndWait(video, /^Saved .*\.webm$/), 'WebM Dash 360p.webm');
  assert.match(decode('dash.webm', await readOpfs(dl, 'WebM Dash 360p.webm'), { frames: FRAMES }), /Video: vp9/);
  assert.equal(await saveAndWait(audio, /^Saved .*\.weba$/), 'WebM Dash (audio).weba');
  assert.match(decode('dash.weba', await readOpfs(dl, 'WebM Dash (audio).weba'), { frames: 0 }), /Audio: opus/);
});

test('DRM-protected DASH is refused up front and no segment is requested', async () => {
  const requestsBefore = gatedLog.length;
  const { page, url } = await openPage('dash-drm.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, 'DASH');
  await popup.waitForSelector('.problem:not([hidden])');
  assert.match(await popup.locator('.problem').first().innerText(), /DRM/);
  assert.equal(await popup.locator('.card button.primary').isDisabled(), true);
  assert.deepEqual(gatedLog.slice(requestsBefore).filter((e) => /dash-tpl\/(init|chunk)-/.test(e.path)), [], 'only the manifest was fetched');
});

test('live DASH with a SegmentTimeline: downloadable with a warning', async () => {
  const { page, url } = await openPage('dash-live.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, 'live');
  const dl = await openDownloaderFrom(popup);
  await waitReady(track(dl, 'Video'));
  assert.match(await dl.locator('#notice').innerText(), /live stream/);
});

test('cancelling a running download saves nothing', async () => {
  const { page, url } = await openPage('hls.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, '360p');
  const dl = await openDownloaderFrom(popup);
  await dl.evaluate(() => {
    window.showSaveFilePicker = async () => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle('cancelled.mp4', { create: true });
      const realCreate = handle.createWritable.bind(handle);
      handle.createWritable = async () => {
        const w = await realCreate();
        const write = w.write.bind(w);
        w.write = async (c) => { await new Promise((r) => setTimeout(r, 400)); return write(c); }; // slow disk
        return w;
      };
      return handle;
    };
  });
  const t = track(dl, 'Video');
  await waitReady(t);
  await t.locator('button.primary').click();
  await t.locator('button:has-text("Cancel")').click();
  await t.locator('.track-status', { hasText: /Cancelled/ }).waitFor({ timeout: 15000 });
  const size = await dl.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('cancelled.mp4')).getFile()).size);
  assert.equal(size, 0, 'aborting the writable discards the swap file');
  await t.locator('button.primary:enabled').waitFor({ timeout: 5000 }); // can retry after cancelling
});

test('blob: sources, EME and empty pages get the right hints', async () => {
  for (const [name, pattern] of [['blob.html', /blob:/], ['drm.html', /DRM/], ['plain.html', /No videos detected/]]) {
    const { url } = await openPage(name);
    await new Promise((r) => setTimeout(r, 1200));
    const popup = await openPopup(url);
    await popup.waitForFunction((src) => new RegExp(src).test(document.body.innerText), pattern.source, { timeout: 10000 });
    assert.equal(await popup.locator('.card').count(), 0, name);
  }
});

test('page-controlled strings are never interpreted as HTML', async () => {
  const { url } = await openPage('xss.html');
  const popup = await popupWith(url, '');
  assert.match(await popup.locator('.card').first().innerText(), /<img src=x onerror=window\.__xss=1>\.mp4/, 'shown as literal text');
  assert.equal(await popup.evaluate(() => window.__xss), undefined);
  assert.equal(await popup.locator('.card img').count(), 0);
});

test('Rescan recovers media the page requested earlier, via the Resource Timing buffer', async () => {
  const { page, url } = await openPage('hls.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, 'HLS');
  await (await sw()).evaluate(() => chrome.storage.session.clear()); // forget everything the sniffer saw
  await popup.waitForSelector('.empty', { timeout: 10000 });
  await popup.locator('#rescan').click();
  await popup.waitForSelector('.card', { timeout: 10000 });
  assert.match(await popup.locator('.card').first().innerText(), /HLS/);
});

test('the list survives the service worker being evicted (MV3 workers are ephemeral), and detection keeps working after', async () => {
  const { page, url } = await openPage('hls.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, '360p');
  await (await sw()).evaluate(() => { self.__marker = 'in-memory state'; });

  // Stop the extension's worker through the DevTools protocol (what Chrome does after ~30 s of idleness).
  const cdp = await ctx.newCDPSession(popup);
  const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', (e) => e.versions.forEach((v) => versions.set(v.versionId, v)));
  await cdp.send('ServiceWorker.enable');
  await new Promise((r) => setTimeout(r, 400));
  const mine = [...versions.values()].filter((v) => v.scriptURL.includes(extId));
  assert.ok(mine.length >= 1, 'found the extension worker');
  for (const v of mine) await cdp.send('ServiceWorker.stopWorker', { versionId: v.versionId });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await (await sw()).evaluate(() => self.__marker ?? null), null, 'the worker was restarted: in-memory state is gone');

  await popup.reload(); // wakes the worker; the list must come from chrome.storage.session
  await popup.waitForFunction(() => document.querySelector('.card')?.innerText.includes('360p'), null, { timeout: 15000 });
  assert.equal(await popup.locator('.card').count(), 1);

  // The webRequest listener is live again: a new stream the page requests now is added next to the old one.
  await page.evaluate((u) => fetch(u).then((r) => r.text()), `${gated.origin}/master-multi.m3u8`);
  await popup.waitForFunction(() => document.querySelectorAll('.card').length === 2, null, { timeout: 15000 });
});

test('injecting the content script again (pages open at install time, rescans) leaves exactly one working instance', async () => {
  // A real extension reload can't be automated for a command-line-loaded extension, but its effect on a page is
  // the same as this: a new content script starts in a world that already holds a (possibly orphaned) older copy.
  const { page, url } = await openPage('hls.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, 'HLS');
  const tabId = await (await sw()).evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, url);
  const generation = () => (async () => (await (await sw()).evaluate(async (id) => (await chrome.scripting.executeScript({ target: { tabId: id }, world: 'ISOLATED', func: () => globalThis.__movieDownloader.generation })), tabId))[0].result)();
  assert.equal(await generation(), 1);
  for (let i = 0; i < 2; i++) {
    await (await sw()).evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: ['content.js'] }), tabId);
  }
  assert.equal(await generation(), 3, 'each injection replaced its predecessor');

  // The newest instance works: wipe the state and let it re-report what the page has requested.
  await (await sw()).evaluate(() => chrome.storage.session.clear());
  await popup.waitForSelector('.empty', { timeout: 10000 });
  await popup.locator('#rescan').click();
  await popup.waitForSelector('.card', { timeout: 10000 });
  assert.equal(await popup.locator('.card').count(), 1);
});

test('diagnostics explain what the extension saw and did, without query strings or the page title', async () => {
  const tabIdOf = async (url) => (await sw()).evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
  const diagnose = async (popup, url) => {
    const res = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'diagnostics', tabId }), await tabIdOf(url));
    assert.equal(res.ok, true);
    return res.diagnostics;
  };

  // HLS: every playlist URL carries a ?_=<timestamp> cache-buster that must not leak.
  const bust = await openPage('hls-bust.html');
  await bust.page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(bust.url, '360p');
  const d = await diagnose(popup, bust.url);
  const text = JSON.stringify(d);
  assert.ok(!text.includes('?_='), 'no query strings anywhere');
  assert.ok(!text.includes('Bust Movie'), 'the page title is left out');
  assert.equal(d.tab.origin, pageOrigin);
  assert.deepEqual(
    d.items.map((i) => [i.kind, i.url.replace(gated.origin, ''), i.hidden]).sort(),
    [['hls', '/master-multi.m3u8', false], ['hls', '/ts180/index.m3u8', true]],
  );
  assert.match(d.log.map((l) => l.message).join('\n'), /master, 2 variants/);

  // Files: rejected pieces are listed with the reason.
  const pieces = await openPage('pieces.html');
  await pieces.page.waitForFunction(() => window.__done === true);
  const popup2 = await popupWith(pieces.url, 'big-chunked.mp4');
  await new Promise((r) => setTimeout(r, 1500));
  const p = await diagnose(popup2, pieces.url);
  const log = p.log.map((l) => l.message).join('\n');
  assert.match(log, /rejected .*tiny-chunked\.mp4: only 2000 bytes/);
  assert.match(log, /rejected .*xhr-fragment\.mp4: a stream fragment/);
  assert.deepEqual(p.items.map((i) => i.url.split('/').pop()), ['big-chunked.mp4']);
  assert.ok(p.rejected.some((u) => u.endsWith('/tiny-chunked.mp4')));
});

test('ordinary web pages cannot talk to the extension, so a page cannot request diagnostics or start downloads', async () => {
  const { page } = await openPage('plain.html');
  assert.equal(await page.evaluate(() => typeof chrome?.runtime?.sendMessage), 'undefined', 'no messaging API without externally_connectable');
  const manifest = await (await sw()).evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined, 'no extension file is reachable from web pages');
});

test('navigating the tab starts a fresh list', async () => {
  const { page, url } = await openPage('direct-open.html');
  const popup = await popupWith(url, 'MP4');
  await page.goto(pageUrl('plain.html'));
  await popup.reload();
  await popup.waitForSelector('.empty', { timeout: 10000 });
});

const tabIdOf = async (url) => (await sw()).evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test("an error page served to Chrome's downloader (200, HTML) is not left behind as a video: it is removed and the built-in downloader takes over", async () => {
  const worker = await sw();
  await worker.evaluate(() => chrome.storage.session.remove('refererHosts'));
  const { url } = await openPage('direct-html.html');
  const popup = await popupWith(url, 'MP4');
  const dl = await openDownloaderFrom(popup).catch(async (e) => {
    const log = await worker.evaluate(async () => (await chrome.storage.session.get('log')).log?.slice(-8).map((l) => l.message));
    const downloads = await worker.evaluate(() => chrome.downloads.search({}).then((all) => all.map((d) => [d.state, d.mime, d.fileSize, d.error])));
    throw new Error(`${e.message}\nworker log: ${JSON.stringify(log)}\ndownloads: ${JSON.stringify(downloads)}`);
  }); // opened automatically once Chrome's download completed with the wrong content
  await dl.waitForFunction(() => document.querySelector('#notice') && !document.querySelector('#notice').hidden);
  assert.match(await dl.locator('#notice').innerText(), /received an error page instead of the video/);
  assert.ok(htmlLog.some((e) => e.path === '/source.mp4' && e.status === 200 && e.headers.referer === undefined), "Chrome's downloader was served the HTML page");
  const left = (await worker.evaluate(() => chrome.downloads.search({}))).filter((i) => i.url.includes(`:${htmlGate.port}/source.mp4`));
  assert.deepEqual(left, [], 'the error page is not left in the downloads list');

  // The built-in downloader sends the page's Referer, so it gets the real file.
  const t = track(dl, 'Video file');
  await waitReady(t);
  const saved = await saveAndWait(t);
  assert.ok((await readOpfs(dl, saved)).equals(readFileSync(join(FIXTURE_DIR, 'source.mp4'))), 'the real video was saved');
  await worker.evaluate(() => chrome.storage.session.remove('refererHosts'));
});

test('a navigation that never commits (204) leaves the list alone, and the page keeps being scanned', async () => {
  const { page, url } = await openPage('direct-open.html');
  const popup = await popupWith(url, 'MP4');
  // The navigation is cancelled and the page stays. Started from a timer so evaluate() returns at once.
  await page.evaluate((target) => void setTimeout(() => location.assign(target), 0), `${open.origin}/204`);
  await settle(1500);
  assert.equal(page.url(), url, 'the page did not navigate');
  await popup.reload();
  await popup.waitForSelector('.card', { timeout: 8000 });
  assert.equal(await popup.locator('.card').count(), 1, 'a cancelled navigation does not clear the list');

  // The content script of that page is still alive: after the list is wiped, Rescan fills it again.
  await (await sw()).evaluate((id) => chrome.storage.session.remove(`tab:${id}`), await tabIdOf(url));
  await popup.reload();
  await popup.waitForSelector('.empty', { timeout: 8000 });
  await popup.locator('#rescan').click();
  await popup.waitForSelector('.card', { timeout: 8000 });
});

test('a page restored from the back/forward cache is scanned again (its list was cleared, the page is not reloaded)', async () => {
  const { page, url } = await openPage('direct-open.html');
  const popup = await popupWith(url, 'MP4');
  await (await sw()).evaluate((id) => chrome.storage.session.remove(`tab:${id}`), await tabIdOf(url));
  await popup.reload();
  await popup.waitForSelector('.empty', { timeout: 8000 });
  // What the browser fires for a restored page; nothing else triggers a scan, so the card can only come from this.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await popup.waitForSelector('.card', { timeout: 8000 });
});

test('links are listed, but only a link on the same site as the page is ever fetched by the extension', async () => {
  const [openBefore, pageBefore] = [openLog.length, pageLog.length];
  const { url } = await openPage('links.html');
  const popup = await openPopup(url);
  await popup.waitForFunction(() => document.querySelectorAll('.card').length === 3, null, { timeout: 15000 });
  await settle(2000); // a fetch that should not happen would have happened by now
  assert.deepEqual((await popup.locator('.card .title').allInnerTexts()).sort(), ['HLS stream', 'linked-file.mp4', 'own.mp4']);
  assert.deepEqual(openLog.slice(openBefore).filter((e) => e.path.includes('linked')), [], 'the other CDN was never contacted');
  assert.ok(pageLog.slice(pageBefore).some((e) => e.path === '/own.mp4' && /^bytes=0-\d+$/.test(e.headers.range || '')), 'the same-site link was verified');
});

test('a page naming 60 videos cannot flood the list or the network: the list is capped, probing is budgeted, the stream stays', async () => {
  const before = openLog.length;
  const { page, url } = await openPage('many.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await openPopup(url);
  await popup.waitForFunction(() => document.querySelectorAll('.card').length >= 30, null, { timeout: 20000 });
  await settle(2500);
  const cards = await popup.locator('.card').allInnerTexts();
  assert.ok(cards.length <= 40, `${cards.length} cards: the per-tab cap is 40`);
  assert.ok(cards.some((c) => /HLS/.test(c)), 'the stream was not pushed out by the files');
  const probes = openLog.slice(before).filter((e) => e.path === '/source.mp4' && /^bytes=0-\d+$/.test(e.headers.range || ''));
  assert.ok(probes.length >= 1 && probes.length <= 30, `${probes.length} verification requests (budget: 30)`);
});

test('closing a tab removes its stored state', async () => {
  const worker = await sw();
  const { page, url } = await openPage('direct-open.html');
  await popupWith(url, 'MP4');
  const tabId = await tabIdOf(url);
  const stored = () => worker.evaluate((id) => chrome.storage.session.get(`tab:${id}`).then((o) => `tab:${id}` in o), tabId);
  assert.equal(await stored(), true);
  await page.close();
  for (let i = 0; i < 20 && (await stored()); i++) await settle(150);
  assert.equal(await stored(), false);
});

test("header rules made for a downloader tab are removed when it closes", async () => {
  const worker = await sw();
  const { page, url } = await openPage('hls.html');
  await page.waitForFunction(() => window.__done === true);
  const popup = await popupWith(url, '360p');
  const dl = await openDownloaderFrom(popup);
  await waitReady(track(dl, 'Video'));
  const dlTabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.includes('downloader.html'))?.id);
  const rulesFor = (id) => worker.evaluate(async (tab) => (await chrome.declarativeNetRequest.getSessionRules()).filter((r) => r.condition.tabIds?.includes(tab)).length, id);
  assert.ok((await rulesFor(dlTabId)) >= 1, 'the downloader tab has a Referer rule of its own');
  await dl.close();
  for (let i = 0; i < 20 && (await rulesFor(dlTabId)); i++) await settle(150);
  assert.equal(await rulesFor(dlTabId), 0, 'its rules were removed with it');
});

test('no uncaught errors were thrown in any extension context during the run', () => {
  assert.deepEqual(webErrors, []);
});
