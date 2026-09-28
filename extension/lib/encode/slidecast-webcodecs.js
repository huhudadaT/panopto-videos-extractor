// The fast slidecast encoder.
//
// A lecture slidecast is an unusual encoding job: an hour long, but with maybe
// 130 distinct pictures in it. So we do not encode at 30 fps. We emit one frame
// every couple of seconds — enough for seeking to feel normal — and make each
// slide change a keyframe. An hour of 720p comes out in a few seconds of work
// and a handful of megabytes, because every frame after a slide change is a
// near-empty P-frame.
//
// The audio is never decoded. Its AAC frames are copied out of the source file
// and into the output, so quality is untouched and memory stays flat.

import { Mp4Muxer } from "../media/mp4-mux.js";
import { PALETTE } from "../core/constants.js";
import { wrapText } from "../core/util.js";
import { Cancelled } from "../core/net.js";

const VIDEO_TIMESCALE = 90000;

/** Does this browser have what we need? */
export async function probeWebCodecsSupport(width = 1280, height = 720) {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
    return { supported: false, reason: "WebCodecs is not available in this browser" };
  }
  const candidates = ["avc1.4d0028", "avc1.4d0020", "avc1.42e01e"];
  for (const codec of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        avc: { format: "avc" },
      });
      if (support.supported) return { supported: true, codec };
    } catch {
      // try the next one
    }
  }
  return { supported: false, reason: "No supported H.264 encoder configuration" };
}

function drawSlide(ctx, bitmap, width, height, caption, burnCaptions) {
  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(0, 0, width, height);

  if (bitmap) {
    // Letterbox rather than crop; slide edges carry content.
    const scale = Math.min(width / bitmap.width, height / bitmap.height);
    const drawWidth = Math.round(bitmap.width * scale);
    const drawHeight = Math.round(bitmap.height * scale);
    const x = Math.round((width - drawWidth) / 2);
    const y = Math.round((height - drawHeight) / 2);
    ctx.drawImage(bitmap, x, y, drawWidth, drawHeight);
  }

  if (burnCaptions && caption) {
    const fontSize = Math.round(height / 30);
    const padding = Math.round(fontSize * 0.7);
    ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
    const lines = wrapText(caption, Math.floor(width / (fontSize * 0.55))).slice(0, 2);
    const blockHeight = lines.length * fontSize * 1.35 + padding * 2;
    ctx.fillStyle = "rgba(28, 25, 23, 0.82)";
    ctx.fillRect(0, height - blockHeight, width, blockHeight);
    ctx.fillStyle = PALETTE.paper;
    ctx.textBaseline = "top";
    lines.forEach((line, index) => {
      ctx.fillText(
        line,
        padding,
        height - blockHeight + padding + index * fontSize * 1.35
      );
    });
  }
}

/**
 * Build the frame schedule: one entry per emitted video frame.
 * Exported so it can be tested without a browser.
 *
 * @param {Array<{index: number, time: number, duration: number}>} slides
 * @param {number} durationSec total media duration
 * @param {number} intervalSec seconds between frames
 * @returns {Array<{slideIndex: number, timeSec: number, durationSec: number, keyframe: boolean}>}
 */
export function planFrames(slides, durationSec, intervalSec) {
  if (!slides.length) return [];
  const interval = Math.max(0.2, intervalSec);
  const total = Math.max(durationSec, slides[slides.length - 1].time + 0.5);
  const frames = [];

  for (let i = 0; i < slides.length; i += 1) {
    const slide = slides[i];
    const start = Math.max(0, slide.time);
    const end = i + 1 < slides.length ? slides[i + 1].time : total;
    const span = Math.max(interval * 0.25, end - start);
    const count = Math.max(1, Math.round(span / interval));
    const step = span / count;

    for (let n = 0; n < count; n += 1) {
      frames.push({
        slideIndex: slide.index,
        timeSec: start + n * step,
        durationSec: step,
        // Every slide change starts a new GOP so seeking lands cleanly.
        keyframe: n === 0,
      });
    }
  }

  // Guard against rounding making a later frame start before an earlier one.
  for (let i = 1; i < frames.length; i += 1) {
    if (frames[i].timeSec <= frames[i - 1].timeSec) {
      frames[i].timeSec = frames[i - 1].timeSec + 0.001;
    }
  }
  return frames;
}

/**
 * Encode a slidecast.
 *
 * @param {{
 *   slides: Array<{index: number, time: number, duration: number, caption: string,
 *                  bytes: Uint8Array|null}>,
 *   audio: {bytes: Uint8Array, track: object}|null,
 *   width: number, height: number, frameIntervalSec: number,
 *   burnCaptions?: boolean, durationSec: number,
 *   signal?: AbortSignal,
 *   onProgress?: (done: number, total: number, note?: string) => void,
 *   onLog?: (message: string) => void
 * }} job
 * @returns {Promise<{bytes: Uint8Array, frameCount: number, codec: string}>}
 */
