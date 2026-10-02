// Built-in downloader page: picks quality/format, then streams the result to a file the user chooses
// (File System Access API), so memory stays bounded however large the video is.

import {
  parsePlaylist, inspectEncryption, detectContainer, sortVariants, variantLabel, externalAudioFor, codecsRemuxable, hasVideo,
} from './lib/hls.js';
import {
  createFetcher, createSegmentLoader, downloadMedia, downloadFile, probeRemux, HttpError,
} from './lib/hls-download.js';
import {
  parseMpd, videoRepresentations, audioRepresentations, representationLabel, representationExtension,
} from './lib/dash.js';
import { downloadDash, canMerge, planFor } from './lib/dash-download.js';
import { ensureExtensionHeaders } from './lib/headers.js';
import { sanitizeFilename, formatBytes, formatDuration, originOf, filenameFromUrl, hostOf, sameSite } from './lib/util.js';
import { el } from './lib/dom.js';

const $ = (id) => document.getElementById(id);
const mux = globalThis.muxjs ?? null;

// ---- helpers --------------------------------------------------------------------------------------------------

function explain(e) {
  if (e instanceof HttpError) {
    if (e.status === 403 || e.status === 401) {
      return `The server refused the request (HTTP ${e.status}). The link may have expired or the stream may be protected. Reload the original page, play the video again, and retry.`;
    }
    if (e.status === 404 || e.status === 410) return `The file is gone (HTTP ${e.status}). Reload the original page and try again.`;
    return `The server answered HTTP ${e.status}.`;
  }
  if (e?.name === 'TypeError') return 'Network error while contacting the server.';
  return e?.message || String(e);
}

function formatRate(bytesPerSecond) {
  return Number.isFinite(bytesPerSecond) && bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : '';
}

