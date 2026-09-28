// A fragmented-MP4 writer.
//
// Fragmented rather than progressive on purpose: fMP4 needs no global sample
// tables, so there are no chunk offsets to patch up after the fact and no
// second pass over the file. Chrome, Safari, Firefox, VLC, mpv and QuickTime
// all play the result.
//
// Feed it samples, call finalize(), get a Uint8Array.

const MOVIE_TIMESCALE = 1000;

// trun sample_flags. sample_depends_on=2 means "this sample depends on nothing"
// (a sync sample); 1 means it does, and we additionally set the
// non-sync-sample bit.
const FLAG_SYNC = 0x02000000;
const FLAG_DELTA = 0x01010000;

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  bytes(value) {
    const view = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.chunks.push(view);
    this.length += view.byteLength;
    return this;
  }

  u8(value) {
    return this.bytes(new Uint8Array([value & 0xff]));
  }

  u16(value) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, value & 0xffff);
    return this.bytes(b);
  }

  i16(value) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setInt16(0, value);
    return this.bytes(b);
  }

  u24(value) {
    return this.bytes(new Uint8Array([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]));
  }

  u32(value) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0);
    return this.bytes(b);
  }

  i32(value) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, value);
    return this.bytes(b);
  }

  u64(value) {
    const high = Math.floor(value / 2 ** 32);
    const low = value % 2 ** 32;
    return this.u32(high).u32(low);
  }

  ascii(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
    return this.bytes(out);
  }

  zeros(count) {
    return this.bytes(new Uint8Array(count));
  }

  concat() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

/** Wrap a payload in a box header. */
export function box(type, ...payloads) {
  let size = 8;
  const parts = [];
  for (const payload of payloads) {
    const view = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    parts.push(view);
    size += view.byteLength;
  }
  const writer = new ByteWriter();
  writer.u32(size).ascii(type);
  for (const part of parts) writer.bytes(part);
  return writer.concat();
}

function fullBox(type, version, flags, ...payloads) {
  const head = new ByteWriter();
  head.u8(version).u24(flags);
  return box(type, head.concat(), ...payloads);
}

function ftyp() {
  const writer = new ByteWriter();
  writer.ascii("isom").u32(0x200);
  for (const brand of ["isom", "iso2", "iso5", "iso6", "avc1", "mp41"]) {
    writer.ascii(brand);
  }
  return box("ftyp", writer.concat());
}

const UNITY_MATRIX = (() => {
  const writer = new ByteWriter();
  const values = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  for (const value of values) writer.u32(value);
  return writer.concat();
})();

function mvhd(durationMs, nextTrackId) {
  const writer = new ByteWriter();
  writer
    .u32(0) // creation time
    .u32(0) // modification time
    .u32(MOVIE_TIMESCALE)
    .u32(Math.round(durationMs))
    .u32(0x00010000) // rate 1.0
    .u16(0x0100) // volume 1.0
    .u16(0) // reserved
    .u32(0)
    .u32(0)
    .bytes(UNITY_MATRIX)
    .zeros(24) // pre_defined
    .u32(nextTrackId);
  return fullBox("mvhd", 0, 0, writer.concat());
}

function tkhd(trackId, durationMs, width, height, isAudio) {
  const writer = new ByteWriter();
  writer
    .u32(0)
    .u32(0)
    .u32(trackId)
    .u32(0) // reserved
    .u32(Math.round(durationMs))
    .u32(0)
    .u32(0) // reserved
    .u16(0) // layer
    .u16(0) // alternate group
    .u16(isAudio ? 0x0100 : 0) // volume
    .u16(0) // reserved
    .bytes(UNITY_MATRIX)
    .u32((width || 0) << 16)
    .u32((height || 0) << 16);
  // flags 3 = track_enabled | track_in_movie
  return fullBox("tkhd", 0, 3, writer.concat());
}

function mdhd(timescale) {
  const writer = new ByteWriter();
  writer
    .u32(0)
    .u32(0)
    .u32(timescale)
    .u32(0) // duration unknown for fragmented tracks
    .u16(0x55c4) // language "und"
    .u16(0);
  return fullBox("mdhd", 0, 0, writer.concat());
}

function hdlr(handlerType, name) {
  const writer = new ByteWriter();
  writer.u32(0).ascii(handlerType).u32(0).u32(0).u32(0).ascii(name).u8(0);
  return fullBox("hdlr", 0, 0, writer.concat());
}

/**
 * Edit list. Used to say "skip the first N media samples", which is how MP4
 * expresses an audio encoder's priming delay.
 *
 * @param {number} segmentDurationMs presentation duration, movie timescale
 * @param {number} mediaTime         first media sample to show, media timescale
 */
