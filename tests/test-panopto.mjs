import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildDeliveryInfoRequest,
  cdnSessionBase,
  mediaUrlsFor,
  normalizeDelivery,
  parseViewerUrl,
} from "../extension/lib/panopto/delivery.js";
import {
  classifySession,
  describeSession,
  unavailableReason,
} from "../extension/lib/panopto/classify.js";
import {
  baseFilename,
  outputFilename,
  pickAudioSource,
  pickVideoSource,
  podcastDownloadUrls,
} from "../extension/lib/panopto/media.js";
import {
  buildConcatList,
  buildOutline,
  buildSlideManifest,
  buildTimeline,
  slideUrlCandidates,
} from "../extension/lib/panopto/slides.js";
import { SESSION_KIND } from "../extension/lib/core/constants.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const raw = JSON.parse(readFileSync(join(fixtures, "delivery-audio-only.json"), "utf8"));
const ORIGIN = "https://pitt.hosted.panopto.com";

function audioOnlyModel() {
  return normalizeDelivery(raw, {
    origin: ORIGIN,
    deliveryId: "c2a88244-c557-44fd-9220-b4b3015c4b89",
  });
}

/** Same session, but with a video stream bolted on, to test the other branch. */
function videoModel() {
  const copy = JSON.parse(JSON.stringify(raw));
  copy.Delivery.IsPrimaryAudioOnly = false;
  copy.Delivery.Streams = [
    {
      PublicID: "video-stream",
      StreamHttpUrl:
        "https://d2y36twrtb17ty.cloudfront.net/sessions/5a7b5bfd-1894-4470-a6f0-b4b3015c4b85/video.hls/master.m3u8",
      StreamUrl:
        "https://d2y36twrtb17ty.cloudfront.net/sessions/5a7b5bfd-1894-4470-a6f0-b4b3015c4b85/video.hls/master.m3u8",
      Tag: "",
      Variants: [
        { Bandwidth: 2400000, Url: "https://cdn.example/video.hls/720/index.m3u8" },
        { Bandwidth: 600000, Url: "https://cdn.example/video.hls/360/index.m3u8" },
      ],
      ViewerMediaFileTypeName: "hls",
      RelativeStart: 0,
      RelativeEnd: 3375.065,
    },
  ];
  return normalizeDelivery(copy, { origin: ORIGIN });
}

