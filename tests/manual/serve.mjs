// Manual audit server: serves the same pages and media the e2e suite uses, on fixed ports, so a person (or an agent
// driving a real browser) can open them with the extension loaded.
//
//   node tests/manual/serve.mjs
//   pages:        http://localhost:4173/            (index lists every page)
//   gated CDN:    http://127.0.0.1:4174  (403 unless the request carries Referer http://localhost:4173/)
//   open CDN:     http://127.0.0.1:4175
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureFixtures, serve, FIXTURE_DIR } from '../helpers/fixtures.js';
import { pieceRoutes, writePages } from '../helpers/pages.js';

ensureFixtures();
const dir = mkdtempSync(join(tmpdir(), 'md-manual-'));
mkdirSync(dir, { recursive: true });
const PAGE_PORT = 4173;
const gated = await serve(FIXTURE_DIR, { port: 4174, requireReferer: `http://localhost:${PAGE_PORT}`, verbose: 'gated' });
const open = await serve(FIXTURE_DIR, { port: 4175, extraRoutes: pieceRoutes, verbose: 'open ' });
const html = await serve(FIXTURE_DIR, {
  port: 4176,
  requireReferer: `http://localhost:${PAGE_PORT}`,
  refusal: { status: 200, headers: { 'Content-Type': 'text/html' }, body: '<!doctype html><title>Access denied</title><p>Access denied</p>' },
  verbose: 'html ',
});
writePages(dir, { G: gated.origin, O: open.origin, H: html.origin });
const pages = readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
writeFileSync(join(dir, 'index.html'), `<!doctype html><meta charset=utf-8><title>Spool test pages</title><h1>Test pages</h1><ul>${pages.map((p) => `<li><a href="${p}">${p}</a></li>`).join('')}</ul>`);
const pagesServer = await serve(dir, { port: PAGE_PORT, verbose: 'page ' });
console.log(`ready: http://localhost:${pagesServer.port}/  (gated CDN :${gated.port}, open CDN :${open.port})`);
process.on('SIGINT', () => process.exit(0));
