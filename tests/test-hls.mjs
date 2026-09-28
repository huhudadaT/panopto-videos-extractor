import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildFetchPlan,
  isAudioOnlyVariant,
  isMasterPlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
  pickVariant,
  resolveUrl,
} from "../extension/lib/panopto/hls.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name) => readFileSync(join(fixtures, name), "utf8");

const MASTER_URL =
  "https://d2y36twrtb17ty.cloudfront.net/sessions/5a7b5bfd-1894-4470-a6f0-b4b3015c4b85/" +
  "c2a88244-c557-44fd-9220-b4b3015c4b89-f7260fa5-c565-4234-8591-b4b3016c2234.hls/master.m3u8" +
  "?InvocationID=7c525e26-20b8-f111-829d-12b1cb861383&StreamID=2569b29c-f470-4749-88d9-b4b3015c496f";

export default function run({ test, assert, assertEqual, assertClose }) {
  test("resolveUrl handles relative playlist references", () => {
    assertEqual(
      resolveUrl("https://cdn.example/sessions/abc/x.hls/master.m3u8", "96003/index.m3u8"),
      "https://cdn.example/sessions/abc/x.hls/96003/index.m3u8",
      "relative path joins against the playlist directory"
    );
  });

  test("master playlist from the real capture parses", () => {
    const text = read("master.m3u8");
    assertEqual(isMasterPlaylist(text), true, "detected as a master playlist");

    const { variants } = parseMasterPlaylist(text, MASTER_URL);
    assertEqual(variants.length, 1, "one rendition");
    assertEqual(variants[0].bandwidth, 105954, "bandwidth");
    assertEqual(variants[0].codecs, "mp4a.40.2", "codecs attribute parsed out of quotes");
    assertEqual(isAudioOnlyVariant(variants[0]), true, "recognised as audio-only");
    assert(
      variants[0].url.endsWith("96003/index.m3u8"),
      `variant URL resolved, got ${variants[0].url}`
    );
    // The query string on the master must not leak into the variant path.
    assert(!variants[0].url.includes("InvocationID"), "variant URL is clean");
  });

  test("media playlist from the real capture parses", () => {
    const text = read("media.m3u8");
    assertEqual(isMasterPlaylist(text), false, "not a master playlist");

    const playlist = parseMediaPlaylist(text, "https://cdn.example/x.hls/96003/index.m3u8");
    assertEqual(playlist.targetDuration, 10, "target duration");
    assertEqual(playlist.segments.length, 376, "segment count");

    // EXT-X-MAP: the CMAF init segment lives at the front of the same file.
    assert(playlist.initSegment, "init segment present");
    assertEqual(playlist.initSegment.byteRange.offset, 0, "init starts at 0");
    assertEqual(playlist.initSegment.byteRange.length, 762, "init is 762 bytes");
    assert(
      playlist.initSegment.url.endsWith("fragmented.mp4"),
      "init points at fragmented.mp4"
    );

    // Every segment is a byte range into one file.
    assertEqual(
      playlist.segments.every((s) => s.url === playlist.initSegment.url),
      true,
      "all segments share one URL — this is CMAF"
    );
    assertEqual(playlist.segments[0].byteRange.offset, 762, "first segment follows the init");
    assertEqual(playlist.segments[0].byteRange.length, 111662, "first segment length");
    assertClose(playlist.segments[0].duration, 9.022358, 0.0001, "first segment duration");
    assertClose(playlist.totalDuration, 3375.065, 0.2, "total duration matches the session");
  });

  test("376 contiguous ranges collapse into a single request", () => {
    const playlist = parseMediaPlaylist(
      read("media.m3u8"),
      "https://cdn.example/x.hls/96003/index.m3u8"
    );
    const plan = buildFetchPlan(playlist);

    assertEqual(plan.requests.length, 1, "one HTTP request for the whole stream");
    assertEqual(plan.container, "mp4", "container detected as fragmented MP4");
    assertEqual(plan.requests[0].range.start, 0, "range starts at the init segment");
    assertEqual(plan.requests[0].range.end, 41720035, "range covers the last segment");
    assertEqual(plan.knownBytes, 41720035, "total size known up front");
  });

  test("discrete .ts segments are planned one request each", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:10",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXTINF:9.9,",
      "seg0.ts",
      "#EXTINF:9.9,",
      "seg1.ts",
      "#EXTINF:4.1,",
      "seg2.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");

    const playlist = parseMediaPlaylist(text, "https://cdn.example/a/index.m3u8");
    assertEqual(playlist.segments.length, 3, "segments parsed");
    assertEqual(playlist.initSegment, null, "no init segment");

    const plan = buildFetchPlan(playlist);
    assertEqual(plan.requests.length, 3, "one request per segment");
    assertEqual(plan.container, "ts", "container detected as MPEG-TS");
    assertEqual(plan.requests[0].range, null, "unranged request");
    assertEqual(plan.knownBytes, 0, "size unknown before fetching");
  });

  test("byte ranges without an offset continue from the previous one", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-MAP:URI=\"all.mp4\",BYTERANGE=\"100@0\"",
      "#EXTINF:2,",
      "#EXT-X-BYTERANGE:500@100",
      "all.mp4",
      "#EXTINF:2,",
      "#EXT-X-BYTERANGE:400",
      "all.mp4",
      "#EXT-X-ENDLIST",
    ].join("\n");

    const playlist = parseMediaPlaylist(text, "https://cdn.example/a/index.m3u8");
    assertEqual(playlist.segments[1].byteRange.offset, 600, "offset inferred from the cursor");
    assertEqual(playlist.segments[1].byteRange.length, 400, "length read");

    const plan = buildFetchPlan(playlist);
    assertEqual(plan.requests.length, 1, "still contiguous");
    assertEqual(plan.requests[0].range.end, 1000, "covers all three ranges");
  });

  test("non-contiguous ranges stay separate", () => {
    const text = [
      "#EXTM3U",
      "#EXTINF:2,",
      "#EXT-X-BYTERANGE:100@0",
      "a.mp4",
      "#EXTINF:2,",
      "#EXT-X-BYTERANGE:100@5000",
      "a.mp4",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const plan = buildFetchPlan(parseMediaPlaylist(text, "https://cdn.example/i.m3u8"));
    assertEqual(plan.requests.length, 2, "gap forces a second request");
    assertEqual(plan.knownBytes, 200, "only the wanted bytes counted");
  });

  test("pickVariant selects by preference", () => {
    const variants = [
      { bandwidth: 100, url: "low" },
      { bandwidth: 900, url: "high" },
      { bandwidth: 400, url: "mid" },
    ];
    assertEqual(pickVariant(variants, "lowest").url, "low", "lowest");
    assertEqual(pickVariant(variants, "highest").url, "high", "highest");
    assertEqual(pickVariant([], "lowest"), null, "empty list");
  });

  test("multi-rendition master sorts and classifies", () => {
    const text = [
      "#EXTM3U",
      '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
      "720/index.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42e01e,mp4a.40.2"',
      "360/index.m3u8",
    ].join("\n");
    const { variants } = parseMasterPlaylist(text, "https://cdn.example/x/master.m3u8");
    assertEqual(variants.length, 2, "two renditions");
    assertEqual(variants[0].resolution, "1280x720", "sorted highest first");
    assertEqual(isAudioOnlyVariant(variants[0]), false, "has video");
    assertEqual(pickVariant(variants, "lowest").resolution, "640x360", "lowest pick");
  });
}
