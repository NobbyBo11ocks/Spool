// Merging two fragmented-MP4 streams (one video, one audio, as DASH delivers them) into a single fragmented MP4.
// Pure byte manipulation, no dependencies. The approach:
//   * init segments: take the video's ftyp + moov, append the audio's trak (renumbering its track_ID if it collides),
//     and append its trex to mvex.
//   * media segments: keep each moof+mdat pair intact (data offsets inside a moof are relative to the moof, so they stay
//     valid), drop styp/sidx and friends, renumber the moof sequence numbers, and remap the audio track_ID in tfhd.
// Segments from both streams are written in start-time order by the caller.
//
// ISO/IEC 14496-12: box layout (size, type), mvhd, tkhd, mvex/trex, moof/mfhd, traf/tfhd.

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function setU32(bytes, offset, value) {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

/** Yields {type, start, end, payload} for each box in bytes[start, end). */
export function* readBoxes(bytes, start = 0, end = bytes.length) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(bytes, p);
    const type = fourcc(bytes, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) throw new Error(`Truncated MP4 box "${type}"`);
      size = u32(bytes, p + 8) * 2 ** 32 + u32(bytes, p + 12);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) throw new Error(`Corrupt MP4 box "${type}"`);
    yield { type, start: p, end: p + size, payload: p + header };
    p += size;
  }
}

const find = (bytes, box, type) => {
  for (const child of readBoxes(bytes, box.payload, box.end)) if (child.type === type) return child;
  return null;
};
const findAll = (bytes, box, type) => [...readBoxes(bytes, box.payload, box.end)].filter((c) => c.type === type);

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function makeBox(type, parts) {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const header = new Uint8Array(8);
  setU32(header, 0, size);
  for (let i = 0; i < 4; i++) header[4 + i] = type.charCodeAt(i);
  return concat([header, ...parts]);
}

/** Parses an init segment (ftyp + moov) into the pieces the merge needs. Throws if it isn't a fragmented MP4. */
function parseInit(bytes) {
  const top = [...readBoxes(bytes)];
  const ftyp = top.find((b) => b.type === 'ftyp');
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new Error('The init segment has no moov box');
  const mvex = find(bytes, moov, 'mvex');
  if (!mvex) throw new Error('Not a fragmented MP4 (no mvex): it cannot be merged');
  const traks = findAll(bytes, moov, 'trak').map((trak) => {
    const tkhd = find(bytes, trak, 'tkhd');
    const version = bytes[tkhd.payload];
    const idOffset = tkhd.payload + (version === 1 ? 20 : 12);
    return { box: trak, idOffset, id: u32(bytes, idOffset) };
  });
  const trexes = findAll(bytes, mvex, 'trex').map((box) => ({ box, id: u32(bytes, box.payload + 4) }));
  return { bytes, ftyp, moov, mvhd: find(bytes, moov, 'mvhd'), traks, trexes };
}

/**
 * Builds the merged init segment.
 * @returns {{init: Uint8Array, audioTrackMap: Map<number, number>}} audioTrackMap: audio track_ID in its own stream -> in the merged file.
 */
export function mergeInit(videoInit, audioInit) {
  const v = parseInit(videoInit);
  const a = parseInit(audioInit);
  const used = new Set(v.traks.map((t) => t.id));
  let next = Math.max(0, ...used) + 1;

  const audioTrackMap = new Map();
  const audioTraks = a.traks.map((t) => {
    const id = used.has(t.id) ? next++ : t.id;
    used.add(id);
    audioTrackMap.set(t.id, id);
    const copy = audioInit.slice(t.box.start, t.box.end); // patch a copy: the caller's bytes stay untouched
    setU32(copy, t.idOffset - t.box.start, id);
    return copy;
  });

  const audioTrexes = a.trexes.map((t) => {
    const copy = audioInit.slice(t.box.start, t.box.end);
    setU32(copy, 12, audioTrackMap.get(t.id) ?? t.id); // trex payload: version/flags(4) then track_ID
    return copy;
  });

  // mvhd: next_track_ID must exceed every track in the file.
  const mvhd = videoInit.slice(v.mvhd.start, v.mvhd.end);
  const version = videoInit[v.mvhd.payload];
  setU32(mvhd, v.mvhd.payload - v.mvhd.start + (version === 1 ? 108 : 96), Math.max(...used) + 1);

  // mvex: both streams' trex; mehd (fragment duration of the video alone) is dropped because it would now be wrong.
  const mvex = find(videoInit, v.moov, 'mvex');
  const videoTrexes = findAll(videoInit, mvex, 'trex').map((b) => videoInit.slice(b.start, b.end));
  const newMvex = makeBox('mvex', [...videoTrexes, ...audioTrexes]);

  const moov = makeBox('moov', [mvhd, ...v.traks.map((t) => videoInit.slice(t.box.start, t.box.end)), ...audioTraks, newMvex]);
  const ftyp = v.ftyp ? videoInit.slice(v.ftyp.start, v.ftyp.end) : new Uint8Array(0);
  return { init: concat([ftyp, moov]), audioTrackMap };
}

/**
 * Rewrites one media segment for the merged file: only moof+mdat are kept, sequence numbers continue from
 * `nextSequence`, and track IDs are remapped with `trackMap`. Returns the chunks to write and the next sequence number.
 */
export function rewriteSegment(bytes, trackMap, nextSequence) {
  const chunks = [];
  let seq = nextSequence;
  for (const box of readBoxes(bytes)) {
    if (box.type === 'mdat') {
      chunks.push(bytes.subarray(box.start, box.end));
    } else if (box.type === 'moof') {
      const moof = bytes.slice(box.start, box.end);
      const rel = (abs) => abs - box.start;
      const mfhd = find(bytes, box, 'mfhd');
      if (mfhd) setU32(moof, rel(mfhd.payload + 4), seq);
      seq++;
      for (const traf of findAll(bytes, box, 'traf')) {
        const tfhd = find(bytes, traf, 'tfhd');
        if (!tfhd) continue;
        const flags = u32(bytes, tfhd.payload) & 0xffffff;
        // An absolute base_data_offset points into the original file and would be wrong after merging.
        if (flags & 0x1) throw new Error('Segments with an explicit base data offset cannot be merged');
        const id = u32(bytes, tfhd.payload + 4);
        if (trackMap.has(id)) setU32(moof, rel(tfhd.payload + 4), trackMap.get(id));
      }
      chunks.push(moof);
    }
    // styp, sidx, emsg, prft, free ...: not needed in the merged file.
  }
  return { chunks, nextSequence: seq };
}