let running = 0;
window.addEventListener('beforeunload', (e) => {
  if (running > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---- one downloadable thing (video, audio, or a plain file) ---------------------------------------------------

class Track {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind; // 'video' | 'audio' | 'file'
    this.media = null;
    this.loader = null;
    this.outputs = [];
    this.controller = null;
    this.onChoose = null;
    this.seq = 0; // bumped on every (re)selection so a slow, stale preparation can't overwrite a newer one

    this.job = null; // DASH: what to download ({video, audio, merge}); HLS and files use media/loader instead
    this.qualitySelect = el('select');
    this.audioSelect = el('select'); // DASH: the audio track to merge into the video
    this.formatSelect = el('select');
    this.qualityLabel = el('label', { hidden: true }, kind === 'audio' ? 'Track' : 'Quality', this.qualitySelect);
    this.audioLabel = el('label', { hidden: true }, 'Audio', this.audioSelect);
    this.formatLabel = el('label', {}, 'Save as', this.formatSelect);
    this.button = el('button', { class: 'btn primary', type: 'button', disabled: true }, 'Download');
    this.cancel = el('button', { class: 'btn', type: 'button', hidden: true }, 'Cancel');
    this.bar = el('progress', { max: 1, value: 0, hidden: true });
    this.statusEl = el('div', { class: 'track-status', role: 'status' });
    this.root = el(
      'section',
      { class: 'track' },
      el('div', { class: 'track-head' }, el('h2', {}, label), el('div', { class: 'buttons' }, this.button, this.cancel)),
      el('div', { class: 'fields' }, this.qualityLabel, this.audioLabel, this.formatLabel),
      this.bar,
      this.statusEl,
    );
    this.cancel.addEventListener('click', () => this.controller?.abort());
    this.qualitySelect.addEventListener('change', () => this.onChoose?.());
    this.audioSelect.addEventListener('change', () => this.onChoose?.());
  }

  status(text, cls = '') {
    this.statusEl.textContent = text;
    this.statusEl.className = `track-status ${cls}`.trim();
  }

  setOutputs(outputs) {
    this.outputs = outputs;
    this.formatSelect.replaceChildren(...outputs.map((o, i) => el('option', { value: String(i) }, o.label)));
    this.formatSelect.disabled = outputs.length < 2;
  }

  get output() {
    return this.outputs[this.formatSelect.selectedIndex] ?? this.outputs[0];
  }

  /** Starts a (re)selection: blocks Download until the new choice is ready. Returns a token for isCurrent(). */
  beginPrepare() {
    this.button.disabled = true;
    this.media = null;
    this.loader = null;
    return ++this.seq;
  }

  isCurrent(token) {
    return token === this.seq;
  }

  setBusy(busy) {
    this.qualitySelect.disabled = busy;
    this.audioSelect.disabled = busy;
    this.formatSelect.disabled = busy || this.outputs.length < 2;
    this.button.disabled = busy;
    this.cancel.hidden = !busy;
    this.bar.hidden = !busy;
  }
}

// ---- file sinks -----------------------------------------------------------------------------------------------

/**
 * Must be called synchronously from a click handler: showSaveFilePicker needs the click's transient user activation.
 * Falls back to buffering in memory + chrome.downloads where the File System Access API is missing.
 */
async function openSink(name, output) {
  if (typeof window.showSaveFilePicker === 'function') {
    const handle = await window.showSaveFilePicker({
      suggestedName: name,
      id: 'spool',
      startIn: 'downloads',
      types: [{ description: output.label, accept: { [output.mime]: [output.ext] } }],
    });
    const writable = await handle.createWritable();
    return {
      name: handle.name,
      write: (chunk) => writable.write(chunk),
      close: () => writable.close(),
      abort: () => writable.abort(),
    };
  }
  const parts = [];
  return {
    name,
    write: async (chunk) => void parts.push(chunk),
    close: async () => {
      const url = URL.createObjectURL(new Blob(parts, { type: output.mime }));
      await chrome.downloads.download({ url, filename: name, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    },
    abort: async () => void (parts.length = 0),
  };
}

// ---- main -----------------------------------------------------------------------------------------------------

async function main() {
  const jobId = new URLSearchParams(location.search).get('job');
  const key = `job:${jobId}`;
  const job = (await chrome.storage.session.get(key))[key];
  if (!job) {
    $('title').textContent = 'This download has expired';
    $('status').textContent = 'Go back to the page with the video, open the extension, and start the download again.';
    return;
  }

  const { item, title, pageUrl, note } = job;
  const urlName = filenameFromUrl(item.url).replace(/\.[a-z0-9]{2,5}$/i, '');
  const base = sanitizeFilename((title || '').trim() || urlName || 'video');
  document.title = `${base} – Spool`;
  $('title').textContent = base;
  $('source').textContent = hostOf(pageUrl || item.url);
  const remarks = new Map(); // track -> notes shown in the banner next to the job's own note
  const showNotices = () => {
    const text = [note, ...[...remarks.values()].flat()].filter(Boolean).join(' ');
    $('notice').textContent = text;
    $('notice').hidden = !text;
  };
  showNotices();

  const pageOrigin = item.initiator || originOf(pageUrl) || originOf(item.url);
  // Cookies go only to hosts related to the video's own site or the page it was found on. A playlist can list any URL, and
  // an unrelated one gets the request without the user's credentials.
  const credentialsFor = (url) => (sameSite(url, item.url) || sameSite(url, pageOrigin) ? 'include' : 'omit');
  const fetcher = createFetcher({ credentials: credentialsFor });
  const tabId = (await chrome.tabs.getCurrent())?.id ?? null; // header rules are scoped to this tab and removed when it closes
  const hostRules = new Map();
  const allowHost = (url) => {
    const host = new URL(url).hostname;
    if (!hostRules.has(host)) hostRules.set(host, ensureExtensionHeaders(url, pageOrigin, { tabId }).catch(() => {}));
    return hostRules.get(host);
  };
  const fetchBytes = async (url, opts) => {
    await allowHost(url);
    return fetcher(url, opts);
  };
  const loadPlaylist = async (url) => {
    const meta = {};
    const bytes = await fetchBytes(url, { meta });
    return parsePlaylist(new TextDecoder().decode(bytes), meta.url || url);
  };

  const tracksEl = $('tracks');

  /** Wires a track's Download button. `prepare()` must have set outputs and (for HLS) track.media. */
  function wireDownload(track, fileBase) {
    track.button.addEventListener('click', () => run(track, fileBase));
  }

  async function run(track, fileBase) {
    const output = track.output;
    const name = `${fileBase(track)}${output.ext}`;
    let sink;
    try {
      sink = await openSink(name, output); // first await: keeps the click's user activation
    } catch (e) {
      track.status(e?.name === 'AbortError' ? 'Cancelled: nothing was saved.' : `Could not create the file: ${e.message}`, e?.name === 'AbortError' ? '' : 'error');
      return;
    }

    const controller = new AbortController();
    track.controller = controller;
    track.setBusy(true);
    track.bar.removeAttribute('value');
    running++;
    const started = performance.now();
    const byteProgress = ({ received, total }) => {
      if (total) track.bar.value = received / total;
      const rate = formatRate((received / (performance.now() - started)) * 1000);
      track.status(`${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : ''}${rate ? ` · ${rate}` : ''}`);
    };
    const segmentProgress = ({ done, total, bytes }) => {
      track.bar.value = done / total;
      const elapsed = (performance.now() - started) / 1000;
      const eta = done > 0 ? formatDuration((elapsed / done) * (total - done)) : '';
      const rate = formatRate(bytes / elapsed);
      track.status([`${done} / ${total} segments`, formatBytes(bytes), rate, eta && `${eta} left`].filter(Boolean).join(' · '));
    };
    try {
      if (track.job) {
        await downloadDash({
          ...track.job,
          sink,
          fetchBytes,
          // downloadFile() (single-file representations) uses fetch directly, so install the Referer/Origin rule first.
          fetchImpl: async (url, init) => {
            await allowHost(url);
            return fetch(url, { ...init, credentials: credentialsFor(url) });
          },
          signal: controller.signal,
          onProgress: (p) => ('received' in p ? byteProgress(p) : segmentProgress(p)),
        });
      } else if (track.kind === 'file') {
        await allowHost(item.url); // downloadFile() uses fetch directly, so install the Referer/Origin rule first
        await downloadFile(item.url, { sink, signal: controller.signal, onProgress: byteProgress, credentials: credentialsFor(item.url) });
      } else {
        const loader = track.loader ?? createSegmentLoader(track.media, { fetchBytes, signal: controller.signal });
        loader.setSignal(controller.signal);
        track.loader = null;
        await downloadMedia(track.media, {
          sink,
          loader,
          signal: controller.signal,
          mux,
          remux: output.remux,
          onProgress: segmentProgress,
        });
      }
      await sink.close();
      track.status(`Saved ${sink.name}`, 'ok');
    } catch (e) {
      await sink.abort().catch(() => {});
      if (controller.signal.aborted || e?.name === 'AbortError') track.status('Cancelled: nothing was saved.');
      else track.status(`Failed: ${explain(e)}`, 'error');
    } finally {
      running--;
      track.controller = null;
      track.bar.hidden = true;
      track.setBusy(false);
    }
  }

  // ---- plain file ---------------------------------------------------------------------------------------------
  if (item.kind === 'file') {
    const track = new Track(item.media === 'audio' ? 'Audio file' : 'Video file', 'file');
    const ext = item.ext || (item.media === 'audio' ? '.mp3' : '.mp4');
    track.setOutputs([{ id: 'original', label: `Original file (${ext.slice(1).toUpperCase()})`, ext, mime: item.mime || (item.media === 'audio' ? 'audio/mpeg' : 'video/mp4'), remux: false }]);
    track.status(item.size ? formatBytes(item.size) : 'Ready');
    track.button.disabled = false;
    wireDownload(track, () => base);
    tracksEl.append(track.root);
    showNotices();
    return;
  }

  // ---- DASH ---------------------------------------------------------------------------------------------------
  /**
   * One main panel: the video (quality + audio track to merge in, one MP4 out). When the streams can't be merged (WebM,
   * non-fragmented MP4) the audio gets its own panel and is saved as a separate file. Audio-only manifests get one panel.
   */
  async function setupDash() {
    const meta = {};
    const manifest = await fetchBytes(item.url, { meta });
    const mpd = parseMpd(new TextDecoder().decode(manifest), meta.url || item.url);
    if (mpd.protected) throw new Error(`This stream is DRM-protected (${mpd.drmSystems.join(', ') || 'DRM'}) and cannot be downloaded.`);
    const videos = videoRepresentations(mpd);
    const audios = audioRepresentations(mpd);
    if (!videos.length && !audios.length) throw new Error('The manifest lists no downloadable video or audio.');

    const notes = [];
    if (mpd.hiddenProtected) notes.push(`${mpd.hiddenProtected} DRM-protected rendition${mpd.hiddenProtected > 1 ? 's are' : ' is'} not listed: DRM can't be downloaded.`);
    if (mpd.type === 'dynamic') notes.push('This is a live stream: only the segments listed right now will be saved.');
    if (mpd.periods.length > 1) notes.push(`The stream has ${mpd.periods.length} periods; the longest one is saved.`);

    const options = (reps) => reps.map((r, i) => el('option', { value: String(i) }, representationLabel(r)));
    const summary = (rep) => {
      const plan = planFor(rep, mpd.type);
      if (plan.single) return 'single file';
      return [`${plan.segments.length} segments`, formatDuration(plan.segments.reduce((sum, s) => sum + s.duration, 0))].filter(Boolean).join(' · ');
    };
    const outputFor = (rep, withAudio = false) => {
      const audioOnly = rep.type === 'audio';
      const ext = withAudio ? '.mp4' : representationExtension(rep);
      const mime = withAudio ? 'video/mp4' : rep.container === 'webm' ? (audioOnly ? 'audio/webm' : 'video/webm') : rep.container === 'ts' ? 'video/mp2t' : audioOnly ? 'audio/mp4' : 'video/mp4';
      const label = withAudio ? 'MP4 (video + audio)' : audioOnly ? ext.slice(1).toUpperCase() : `${ext.slice(1).toUpperCase()}${audios.length ? ' (video only)' : ''}`;
      return { id: ext.slice(1), label, ext, mime, remux: false };
    };
    const fail = (track, e) => {
      track.job = null;
      track.button.disabled = true;
      track.status(`Could not read this stream: ${explain(e)}`, 'error');
    };

    const mainIsAudio = videos.length === 0;
    const main = new Track(mainIsAudio ? 'Audio' : 'Video', mainIsAudio ? 'audio' : 'video');
    const side = new Track('Audio (separate stream)', 'audio');
    side.root.hidden = true;
    tracksEl.append(main.root);
    if (!mainIsAudio) tracksEl.append(side.root);

    const currentVideo = () => videos[Number(main.qualitySelect.value)];
    // Multi-language streams list languages in the packager's order: start with the browser's language when there is one.
    let firstRender = true;
    const browserLanguage = (navigator.language || '').slice(0, 2).toLowerCase();
    wireDownload(main, () => (mainIsAudio ? `${base} (audio)` : `${base}${currentVideo().height ? ` ${currentVideo().height}p` : ''}`));
    wireDownload(side, () => `${base} (audio)`);

    function updateMain() {
      const mainNotes = [...notes];
      try {
        if (mainIsAudio) {
          const rep = audios[Number(main.qualitySelect.value)];
          main.job = { mpdType: mpd.type, audio: rep, merge: false };
          main.setOutputs([outputFor(rep)]);
          main.status(summary(rep));
        } else {
          const video = currentVideo();
          const mergeable = audios.filter((a) => canMerge(video, a, mpd.type));
          const kept = main.audioSelect.selectedIndex;
          main.audioSelect.replaceChildren(...options(mergeable), el('option', { value: String(mergeable.length) }, 'None (video only)'));
          const preferred = firstRender && browserLanguage ? mergeable.findIndex((a) => a.lang.toLowerCase().startsWith(browserLanguage)) : -1;
          main.audioSelect.selectedIndex = preferred >= 0 ? preferred : Math.max(0, Math.min(kept, mergeable.length));
          firstRender = false;
          const audioRep = mergeable[Number(main.audioSelect.value)] ?? null;
          main.audioLabel.hidden = mergeable.length === 0;
          side.root.hidden = !(audios.length && !mergeable.length);
          if (audios.length && !mergeable.length) mainNotes.push("The video and audio use formats that can't be merged here, so the audio is saved as a separate file.");
          main.job = { mpdType: mpd.type, video, audio: audioRep, merge: Boolean(audioRep) };
          main.setOutputs([outputFor(video, Boolean(audioRep))]);
          main.status(summary(video));
        }
        main.button.disabled = false;
      } catch (e) {
        fail(main, e);
      }
      remarks.set(main, mainNotes);
      showNotices();
    }

    function updateSide() {
      try {
        const rep = audios[Number(side.qualitySelect.value)];
        side.job = { mpdType: mpd.type, audio: rep, merge: false };
        side.setOutputs([outputFor(rep)]);
        side.status(summary(rep));
        side.button.disabled = false;
      } catch (e) {
        fail(side, e);
      }
    }

    main.qualityLabel.hidden = false;
    main.qualitySelect.replaceChildren(...options(mainIsAudio ? audios : videos));
    main.onChoose = updateMain;
    if (!mainIsAudio && audios.length) {
      side.qualityLabel.hidden = false;
      side.qualitySelect.replaceChildren(...options(audios));
      side.onChoose = updateSide;
      updateSide();
    }
    updateMain();
  }

  if (item.kind === 'dash') {
    await setupDash();
    return;
  }

  // ---- HLS ----------------------------------------------------------------------------------------------------
  const parsed = await loadPlaylist(item.url);

  /** Reads one media playlist into `track` and works out which output formats are possible. */
  async function prepare(track, media, hints, token) {
    remarks.delete(track);
    const enc = inspectEncryption(media);
    if (!enc.supported) {
      track.setOutputs([]);
      track.status(enc.reason, 'error');
      showNotices();
      return;
    }
    if (!media.segments.length) {
      track.setOutputs([]);
      track.status('This playlist has no segments.', 'error');
      showNotices();
      return;
    }
    const container = detectContainer(media);
    const audioOnly = track.kind === 'audio' || hints.audioOnly;
    const outputs = [];
    const notes = [];
    if (container === 'ts') {
      const ts = { id: 'ts', label: 'TS (original, no conversion)', ext: '.ts', mime: 'video/mp2t', remux: false };
      let remux = { ok: false, reason: 'MP4 conversion is unavailable.' };
      if (mux && codecsRemuxable(hints.codecs)) {
        track.status('Checking the stream format…');
        const loader = createSegmentLoader(media, { fetchBytes, signal: AbortSignal.timeout(60_000) }); // a silent server must not leave the page stuck on 'Checking'
        remux = await probeRemux(loader, mux).catch((e) => ({ ok: false, reason: explain(e) }));
        if (!track.isCurrent(token)) return;
        if (remux.ok) track.loader = loader;
      } else if (mux) {
        remux = { ok: false, reason: `Codecs ${hints.codecs} can't be converted to MP4.` };
      }
      if (remux.ok) {
        outputs.push({ id: 'mp4', label: audioOnly ? 'M4A (converted)' : 'MP4 (converted)', ext: audioOnly ? '.m4a' : '.mp4', mime: audioOnly ? 'audio/mp4' : 'video/mp4', remux: true });
      } else {
        notes.push(`${remux.reason} Saving as .ts, which VLC and most players open.`);
      }
      outputs.push(ts);
    } else if (container === 'fmp4') {
      outputs.push({ id: 'mp4', label: audioOnly ? 'M4A' : 'MP4', ext: audioOnly ? '.m4a' : '.mp4', mime: audioOnly ? 'audio/mp4' : 'video/mp4', remux: false });
    } else {
      const raw = { aac: ['.aac', 'audio/aac'], mp3: ['.mp3', 'audio/mpeg'], ac3: ['.ac3', 'audio/ac3'] }[container];
      outputs.push({ id: container, label: container.toUpperCase(), ext: raw[0], mime: raw[1], remux: false });
    }
    if (!media.endList) notes.push('This looks like a live stream: only the segments listed right now will be saved.');
    track.media = media;
    track.setOutputs(outputs);
    track.status([`${media.segments.length} segments`, formatDuration(media.duration), enc.method !== 'NONE' && enc.method].filter(Boolean).join(' · '));
    track.button.disabled = false;
    remarks.set(track, notes);
    showNotices();
  }

  if (parsed.type === 'media') {
    const track = new Track(item.media === 'audio' ? 'Audio' : 'Video', item.media === 'audio' ? 'audio' : 'video');
    tracksEl.append(track.root);
    wireDownload(track, () => base);
    await prepare(track, parsed, { codecs: '', audioOnly: false }, track.beginPrepare());
    return;
  }

  // Master playlist: choose a quality; a separate audio stream gets its own row.
  const variants = sortVariants(parsed.variants);
  if (!variants.length) throw new Error('The playlist lists no streams.');
  const video = new Track('Video', 'video');
  const audio = new Track('Audio (separate stream)', 'audio');
  audio.root.hidden = true;
  tracksEl.append(video.root, audio.root);

  video.qualityLabel.hidden = false;
  video.qualitySelect.replaceChildren(...variants.map((v, i) => el('option', { value: String(i) }, variantLabel(v))));
  const chosenVariant = () => variants[Number(video.qualitySelect.value)];
  wireDownload(video, (t) => `${base}${chosenVariant().height ? ` ${chosenVariant().height}p` : ''}`);
  wireDownload(audio, () => `${base} (audio)`);

  async function chooseAudio() {
    const renditions = externalAudioFor(parsed, chosenVariant());
    audio.root.hidden = renditions.length === 0;
    if (!renditions.length) return;
    audio.qualityLabel.hidden = false;
    audio.qualitySelect.replaceChildren(...renditions.map((r, i) => el('option', { value: String(i) }, [r.name, r.language].filter(Boolean).join(' · ') || `Track ${i + 1}`)));
    audio.onChoose = async () => {
      if (audio.controller) return; // the audio is downloading: changing the video quality must not reset its row
      const token = audio.beginPrepare();
      try {
        const media = await loadPlaylist(renditions[Number(audio.qualitySelect.value)].url);
        if (audio.isCurrent(token)) await prepare(audio, media, { codecs: '', audioOnly: true }, token);
      } catch (e) {
        if (audio.isCurrent(token)) audio.status(`Could not read the audio playlist: ${explain(e)}`, 'error');
      }
    };
    await audio.onChoose();
  }

  video.onChoose = async () => {
    const token = video.beginPrepare();
    const variant = chosenVariant();
    try {
      const media = await loadPlaylist(variant.url);
      if (!video.isCurrent(token)) return;
      await prepare(video, media, { codecs: variant.codecs, audioOnly: !hasVideo(variant) }, token);
      if (video.isCurrent(token)) await chooseAudio();
    } catch (e) {
      if (video.isCurrent(token)) video.status(`Could not read this quality: ${explain(e)}`, 'error');
    }
  };
  await video.onChoose();
}

main().catch((e) => {
  $('status').textContent = `Could not prepare the download: ${explain(e)}`;
  $('status').className = 'error';
  console.error(e);
});
