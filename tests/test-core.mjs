import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clamp,
  collectOrigins,
  concatBytes,
  errorMessage,
  formatBytes,
  formatDuration,
  mapLimit,
  mergeRanges,
  originPattern,
  retry,
  slugify,
  timecode,
  wrapText,
} from "../extension/lib/core/util.js";
import { createZip, crc32, listZipEntries } from "../extension/lib/core/zip.js";
import { planFrames } from "../extension/lib/encode/slidecast-webcodecs.js";
import { slideAt } from "../extension/lib/encode/slidecast-recorder.js";

function haveUnzip() {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default function run({ test, assert, assertEqual, assertDeepEqual, assertClose }) {
  // ---------------------------------------------------------------- formatting

  test("formatBytes scales sensibly", () => {
    assertEqual(formatBytes(0), "0 B", "zero");
    assertEqual(formatBytes(999), "999 B", "bytes");
    assertEqual(formatBytes(1536), "1.5 KB", "kilobytes keep a decimal");
    assertEqual(formatBytes(41720035), "40 MB", "the real fragmented.mp4 size drops the decimal above 10");
    assertEqual(formatBytes(null), "—", "missing value");
  });

  test("formatDuration reads like a player", () => {
    assertEqual(formatDuration(0), "0:00", "zero");
    assertEqual(formatDuration(77.92), "1:18", "rounds to the nearest second");
    assertEqual(formatDuration(3375.065), "56:15", "the captured lecture length");
    assertEqual(formatDuration(3600), "1:00:00", "an hour gains a field");
    assertEqual(formatDuration(-4), "—", "negative");
  });

  test("timecode is ffmpeg-shaped", () => {
    assertEqual(timecode(0), "00:00:00.000", "zero");
    assertEqual(timecode(77.924), "00:01:17.924", "millisecond precision");
    assertEqual(timecode(3661.5), "01:01:01.500", "hours");
  });

  test("slugify makes safe, readable names", () => {
    assertEqual(slugify("Ohm's Law & Kirchhoff"), "ohm-s-law-kirchhoff", "punctuation");
    assertEqual(slugify("2271_BIOENG_1310"), "2271-bioeng-1310", "underscores become dashes");
    assertEqual(slugify("Café Résumé"), "cafe-resume", "diacritics folded");
    assertEqual(slugify(""), "panopto-session", "empty input gets a fallback");
    assertEqual(slugify("a".repeat(200)).length, 70, "length capped");
    assertEqual(slugify("///"), "panopto-session", "all-punctuation input");
  });

  test("wrapText breaks on words", () => {
    assertDeepEqual(wrapText("one two three four", 9), ["one two", "three", "four"], "wrapped");
    assertDeepEqual(wrapText("", 10), [], "empty");
    assertDeepEqual(wrapText("unbreakableword", 5), ["unbreakableword"], "long word kept whole");
  });

  test("clamp and origin helpers", () => {
    assertEqual(clamp(5, 1, 3), 3, "upper bound");
    assertEqual(clamp(-5, 1, 3), 1, "lower bound");
    assertEqual(
      originPattern("https://cdn.example.net/a/b?c=1"),
      "https://cdn.example.net/*",
      "origin pattern"
    );
    assertEqual(originPattern("nonsense"), null, "unparseable");
    assertDeepEqual(
      collectOrigins([
        "https://a.example/1",
        "https://a.example/2",
        "https://b.example/3",
        "junk",
      ]),
      ["https://a.example/*", "https://b.example/*"],
      "deduplicated"
    );
  });

  test("errorMessage copes with anything thrown", () => {
    assertEqual(errorMessage(new Error("boom")), "boom", "Error");
    assertEqual(errorMessage("boom"), "boom", "string");
    assertEqual(errorMessage(null), "Unknown error", "null");
    assertEqual(errorMessage({ code: 7 }), '{"code":7}', "plain object");
  });

  // -------------------------------------------------------------------- ranges

  test("mergeRanges joins touching and overlapping spans", () => {
    assertDeepEqual(
      mergeRanges([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 25, end: 30 },
        { start: 28, end: 40 },
      ]),
      [
        { start: 0, end: 20 },
        { start: 25, end: 40 },
      ],
      "merged"
    );
    assertDeepEqual(
      mergeRanges([
        { start: 100, end: 200 },
        { start: 0, end: 50 },
      ]),
      [
        { start: 0, end: 50 },
        { start: 100, end: 200 },
      ],
      "sorts before merging"
    );
    assertDeepEqual(mergeRanges([]), [], "empty");
  });

  test("concatBytes joins buffers", () => {
    const joined = concatBytes([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([])]);
    assertDeepEqual(Array.from(joined), [1, 2, 3], "joined in order");
    assertEqual(concatBytes([]).byteLength, 0, "empty list");
  });

  // ------------------------------------------------------------- concurrency

  test("mapLimit preserves order and bounds parallelism", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    const seen = [];

    const results = await mapLimit(
      items,
      4,
      async (item) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, item % 3));
        inFlight -= 1;
        return item * 2;
      },
      (done) => seen.push(done)
    );

    assertDeepEqual(results, items.map((i) => i * 2), "results in input order");
    assert(peak <= 4, `concurrency capped, peaked at ${peak}`);
    assertEqual(seen.length, 20, "progress fired once per item");
    assertEqual(seen[seen.length - 1], 20, "progress ends at the total");
  });

  test("mapLimit handles fewer items than workers", async () => {
    const results = await mapLimit([1, 2], 10, async (n) => n + 1);
    assertDeepEqual(results, [2, 3], "still works");
    assertDeepEqual(await mapLimit([], 4, async (n) => n), [], "empty input");
  });

  test("retry backs off then gives up", async () => {
    let calls = 0;
    const value = await retry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("not yet");
        return "ok";
      },
      { attempts: 4, baseDelayMs: 1 }
    );
    assertEqual(value, "ok", "eventually succeeds");
    assertEqual(calls, 3, "stopped as soon as it worked");

    let attempts = 0;
    let threw = false;
    try {
      await retry(
        async () => {
          attempts += 1;
          throw new Error("always");
        },
        { attempts: 3, baseDelayMs: 1 }
      );
    } catch (error) {
      threw = true;
      assertEqual(error.message, "always", "surfaces the last error");
    }
    assert(threw, "gave up");
    assertEqual(attempts, 3, "used its attempts");
  });

  test("retry respects the fatal flag", async () => {
    let attempts = 0;
    try {
      await retry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error("401"), { fatal: true });
        },
        { attempts: 5, baseDelayMs: 1 }
      );
    } catch {
      /* expected */
    }
    assertEqual(attempts, 1, "a fatal error is not retried");
  });

  // ----------------------------------------------------------------------- zip

  test("crc32 matches the known check value", () => {
    // The standard CRC-32 of "123456789" is 0xCBF43926.
    assertEqual(crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "check value");
    assertEqual(crc32(new Uint8Array(0)), 0, "empty input");
  });

  test("createZip writes a readable archive", () => {
    const encoder = new TextEncoder();
    const entries = [
      { name: "01-first.jpg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) },
      { name: "timeline.json", bytes: encoder.encode('{"a":1}') },
      { name: "slides.txt", bytes: encoder.encode("file '01-first.jpg'\nduration 1.500\n") },
    ];
    const zip = createZip(entries, { date: new Date("2026-08-27T17:07:11Z") });

    assertEqual(zip[0], 0x50, "PK signature");
    assertEqual(zip[1], 0x4b, "PK signature");

    const listed = listZipEntries(zip);
    assertDeepEqual(
      listed.map((entry) => entry.name),
      ["01-first.jpg", "timeline.json", "slides.txt"],
      "entries in order"
    );
    assertDeepEqual(
      listed.map((entry) => entry.size),
      entries.map((entry) => entry.bytes.byteLength),
      "sizes recorded"
    );

    // Stored, not deflated, so the payload is findable verbatim.
    const payload = zip.subarray(listed[1].dataOffset, listed[1].dataOffset + listed[1].size);
    assertEqual(new TextDecoder().decode(payload), '{"a":1}', "content stored uncompressed");
  });

  test("createZip handles an empty archive", () => {
    const zip = createZip([]);
    assertEqual(listZipEntries(zip).length, 0, "no entries");
    assertEqual(zip.byteLength, 22, "just the end-of-central-directory record");
  });

  test("a real unzip accepts our archive", () => {
    if (!haveUnzip()) {
      // Nothing to prove on a machine without unzip; the reader test covers it.
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "lectern-zip-"));
    const encoder = new TextEncoder();
    const jpeg = new Uint8Array(4096);
    for (let i = 0; i < jpeg.length; i += 1) jpeg[i] = (i * 31) & 0xff;

    const zip = createZip([
      { name: "01-resistor-configurations.jpg", bytes: jpeg },
      { name: "outline.txt", bytes: encoder.encode("[00:00:00.000] Resistor configurations\n") },
      { name: "build-slidecast.sh", bytes: encoder.encode("#!/usr/bin/env bash\necho hi\n") },
    ]);
    const path = join(dir, "slides.zip");
    writeFileSync(path, zip);

    execFileSync("unzip", ["-tq", path]); // throws on a bad archive
    execFileSync("unzip", ["-q", path, "-d", join(dir, "out")]);

    const extracted = readdirSync(join(dir, "out")).sort();
    assertDeepEqual(
      extracted,
      ["01-resistor-configurations.jpg", "build-slidecast.sh", "outline.txt"],
      "unzip extracted every entry"
    );
    const roundTripped = readFileSync(join(dir, "out", "01-resistor-configurations.jpg"));
    assertEqual(roundTripped.length, jpeg.length, "binary length preserved");
    assertEqual(Buffer.compare(roundTripped, Buffer.from(jpeg)), 0, "binary content preserved");
  });

  // --------------------------------------------------------- the frame planner

  test("planFrames covers the timeline with no gaps", () => {
    const slides = [
      { index: 0, time: 0, duration: 77.924 },
      { index: 1, time: 77.924, duration: 5.587 },
      { index: 2, time: 83.511, duration: 140.815 },
    ];
    const frames = planFrames(slides, 224.326, 2);

    assertEqual(frames[0].timeSec, 0, "starts at zero");
    assertEqual(frames[0].keyframe, true, "opens on a keyframe");
    assert(frames.length > 100, `expected ~112 frames, got ${frames.length}`);

    const last = frames[frames.length - 1];
    assertClose(last.timeSec + last.durationSec, 224.326, 0.01, "runs to the end");

    for (let i = 1; i < frames.length; i += 1) {
      assert(
        frames[i].timeSec > frames[i - 1].timeSec,
        `frame ${i} starts after frame ${i - 1}`
      );
      assertClose(
        frames[i - 1].timeSec + frames[i - 1].durationSec,
        frames[i].timeSec,
        0.02,
        `no gap before frame ${i}`
      );
    }
  });

  test("every slide change is a keyframe, and only slide changes are", () => {
    const slides = [
      { index: 0, time: 0, duration: 10 },
      { index: 1, time: 10, duration: 10 },
      { index: 2, time: 20, duration: 10 },
    ];
    const frames = planFrames(slides, 30, 2);
    const keyframes = frames.filter((frame) => frame.keyframe);
    assertEqual(keyframes.length, 3, "one keyframe per slide");
    assertDeepEqual(
      keyframes.map((frame) => frame.slideIndex),
      [0, 1, 2],
      "keyframes land on the slide boundaries"
    );
    assertDeepEqual(keyframes.map((frame) => frame.timeSec), [0, 10, 20], "at the right times");
  });

  test("a very short slide still gets one frame", () => {
    const slides = [
      { index: 0, time: 0, duration: 0.07 },
      { index: 1, time: 0.07, duration: 30 },
    ];
    const frames = planFrames(slides, 30.07, 2);
    assertEqual(
      frames.filter((frame) => frame.slideIndex === 0).length,
      1,
      "the 70 ms slide is not dropped"
    );
    assert(
      frames.every((frame) => frame.durationSec > 0),
      "no zero-duration frames"
    );
  });

  test("planFrames scales with the interval", () => {
    const slides = [{ index: 0, time: 0, duration: 60 }];
    assertEqual(planFrames(slides, 60, 2).length, 30, "2 s interval");
    assertEqual(planFrames(slides, 60, 4).length, 15, "4 s interval");
    assertEqual(planFrames([], 60, 2).length, 0, "no slides, no frames");
  });

  test("an hour-long lecture stays a manageable frame count", () => {
    // The captured session: 137 slides over 3375 s.
    const slides = Array.from({ length: 137 }, (_, i) => ({
      index: i,
      time: (3375 / 137) * i,
      duration: 3375 / 137,
    }));
    const frames = planFrames(slides, 3375, 2);
    assert(
      frames.length > 1600 && frames.length < 1800,
      `expected ~1700 frames for 56 minutes, got ${frames.length}`
    );
    assertEqual(frames.filter((f) => f.keyframe).length, 137, "137 keyframes");
  });

  test("slideAt finds the slide on screen", () => {
    const slides = [
      { index: 0, time: 0 },
      { index: 1, time: 77.924 },
      { index: 2, time: 83.511 },
      { index: 3, time: 224.326 },
    ];
    assertEqual(slideAt(slides, 0).index, 0, "at the start");
    assertEqual(slideAt(slides, 50).index, 0, "mid first slide");
    assertEqual(slideAt(slides, 77.924).index, 1, "exactly on a boundary");
    assertEqual(slideAt(slides, 80).index, 1, "inside a short slide");
    assertEqual(slideAt(slides, 9999).index, 3, "past the end holds the last slide");
    assertEqual(slideAt(slides, -1).index, 0, "before the start");
    assertEqual(slideAt([], 5), null, "no slides");
  });
}
