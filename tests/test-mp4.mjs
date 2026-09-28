import {
  Mp4Muxer,
  box,
  remuxAudioOnly,
} from "../extension/lib/media/mp4-mux.js";
import {
  demuxAudioTrack,
  findBox,
  findBoxes,
  isAudioOnlyFile,
  parseAudioSpecificConfig,
  parseEsds,
  readBoxes,
} from "../extension/lib/media/mp4-demux.js";

// AudioSpecificConfig for AAC-LC, 48 kHz, stereo:
// objectType 2 (00010), rateIndex 3 (0011), channelConfig 2 (0010)
const ASC_48K_STEREO = new Uint8Array([0x11, 0x90]);

function fakeAacFrames(count, size = 400) {
  return Array.from({ length: count }, (_, i) => {
    const frame = new Uint8Array(size);
    frame.fill((i * 7 + 13) & 0xff);
    frame[0] = 0xff;
    frame[1] = i & 0xff;
    return frame;
  });
}

export default function run({ test, assert, assertEqual, assertDeepEqual }) {
  test("box() writes a correct header", () => {
    const result = box("free", new Uint8Array([1, 2, 3, 4]));
    assertEqual(result.byteLength, 12, "box length");
    assertEqual(
      new DataView(result.buffer).getUint32(0),
      12,
      "size field matches byte length"
    );
    assertEqual(
      String.fromCharCode(...result.subarray(4, 8)),
      "free",
      "type field"
    );
  });

  test("readBoxes walks a flat sequence", () => {
    const a = box("aaaa", new Uint8Array(4));
    const b = box("bbbb", new Uint8Array(8));
    const joined = new Uint8Array(a.byteLength + b.byteLength);
    joined.set(a, 0);
    joined.set(b, a.byteLength);
    const boxes = readBoxes(joined);
    assertDeepEqual(boxes.map((x) => x.type), ["aaaa", "bbbb"], "box types");
  });

  test("audio-only mux then demux round-trips", () => {
    const frames = fakeAacFrames(240);
    const muxer = new Mp4Muxer({
      audio: {
        sampleRate: 48000,
        channels: 2,
        timescale: 48000,
        description: ASC_48K_STEREO,
        bitrate: 106000,
      },
      fragmentSeconds: 4,
    });

    let cursor = 0;
    for (const frame of frames) {
      muxer.addAudioSample({
        data: frame,
        timestampTicks: cursor,
        durationTicks: 1024,
        keyframe: true,
      });
      cursor += 1024;
    }

    const file = muxer.finalize();

    // Top-level structure
    const topTypes = readBoxes(file).map((b) => b.type);
    assertEqual(topTypes[0], "ftyp", "starts with ftyp");
    assertEqual(topTypes[1], "moov", "moov second");
    assert(topTypes.includes("moof"), "has fragments");
    assert(topTypes.includes("mdat"), "has media data");

    // mvex/trex present, so the file declares itself fragmented
    assert(findBox(file, ["moov", "mvex", "trex"]), "trex present");
    assert(findBox(file, ["moov", "mvex", "mehd"]), "mehd present");

    const track = demuxAudioTrack(file);
    assertEqual(track.fragmented, true, "detected as fragmented");
    assertEqual(track.timescale, 48000, "timescale");
    assertEqual(track.sampleRate, 48000, "sample rate from ASC");
    assertEqual(track.channels, 2, "channel count from ASC");
    assertEqual(track.samples.length, frames.length, "sample count");
    assertEqual(track.durationTicks, 240 * 1024, "total duration in ticks");
    assertEqual(Math.round(track.durationSec * 100) / 100, 5.12, "duration seconds");
    assertDeepEqual(Array.from(track.asc), [0x11, 0x90], "ASC survives esds");

    // Byte-exact sample recovery — the whole point of the demuxer.
    for (let i = 0; i < frames.length; i += 1) {
      const sample = track.samples[i];
      const recovered = file.subarray(sample.offset, sample.offset + sample.size);
      assertEqual(sample.size, frames[i].byteLength, `sample ${i} size`);
      if (
        recovered[0] !== frames[i][0] ||
        recovered[1] !== frames[i][1] ||
        recovered[399] !== frames[i][399]
      ) {
        throw new Error(`sample ${i} bytes do not match`);
      }
    }

    assertEqual(isAudioOnlyFile(file), true, "reports audio-only");
  });

  test("fragments are split at the configured boundary", () => {
    const frames = fakeAacFrames(500, 100);
    const muxer = new Mp4Muxer({
      audio: { sampleRate: 48000, channels: 1, timescale: 48000, description: ASC_48K_STEREO },
      fragmentSeconds: 2,
    });
    let cursor = 0;
    for (const frame of frames) {
      muxer.addAudioSample({
        data: frame,
        timestampTicks: cursor,
        durationTicks: 1024,
        keyframe: true,
      });
      cursor += 1024;
    }
    const file = muxer.finalize();
    const moofCount = readBoxes(file).filter((b) => b.type === "moof").length;
    // 500 * 1024 / 48000 = 10.67 s of audio, split every 2 s.
    assert(moofCount >= 5 && moofCount <= 7, `expected ~6 fragments, got ${moofCount}`);
    assertEqual(demuxAudioTrack(file).samples.length, 500, "all samples survive");
  });

  test("video + audio mux interleaves and parses", () => {
    // A minimal but structurally valid avcC payload.
    const avcC = new Uint8Array([
      0x01, 0x4d, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x4d, 0x00, 0x28,
      0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80,
    ]);
    const muxer = new Mp4Muxer({
      video: { width: 1280, height: 720, timescale: 90000, description: avcC },
      audio: { sampleRate: 48000, channels: 2, timescale: 48000, description: ASC_48K_STEREO },
      fragmentSeconds: 4,
    });

    for (let i = 0; i < 20; i += 1) {
      muxer.addVideoSample({
        data: new Uint8Array(500).fill(i + 1),
        timestampTicks: i * 45000, // 0.5 s per frame
        durationTicks: 45000,
        keyframe: i % 4 === 0,
      });
    }
    for (let i = 0; i < 200; i += 1) {
      muxer.addAudioSample({
        data: new Uint8Array(200).fill(i + 1),
        timestampTicks: i * 1024,
        durationTicks: 1024,
        keyframe: true,
      });
    }

    const file = muxer.finalize();
    const traks = findBoxes(file, ["moov", "trak"]);
    assertEqual(traks.length, 2, "two tracks");
    assert(findBox(file, ["moov", "trak", "mdia", "minf", "stbl", "stsd", "avc1"]), "avc1 entry");
    assert(findBox(file, ["moov", "trak", "mdia", "minf", "stbl", "stsd", "mp4a"]), "mp4a entry");

    const avcCBox = findBox(file, [
      "moov", "trak", "mdia", "minf", "stbl", "stsd", "avc1", "avcC",
    ]);
    assert(avcCBox, "avcC box present");
    assertDeepEqual(
      Array.from(file.subarray(avcCBox.bodyStart, avcCBox.end)),
      Array.from(avcC),
      "avcC payload preserved"
    );

    const track = demuxAudioTrack(file);
    assertEqual(track.samples.length, 200, "audio samples found in a two-track file");
    assertEqual(isAudioOnlyFile(file), false, "not audio-only");

    const moofs = readBoxes(file).filter((b) => b.type === "moof");
    assert(moofs.length >= 4, `expected several fragments, got ${moofs.length}`);
  });

  test("parseAudioSpecificConfig reads standard configs", () => {
    assertEqual(parseAudioSpecificConfig(ASC_48K_STEREO).sampleRate, 48000, "48 kHz");
    assertEqual(parseAudioSpecificConfig(ASC_48K_STEREO).channels, 2, "stereo");
    assertEqual(parseAudioSpecificConfig(ASC_48K_STEREO).objectType, 2, "AAC-LC");
    // 44.1 kHz mono: objectType 2, rateIndex 4, channelConfig 1
    const mono441 = new Uint8Array([0x12, 0x08]);
    assertEqual(parseAudioSpecificConfig(mono441).sampleRate, 44100, "44.1 kHz");
    assertEqual(parseAudioSpecificConfig(mono441).channels, 1, "mono");
    assertEqual(parseAudioSpecificConfig(null), null, "null input is tolerated");
  });

  test("parseEsds survives a long-form descriptor length", () => {
    // Hand-build an esds using the 4-byte extended length encoding that some
    // encoders emit, to be sure the parser handles both forms.
    const asc = new Uint8Array([0x11, 0x90]);
    const parts = [];
    parts.push(0x00, 0x00, 0x00, 0x00); // version + flags
    const dsi = [0x05, 0x80, 0x80, 0x80, asc.byteLength, ...asc];
    const dcd = [
      0x04, 0x80, 0x80, 0x80, 13 + dsi.length,
      0x40, 0x15, 0x00, 0x00, 0x00,
      0x00, 0x01, 0xf4, 0x00,
      0x00, 0x01, 0xf4, 0x00,
      ...dsi,
    ];
    const es = [0x03, 0x80, 0x80, 0x80, 3 + dcd.length, 0x00, 0x01, 0x00, ...dcd];
    parts.push(...es);
    const body = new Uint8Array(parts);
    const file = box("esds", body);
    const parsed = parseEsds(file, 8, file.byteLength);
    assertDeepEqual(Array.from(parsed.asc), [0x11, 0x90], "ASC read via long lengths");
    assertEqual(parsed.objectTypeIndication, 0x40, "object type indication");
  });

  test("remuxAudioOnly strips video from a mixed file", () => {
    const avcC = new Uint8Array([0x01, 0x4d, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x02, 0x67, 0x4d, 0x00]);
    const source = new Mp4Muxer({
      video: { width: 640, height: 360, timescale: 90000, description: avcC },
      audio: { sampleRate: 44100, channels: 1, timescale: 44100, description: new Uint8Array([0x12, 0x08]) },
    });
    for (let i = 0; i < 10; i += 1) {
      source.addVideoSample({
        data: new Uint8Array(1000).fill(9),
        timestampTicks: i * 90000,
        durationTicks: 90000,
        keyframe: true,
      });
    }
    const audioFrames = fakeAacFrames(100, 150);
    let cursor = 0;
    for (const frame of audioFrames) {
      source.addAudioSample({
        data: frame,
        timestampTicks: cursor,
        durationTicks: 1024,
        keyframe: true,
      });
      cursor += 1024;
    }
    const mixed = source.finalize();

    const track = demuxAudioTrack(mixed);
    const audioOnly = remuxAudioOnly(track, mixed);

    assertEqual(isAudioOnlyFile(audioOnly), true, "output has only an audio track");
    assert(audioOnly.byteLength < mixed.byteLength, "output is smaller than the source");

    const reparsed = demuxAudioTrack(audioOnly);
    assertEqual(reparsed.samples.length, 100, "sample count preserved");
    assertEqual(reparsed.sampleRate, 44100, "sample rate preserved");
    assertEqual(reparsed.channels, 1, "channel count preserved");
    assertEqual(reparsed.durationTicks, 100 * 1024, "duration preserved");
  });
}
