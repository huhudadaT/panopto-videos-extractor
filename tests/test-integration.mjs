// End-to-end tests for the task pipeline.
//
// The network is stubbed, but everything else is the real code path a job takes:
// source selection, playlist parsing, byte-range fetching, demuxing, remuxing,
// zip packaging and filename generation. The media fixtures are genuine ffmpeg
// output, so the demuxer is reading a real container.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { normalizeDelivery } from "../extension/lib/panopto/delivery.js";
import { classifySession } from "../extension/lib/panopto/classify.js";
import { getTask } from "../extension/lib/tasks/registry.js";
import { DEFAULTS } from "../extension/lib/core/constants.js";
import { listZipEntries } from "../extension/lib/core/zip.js";
import { demuxAudioTrack, isAudioOnlyFile } from "../extension/lib/media/mp4-demux.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const bin = (name) => new Uint8Array(readFileSync(join(fixtures, name)));
const text = (name) => readFileSync(join(fixtures, name), "utf8");

const raw = JSON.parse(text("delivery-audio-only.json"));
const ORIGIN = "https://pitt.hosted.panopto.com";

/**
 * Stand in for fetch. Routes by URL shape and honours Range headers so the
 * byte-range path is genuinely exercised.
 */
function installFetchStub(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });

    let body = null;
    for (const [pattern, value] of routes) {
      if (typeof pattern === "string" ? url.includes(pattern) : pattern.test(url)) {
        body = typeof value === "function" ? value(url) : value;
        break;
      }
    }

    if (body == null) {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: new Map(),
      };
    }

    let bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;

    const range = (init.headers || {}).Range;
    if (range) {
      const match = /bytes=(\d+)-(\d+)/.exec(range);
      if (match) bytes = bytes.subarray(Number(match[1]), Number(match[2]) + 1);
    }

    return {
      ok: true,
      status: range ? 206 : 200,
      statusText: "OK",
      headers: new Map([["content-length", String(bytes.byteLength)]]),
      body: null, // no stream, so fetchBytes takes the arrayBuffer path
      async arrayBuffer() {
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        );
      },
    };
  };
  return calls;
}

function makeContext(model, overrides = {}) {
  const progressEvents = [];
  const logLines = [];
  return {
    context: {
      model,
      verdict: classifySession(model),
      options: { ...DEFAULTS, ...(overrides.options || {}) },
      signal: undefined,
      progress: (stage, done, total) => progressEvents.push({ stage, done, total }),
      log: (message) => logLines.push(message),
    },
    progressEvents,
    logLines,
  };
}

function audioOnlyModel() {
  return normalizeDelivery(raw, {
    origin: ORIGIN,
    deliveryId: "c2a88244-c557-44fd-9220-b4b3015c4b89",
  });
}

