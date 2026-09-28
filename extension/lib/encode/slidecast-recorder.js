// The compatible slidecast encoder.
//
// Everything the fast path does with WebCodecs, this does with a canvas, an
// <audio> element and MediaRecorder. It is bound to wall-clock time — a
// 56-minute lecture takes 56 minutes — so it is not the default. It exists
// because it depends on nothing exotic: if the fast path hits a driver bug or
// a browser without an H.264 encoder, this still works.
//
// It also streams the audio off a blob URL instead of decoding it, so memory
// stays flat regardless of lecture length.

import { PALETTE } from "../core/constants.js";
import { wrapText } from "../core/util.js";
import { Cancelled } from "../core/net.js";

function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return null;
}

export function probeRecorderSupport() {
  if (typeof MediaRecorder === "undefined") {
    return { supported: false, reason: "MediaRecorder is not available" };
  }
  const mimeType = pickMimeType();
  if (!mimeType) return { supported: false, reason: "No supported WebM encoder" };
  return { supported: true, mimeType };
}

/**
 * Which slide should be on screen at time t. Binary search so this stays cheap
 * when called once per animation frame. Exported for testing.
 */
export function slideAt(slides, timeSec) {
  if (!slides.length) return null;
  let low = 0;
  let high = slides.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (slides[mid].time <= timeSec) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return slides[found];
}

/**
 * @param {{
 *   slides: Array<{index: number, time: number, caption: string, bytes: Uint8Array|null}>,
 *   audioBlob: Blob,
 *   width: number, height: number, durationSec: number,
 *   burnCaptions?: boolean, signal?: AbortSignal,
 *   onProgress?: (done: number, total: number) => void,
 *   onLog?: (message: string) => void
 * }} job
 */
export async function recordSlidecast(job) {
  const {
    slides,
    audioBlob,
    width,
    height,
    durationSec,
    burnCaptions = false,
    signal,
    onProgress,
    onLog,
  } = job;

  const support = probeRecorderSupport();
  if (!support.supported) {
    throw Object.assign(new Error(support.reason), { fatal: true });
  }

  const bitmaps = new Map();
  for (const slide of slides) {
    if (!slide.bytes || slide.bytes.byteLength === 0) continue;
    try {
      bitmaps.set(
        slide.index,
        await createImageBitmap(new Blob([slide.bytes], { type: "image/jpeg" }))
      );
    } catch {
      /* blank frame for this slide */
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });

  const audioUrl = URL.createObjectURL(audioBlob);
  const audio = new Audio();
  audio.src = audioUrl;
  audio.preload = "auto";
  // Muted playback still feeds the graph; this stops the lecture playing aloud
  // for however long the encode takes.
  audio.volume = 0;

  const audioContext = new AudioContext();
  const sourceNode = audioContext.createMediaElementSource(audio);
  const destination = audioContext.createMediaStreamDestination();
  sourceNode.connect(destination);

  const stream = canvas.captureStream(0);
  const videoTrack = stream.getVideoTracks()[0];
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);

  const recorder = new MediaRecorder(stream, {
    mimeType: support.mimeType,
    videoBitsPerSecond: Math.round(width * height * 1.2),
    audioBitsPerSecond: 128000,
  });

  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  let lastDrawnSlide = -1;
  let rafHandle = 0;
  let finished = false;

  function paint() {
    const now = audio.currentTime;
    const slide = slideAt(slides, now);
    const slideIndex = slide ? slide.index : -1;
    if (slideIndex !== lastDrawnSlide) {
      ctx.fillStyle = PALETTE.paper;
      ctx.fillRect(0, 0, width, height);
      const bitmap = bitmaps.get(slideIndex);
      if (bitmap) {
        const scale = Math.min(width / bitmap.width, height / bitmap.height);
        const dw = Math.round(bitmap.width * scale);
        const dh = Math.round(bitmap.height * scale);
        ctx.drawImage(bitmap, Math.round((width - dw) / 2), Math.round((height - dh) / 2), dw, dh);
      }
      if (burnCaptions && slide && slide.caption) {
        const fontSize = Math.round(height / 30);
        const padding = Math.round(fontSize * 0.7);
        ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
        const lines = wrapText(slide.caption, Math.floor(width / (fontSize * 0.55))).slice(0, 2);
        const blockHeight = lines.length * fontSize * 1.35 + padding * 2;
        ctx.fillStyle = "rgba(28, 25, 23, 0.82)";
        ctx.fillRect(0, height - blockHeight, width, blockHeight);
        ctx.fillStyle = PALETTE.paper;
        ctx.textBaseline = "top";
        lines.forEach((line, i) => {
          ctx.fillText(line, padding, height - blockHeight + padding + i * fontSize * 1.35);
        });
      }
      lastDrawnSlide = slideIndex;
    }
    // captureStream(0) means frames are pushed manually, so a static slide
    // costs one frame rather than sixty per second.
    if (videoTrack.requestFrame) videoTrack.requestFrame();
    if (onProgress) onProgress(Math.min(now, durationSec), durationSec);
    if (!finished) rafHandle = requestAnimationFrame(paint);
  }

  function cleanup() {
    finished = true;
    cancelAnimationFrame(rafHandle);
    try {
      audio.pause();
    } catch {
      /* already stopped */
    }
    for (const bitmap of bitmaps.values()) bitmap.close();
    for (const track of stream.getTracks()) track.stop();
    audioContext.close().catch(() => {});
    URL.revokeObjectURL(audioUrl);
  }

  if (onLog) {
    onLog(
      `Recording in real time — this will take about ${Math.ceil(durationSec / 60)} minutes`
    );
  }

  try {
    const bytes = await new Promise((resolve, reject) => {
      recorder.onerror = (event) => reject(event.error || new Error("Recording failed"));
      recorder.onstop = async () => {
        try {
          const blob = new Blob(chunks, { type: support.mimeType });
          resolve(new Uint8Array(await blob.arrayBuffer()));
        } catch (error) {
          reject(error);
        }
      };

      audio.onended = () => {
        if (recorder.state !== "inactive") recorder.stop();
      };
      audio.onerror = () => reject(new Error("The audio track could not be played back"));

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            if (recorder.state !== "inactive") recorder.stop();
            reject(new Cancelled());
          },
          { once: true }
        );
      }

      audio
        .play()
        .then(() => {
          recorder.start(2000);
          paint();
        })
        .catch(reject);
    });

    return { bytes, container: "webm", mimeType: support.mimeType };
  } finally {
    cleanup();
  }
}
