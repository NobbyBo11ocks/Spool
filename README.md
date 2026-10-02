<p align="center">
  <img src="docs/brand/icon-512.png" alt="Spool" width="112" height="112">
</p>

<h1 align="center">Spool</h1>

<p align="center">
  Save the video you're watching. Direct files, HLS and DASH streams, converted to a single MP4.<br>
  Runs entirely in your browser. No account, no server, no tracking, no DRM bypass.
</p>

<p align="center">
  <a href="https://github.com/NobbyBo11ocks/Spool/actions/workflows/ci.yml"><img src="https://github.com/NobbyBo11ocks/Spool/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

<p align="center">
  <img src="docs/images/popup-light.png#gh-light-mode-only" alt="Spool popup listing a video file, an HLS stream and a DASH stream" width="300">
  <img src="docs/images/popup-dark.png#gh-dark-mode-only" alt="Spool popup listing a video file, an HLS stream and a DASH stream" width="300">
</p>

Spool is a Chrome extension (Manifest V3). It notices the media a page loads, lists it in a small popup, and saves it:
plain files through Chrome's download manager, streams through a built-in downloader that fetches the segments, joins them
and streams the result to a file you choose.

> **Only save video you have the right to save**: your own files, public-domain or Creative Commons video, lectures,
> content a site explicitly lets you download. Many sites forbid downloading in their terms, and you are responsible for
> what you save. Spool does not circumvent DRM and never will (see [What it will not do](#what-it-will-not-do)).

## Features

- **Direct files**: MP4, WebM, MOV, MKV, MP3, M4A and more, saved under the page's title.
- **HLS** (`.m3u8`): quality picker, AES-128 decryption, MPEG-TS converted to MP4 in the browser, fragmented MP4, a separate
  audio rendition saved as its own file.
- **DASH** (`.mpd`): quality and audio-language pickers; video and audio are merged into **one MP4** (SegmentTemplate,
  SegmentTimeline, SegmentList, byte ranges).
- **Works with hotlink protection.** Many CDNs only answer requests that carry the embedding page's `Referer`. The
  built-in downloader sends it, and a file Chrome's own downloader gets refused is retried there automatically.
- **Bounded memory.** Segments are fetched in parallel but written in order straight to disk, so a 4 GB stream does not
  need 4 GB of RAM. Stalls, timeouts and bad segments (a login page where a segment should be) are detected and reported.
- **Quiet list.** Init segments, numbered fragments, tracking-size files and HTML error pages are filtered out so the real
  video isn't buried.
- **Compact UI** with light and dark themes. Everything from the page is rendered as text, never as HTML.

## Install

Spool is not on the Chrome Web Store yet; load it unpacked:

1. Download or clone this repository (or take `spool-<version>.zip` from a release and unzip it).
2. Open `chrome://extensions` and switch on **Developer mode**.
3. Click **Load unpacked** and choose the **`extension`** folder (the one that contains `manifest.json`).
4. Pin Spool from the puzzle-piece menu so its badge is visible.

Requires Chrome 116 or newer (or another Chromium browser with Manifest V3 support).

Pages that were open before you installed Spool keep working, but Spool can only see requests made after installation
(plus what the page's resource-timing buffer remembers): reload the page and press play. After you change the files,
click the reload arrow on Spool's card at `chrome://extensions`.

## Use

1. Open a page and press play. The toolbar icon shows how many videos were found.
2. Open the popup. Each row has **Download**, **Copy link** and, for plain files, **Built-in downloader**.
   - *File*: saved by Chrome into your Downloads folder.
   - *HLS / DASH*: a downloader tab opens. Choose quality (and audio), choose the format, press **Download**, pick where to
     save. Keep that tab open until it says *Saved*.
3. Nothing found? Press play first, then the refresh button in the popup. The clipboard button copies diagnostics (see
   [Troubleshooting](#troubleshooting)).

<p align="center">
  <img src="docs/images/downloader-light.png#gh-light-mode-only" alt="The built-in downloader saving an HLS stream: quality, format, progress" width="520">
  <img src="docs/images/downloader-dark.png#gh-dark-mode-only" alt="The built-in downloader saving an HLS stream: quality, format, progress" width="520">
</p>

## What it supports

| Source | Status |
| --- | --- |
| Direct `video/*` and `audio/*` files | Supported. Chrome's download manager, with the built-in downloader as fallback |
| HLS, MPEG-TS (H.264 + AAC) | Supported, converted to `.mp4` (or saved as the original `.ts`) |
| HLS, MPEG-TS with HEVC, AC-3, E-AC-3, MP3 | Supported as the original `.ts` only (the converter can't handle these codecs) |
| HLS, fragmented MP4 (`EXT-X-MAP`, `.m4s`) | Supported, saved as `.mp4` / `.m4a` |
| HLS with AES-128 (key at a plain URL, implicit IV too) | Supported |
| HLS with a separate audio playlist | Supported, as a second file (not merged) |
| DASH, ISO BMFF (MP4) segments | Supported, video + audio merged into one `.mp4` |
| DASH, WebM | Supported, saved as `.webm` (audio as a separate file: WebM can't be merged) |
| DASH, a whole progressive file per stream (no segment index) | Supported, saved as is; video and audio stay separate files |
| DASH with several periods | The longest period is saved (ads and bumpers are short), with a notice |
| Live HLS / DASH | Saves the segments listed at that moment, with a warning |
| DRM: Widevine, PlayReady, FairPlay, SAMPLE-AES, any `ContentProtection` that needs a licence | **Refused**, with the system named |
| YouTube and other adaptive byte-range services | Not supported |

### What it will not do

Spool saves a stream exactly as the server hands it out. It does not decrypt DRM-protected media, extract keys, spoof a
device, or work around sites that obfuscate or protect their media. A stream that is protected is shown as
*DRM-protected* and is not downloadable. A stream that offers a clear rendition next to a protected one is not mistaken
for DRM: the clear one is offered, and the protected ones are counted as hidden.

## Privacy and permissions

Nothing leaves your browser except requests to the media hosts themselves. There is no analytics, no remote code and no
account. Spool keeps its working state in `chrome.storage.session`, which Chrome clears when the browser closes.

| Permission | Why |
| --- | --- |
| `webRequest` | Watch (not block or change) responses to recognise media by content type and size |
| `webNavigation` | Start a fresh list when the page you're on navigates |
| `downloads` | Hand plain files to Chrome's download manager |
| `storage` | Keep the per-tab list while Chrome suspends the extension's service worker |
| `scripting` | Inject the small page script into tabs that were already open at install time |
| `declarativeNetRequestWithHostAccess` | Add the page's `Referer`/`Origin` to Spool's *own* requests for a media file |
| Host access to `http://*/*` and `https://*/*` | Media can be on any site or CDN |

Requests Spool makes on its own are restrained: cookies are sent only to the page's own site, never to a third-party host
a page merely links to; a URL that a page only *names* (a link, a meta tag) on another site is listed but never fetched
until you choose to download it; and playlist and file checks are capped and queued so a hostile page can't turn the
extension into a request cannon.

## Troubleshooting

- **Nothing is listed.** Press play, then refresh in the popup. If the page was open before installing, reload it.
  A `blob:` video needs the underlying stream to be requested: press play or reload.
- **"DRM-protected".** The stream needs a licence to play and cannot be downloaded.
- **A file was refused by the server.** Spool falls back to the built-in downloader, which sends the page's `Referer` and
  cookies, and remembers the host for the rest of the session.
- **Copy diagnostics.** The clipboard button in the popup copies what Spool saw on the current tab (detected items,
  rejected URLs with the reason, recent events) as JSON. Query strings, fragments and the page title are left out because
  they often carry session tokens. Attach it to a bug report.

## How it works

- `background.js` (service worker) classifies network responses ([`lib/detect.js`](extension/lib/detect.js)), keeps a
  per-tab list in `chrome.storage.session`, reads playlists and manifests to label them, and starts downloads.
- `content.js` adds `<video src>`, links and requests the page made before Spool loaded (Resource Timing), and notices
  encrypted-media (EME) playback.
- `popup.*` lists what was found. `downloader.*` is the built-in downloader.
- Engines, all free of browser APIs so they run in Node tests: [`lib/hls.js`](extension/lib/hls.js) (RFC 8216 parser),
  [`lib/dash.js`](extension/lib/dash.js) (ISO 23009-1), [`lib/hls-download.js`](extension/lib/hls-download.js) and
  [`lib/dash-download.js`](extension/lib/dash-download.js) (ordered parallel fetch, AES-128, TS to MP4 with
  [mux.js](https://github.com/videojs/mux.js), fMP4 merging).
- **Chrome's own download manager cannot send a `Referer`** (measured in Chrome 154: its requests bypass
  `declarativeNetRequest` and `webRequest`, and `downloads.download({headers})` rejects `Referer`). So when a server refuses
  it, or answers it with an error page, that download is removed and the file goes through the built-in downloader instead.

## Development

```
npm install
npm test            # ESLint, then the unit and integration tests (real ffmpeg-generated HLS and DASH, decoded with ffmpeg)
npm run lint
npm run pack        # dist/spool-<version>.zip, the extension folder only
npm run icons       # re-render the PNG icons from docs/brand/*.svg
```

The end-to-end suite loads the unpacked extension into a real browser and drives it against local pages and a "gated" CDN
that refuses requests without the page's `Referer`. Branded Chrome 137+ ignores `--load-extension`, so use Chrome for
Testing:

```
npx @puppeteer/browsers install chrome@stable --path .chrome
set CHROME_FOR_TESTING=C:\path\to\.chrome\chrome\win64-<version>\chrome-win64\chrome.exe
npm run test:e2e
```

Without `CHROME_FOR_TESTING`, Playwright's bundled Chromium is used (`npx playwright install chromium`). CI runs both
suites on every push. The tests use the ffmpeg bundled by `ffmpeg-static`; set `FFMPEG_PATH` to use a system build instead
(CI does: the bundled static binary was observed to crash on GitHub's Linux runners when decoding MPEG-TS).

To try the extension by hand against the same pages and CDNs the tests use:

```
node tests/manual/serve.mjs    # pages :4173, gated CDN :4174, open CDN :4175, HTML-refusing CDN :4176
```

It prints one line per request (path, status, `Range`, `Referer`, `Origin`, `Sec-Fetch-*`), which shows exactly which
requests came from the page and which from the extension.

Layout: `extension/` (what you load), `extension/lib/` (pure modules, unit-tested), `extension/lib/vendor/` (mux.js,
Apache-2.0), `tests/` (unit tests, ffmpeg fixtures, e2e), `scripts/` (icons, screenshots, packaging), `docs/`.

## License

[MIT](LICENSE). Bundled mux.js is Apache-2.0 ([`MUX-LICENSE.txt`](extension/lib/vendor/MUX-LICENSE.txt)).