export default function run({ test, assert, assertEqual, assertDeepEqual }) {
  const originalFetch = globalThis.fetch;

  test("audio task saves an audio-only source byte-for-byte", async () => {
    const source = bin("audio-only.m4a");
    installFetchStub([[".mp4", source]]);

    const model = audioOnlyModel();
    const { context, logLines } = makeContext(model);
    const result = await getTask("audio").run(context);

    assertEqual(result.files.length, 1, "one output file");
    const file = result.files[0];
    assertEqual(
      file.filename,
      "2026-08-27-2271-bioeng-1310-sec1025-audio.m4a",
      "filename"
    );
    assertEqual(file.mimeType, "audio/mp4", "mime type");
    assertEqual(file.bytes.byteLength, source.byteLength, "bytes untouched");
    assertEqual(
      Buffer.compare(Buffer.from(file.bytes), Buffer.from(source)),
      0,
      "byte-for-byte identical to the source"
    );
    assert(
      logLines.some((line) => line.includes("byte-for-byte")),
      `log explains the passthrough, got: ${logLines.join(" | ")}`
    );
    assert(
      logLines.some((line) => line.includes("48 kHz")),
      "log reports the track parameters"
    );
  });

  test("audio task strips video from a mixed source", async () => {
    const source = bin("with-video.mp4");
    installFetchStub([[".mp4", source]]);

    // A video session: the podcast stream now carries video too.
    const withVideo = JSON.parse(JSON.stringify(raw));
    withVideo.Delivery.IsPrimaryAudioOnly = false;
    const model = normalizeDelivery(withVideo, { origin: ORIGIN });

    const { context, logLines } = makeContext(model);
    const result = await getTask("audio").run(context);

    const output = result.files[0].bytes;
    assertEqual(isAudioOnlyFile(source), false, "source has video");
    assertEqual(isAudioOnlyFile(output), true, "output does not");
    assert(
      output.byteLength < source.byteLength / 2,
      `output much smaller: ${output.byteLength} vs ${source.byteLength}`
    );

    // The audio must survive intact.
    const before = demuxAudioTrack(source);
    const after = demuxAudioTrack(output);
    assertEqual(after.samples.length, before.samples.length, "same frame count");
    assertEqual(after.sampleRate, before.sampleRate, "same sample rate");
    assertEqual(after.channels, before.channels, "same channel count");
    assertEqual(after.durationTicks, before.durationTicks, "same duration");
    assertDeepEqual(
      Array.from(after.asc),
      Array.from(before.asc),
      "codec config preserved"
    );
    // And the priming trim must carry across, or playback drifts.
    assertEqual(
      after.editList && after.editList.mediaTime,
      before.editList && before.editList.mediaTime,
      "edit list carried through"
    );
    assert(
      logLines.some((line) => line.includes("Stripped the video track")),
      "log explains the remux"
    );
  });

  test("audio task walks the HLS byte-range path", async () => {
    const source = bin("audio-only.m4a");
    // Two segments carving up one file, exactly as Panopto does it.
    const half = Math.floor(source.byteLength / 2);
    const playlist = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:1",
      '#EXT-X-MAP:URI="fragmented.mp4",BYTERANGE="0@0"',
      "#EXTINF:1.0,",
      `#EXT-X-BYTERANGE:${half}@0`,
      "fragmented.mp4",
      "#EXTINF:1.0,",
      `#EXT-X-BYTERANGE:${source.byteLength - half}@${half}`,
      "fragmented.mp4",
      "#EXT-X-ENDLIST",
    ].join("\n");

    const calls = installFetchStub([
      ["master.m3u8", text("master.m3u8")],
      ["index.m3u8", playlist],
      ["fragmented.mp4", source],
    ]);

    // No podcast stream, so the task must go through HLS.
    const model = audioOnlyModel();
    model.podcastStreams = [];

    const { context, logLines } = makeContext(model);
    const result = await getTask("audio").run(context);

    assertEqual(
      Buffer.compare(Buffer.from(result.files[0].bytes), Buffer.from(source)),
      0,
      "reassembled byte-for-byte from ranges"
    );

    const ranged = calls.filter((call) => call.headers.Range);
    assertEqual(ranged.length, 1, "the two contiguous ranges collapsed into one request");
    assertEqual(
      ranged[0].headers.Range,
      `bytes=0-${source.byteLength - 1}`,
      "range covers the whole file"
    );
    assert(
      logLines.some((line) => line.includes("collapse into 1 request")),
      `log reports the collapse, got: ${logLines.join(" | ")}`
    );
  });

  test("audio task reports a dead source clearly", async () => {
    installFetchStub([]); // everything 404s
    const { context } = makeContext(audioOnlyModel());
    let message = null;
    try {
      await getTask("audio").run(context);
    } catch (error) {
      message = error.message;
    }
    assert(message, "the task failed");
    assert(message.includes("404"), `error mentions the status, got: ${message}`);
  });

  test("slides task packages images and sidecars", async () => {
    const jpegs = [bin("slide-0.jpg"), bin("slide-1.jpg"), bin("slide-2.jpg")];
    let served = 0;
    installFetchStub([[/_et\/images\/slide\d+\.jpg$/, () => jpegs[served++ % 3]]]);

    const model = audioOnlyModel();
    const { context } = makeContext(model);
    const result = await getTask("slides").run(context);

    assertEqual(result.files.length, 1, "one zip");
    assertEqual(
      result.files[0].filename,
      "2026-08-27-2271-bioeng-1310-sec1025-slides.zip",
      "filename"
    );
    assertEqual(result.files[0].mimeType, "application/zip", "mime type");

    const entries = listZipEntries(result.files[0].bytes);
    const names = entries.map((entry) => entry.name);

    assertEqual(names.filter((name) => name.endsWith(".jpg")).length, 6, "six slide images");
    assert(names.includes("timeline.json"), "timeline included");
    assert(names.includes("slides.txt"), "concat list included");
    assert(names.includes("outline.txt"), "outline included");
    assert(names.includes("build-slidecast.sh"), "rebuild script included");
    assertEqual(names[0], "01-resistor-configurations.jpg", "first slide named from its caption");

    // The sidecars must be valid, not just present.
    const find = (name) => entries.find((entry) => entry.name === name);
    const read = (entry) =>
      new TextDecoder().decode(
        result.files[0].bytes.subarray(entry.dataOffset, entry.dataOffset + entry.size)
      );

    const timeline = JSON.parse(read(find("timeline.json")));
    assertEqual(timeline.slides.length, 6, "timeline covers every slide");
    assertEqual(timeline.session.audioOnly, true, "session metadata carried");
    assertEqual(timeline.slides[0].sequenceNumber, "65537", "sparse sequence number preserved");

    const concat = read(find("slides.txt"));
    assert(concat.includes("file '01-resistor-configurations.jpg'"), "concat references the image");
    assert(concat.includes("duration "), "concat carries durations");

    const script = read(find("build-slidecast.sh"));
    assert(script.startsWith("#!/usr/bin/env bash"), "script has a shebang");
    assert(script.includes("-f concat -safe 0 -i slides.txt"), "script uses the concat list");
    assert(
      script.includes("2026-08-27-2271-bioeng-1310-sec1025-audio.m4a"),
      "script defaults to the matching audio filename"
    );
  });

  test("slides task tolerates individual failures", async () => {
    const jpeg = bin("slide-0.jpg");
    // Only the CDN thumb route works, and only for even sequence positions.
    installFetchStub([
      [
        /_et\/thumbs\/slide(65537|196610|327683)\.jpg$/,
        () => jpeg,
      ],
    ]);

    const model = audioOnlyModel();
    const { context, logLines } = makeContext(model);
    const result = await getTask("slides").run(context);

    const names = listZipEntries(result.files[0].bytes).map((entry) => entry.name);
    assertEqual(names.filter((name) => name.endsWith(".jpg")).length, 3, "three slides recovered");
    assert(result.summary.includes("3 slides"), `summary reports the count: ${result.summary}`);
    assert(
      logLines.some((line) => line.includes("3 of 6 slides could not be downloaded")),
      `log reports the failures, got: ${logLines.join(" | ")}`
    );

    // The timeline must describe what is actually in the zip, not what was asked for.
    const entries = listZipEntries(result.files[0].bytes);
    const timelineEntry = entries.find((entry) => entry.name === "timeline.json");
    const timeline = JSON.parse(
      new TextDecoder().decode(
        result.files[0].bytes.subarray(
          timelineEntry.dataOffset,
          timelineEntry.dataOffset + timelineEntry.size
        )
      )
    );
    assertEqual(timeline.slides.length, 3, "timeline lists only the slides present");
  });

  test("slides task falls back through the proxy routes", async () => {
    const jpeg = bin("slide-0.jpg");
    // CDN is gone entirely; only the same-origin Image.aspx proxy answers.
    const calls = installFetchStub([["/Panopto/Pages/Viewer/Image.aspx", jpeg]]);

    const { context, logLines } = makeContext(audioOnlyModel());
    const result = await getTask("slides").run(context);

    const names = listZipEntries(result.files[0].bytes).map((entry) => entry.name);
    assertEqual(names.filter((name) => name.endsWith(".jpg")).length, 6, "all slides recovered");
    assert(
      calls.some((call) => call.url.includes("Image.aspx?id=348813026")),
      "used the numeric object id"
    );
    assert(
      logLines.some((line) => line.includes("Image.aspx")),
      "log names the route that worked"
    );
  });

  test("slides task refuses a session with no timeline", async () => {
    installFetchStub([]);
    const model = audioOnlyModel();
    model.slides = [];
    const { context } = makeContext(model);
    let message = null;
    try {
      await getTask("slides").run(context);
    } catch (error) {
      message = error.message;
    }
    assertEqual(message, "This session has no slide timeline", "clear refusal");
  });

  test("progress is reported in stage order", async () => {
    installFetchStub([[".mp4", bin("audio-only.m4a")]]);
    const { context, progressEvents } = makeContext(audioOnlyModel());
    await getTask("audio").run(context);

    const stages = [...new Set(progressEvents.map((event) => event.stage))];
    assertDeepEqual(stages, ["audio", "decode", "package"], "stages in order");
    for (const event of progressEvents) {
      if (event.total) {
        assert(
          event.done <= event.total,
          `progress never exceeds its total (${event.done}/${event.total})`
        );
      }
    }
  });

  // Leave the environment as we found it.
  test("fetch stub is removed", () => {
    globalThis.fetch = originalFetch;
    assertEqual(globalThis.fetch, originalFetch, "restored");
  });
}
