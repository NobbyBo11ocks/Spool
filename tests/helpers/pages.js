// Test pages and server routes shared by the automated e2e suite and the manual dev server (tests/manual/serve.mjs),
// so what a person inspects in a real browser is exactly what the tests exercise.
import { writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_DIR } from './fixtures.js';

/** Stream pieces and look-alikes that must NOT be offered as downloads, plus one legitimate file of unknown size. */
export function pieceRoutes(req, res, url, send) {
  const box = (type, total) => {
    const b = Buffer.alloc(total, 0x11);
    b.writeUInt32BE(24, 0);
    b.write(type, 4, 'latin1');
    return b;
  };
  const chunked = (body) => {
    // No Content-Length (and Range is ignored): Node uses chunked transfer encoding, so the size is unknown up front.
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*' });
    res.write(body.subarray(0, Math.floor(body.length / 2)));
    setTimeout(() => res.end(body.subarray(Math.floor(body.length / 2))), 10);
    return true;
  };
  switch (url.pathname) {
    case '/204': // a navigation that never commits: the page stays where it is
      return send(204, {}), true;
    case '/init-s1080p-v1-a1.mp4': // an fMP4 stream's init segment: ~2 KB of ftyp+moov
      return send(200, { 'Content-Type': 'video/mp4', 'Content-Length': 2048 }, box('ftyp', 2048)), true;
    case '/tiny-chunked.mp4':
      return chunked(box('ftyp', 2000));
    case '/fragment.mp4': // a media segment: starts with styp, and is big enough to pass any size check
      return send(200, { 'Content-Type': 'video/mp4', 'Content-Length': 300_000 }, box('styp', 300_000)), true;
    case '/xhr-fragment.mp4':
      return send(200, { 'Content-Type': 'video/mp4', 'Content-Length': 400_000 }, box('moof', 400_000)), true;
    case '/big-chunked.mp4': // legitimate: a complete file whose size the server doesn't announce
      return chunked(readFileSync(join(FIXTURE_DIR, 'source.mp4')));
    default:
      return false;
  }
}

/**
 * Writes the test pages into `dir`. `G` is the origin of the "gated" CDN (answers 403 without the page's Referer),
 * `O` the origin of an open CDN that also serves the stream-piece routes, `H` the origin of a CDN that answers 200 with a
 * small HTML page (instead of 403) to requests without the page's Referer.
 */
export function writePages(dir, { G, O, H = G }) {
  const page = (name, body) => writeFileSync(join(dir, name), `<!doctype html><meta charset=utf-8>${body}`);
  // A player fetches playlists with fetch()/XHR; do the same.
  const player = (urls) => `<script>(async()=>{ for (const u of ${JSON.stringify(urls)}) await fetch(u).then(r=>r.text()); window.__done=true })()</script>`;
  page('direct.html', `<title>Gated Movie</title><video muted preload=auto src="${G}/source.mp4"></video>`);
  page('direct-open.html', `<title>Open Movie</title><video muted preload=auto src="${O}/source.mp4"></video>`);
  page('hls.html', `<title>Streamed Movie</title>${player([`${G}/master.m3u8`, `${G}/ts/index.m3u8`])}`);
  page('hls-multi.html', `<title>Multi Movie</title>${player([`${G}/master-multi.m3u8`, `${G}/ts180/index.m3u8`])}`);
  // Same as hls-multi but every URL is unique per load, so no HTTP cache can answer for the extension or the page.
  page(
    'hls-bust.html',
    `<title>Bust Movie</title><script>(async()=>{ const r = Date.now(); for (const u of ['${G}/master-multi.m3u8?_=' + r, '${G}/ts180/index.m3u8?_=' + r]) await fetch(u).then(x=>x.text()); window.__done=true })()</script>`,
  );
  page('hls-audio.html', `<title>Split Movie</title>${player([`${G}/master-audio.m3u8`, `${G}/video-only/index.m3u8`, `${G}/audio-only/index.m3u8`])}`);
  page('hls-aes.html', `<title>Encrypted Movie</title>${player([`${G}/aes-seq/index.m3u8`])}`);
  page('hls-live.html', `<title>Live Movie</title>${player([`${G}/live/index.m3u8`])}`);
  page('hls-drm.html', `<title>DRM Movie</title>${player([`${G}/drm/index.m3u8`])}`);
  page('hls-hevc.html', `<title>HEVC Movie</title>${player([`${G}/hevc/index.m3u8`])}`);
  page('dash.html', `<title>Dash Movie</title>${player([`${G}/dash-tpl/index.mpd`])}`);
  page('dash-multi.html', `<title>Multi Dash</title>${player([`${G}/dash-multi/index.mpd`])}`);
  page('dash-single.html', `<title>Ranged Dash</title>${player([`${G}/dash-single/index.mpd`])}`);
  page('dash-webm.html', `<title>WebM Dash</title>${player([`${G}/dash-webm/index.mpd`])}`);
  page('dash-drm.html', `<title>Protected Dash</title>${player([`${G}/dash-tpl/drm.mpd`])}`);
  page('dash-live.html', `<title>Live Dash</title>${player([`${G}/dash-tpl/live.mpd`])}`);
  page(
    'pieces.html',
    `<title>Stream Pieces</title>
     <video muted preload=auto src="${O}/init-s1080p-v1-a1.mp4"></video>
     <video muted preload=auto src="${O}/tiny-chunked.mp4"></video>
     <video muted preload=auto src="${O}/big-chunked.mp4"></video>
     <script>
       // An MSE player fetches media segments with fetch()/XHR, never through <video src>.
       Promise.all(['fragment.mp4', 'xhr-fragment.mp4'].map((n) => fetch('${O}/' + n).then((r) => r.arrayBuffer()))).then(() => { window.__done = true; });
     </script>`,
  );
  page('direct-html.html', `<title>Html Movie</title><video muted preload=auto src="${H}/source.mp4"></video>`);
  // Links only name URLs. The two on the other CDN must be listed but never fetched by the extension; the one on the
  // page's own site may be verified.
  copyFileSync(join(FIXTURE_DIR, 'source.mp4'), join(dir, 'own.mp4'));
  page('links.html', `<title>Links</title><a href="${O}/linked-file.mp4">file</a> <a href="${O}/linked/stream.m3u8">stream</a> <a href="own.mp4">own</a>`);
  // A page naming far more videos than the list holds, after it has loaded a stream that must survive the flood.
  const many = Array.from({ length: 60 }, (_, i) => `<source src="${O}/source.mp4?id=${i + 1}">`).join('');
  page('many.html', `<title>Many Movies</title><video muted preload=none>${many}</video>${player([`${G}/master.m3u8`, `${G}/ts/index.m3u8`])}`);
  page('blob.html', `<title>Blob Movie</title><video id=v></video><script>v.src = URL.createObjectURL(new Blob([new Uint8Array(10)], {type:'video/mp4'}));</script>`);
  page('drm.html', `<title>EME Movie</title><video id=v></video><script>setTimeout(()=>v.dispatchEvent(new Event('encrypted')), 300)</script>`);
  page('plain.html', `<title>Plain</title><p>nothing here</p>`);
  // The file name shown in the popup comes from the page-controlled URL path.
  page('xss.html', `<title>t</title><video src="${G}/%3Cimg%20src%3Dx%20onerror%3Dwindow.__xss%3D1%3E.mp4"></video>`);
}