export async function encodeSlidecast(job) {
  const {
    slides,
    audio,
    width,
    height,
    frameIntervalSec,
    burnCaptions = false,
    durationSec,
    signal,
    onProgress,
    onLog,
  } = job;

  const support = await probeWebCodecsSupport(width, height);
  if (!support.supported) {
    throw Object.assign(new Error(support.reason), { fatal: true });
  }

  const frames = planFrames(slides, durationSec, frameIntervalSec);
  if (frames.length === 0) {
    throw Object.assign(new Error("Nothing to encode — no slides"), { fatal: true });
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: false });

  // Decode each slide image once. 130 bitmaps at ~1600x900 is fine; anything
  // larger is downscaled by the canvas draw anyway.
  const bitmaps = new Map();
  for (const slide of slides) {
    if (signal && signal.aborted) throw new Cancelled();
    if (!slide.bytes || slide.bytes.byteLength === 0) continue;
    try {
      bitmaps.set(
        slide.index,
        await createImageBitmap(new Blob([slide.bytes], { type: "image/jpeg" }))
      );
    } catch {
      if (onLog) onLog(`Slide ${slide.index + 1} image could not be decoded; using a blank frame`);
    }
  }

  const muxer = new Mp4Muxer({
    video: {
      width,
      height,
      timescale: VIDEO_TIMESCALE,
      description: null, // filled in from the encoder's first chunk
    },
    audio: audio
      ? {
          sampleRate: audio.track.sampleRate,
          channels: audio.track.channels,
          timescale: audio.track.timescale,
          description: audio.track.asc,
          primingSamples:
            audio.track.editList && audio.track.editList.mediaTime > 0
              ? audio.track.editList.mediaTime
              : 0,
        }
      : null,
    fragmentSeconds: 4,
  });

  let encoderError = null;
  let description = null;

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (metadata && metadata.decoderConfig && metadata.decoderConfig.description) {
        description = new Uint8Array(metadata.decoderConfig.description);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      muxer.addVideoSample({
        data,
        timestampTicks: Math.round((chunk.timestamp / 1e6) * VIDEO_TIMESCALE),
        durationTicks: Math.max(
          1,
          Math.round(((chunk.duration || 0) / 1e6) * VIDEO_TIMESCALE)
        ),
        keyframe: chunk.type === "key",
      });
    },
    error: (error) => {
      encoderError = error;
    },
  });

  encoder.configure({
    codec: support.codec,
    width,
    height,
    // Slides are flat graphics; they compress hard. This is generous.
    bitrate: Math.round(width * height * 0.35),
    framerate: Math.max(1, Math.round(1 / Math.max(0.2, frameIntervalSec))),
    latencyMode: "quality",
    avc: { format: "avc" },
  });

  if (onLog) {
    onLog(
      `Encoding ${frames.length} frames at ${width}\u00d7${height} (${support.codec})`
    );
  }

  let lastDrawnSlide = -1;
  for (let i = 0; i < frames.length; i += 1) {
    if (signal && signal.aborted) {
      encoder.close();
      throw new Cancelled();
    }
    if (encoderError) throw encoderError;

    const frame = frames[i];
    if (frame.slideIndex !== lastDrawnSlide) {
      const slide = slides.find((s) => s.index === frame.slideIndex);
      drawSlide(
        ctx,
        bitmaps.get(frame.slideIndex) || null,
        width,
        height,
        slide ? slide.caption : "",
        burnCaptions
      );
      lastDrawnSlide = frame.slideIndex;
    }

    const videoFrame = new VideoFrame(canvas, {
      timestamp: Math.round(frame.timeSec * 1e6),
      duration: Math.round(frame.durationSec * 1e6),
    });
    encoder.encode(videoFrame, { keyFrame: frame.keyframe });
    videoFrame.close();

    // Keep the encoder queue short so memory stays bounded on long lectures.
    if (encoder.encodeQueueSize > 12) {
      await new Promise((resolve) => {
        encoder.addEventListener("dequeue", resolve, { once: true });
      });
    }
    if (onProgress && (i % 10 === 0 || i === frames.length - 1)) {
      onProgress(i + 1, frames.length);
    }
  }

  await encoder.flush();
  encoder.close();
  if (encoderError) throw encoderError;

  for (const bitmap of bitmaps.values()) bitmap.close();

  if (!description) {
    throw new Error("Encoder produced no codec description; cannot write the MP4 header");
  }
  muxer.videoConfig.description = description;

  if (audio) {
    let cursor = 0;
    for (const sample of audio.track.samples) {
      muxer.addAudioSample({
        data: audio.bytes.subarray(sample.offset, sample.offset + sample.size),
        timestampTicks: cursor,
        durationTicks: sample.duration,
        keyframe: true,
      });
      cursor += sample.duration;
    }
  }

  return {
    bytes: muxer.finalize(),
    frameCount: frames.length,
    codec: support.codec,
    container: "mp4",
  };
}
