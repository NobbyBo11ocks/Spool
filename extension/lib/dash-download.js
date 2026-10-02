// Download engine for DASH representations. Like hls-download.js it is free of DOM and chrome.* APIs: the caller supplies
// `fetchBytes` and a `sink`, so it is tested in Node against real ffmpeg-generated DASH.

import { resolveSegments } from './dash.js';
import { mergeInit, rewriteSegment } from './fmp4.js';
import { runOrdered, downloadFile, assertMediaBytes } from './hls-download.js';

/** Resolves the segment plan of a representation, turning "can't" answers into errors with a readable message. */
export function planFor(rep, mpdType) {
  const plan = resolveSegments(rep, mpdType);
  if (plan.error) throw new Error(plan.error);
  return plan;
}

/**
 * Video and audio can be merged into one MP4 when both are segmented ISO BMFF streams (init segment + media segments).
 * A stream that turns out not to be fragmented is still refused later, by mergeInit(), with a clear error.
 */
export function canMerge(video, audio, mpdType = 'static') {
  if (!video || !audio) return false;
  if (video.container !== 'mp4' || audio.container !== 'mp4') return false;
  try {
    return [video, audio].every((rep) => {
      const plan = resolveSegments(rep, mpdType);
      return !plan.error && !plan.single && plan.init && plan.segments.length > 0;
    });
  } catch {
    return false;
  }
}

/**
 * Downloads one representation (`merge: false`) or video + audio merged into one fragmented MP4 (`merge: true`).
 * Segment progress is reported as `{done, total, bytes}`; a single-file representation reports `{received, total}`.
 */
export async function downloadDash({ mpdType = 'static', video = null, audio = null, merge = false, sink, fetchBytes, signal, onProgress = () => {}, concurrency = 6, fetchImpl, credentials }) {
  const reps = [video, audio].filter(Boolean);
  if (!reps.length) throw new Error('Nothing selected to download.');
  let fetched = 0;
  const get = async (resource) => {
    const bytes = await fetchBytes(resource.url, { range: resource.range, signal });
    assertMediaBytes(bytes, resource.url); // a login page or JSON error is not a segment
    fetched += bytes.byteLength;
    return bytes;
  };

  if (merge && reps.length === 2) {
    const [vPlan, aPlan] = [planFor(video, mpdType), planFor(audio, mpdType)];
    if (!vPlan.init || !aPlan.init) throw new Error('A stream has no init segment, so it cannot be merged.');
    const [vInit, aInit] = await Promise.all([get(vPlan.init), get(aPlan.init)]);
    const { init, audioTrackMap } = mergeInit(vInit, aInit);
    await sink.write(init);

    // One list in presentation order: segments of both streams interleaved by start time (video first on a tie).
    const jobs = [
      ...vPlan.segments.map((s) => ({ ...s, trackMap: new Map() })),
      ...aPlan.segments.map((s) => ({ ...s, trackMap: audioTrackMap, audio: true })),
    ].sort((x, y) => x.start - y.start || Number(!!x.audio) - Number(!!y.audio));

    let sequence = 1;
    await runOrdered({
      total: jobs.length,
      concurrency,
      ahead: concurrency * 2,
      signal,
      produce: (i) => get(jobs[i]),
      consume: async (i, bytes) => {
        const out = rewriteSegment(bytes, jobs[i].trackMap, sequence);
        sequence = out.nextSequence;
        for (const chunk of out.chunks) await sink.write(chunk);
        onProgress({ done: i + 1, total: jobs.length, bytes: fetched });
      },
    });
    return;
  }

  if (reps.length !== 1) throw new Error('Select one stream, or ask for the merged file.');
  const rep = reps[0];
  const plan = planFor(rep, mpdType);

  if (plan.single) {
    // A whole file (progressive MP4 / on-demand profile): stream it to disk.
    await downloadFile(plan.url, { sink, signal, onProgress, ...(fetchImpl ? { fetchImpl } : {}), ...(credentials ? { credentials } : {}) });
    return;
  }
  if (plan.init) await sink.write(await get(plan.init));
  await runOrdered({
    total: plan.segments.length,
    concurrency,
    ahead: concurrency * 2,
    signal,
    produce: (i) => get(plan.segments[i]),
    consume: async (i, bytes) => {
      await sink.write(bytes);
      onProgress({ done: i + 1, total: plan.segments.length, bytes: fetched });
    },
  });
}