function edts(segmentDurationMs, mediaTime) {
  const writer = new ByteWriter();
  writer
    .u32(1) // entry_count
    .u64(Math.max(0, Math.round(segmentDurationMs)))
    .u64(Math.max(0, Math.round(mediaTime)))
    .i16(1) // media_rate_integer
    .i16(0); // media_rate_fraction
  return box("edts", fullBox("elst", 1, 0, writer.concat()));
}

function dinf() {
  const url = fullBox("url ", 0, 1); // self-contained
  const dref = fullBox("dref", 0, 0, new ByteWriter().u32(1).concat(), url);
  return box("dinf", dref);
}

function emptyStbl(sampleEntry) {
  const stsd = fullBox("stsd", 0, 0, new ByteWriter().u32(1).concat(), sampleEntry);
  const stts = fullBox("stts", 0, 0, new ByteWriter().u32(0).concat());
  const stsc = fullBox("stsc", 0, 0, new ByteWriter().u32(0).concat());
  const stsz = fullBox("stsz", 0, 0, new ByteWriter().u32(0).u32(0).concat());
  const stco = fullBox("stco", 0, 0, new ByteWriter().u32(0).concat());
  return box("stbl", stsd, stts, stsc, stsz, stco);
}

function avc1SampleEntry(width, height, avcCPayload) {
  const writer = new ByteWriter();
  writer
    .zeros(6) // reserved
    .u16(1) // data_reference_index
    .u16(0) // pre_defined
    .u16(0) // reserved
    .zeros(12) // pre_defined[3]
    .u16(width)
    .u16(height)
    .u32(0x00480000) // 72 dpi
    .u32(0x00480000)
    .u32(0) // reserved
    .u16(1) // frame_count
    .zeros(32) // compressorname
    .u16(0x0018) // depth
    .i16(-1); // pre_defined
  return box("avc1", writer.concat(), box("avcC", avcCPayload));
}

function esds(asc, avgBitrate) {
  const descriptorInfo = asc && asc.byteLength ? asc : new Uint8Array([0x12, 0x10]);

  const decoderSpecific = new ByteWriter();
  decoderSpecific.u8(0x05).u8(descriptorInfo.byteLength).bytes(descriptorInfo);

  const slConfig = new ByteWriter();
  slConfig.u8(0x06).u8(1).u8(0x02);

  const decoderConfigBody = new ByteWriter();
  decoderConfigBody
    .u8(0x40) // objectTypeIndication: MPEG-4 Audio
    .u8(0x15) // streamType 5 (audio) << 2 | upstream 0 | reserved 1
    .u24(0) // bufferSizeDB
    .u32(avgBitrate || 128000) // maxBitrate
    .u32(avgBitrate || 128000) // avgBitrate
    .bytes(decoderSpecific.concat());
  const decoderConfigBytes = decoderConfigBody.concat();

  const decoderConfig = new ByteWriter();
  decoderConfig.u8(0x04).u8(decoderConfigBytes.byteLength).bytes(decoderConfigBytes);

  const esBody = new ByteWriter();
  esBody
    .u16(1) // ES_ID
    .u8(0) // flags + stream priority
    .bytes(decoderConfig.concat())
    .bytes(slConfig.concat());
  const esBytes = esBody.concat();

  const es = new ByteWriter();
  es.u8(0x03).u8(esBytes.byteLength).bytes(esBytes);

  return fullBox("esds", 0, 0, es.concat());
}

function mp4aSampleEntry(channels, sampleRate, asc, avgBitrate) {
  const writer = new ByteWriter();
  writer
    .zeros(6)
    .u16(1) // data_reference_index
    .u16(0) // version
    .u16(0) // revision
    .u32(0) // vendor
    .u16(channels)
    .u16(16) // sample size
    .u16(0) // pre_defined
    .u16(0) // reserved
    .u32(Math.round(sampleRate) << 16);
  return box("mp4a", writer.concat(), esds(asc, avgBitrate));
}

function trex(trackId) {
  const writer = new ByteWriter();
  writer
    .u32(trackId)
    .u32(1) // default_sample_description_index
    .u32(0) // default_sample_duration
    .u32(0) // default_sample_size
    .u32(0); // default_sample_flags
  return fullBox("trex", 0, 0, writer.concat());
}

function mfhd(sequenceNumber) {
  return fullBox("mfhd", 0, 0, new ByteWriter().u32(sequenceNumber).concat());
}