export default function run({ test, assert, assertEqual, assertDeepEqual, assertClose }) {
  // ------------------------------------------------------------- viewer URLs

  test("parseViewerUrl accepts a real viewer URL", () => {
    const parsed = parseViewerUrl(
      `${ORIGIN}/Panopto/Pages/Viewer.aspx?id=c2a88244-c557-44fd-9220-b4b3015c4b89`
    );
    assertEqual(parsed.isViewer, true, "recognised");
    assertEqual(parsed.deliveryId, "c2a88244-c557-44fd-9220-b4b3015c4b89", "delivery id");
    assertEqual(parsed.origin, ORIGIN, "origin");
  });

  test("parseViewerUrl rejects non-sessions", () => {
    assertEqual(parseViewerUrl("https://example.com/x").isViewer, false, "wrong host");
    assertEqual(
      parseViewerUrl(`${ORIGIN}/Panopto/Pages/Sessions/List.aspx`).isViewer,
      false,
      "folder listing, no session"
    );
    assertEqual(
      parseViewerUrl(`${ORIGIN}/Panopto/Pages/Viewer.aspx?id=not-a-guid`).isViewer,
      false,
      "malformed id"
    );
    assertEqual(parseViewerUrl("").isViewer, false, "empty string");
    assertEqual(
      parseViewerUrl(`${ORIGIN}/Panopto/Pages/Embed.aspx?id=c2a88244-c557-44fd-9220-b4b3015c4b89`)
        .isViewer,
      true,
      "embed pages count"
    );
  });

  test("DeliveryInfo request matches what the viewer sends", () => {
    const request = buildDeliveryInfoRequest(ORIGIN, "abc");
    assertEqual(request.method, "POST", "method");
    assertEqual(
      request.url,
      `${ORIGIN}/Panopto/Pages/Viewer/DeliveryInfo.aspx`,
      "endpoint"
    );
    assertEqual(
      request.headers["Content-Type"],
      "application/x-www-form-urlencoded",
      "form encoded"
    );
    assert(request.body.includes("deliveryId=abc"), "carries the delivery id");
    assert(request.body.includes("responseType=json"), "asks for JSON");
    assert(request.body.includes("refreshAuthCookie=true"), "refreshes the auth cookie");
  });

  // --------------------------------------------------------------- CDN bases

  test("cdnSessionBase strips the :443 Panopto appends", () => {
    assertEqual(
      cdnSessionBase(
        "https://d2y36twrtb17ty.cloudfront.net:443/sessions/5a7b5bfd-1894-4470-a6f0-b4b3015c4b85/x.mp4?InvocationID=1"
      ),
      "https://d2y36twrtb17ty.cloudfront.net/sessions/5a7b5bfd-1894-4470-a6f0-b4b3015c4b85",
      "port removed, query dropped"
    );
    assertEqual(cdnSessionBase("https://cdn.example/nope.mp4"), null, "no sessions segment");
    assertEqual(cdnSessionBase("not a url"), null, "unparseable");
  });

  // ------------------------------------------------------------ normalization

  test("normalizeDelivery flattens the real payload", () => {
    const model = audioOnlyModel();
    assertEqual(model.name, "Thursday, August 27, 2026 at 5:07:11 PM", "session name");
    assertEqual(model.folder, "2271_BIOENG_1310_SEC1025", "folder");
    assertEqual(model.presenter, "Kang Kim", "presenter");
    assertClose(model.durationSec, 3375.065, 0.001, "duration");
    assertEqual(model.isPrimaryAudioOnly, true, "audio-only flag");
    assertEqual(model.sessionFileId, "5a7b5bfd-1894-4470-a6f0-b4b3015c4b85", "session file id");
    assertEqual(
      model.cdnSessionBase,
      "https://d2y36twrtb17ty.cloudfront.net/sessions/5a7b5bfd-1894-4470-a6f0-b4b3015c4b85",
      "CDN base derived from a stream URL"
    );
    assertEqual(model.streams.length, 1, "one stream");
    assertEqual(model.streams[0].isHls, true, "stream is HLS");
    assertEqual(model.streams[0].tag, "AUDIO", "tagged AUDIO");
    assertEqual(model.streams[0].variants.length, 1, "one variant");
    assertEqual(model.podcastStreams.length, 1, "one podcast stream");
    assertEqual(model.podcastStreams[0].isHls, false, "podcast is progressive");
  });

  test("slides keep their sparse sequence numbers and sort by time", () => {
    const model = audioOnlyModel();
    assertEqual(model.slides.length, 6, "slide count");
    assertDeepEqual(
      model.slides.map((s) => s.seq),
      ["65537", "131073", "196610", "262147", "327683", "393220"],
      "sequence numbers are the real sparse values, not indices"
    );
    assertEqual(model.slides[0].time, 0, "first slide at t=0");
    assert(
      model.slides.every((slide, i) => i === 0 || slide.time >= model.slides[i - 1].time),
      "sorted by time"
    );
    assertEqual(model.slides[0].objectId, "348813026", "numeric object id kept for Image.aspx");
    assertEqual(
      model.slides[0].objectPid,
      "e755e98e-85f7-4353-b625-b4b3015c49d2",
      "object PID kept for the CDN path"
    );
  });

  test("normalizeDelivery survives a hostile payload", () => {
    const model = normalizeDelivery({}, { origin: ORIGIN });
    assertEqual(model.slides.length, 0, "no slides");
    assertEqual(model.streams.length, 0, "no streams");
    assertEqual(model.name, "Panopto session", "falls back to a name");
    assertEqual(model.durationSec, 0, "zero duration");
    assertEqual(normalizeDelivery(null, {}).slides.length, 0, "null payload");
  });

  // ------------------------------------------------------------ classification

  test("the captured session classifies as audio plus slides", () => {
    const model = audioOnlyModel();
    const verdict = classifySession(model);
    assertEqual(verdict.kind, SESSION_KIND.AUDIO_SLIDES, "kind");
    assertEqual(verdict.hasVideo, false, "no video encode");
    assertEqual(verdict.hasSlides, true, "has slides");
    assertEqual(verdict.slideCount, 6, "slide count");
    assertDeepEqual(
      verdict.availability,
      { audio: true, slides: true, slidecast: true },
      "all three modes available"
    );
    assertEqual(describeSession(model, verdict), "Audio + slides · 6 slides", "description");
  });

  test("an AUDIO-tagged stream is not mistaken for video", () => {
    const model = audioOnlyModel();
    model.isPrimaryAudioOnly = false; // even if the flag lies
    assertEqual(classifySession(model).hasVideo, false, "the AUDIO tag still wins");
  });

  test("a video session classifies and reports availability", () => {
    const verdict = classifySession(videoModel());
    assertEqual(verdict.kind, SESSION_KIND.VIDEO_SLIDES, "video plus slides");
    assertEqual(verdict.hasVideo, true, "has video");
    assertEqual(verdict.availability.slidecast, true, "can still build a slidecast");
  });

  test("a session with no slides blocks the slide modes", () => {
    const stripped = audioOnlyModel();
    stripped.slides = [];
    const verdict = classifySession(stripped);
    assertEqual(verdict.kind, SESSION_KIND.AUDIO_ONLY, "audio only");
    assertEqual(verdict.availability.audio, true, "audio still fine");
    assertEqual(verdict.availability.slides, false, "slides unavailable");
    assertEqual(verdict.availability.slidecast, false, "slidecast unavailable");
    assertEqual(
      unavailableReason("slides", verdict),
      "No slide timeline in this session",
      "reason given"
    );
    assertEqual(unavailableReason("audio", verdict), null, "no reason for an available mode");
  });

  // ------------------------------------------------------------- media choice

  test("audio picks the progressive podcast over the HLS ladder", () => {
    const source = pickAudioSource(audioOnlyModel());
    assertEqual(source.type, "progressive", "one GET beats a playlist");
    assertEqual(source.container, "mp4", "container");
    assertEqual(source.audioOnlyContainer, true, "no video in the container, so passthrough");
    assert(source.url.includes("2c38b1a1"), "the podcast stream URL");
  });

  test("audio falls back to the lowest HLS rendition", () => {
    const model = audioOnlyModel();
    model.podcastStreams = [];
    const source = pickAudioSource(model);
    assertEqual(source.type, "hls", "HLS route");
    assertEqual(source.audioOnlyContainer, true, "AUDIO tag implies audio-only");
    assert(source.url.endsWith("96003/index.m3u8"), "picked the variant, not the master");
  });

  test("an audio-only session has no video source", () => {
    assertEqual(pickVideoSource(audioOnlyModel()), null, "nothing to pick");
  });

  test("video picks the highest rendition", () => {
    const source = pickVideoSource(videoModel());
    assertEqual(source.type, "hls", "HLS route");
    assert(source.url.includes("720"), `expected the 720 rendition, got ${source.url}`);
  });

  test("video sessions still expose an audio route", () => {
    const source = pickAudioSource(videoModel());
    assertEqual(source.type, "progressive", "podcast mp4");
    assertEqual(
      source.audioOnlyContainer,
      false,
      "podcast holds video too, so the track needs remuxing"
    );
  });

  test("podcast download endpoints are well formed", () => {
    const urls = podcastDownloadUrls(audioOnlyModel());
    assertEqual(urls.length, 2, "video and audio endpoints");
    assert(urls[0].url.includes("mediaTargetType=videoPodcast"), "video podcast");
    assert(urls[1].url.endsWith(".mp3?mediaTargetType=audioPodcast"), "audio podcast");
    assertEqual(podcastDownloadUrls({ origin: null, deliveryId: null }).length, 0, "needs both");
  });

  // ---------------------------------------------------------------- filenames

  test("filenames come out readable and date-led", () => {
    const model = audioOnlyModel();
    assertEqual(
      baseFilename(model),
      "2026-08-27-2271-bioeng-1310-sec1025",
      "date plus folder, lowercased"
    );
    assertEqual(
      outputFilename(model, "slidecast", "mp4"),
      `${baseFilename(model)}-slidecast.mp4`,
      "mode and extension appended"
    );
    const unnamed = audioOnlyModel();
    unnamed.name = "Week 4 / Lecture: Ohm's Law!!";
    unnamed.folder = null;
    assert(
      !/[/:!']/.test(baseFilename(unnamed)),
      `unsafe characters stripped, got ${baseFilename(unnamed)}`
    );
  });

  // ------------------------------------------------------------------- slides

  test("slide URL candidates are ordered CDN first, proxies after", () => {
    const model = audioOnlyModel();
    const urls = slideUrlCandidates(model, model.slides[0], "full");
    assertEqual(urls.length, 4, "four routes to try");
    assertEqual(
      urls[0],
      "https://d2y36twrtb17ty.cloudfront.net/sessions/5a7b5bfd-1894-4470-a6f0-b4b3015c4b85/" +
        "e755e98e-85f7-4353-b625-b4b3015c49d2_et/images/slide65537.jpg",
      "full-size CDN path built from the PID and sequence number"
    );
    assert(urls[1].includes("/thumbs/slide65537.jpg"), "thumb on the CDN as a second try");
    assert(urls[2].includes("Image.aspx?id=348813026&number=65537"), "same-origin full proxy");
    assert(urls[3].includes("Thumb.aspx?"), "same-origin thumb proxy");
    assert(urls[3].includes("isPrimary=false"), "thumb proxy marks the secondary stream");
  });

  test("thumbnail mode asks for thumbs only", () => {
    const model = audioOnlyModel();
    const urls = slideUrlCandidates(model, model.slides[0], "thumb");
    assert(urls[0].includes("/thumbs/"), "thumb path first");
    assertEqual(
      urls.filter((url) => url.includes("/images/")).length,
      0,
      "no full-size CDN request"
    );
  });

  test("slide manifest durations tile the session exactly", () => {
    const model = audioOnlyModel();
    const manifest = buildSlideManifest(model, { size: "full" });
    assertEqual(manifest.length, 6, "one entry per slide");

    for (let i = 1; i < manifest.length; i += 1) {
      assertClose(
        manifest[i - 1].time + manifest[i - 1].duration,
        manifest[i].time,
        0.0001,
        `slide ${i - 1} ends where slide ${i} begins`
      );
    }
    const last = manifest[manifest.length - 1];
    assertClose(last.time + last.duration, model.durationSec, 0.001, "last slide runs to the end");
    assert(
      manifest.every((slide) => slide.duration > 0),
      "no zero-length slides"
    );
  });

  test("slide filenames sort lexicographically in presentation order", () => {
    const manifest = buildSlideManifest(audioOnlyModel(), { size: "full" });
    const names = manifest.map((slide) => slide.filename);
    assertDeepEqual([...names].sort(), names, "already in order");
    assert(/^01-/.test(names[0]), `zero-padded index, got ${names[0]}`);
    assert(names[0].endsWith(".jpg"), "jpg extension");
    assert(
      names[0].includes("resistor-configurations"),
      `caption slugged into the filename, got ${names[0]}`
    );
  });

  test("timeline JSON carries timings and captions", () => {
    const model = audioOnlyModel();
    const manifest = buildSlideManifest(model, { size: "full" });
    const timeline = buildTimeline(model, manifest);

    assertEqual(timeline.generator, "Lectern", "generator recorded");
    assertEqual(timeline.session.audioOnly, true, "audio-only noted");
    assertEqual(timeline.slides.length, 6, "all slides present");
    assertEqual(timeline.slides[0].startTimecode, "00:00:00.000", "first timecode");
    assertEqual(timeline.slides[0].sequenceNumber, "65537", "sequence number preserved");
    assert(
      timeline.session.viewerUrl.includes(model.deliveryId),
      "links back to the lecture"
    );
    // Must survive a JSON round trip; it is written to a file.
    assertDeepEqual(JSON.parse(JSON.stringify(timeline)), timeline, "serialises cleanly");
  });

  test("ffmpeg concat list repeats the final file", () => {
    const manifest = buildSlideManifest(audioOnlyModel(), { size: "full" });
    const list = buildConcatList(manifest);
    const fileLines = list.split("\n").filter((line) => line.startsWith("file "));
    const durationLines = list.split("\n").filter((line) => line.startsWith("duration "));

    assertEqual(fileLines.length, 7, "six slides plus the repeated last one");
    assertEqual(durationLines.length, 6, "one duration per slide");
    assertEqual(
      fileLines[fileLines.length - 1],
      fileLines[fileLines.length - 2],
      "last file repeated so its duration is honoured"
    );
  });

  test("concat list escapes quotes in captions", () => {
    const model = audioOnlyModel();
    model.slides[0].caption = "Ohm's Law";
    const list = buildConcatList(buildSlideManifest(model, { size: "full" }));
    assert(!/file '[^']*'[^\n]*'/.test(list.split("\n")[1]), "no unescaped quote breaks the line");
  });

  test("outline includes timecodes and metadata", () => {
    const model = audioOnlyModel();
    const outline = buildOutline(model, buildSlideManifest(model, { size: "full" }));
    assert(outline.startsWith(model.name), "starts with the session name");
    assert(outline.includes("2271_BIOENG_1310_SEC1025"), "folder included");
    assert(outline.includes("[00:00:00.000]"), "timecodes present");
    assert(outline.includes("Resistor configurations"), "captions present");
  });

  // -------------------------------------------------------------- permissions

  test("mediaUrlsFor covers every host the job will touch", () => {
    const urls = mediaUrlsFor(audioOnlyModel());
    const hosts = new Set(urls.map((url) => new URL(url).hostname));
    assert(hosts.has("d2y36twrtb17ty.cloudfront.net"), "the CDN");
    assert(hosts.has("pitt.hosted.panopto.com"), "the tenant");
  });
}
