// Minimal MPEG-2 Transport Stream inspection: which elementary streams does a segment contain?
// Needed because mux.js silently ignores streams it can't handle (e.g. HEVC video), which would turn a
// "conversion to MP4" into a quiet loss of the video track.

const PACKET = 188;

const STREAM_TYPES = {
  0x01: { label: 'MPEG-1 video', kind: 'video' },
  0x02: { label: 'MPEG-2 video', kind: 'video' },
  0x03: { label: 'MP3 audio', kind: 'audio' },
  0x04: { label: 'MP3 audio', kind: 'audio' },
  0x06: { label: 'private data (e.g. AC-3/subtitles)', kind: 'other' },
  0x0f: { label: 'AAC audio', kind: 'audio' },
  0x11: { label: 'AAC (LATM) audio', kind: 'audio' },
  0x15: { label: 'timed metadata', kind: 'metadata' },
  0x1b: { label: 'H.264 video', kind: 'video' },
  0x24: { label: 'HEVC (H.265) video', kind: 'video' },
  0x81: { label: 'AC-3 audio', kind: 'audio' },
  0x87: { label: 'E-AC-3 audio', kind: 'audio' },
};

/** Stream types mux.js can convert to MP4. Timed metadata is harmless and ignored. */
export const REMUXABLE_STREAM_TYPES = new Set([0x1b, 0x0f, 0x15]);

export function describeStreamType(type) {
  return STREAM_TYPES[type] ?? { label: `stream type 0x${type.toString(16)}`, kind: 'other' };
}

/**
 * Reads the PAT and first PMT of a TS segment.
 * @returns {null | {streams: {type: number, pid: number}[]}} null if this isn't (parsable) MPEG-TS.
 */
export function readTsStreams(bytes) {
  if (bytes.length < PACKET || bytes[0] !== 0x47) return null;
  let pmtPid = null;
  const partial = new Map(); // pid -> bytes collected so far for the section being assembled

  for (let off = 0; off + PACKET <= bytes.length; off += PACKET) {
    if (bytes[off] !== 0x47) return null;
    const pusi = (bytes[off + 1] & 0x40) !== 0;
    const pid = ((bytes[off + 1] & 0x1f) << 8) | bytes[off + 2];
    const adaptation = (bytes[off + 3] >> 4) & 0x3;
    if (!(adaptation & 0x1)) continue; // no payload
    let p = off + 4;
    if (adaptation & 0x2) p += 1 + bytes[off + 4];
    if (p >= off + PACKET) continue;
    if (pid !== 0 && pid !== pmtPid) continue;

    let chunk;
    if (pusi) {
      const start = p + 1 + bytes[p]; // skip pointer_field
      chunk = bytes.subarray(start, off + PACKET);
    } else if (partial.has(pid)) {
      chunk = bytes.subarray(p, off + PACKET);
    } else {
      continue;
    }
    const prev = pusi ? new Uint8Array(0) : partial.get(pid);
    const buf = new Uint8Array(prev.length + chunk.length);
    buf.set(prev, 0);
    buf.set(chunk, prev.length);
    partial.set(pid, buf);

    if (buf.length < 3) continue;
    const total = 3 + (((buf[1] & 0x0f) << 8) | buf[2]);
    if (buf.length < total) continue; // section continues in the next packet
    partial.delete(pid);

    if (pid === 0 && buf[0] === 0x00) {
      for (let i = 8; i + 4 <= total - 4; i += 4) {
        const program = (buf[i] << 8) | buf[i + 1];
        if (program !== 0) {
          pmtPid = ((buf[i + 2] & 0x1f) << 8) | buf[i + 3];
          break;
        }
      }
    } else if (pid === pmtPid && buf[0] === 0x02) {
      const streams = [];
      let i = 12 + (((buf[10] & 0x0f) << 8) | buf[11]); // skip program descriptors
      while (i + 5 <= total - 4) {
        streams.push({ type: buf[i], pid: ((buf[i + 1] & 0x1f) << 8) | buf[i + 2] });
        i += 5 + (((buf[i + 3] & 0x0f) << 8) | buf[i + 4]);
      }
      return { streams };
    }
  }
  return null;
}
