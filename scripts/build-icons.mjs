// Renders the SVG masters in docs/brand/ to the PNG icons Chrome needs (extension/icons/) with headless Chromium, so the
// artwork stays reproducible and crisp at every size.
//
//   npm run icons
//
// docs/brand/icon.svg is used for 32 px and up; docs/brand/icon-16.svg is a separate optical size for 16 px;
// docs/brand/social.svg becomes the 1280x640 social preview image.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (name) => readFileSync(`${root}docs/brand/${name}`, 'utf8');
const masters = { large: read('icon.svg'), small: read('icon-16.svg'), social: read('social.svg') };

const targets = [
  { size: 16, svg: masters.small, file: 'extension/icons/icon16.png' },
  { size: 32, svg: masters.large, file: 'extension/icons/icon32.png' },
  { size: 48, svg: masters.large, file: 'extension/icons/icon48.png' },
  { size: 128, svg: masters.large, file: 'extension/icons/icon128.png' },
  { size: 512, svg: masters.large, file: 'docs/brand/icon-512.png' },
  { width: 1280, height: 640, svg: masters.social, file: 'docs/brand/social.png' }, // GitHub social preview (upload it in the repo settings)
];

mkdirSync(`${root}extension/icons`, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_FOR_TESTING || undefined, headless: true });
for (const { size, width = size, height = size, svg, file } of targets) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${width}px;height:${height}px}</style>${svg}`);
  await page.screenshot({ path: `${root}${file}`, omitBackground: true, clip: { x: 0, y: 0, width, height } });
  await page.close();
  console.log(`wrote ${file} (${width}x${height})`);
}
await browser.close();