function tfhd(trackId) {
  // flags 0x020000 = default-base-is-moof. Everything else per sample in trun.
  return fullBox("tfhd", 0, 0x020000, new ByteWriter().u32(trackId).concat());
}

function tfdt(baseMediaDecodeTime) {
  return fullBox("tfdt", 1, 0, new ByteWriter().u64(baseMediaDecodeTime).concat());
}

/** trun with duration + size + flags per sample, and an explicit data offset. */
function trun(samples, dataOffset) {
  const flags = 0x000001 | 0x000100 | 0x000200 | 0x000400;
  const writer = new ByteWriter();
  writer.u32(samples.length).i32(dataOffset);
  for (const sample of samples) {
    writer
      .u32(Math.max(0, Math.round(sample.duration)))
      .u32(sample.data.byteLength)
      .u32(sample.keyframe ? FLAG_SYNC : FLAG_DELTA);
  }
  return fullBox("trun", 1, flags, writer.concat());
}

function trunByteLength(sampleCount) {
  // header(8) + version/flags(4) + sample_count(4) + data_offset(4) + 12/sample
  return 8 + 4 + 4 + 4 + sampleCount * 12;
}

function moofByteLength(sampleCount) {
  const mfhdLength = 16;
  const tfhdLength = 16;
  const tfdtLength = 20;
  const trafLength = 8 + tfhdLength + tfdtLength + trunByteLength(sampleCount);
  return 8 + mfhdLength + trafLength;
}

/**
 * @typedef {{data: Uint8Array, timestampTicks: number, durationTicks: number, keyframe: boolean}} Sample
 */

export class Mp4Muxer {
  /**
   * @param {{
   *   video?: {width: number, height: number, timescale: number, description: Uint8Array},
   *   audio?: {sampleRate: number, channels: number, timescale: number,
   *            description: Uint8Array|null, bitrate?: number},
   *   fragmentSeconds?: number
   * }} config
   */
  constructor(config = {}) {
    this.videoConfig = config.video || null;
    this.audioConfig = config.audio || null;
    this.fragmentSeconds = config.fragmentSeconds || 4;

    let nextTrackId = 1;
    this.videoTrackId = this.videoConfig ? nextTrackId++ : null;
    this.audioTrackId = this.audioConfig ? nextTrackId++ : null;
    this.nextTrackId = nextTrackId;

    /** @type {Sample[]} */
    this.videoSamples = [];
    /** @type {Sample[]} */
    this.audioSamples = [];
  }

  addVideoSample(sample) {
    if (!this.videoConfig) throw new Error("Muxer has no video track configured");
    this.videoSamples.push(sample);
  }

  addAudioSample(sample) {
    if (!this.audioConfig) throw new Error("Muxer has no audio track configured");
    this.audioSamples.push(sample);
  }

  /** Total duration in seconds, taken from the longer track. */
  durationSeconds() {
    const videoEnd = this.videoSamples.length
      ? (this.videoSamples[this.videoSamples.length - 1].timestampTicks +
          this.videoSamples[this.videoSamples.length - 1].durationTicks) /
        this.videoConfig.timescale
      : 0;
    const audioEnd = this.audioSamples.length
      ? (this.audioSamples[this.audioSamples.length - 1].timestampTicks +
          this.audioSamples[this.audioSamples.length - 1].durationTicks) /
        this.audioConfig.timescale
      : 0;
    return Math.max(videoEnd, audioEnd);
  }

  buildMoov() {
    const durationMs = this.durationSeconds() * 1000;
    const traks = [];
    const trexes = [];

    if (this.videoConfig) {
      const { width, height, timescale, description } = this.videoConfig;
      traks.push(
        box(
          "trak",
          tkhd(this.videoTrackId, durationMs, width, height, false),
          box(
            "mdia",
            mdhd(timescale),
            hdlr("vide", "Lectern Video"),
            box(
              "minf",
              fullBox("vmhd", 0, 1, new ByteWriter().u16(0).u16(0).u16(0).u16(0).concat()),
              dinf(),
              emptyStbl(avc1SampleEntry(width, height, description))
            )
          )
        )
      );
      trexes.push(trex(this.videoTrackId));
    }

    if (this.audioConfig) {
      const { sampleRate, channels, timescale, description, bitrate } = this.audioConfig;
      const trim = Math.max(0, Number(this.audioConfig.primingSamples) || 0);
      const audioParts = [tkhd(this.audioTrackId, durationMs, 0, 0, true)];
      if (trim > 0) {
        const presentedMs = Math.max(
          0,
          durationMs - (trim / timescale) * MOVIE_TIMESCALE
        );
        audioParts.push(edts(presentedMs, trim));
      }
      traks.push(
        box(
          "trak",
          ...audioParts,
          box(
            "mdia",
            mdhd(timescale),
            hdlr("soun", "Lectern Audio"),
            box(
              "minf",
              fullBox("smhd", 0, 0, new ByteWriter().u16(0).u16(0).concat()),
              dinf(),
              emptyStbl(mp4aSampleEntry(channels, sampleRate, description, bitrate))
            )
          )
        )
      );
      trexes.push(trex(this.audioTrackId));
    }

    const mehd = fullBox(
      "mehd",
      1,
      0,
      new ByteWriter().u64(Math.round(durationMs)).concat()
    );

    return box(
      "moov",
      mvhd(durationMs, this.nextTrackId),
      ...traks,
      box("mvex", mehd, ...trexes)
    );
  }

