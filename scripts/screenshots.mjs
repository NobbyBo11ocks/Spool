// Captures the real extension UI (popup + downloader, light and dark) for the README, using the same fixtures as the tests.
// Friendly host names come from Chrome's --host-resolver-rules, so the screenshots read like a real CDN, not 127.0.0.1.
//
//   CHROME_FOR_TESTING=<path to chrome.exe> npm run screenshots
//
// Writes docs/images/popup-{light,dark}.png and downloader-{light,dark}.png (2x pixel density).
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFixtures, serve, FIXTURE_DIR } from '../tests/helpers/fixtures.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.env.SCREENSHOT_DIR || `${root}docs/images`;
const EXT = `${root}extension`;
const HOST = 'cdn.streamhost.example';
mkdirSync(OUT, { recursive: true });
ensureFixtures();

const work = mkdtempSync(join(tmpdir(), 'spool-shots-'));
const pagesDir = join(work, 'pages');
mkdirSync(pagesDir);
const pageServer = await serve(pagesDir);
const pageOrigin = `http://localhost:${pageServer.port}`;
const hls = await serve(FIXTURE_DIR, { requireReferer: pageOrigin });
const files = await serve(FIXTURE_DIR);
const H = `http://${HOST}:${hls.port}`;
const F = `http://${HOST}:${files.port}`;

const player = (urls) => `(async()=>{ for (const u of ${JSON.stringify(urls)}) await fetch(u).then(r=>r.text()); window.__done=true })()`;
writeFileSync(
  join(pagesDir, 'demo.html'),
  `<!doctype html><meta charset=utf-8><title>Big Buck Bunny</title>
   <video muted preload=auto src="${F}/source.mp4"></video>
   <script>${player([`${H}/master-hd.m3u8`, `${H}/ts/index.m3u8`, `${H}/dash-multi/index.mpd`])}</script>`,
);

const ctx = await chromium.launchPersistentContext(join(work, 'profile'), {
  ...(process.env.CHROME_FOR_TESTING ? { executablePath: process.env.CHROME_FOR_TESTING } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 900, height: 900 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--host-resolver-rules=MAP ${HOST} 127.0.0.1`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
await new Promise((r) => setTimeout(r, 2500)); // let the worker finish registering its listeners

// Stand-in for the native save dialog; writes slowly so a download can be captured mid-way.
const slowPicker = () => {
  window.showSaveFilePicker = async (opts) => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(opts.suggestedName, { create: true });
    const create = handle.createWritable.bind(handle);
    handle.createWritable = async () => {
      const writable = await create();
      const write = writable.write.bind(writable);
      writable.write = async (chunk) => { await new Promise((r) => setTimeout(r, 650)); return write(chunk); };
      return writable;
    };
    return handle;
  };
};

for (const scheme of ['light', 'dark']) {
  const url = `${pageOrigin}/demo.html?${scheme}`;
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.__done === true);
  await new Promise((r) => setTimeout(r, 1500));
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);

  const popup = await ctx.newPage();
  await popup.emulateMedia({ colorScheme: scheme });
  await popup.setViewportSize({ width: 360, height: 700 });
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
  await popup.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.card')];
    return cards.length >= 3 && cards.some((c) => c.textContent.includes('qualities'));
  });
  await new Promise((r) => setTimeout(r, 400));
  await popup.locator('body').screenshot({ path: `${OUT}/popup-${scheme}.png` });

  const [dl] = await Promise.all([
    ctx.waitForEvent('page', { predicate: (p) => p.url().includes('downloader.html') }),
    popup.locator('.card', { has: popup.locator('.chip', { hasText: /^HLS$/ }) }).locator('button.primary').click(),
  ]);
  await dl.emulateMedia({ colorScheme: scheme });
  await dl.setViewportSize({ width: 552, height: 420 });
  await dl.waitForLoadState();
  await dl.evaluate(slowPicker);
  await dl.locator('button.primary:enabled').first().waitFor();
  await dl.locator('section.track:not([hidden]) button.primary').first().click();
  await dl.locator('.track-status', { hasText: /segments/ }).waitFor();
  await new Promise((r) => setTimeout(r, 1700));
  await dl.locator('main').screenshot({ path: `${OUT}/downloader-${scheme}.png` });
  await dl.close();
  await popup.close();
  await page.close();
}

await ctx.close();
await Promise.all([pageServer.close(), hls.close(), files.close()]);
console.log(`wrote popup/downloader screenshots to ${OUT}`);
