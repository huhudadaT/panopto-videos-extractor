// Deciding which URL to actually pull.
//
// Panopto hands us up to three routes to the same content:
//   1. PodcastStreams[].StreamUrl  — a progressive .mp4 on the CDN. One GET,
//      no playlist, seekable. Best when it exists.
//   2. Streams[].StreamHttpUrl     — an HLS master playlist. Always present.
//   3. /Panopto/Podcast/Download/  — the tenant's download endpoint. Often
//      disabled by the folder's settings, so it's a last resort.

import { slugify } from "../core/util.js";
import { isAudioOnlyVariant, pickVariant } from "./hls.js";

const SOURCE = {
  PROGRESSIVE: "progressive",
  HLS: "hls",
};

function progressiveFrom(streams) {
  return (
    streams.find((stream) => !stream.isHls && /\.mp4(\?|$)/i.test(stream.url)) || null
  );
}

/**
 * Best route to the audio.
 * @returns {{type: string, url: string, container: string, label: string,
 *            audioOnlyContainer: boolean, stream: object|null}|null}
 */
export function pickAudioSource(model) {
  // An audio-only session's podcast mp4 contains nothing but the AAC track, so
  // it can be saved byte-for-byte with no remuxing at all.
  const podcast = progressiveFrom(model.podcastStreams);
  if (podcast) {
    return {
      type: SOURCE.PROGRESSIVE,
      url: podcast.url,
      container: "mp4",
      label: model.isPrimaryAudioOnly ? "podcast audio (mp4)" : "podcast video (mp4)",
      audioOnlyContainer: Boolean(model.isPrimaryAudioOnly),
      stream: podcast,
    };
  }

  const hls = model.streams.find((stream) => stream.isHls);
  if (hls) {
    const audioTagged = String(hls.tag || "").toUpperCase() === "AUDIO";
    const variant = pickVariant(hls.variants, "lowest");
    return {
      type: SOURCE.HLS,
      url: variant ? variant.url : hls.url,
      masterUrl: hls.url,
      container: "mp4",
      label: audioTagged ? "HLS audio ladder" : "HLS (lowest rendition)",
      audioOnlyContainer: audioTagged || (variant ? isAudioOnlyVariant(variant) : false),
      stream: hls,
    };
  }

  return null;
}

/** Best route to the video. Null when the session has no video encode. */
export function pickVideoSource(model) {
  if (model.isPrimaryAudioOnly) return null;

  const hls = model.streams.find((stream) => stream.isHls && stream.variants.length);
  if (hls) {
    const variant = pickVariant(hls.variants, "highest");
    return {
      type: SOURCE.HLS,
      url: variant ? variant.url : hls.url,
      masterUrl: hls.url,
      container: "mp4",
      label: variant && variant.resolution ? `HLS ${variant.resolution}` : "HLS (best)",
      stream: hls,
    };
  }

  const podcast = progressiveFrom(model.podcastStreams);
  if (podcast) {
    return {
      type: SOURCE.PROGRESSIVE,
      url: podcast.url,
      container: "mp4",
      label: "podcast video (mp4)",
      stream: podcast,
    };
  }

  return null;
}

/** Tenant download endpoints. Frequently 403/404 — offered only as a fallback. */
export function podcastDownloadUrls(model) {
  if (!model.origin || !model.deliveryId) return [];
  const base = `${model.origin}/Panopto/Podcast/Download/${model.deliveryId}`;
  return [
    { url: `${base}.mp4?mediaTargetType=videoPodcast`, container: "mp4" },
    { url: `${base}.mp3?mediaTargetType=audioPodcast`, container: "mp3" },
  ];
}

/** A stable, readable base name: "2026-08-27-resistor-configurations". */
export function baseFilename(model) {
  const parts = [];
  const isoish = model.name.match(/(\w+),\s+(\w+)\s+(\d{1,2}),\s+(\d{4})/);
  if (isoish) {
    const [, , month, day, year] = isoish;
    const monthIndex = [
      "january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december",
    ].indexOf(month.toLowerCase());
    if (monthIndex >= 0) {
      parts.push(
        `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
      );
    }
  }
  if (model.folder) parts.push(slugify(model.folder, 40));
  if (parts.length === 0) parts.push(slugify(model.name, 60));
  return slugify(parts.join("-"), 80);
}

export function outputFilename(model, mode, extension) {
  const suffix = { audio: "audio", slides: "slides", slidecast: "slidecast" }[mode] || mode;
  return `${baseFilename(model)}-${suffix}.${extension}`;
}

export { SOURCE };