  /** Split a track's samples into time-bounded fragments. */
  static planFragments(samples, timescale, fragmentSeconds, trackId) {
    const fragments = [];
    const limit = fragmentSeconds * timescale;
    let current = null;
    for (const sample of samples) {
      if (
        !current ||
        (sample.timestampTicks - current.baseTime >= limit && sample.keyframe !== false)
      ) {
        current = { trackId, baseTime: sample.timestampTicks, samples: [] };
        fragments.push(current);
      }
      current.samples.push(sample);
    }
    return fragments;
  }

  finalize() {
    const writer = new ByteWriter();
    writer.bytes(ftyp());
    writer.bytes(this.buildMoov());

    const fragments = [];
    if (this.videoConfig && this.videoSamples.length) {
      fragments.push(
        ...Mp4Muxer.planFragments(
          this.videoSamples,
          this.videoConfig.timescale,
          this.fragmentSeconds,
          this.videoTrackId
        ).map((fragment) => ({ ...fragment, timescale: this.videoConfig.timescale }))
      );
    }
    if (this.audioConfig && this.audioSamples.length) {
      fragments.push(
        ...Mp4Muxer.planFragments(
          this.audioSamples,
          this.audioConfig.timescale,
          this.fragmentSeconds,
          this.audioTrackId
        ).map((fragment) => ({ ...fragment, timescale: this.audioConfig.timescale }))
      );
    }

    // Interleave by wall-clock start so players can stream the result.
    fragments.sort((a, b) => a.baseTime / a.timescale - b.baseTime / b.timescale);

    let sequence = 1;
    for (const fragment of fragments) {
      const dataOffset = moofByteLength(fragment.samples.length) + 8;
      const moof = box(
        "moof",
        mfhd(sequence),
        box(
          "traf",
          tfhd(fragment.trackId),
          tfdt(fragment.baseTime),
          trun(
            fragment.samples.map((sample) => ({
              duration: sample.durationTicks,
              data: sample.data,
              keyframe: sample.keyframe !== false,
            })),
            dataOffset
          )
        )
      );

      // planFragments() and moofByteLength() must agree or data_offset lies.
      if (moof.byteLength !== dataOffset - 8) {
        throw new Error(
          `moof size mismatch: wrote ${moof.byteLength}, predicted ${dataOffset - 8}`
        );
      }

      writer.bytes(moof);
      const payload = new ByteWriter();
      for (const sample of fragment.samples) payload.bytes(sample.data);
      writer.bytes(box("mdat", payload.concat()));
      sequence += 1;
    }

    return writer.concat();
  }
}

/**
 * Losslessly rewrap an AAC track as an audio-only .m4a.
 *
 * @param {{timescale: number, sampleRate: number, channels: number,
 *          asc: Uint8Array|null, samples: Array, }} track from demuxAudioTrack
 * @param {Uint8Array} sourceBytes the file the track came from
 */
export function remuxAudioOnly(track, sourceBytes) {
  // Carry the source's priming trim so the remux stays in sync with the
  // original rather than drifting one AAC frame late.
  const priming =
    track.editList && track.editList.mediaTime > 0 ? track.editList.mediaTime : 0;

  const muxer = new Mp4Muxer({
    audio: {
      sampleRate: track.sampleRate,
      channels: track.channels,
      timescale: track.timescale,
      description: track.asc,
      primingSamples: priming,
    },
  });
  let cursor = 0;
  for (const sample of track.samples) {
    muxer.addAudioSample({
      data: sourceBytes.subarray(sample.offset, sample.offset + sample.size),
      timestampTicks: cursor,
      durationTicks: sample.duration,
      keyframe: true,
    });
    cursor += sample.duration;
  }
  return muxer.finalize();
}

export { MOVIE_TIMESCALE, FLAG_SYNC, FLAG_DELTA };
