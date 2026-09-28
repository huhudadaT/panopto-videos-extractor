// A narrow ISO BMFF reader: enough to lift an AAC track out of an MP4 without
// decoding it.
//
// Why bother? Decoding an hour of audio to PCM costs ~650 MB of Float32 in an
// AudioBuffer and then has to be re-encoded, losing quality twice. Reading the
// sample table instead lets us copy the original AAC frames straight into the
// output file.
//
// Two layouts show up in Panopto content:
//   progressive — podcast .mp4, sample tables in moov/trak/mdia/minf/stbl
//   fragmented  — the CMAF fragmented.mp4 the HLS ladder points at, samples
//                 described by moof/traf/trun
// Both are handled.

// Some container boxes carry a fixed payload before their children. Descending
// into them means skipping that payload first, or you try to parse a version
// field as a box header. These are the ones we ever traverse.
const CHILD_OFFSETS = {
  stsd: 8, //   version/flags(4) + entry_count(4)
  dref: 8, //   version/flags(4) + entry_count(4)
  avc1: 78, //  VisualSampleEntry
  hvc1: 78,
  hev1: 78,
  mp4a: 28, //  AudioSampleEntry
  enca: 28,
  meta: 4, //   version/flags(4)
};

function makeView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readType(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

/**
 * Walk the boxes in [start, end).
 * @returns {Array<{type: string, start: number, bodyStart: number, end: number}>}
 */
export function readBoxes(bytes, start = 0, end = bytes.byteLength) {
  const view = makeView(bytes);
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = readType(view, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      const high = view.getUint32(offset + 8);
      const low = view.getUint32(offset + 12);
      size = high * 2 ** 32 + low;
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) {
      // Truncated tail — stop rather than throw, partial files are common.
      break;
    }
    boxes.push({ type, start: offset, bodyStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

/** Where a box's children begin, accounting for any fixed leading payload. */
export function childStart(box) {
  return box.bodyStart + (CHILD_OFFSETS[box.type] || 0);
}

/** Depth-first search for boxes at a path like ["moov", "trak", "mdia"]. */
export function findBoxes(bytes, path, start = 0, end = bytes.byteLength) {
  let frontier = [{ type: "", bodyStart: start, end }];
  for (const wanted of path) {
    const next = [];
    for (const parent of frontier) {
      for (const box of readBoxes(bytes, childStart(parent), parent.end)) {
        if (box.type === wanted) next.push(box);
      }
    }
    frontier = next;
    if (frontier.length === 0) return [];
  }
  return frontier;
}

export function findBox(bytes, path, start, end) {
  const all = findBoxes(bytes, path, start, end);
  return all.length ? all[0] : null;
}

/** MPEG-4 descriptors use a 7-bit-per-byte variable length. */
function readDescriptorLength(view, offset) {
  let length = 0;
  let read = 0;
  for (let i = 0; i < 4; i += 1) {
    const byte = view.getUint8(offset + i);
    read += 1;
    length = (length << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return { length, read };
}

/**
 * Pull the AudioSpecificConfig out of an esds box body.
 * @returns {{objectTypeIndication: number, asc: Uint8Array|null, avgBitrate: number}}
 */
export function parseEsds(bytes, bodyStart, end) {
  const view = makeView(bytes);
  let offset = bodyStart + 4; // version + flags
  let objectTypeIndication = 0x40;
  let avgBitrate = 0;
  let asc = null;

  function walk(limit) {
    while (offset + 2 <= limit) {
      const tag = view.getUint8(offset);
      const { length, read } = readDescriptorLength(view, offset + 1);
      const payload = offset + 1 + read;
      const payloadEnd = Math.min(payload + length, limit);

      if (tag === 0x03) {
        // ES_Descriptor: ES_ID(2) + flags(1), then nested descriptors.
        let cursor = payload + 2;
        const flags = view.getUint8(cursor);
        cursor += 1;
        if (flags & 0x80) cursor += 2; // dependsOn_ES_ID
        if (flags & 0x40) cursor += 1 + view.getUint8(cursor); // URL
        if (flags & 0x20) cursor += 2; // OCR_ES_Id
        offset = cursor;
        walk(payloadEnd);
        return;
      }
      if (tag === 0x04) {
        objectTypeIndication = view.getUint8(payload);
        avgBitrate = view.getUint32(payload + 9);
        offset = payload + 13;
        walk(payloadEnd);
        return;
      }
      if (tag === 0x05) {
        asc = bytes.subarray(payload, payloadEnd);
        return;
      }
      offset = payloadEnd;
    }
  }

  walk(end);
  return { objectTypeIndication, asc, avgBitrate };
}

/** ASC header -> sample rate + channel count, for when stsd disagrees. */
export function parseAudioSpecificConfig(asc) {
  if (!asc || asc.byteLength < 2) return null;
  const rates = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
    16000, 12000, 11025, 8000, 7350, 0, 0, 0,
  ];
  const b0 = asc[0];
  const b1 = asc[1];
  let objectType = (b0 & 0xf8) >> 3;
  let bitCursor = 5;

  function readBits(count) {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = asc[bitCursor >> 3];
      if (byte === undefined) return value << (count - i - 1);
      const bit = (byte >> (7 - (bitCursor & 7))) & 1;
      value = (value << 1) | bit;
      bitCursor += 1;
    }
    return value;
  }

  bitCursor = 5;
  if (objectType === 31) objectType = 32 + readBits(6);
  const rateIndex = readBits(4);
  const sampleRate = rateIndex === 0x0f ? readBits(24) : rates[rateIndex] || 0;
  const channelConfig = readBits(4);

  return {
    objectType,
    sampleRate,
    channels: channelConfig,
    codec: `mp4a.40.${objectType || 2}`,
    _raw: { b0, b1 },
  };
}

function expandStts(bytes, box) {
  const view = makeView(bytes);
  const count = view.getUint32(box.bodyStart + 4);
  const durations = [];
  let offset = box.bodyStart + 8;
  for (let i = 0; i < count; i += 1) {
    const sampleCount = view.getUint32(offset);
    const delta = view.getUint32(offset + 4);
    for (let n = 0; n < sampleCount; n += 1) durations.push(delta);
    offset += 8;
  }
  return durations;
}

function readStsz(bytes, box) {
  const view = makeView(bytes);
  const uniformSize = view.getUint32(box.bodyStart + 4);
  const count = view.getUint32(box.bodyStart + 8);
  if (uniformSize !== 0) return new Array(count).fill(uniformSize);
  const sizes = new Array(count);
  let offset = box.bodyStart + 12;
  for (let i = 0; i < count; i += 1) {
    sizes[i] = view.getUint32(offset);
    offset += 4;
  }
  return sizes;
}

function readStsc(bytes, box) {
  const view = makeView(bytes);
  const count = view.getUint32(box.bodyStart + 4);
  const entries = [];
  let offset = box.bodyStart + 8;
  for (let i = 0; i < count; i += 1) {
    entries.push({
      firstChunk: view.getUint32(offset),
      samplesPerChunk: view.getUint32(offset + 4),
    });
    offset += 12;
  }
  return entries;
}

function readChunkOffsets(bytes, stblBox) {
  const view = makeView(bytes);
  const stco = findBox(bytes, ["stco"], stblBox.bodyStart, stblBox.end);
  if (stco) {
    const count = view.getUint32(stco.bodyStart + 4);
    const offsets = new Array(count);
    for (let i = 0; i < count; i += 1) {
      offsets[i] = view.getUint32(stco.bodyStart + 8 + i * 4);
    }
    return offsets;
  }
  const co64 = findBox(bytes, ["co64"], stblBox.bodyStart, stblBox.end);
  if (co64) {
    const count = view.getUint32(co64.bodyStart + 4);
    const offsets = new Array(count);
    for (let i = 0; i < count; i += 1) {
      const base = co64.bodyStart + 8 + i * 8;
      offsets[i] = view.getUint32(base) * 2 ** 32 + view.getUint32(base + 4);
    }
    return offsets;
  }
  return [];
}

function describeAudioSampleEntry(bytes, stblBox) {
  const view = makeView(bytes);
  const stsd = findBox(bytes, ["stsd"], stblBox.bodyStart, stblBox.end);
  if (!stsd) return null;
  const entries = readBoxes(bytes, stsd.bodyStart + 8, stsd.end);
  const entry = entries.find((box) => box.type === "mp4a") || entries[0];
  if (!entry) return null;

  const channels = view.getUint16(entry.bodyStart + 16);
  const sampleSize = view.getUint16(entry.bodyStart + 18);
  const sampleRate = view.getUint32(entry.bodyStart + 24) / 65536;

  const esds = findBox(bytes, ["esds"], entry.bodyStart + 28, entry.end);
  const decoder = esds ? parseEsds(bytes, esds.bodyStart, esds.end) : null;

  return {
    format: entry.type,
    channels,
    sampleSize,
    sampleRate,
    asc: decoder ? decoder.asc : null,
    avgBitrate: decoder ? decoder.avgBitrate : 0,
  };
}

/**
 * Read trak/edts/elst. AAC encoders prepend ~1024 priming samples and signal
 * "skip these" with an edit list; dropping the elst on a remux shifts the audio
 * later by one frame. We read it so the muxer can write it back.
 *
 * @returns {{mediaTime: number, segmentDuration: number}|null} mediaTime is in
 *   the media timescale, segmentDuration in the movie timescale.
 */
export function readEditList(bytes, trakBox) {
  const elst = findBox(bytes, ["edts", "elst"], trakBox.bodyStart, trakBox.end);
  if (!elst) return null;
  const view = makeView(bytes);
  const version = view.getUint8(elst.bodyStart);
  const count = view.getUint32(elst.bodyStart + 4);
  if (count === 0) return null;
  let offset = elst.bodyStart + 8;
  if (version === 1) {
    const segmentDuration =
      view.getUint32(offset) * 2 ** 32 + view.getUint32(offset + 4);
    const high = view.getInt32(offset + 8);
    const low = view.getUint32(offset + 12);
    return { segmentDuration, mediaTime: high * 2 ** 32 + low };
  }
  return {
    segmentDuration: view.getUint32(offset),
    mediaTime: view.getInt32(offset + 4),
  };
}

function trackIsAudio(bytes, trakBox) {
  const hdlr = findBox(bytes, ["mdia", "hdlr"], trakBox.bodyStart, trakBox.end);
  if (!hdlr) return false;
  const view = makeView(bytes);
  return readType(view, hdlr.bodyStart + 8) === "soun";
}

function readTrackId(bytes, trakBox) {
  const tkhd = findBox(bytes, ["tkhd"], trakBox.bodyStart, trakBox.end);
  if (!tkhd) return null;
  const view = makeView(bytes);
  const version = view.getUint8(tkhd.bodyStart);
  return version === 1
    ? view.getUint32(tkhd.bodyStart + 20)
    : view.getUint32(tkhd.bodyStart + 12);
}

function readMdhdTimescale(bytes, trakBox) {
  const mdhd = findBox(bytes, ["mdia", "mdhd"], trakBox.bodyStart, trakBox.end);
  if (!mdhd) return null;
  const view = makeView(bytes);
  const version = view.getUint8(mdhd.bodyStart);
  return version === 1
    ? view.getUint32(mdhd.bodyStart + 20)
    : view.getUint32(mdhd.bodyStart + 12);
}

function progressiveSamples(bytes, stblBox) {
  const stts = findBox(bytes, ["stts"], stblBox.bodyStart, stblBox.end);
  const stsz = findBox(bytes, ["stsz"], stblBox.bodyStart, stblBox.end);
  const stsc = findBox(bytes, ["stsc"], stblBox.bodyStart, stblBox.end);
  if (!stsz || !stsc) return [];

  const sizes = readStsz(bytes, stsz);
  if (sizes.length === 0) return [];
  const durations = stts ? expandStts(bytes, stts) : [];
  const chunkEntries = readStsc(bytes, stsc);
  const chunkOffsets = readChunkOffsets(bytes, stblBox);
  if (chunkOffsets.length === 0) return [];

  const samples = [];
  let sampleIndex = 0;
  let entryIndex = 0;

  for (let chunk = 0; chunk < chunkOffsets.length && sampleIndex < sizes.length; chunk += 1) {
    while (
      entryIndex + 1 < chunkEntries.length &&
      chunkEntries[entryIndex + 1].firstChunk <= chunk + 1
    ) {
      entryIndex += 1;
    }
    const perChunk = chunkEntries[entryIndex]
      ? chunkEntries[entryIndex].samplesPerChunk
      : 1;
    let offset = chunkOffsets[chunk];
    for (let i = 0; i < perChunk && sampleIndex < sizes.length; i += 1) {
      samples.push({
        offset,
        size: sizes[sampleIndex],
        duration: durations[sampleIndex] ?? durations[durations.length - 1] ?? 1024,
      });
      offset += sizes[sampleIndex];
      sampleIndex += 1;
    }
  }

  return samples;
}

function fragmentedSamples(bytes, trackId) {
  const samples = [];
  const trexDefaults = { duration: 0, size: 0 };

  const trex = findBoxes(bytes, ["moov", "mvex", "trex"]).find((box) => {
    const view = makeView(bytes);
    return view.getUint32(box.bodyStart + 4) === trackId;
  });
  if (trex) {
    const view = makeView(bytes);
    trexDefaults.duration = view.getUint32(trex.bodyStart + 12);
    trexDefaults.size = view.getUint32(trex.bodyStart + 16);
  }

  const view = makeView(bytes);
  for (const moof of readBoxes(bytes).filter((box) => box.type === "moof")) {
    for (const traf of readBoxes(bytes, moof.bodyStart, moof.end).filter(
      (box) => box.type === "traf"
    )) {
      const tfhd = readBoxes(bytes, traf.bodyStart, traf.end).find((b) => b.type === "tfhd");
      if (!tfhd) continue;

      const tfhdFlags = view.getUint32(tfhd.bodyStart) & 0x00ffffff;
      let cursor = tfhd.bodyStart + 4;
      const thisTrackId = view.getUint32(cursor);
      cursor += 4;
      if (thisTrackId !== trackId) continue;

      let baseDataOffset = moof.start;
      if (tfhdFlags & 0x000001) {
        baseDataOffset = view.getUint32(cursor) * 2 ** 32 + view.getUint32(cursor + 4);
        cursor += 8;
      }
      if (tfhdFlags & 0x000002) cursor += 4; // sample description index
      let defaultDuration = trexDefaults.duration;
      let defaultSize = trexDefaults.size;
      if (tfhdFlags & 0x000008) {
        defaultDuration = view.getUint32(cursor);
        cursor += 4;
      }
      if (tfhdFlags & 0x000010) {
        defaultSize = view.getUint32(cursor);
        cursor += 4;
      }

      for (const trun of readBoxes(bytes, traf.bodyStart, traf.end).filter(
        (b) => b.type === "trun"
      )) {
        const version = view.getUint8(trun.bodyStart);
        const flags = view.getUint32(trun.bodyStart) & 0x00ffffff;
        let p = trun.bodyStart + 4;
        const sampleCount = view.getUint32(p);
        p += 4;
        let dataOffset = 0;
        if (flags & 0x000001) {
          dataOffset = view.getInt32(p);
          p += 4;
        }
        if (flags & 0x000004) p += 4; // first sample flags

        let position = baseDataOffset + dataOffset;
        for (let i = 0; i < sampleCount; i += 1) {
          let duration = defaultDuration;
          let size = defaultSize;
          if (flags & 0x000100) {
            duration = view.getUint32(p);
            p += 4;
          }
          if (flags & 0x000200) {
            size = view.getUint32(p);
            p += 4;
          }
          if (flags & 0x000400) p += 4; // sample flags
          if (flags & 0x000800) p += 4; // composition offset
          samples.push({ offset: position, size, duration });
          position += size;
        }
        void version;
      }
    }
  }

  return samples;
}

/**
 * Extract the audio track from an MP4 without decoding it.
 *
 * @param {Uint8Array} bytes whole file
 * @returns {{
 *   trackId: number, timescale: number, sampleRate: number, channels: number,
 *   codec: string, asc: Uint8Array|null, fragmented: boolean,
 *   samples: Array<{offset: number, size: number, duration: number}>,
 *   durationTicks: number, durationSec: number, byteLength: number
 * }}
 */
export function demuxAudioTrack(bytes) {
  const traks = findBoxes(bytes, ["moov", "trak"]);
  const audioTrak = traks.find((trak) => trackIsAudio(bytes, trak));
  if (!audioTrak) {
    throw Object.assign(new Error("No audio track found in this MP4"), { fatal: true });
  }

  const trackId = readTrackId(bytes, audioTrak) ?? 1;
  const timescale = readMdhdTimescale(bytes, audioTrak) || 48000;
  const stbl = findBox(
    bytes,
    ["mdia", "minf", "stbl"],
    audioTrak.bodyStart,
    audioTrak.end
  );
  if (!stbl) {
    throw Object.assign(new Error("Audio track has no sample table"), { fatal: true });
  }

  const entry = describeAudioSampleEntry(bytes, stbl) || {};
  let samples = progressiveSamples(bytes, stbl);
  let fragmented = false;
  if (samples.length === 0) {
    samples = fragmentedSamples(bytes, trackId);
    fragmented = samples.length > 0;
  }
  if (samples.length === 0) {
    throw Object.assign(new Error("Audio track contains no samples"), { fatal: true });
  }

  const fromAsc = parseAudioSpecificConfig(entry.asc);
  const sampleRate = fromAsc?.sampleRate || entry.sampleRate || timescale;
  const channels = fromAsc?.channels || entry.channels || 2;
  const durationTicks = samples.reduce((sum, s) => sum + s.duration, 0);
  const byteLength = samples.reduce((sum, s) => sum + s.size, 0);
  const editList = readEditList(bytes, audioTrak);

  return {
    trackId,
    timescale,
    editList,
    sampleRate,
    channels,
    codec: fromAsc?.codec || "mp4a.40.2",
    asc: entry.asc || null,
    format: entry.format || "mp4a",
    fragmented,
    samples,
    durationTicks,
    durationSec: durationTicks / timescale,
    byteLength,
  };
}

/** Copy each sample's bytes out of the file. */
export function readSampleData(bytes, samples) {
  return samples.map((sample) => bytes.subarray(sample.offset, sample.offset + sample.size));
}

/** True when the file has no video track — i.e. it's already audio-only. */
export function isAudioOnlyFile(bytes) {
  const traks = findBoxes(bytes, ["moov", "trak"]);
  if (traks.length === 0) return false;
  return traks.every((trak) => trackIsAudio(bytes, trak));
}
