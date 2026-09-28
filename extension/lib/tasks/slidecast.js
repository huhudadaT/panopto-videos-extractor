// Task: combine the audio and the slides into a video.
//
// Composes the other two tasks rather than duplicating them, then hands the
// result to whichever encoder the user picked.

import { ENCODER, MODE, VIDEO_SIZES } from "../core/constants.js";
import { STAGE } from "../core/messages.js";
import { formatBytes, formatDuration } from "../core/util.js";
import { outputFilename } from "../panopto/media.js";
import { buildSlideManifest } from "../panopto/slides.js";
import { loadAudio } from "./audio.js";
import { loadSlides } from "./slides.js";
import { encodeSlidecast, probeWebCodecsSupport } from "../encode/slidecast-webcodecs.js";
import { probeRecorderSupport, recordSlidecast } from "../encode/slidecast-recorder.js";

export const id = MODE.SLIDECAST;
export const label = "Audio + slides";

function resolveSize(options) {
  const height = options.videoHeight || 720;
  const match = VIDEO_SIZES.find((size) => size.height === height);
  return match || { width: Math.round((height * 16) / 9), height };
}

export async function run(ctx) {
  const { model, options, signal, progress, log } = ctx;
  const { width, height } = resolveSize(options);

  // Audio first: if this fails there is no point downloading 137 images.
  const audio = await loadAudio(ctx);
  const { manifest, images } = await loadSlides(ctx);

  const byIndex = new Map(images.map((image) => [image.index, image]));
  const timing = buildSlideManifest(model, { size: options.slideSize });
  const slides = timing.map((slide) => ({
    index: slide.index,
    time: slide.time,
    duration: slide.duration,
    caption: slide.caption,
    bytes: byIndex.get(slide.index)?.bytes || null,
  }));

  const usable = slides.filter((slide) => slide.bytes).length;
  if (usable === 0) {
    throw Object.assign(new Error("No slide images downloaded, so there is nothing to show"), {
      fatal: true,
    });
  }

  const durationSec = model.durationSec || (audio.track ? audio.track.durationSec : 0);
  let wantFast = options.encoder !== ENCODER.COMPATIBLE;

  if (wantFast && !audio.track) {
    log("The audio track could not be parsed, so the fast encoder cannot mux it — falling back");
    wantFast = false;
  }
  if (wantFast) {
    const support = await probeWebCodecsSupport(width, height);
    if (!support.supported) {
      log(`Fast encoder unavailable (${support.reason}) — falling back`);
      wantFast = false;
    }
  }
  if (!wantFast) {
    const support = probeRecorderSupport();
    if (!support.supported) {
      throw Object.assign(
        new Error(`Neither encoder is available: ${support.reason}`),
        { fatal: true }
      );
    }
  }

  progress(STAGE.ENCODE, 0, 1);

  let encoded;
  if (wantFast) {
    encoded = await encodeSlidecast({
      slides,
      audio: { bytes: audio.bytes, track: audio.track },
      width,
      height,
      frameIntervalSec: options.frameIntervalSec || 2,
      burnCaptions: Boolean(options.burnCaptions),
      durationSec,
      signal,
      onLog: log,
      onProgress: (done, total) => progress(STAGE.ENCODE, done, total),
    });
    log(`Encoded ${encoded.frameCount} frames`);
  } else {
    encoded = await recordSlidecast({
      slides,
      audioBlob: new Blob([audio.bytes], {
        type: audio.container === "mp4" ? "audio/mp4" : "video/mp2t",
      }),
      width,
      height,
      durationSec,
      burnCaptions: Boolean(options.burnCaptions),
      signal,
      onLog: log,
      onProgress: (seconds, total) => progress(STAGE.ENCODE, seconds, total),
    });
  }

  progress(STAGE.ENCODE, 1, 1);

  return {
    files: [
      {
        filename: outputFilename(model, MODE.SLIDECAST, encoded.container),
        bytes: encoded.bytes,
        mimeType: encoded.container === "mp4" ? "video/mp4" : "video/webm",
      },
    ],
    summary:
      `${formatDuration(durationSec)} video, ${width}\u00d7${height}, ` +
      `${usable} slides, ${formatBytes(encoded.bytes.byteLength)}`,
  };
}

export default { id, label, run };
