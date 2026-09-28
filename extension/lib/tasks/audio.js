// Task: extract the audio.
//
// Three paths, cheapest first:
//   1. The source is already an audio-only MP4 (every audio-only Panopto
//      session's podcast stream is) — save the bytes untouched. No parsing, no
//      re-encoding, nothing to get wrong.
//   2. The source is an MP4 with video — demux the AAC track and rewrap it as
//      .m4a. Lossless, verified bit-exact against ffmpeg.
//   3. The source is an MPEG-TS ladder — save the .ts. Extracting AAC from TS
//      needs a whole second demuxer, and every player handles .ts anyway.

import { MODE } from "../core/constants.js";
import { STAGE } from "../core/messages.js";
import { demuxAudioTrack, isAudioOnlyFile } from "../media/mp4-demux.js";
import { remuxAudioOnly } from "../media/mp4-mux.js";
import { formatBytes, formatDuration } from "../core/util.js";
import { outputFilename, pickAudioSource } from "../panopto/media.js";
import { downloadStream } from "./media-fetch.js";

export const id = MODE.AUDIO;
export const label = "Audio only";

/** Fetch the audio and return both the bytes and, when possible, its track. */
export async function loadAudio(ctx) {
  const { model, signal, progress, log } = ctx;

  const source = pickAudioSource(model);
  if (!source) {
    throw Object.assign(new Error("This session exposes no downloadable audio"), {
      fatal: true,
    });
  }

  progress(STAGE.AUDIO, 0, 1);
  const downloaded = await downloadStream(source, {
    signal,
    onLog: log,
    variantPreference: "lowest",
    onProgress: (received, total) => progress(STAGE.AUDIO, received, total),
  });
  log(`Audio downloaded: ${formatBytes(downloaded.bytes.byteLength)}`);

  if (downloaded.container !== "mp4") {
    return { ...downloaded, track: null, source, passthrough: true, extension: downloaded.container };
  }

  progress(STAGE.DECODE, 0, 1);
  let track = null;
  try {
    track = demuxAudioTrack(downloaded.bytes);
    log(
      `AAC track: ${track.sampleRate / 1000} kHz, ` +
        `${track.channels === 1 ? "mono" : `${track.channels} ch`}, ` +
        `${track.samples.length} frames, ${formatDuration(track.durationSec)}` +
        (track.fragmented ? " (fragmented)" : "")
    );
  } catch (error) {
    log(`Could not read the audio sample table (${error.message}); saving the container as-is`);
  }
  progress(STAGE.DECODE, 1, 1);

  const alreadyAudioOnly = track ? isAudioOnlyFile(downloaded.bytes) : false;
  return {
    ...downloaded,
    track,
    source,
    // Passthrough when there is no video to strip, or no sample table to read.
    passthrough: alreadyAudioOnly || !track,
    extension: "m4a",
  };
}

export async function run(ctx) {
  const { model, progress, log } = ctx;
  const audio = await loadAudio(ctx);

  progress(STAGE.PACKAGE, 0, 1);

  let bytes = audio.bytes;
  let extension = audio.extension;

  if (audio.container !== "mp4") {
    extension = audio.container;
    log(`Saving the ${extension.toUpperCase()} container unchanged`);
  } else if (audio.passthrough) {
    extension = "m4a";
    log("Source holds nothing but the audio track — saving it byte-for-byte");
  } else {
    bytes = remuxAudioOnly(audio.track, audio.bytes);
    extension = "m4a";
    log(
      `Stripped the video track: ${formatBytes(audio.bytes.byteLength)} \u2192 ${formatBytes(
        bytes.byteLength
      )}`
    );
  }

  progress(STAGE.PACKAGE, 1, 1);

  return {
    files: [
      {
        filename: outputFilename(model, MODE.AUDIO, extension),
        bytes,
        mimeType: extension === "m4a" ? "audio/mp4" : "video/mp2t",
      },
    ],
    summary: `${formatBytes(bytes.byteLength)} of audio`,
  };
}

export default { id, label, run };
