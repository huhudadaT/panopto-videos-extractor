// Getting bytes for a stream, whatever shape Panopto hands us.
//
// A "source" from panopto/media.js is either a progressive URL (one GET) or an
// HLS URL that may be a master playlist, a media playlist, or a master that
// points at a media playlist. This resolves all of that and returns the bytes.

import { fetchBytes, fetchPlan, fetchText, short } from "../core/net.js";
import {
  buildFetchPlan,
  isMasterPlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
  pickVariant,
} from "../panopto/hls.js";
import { SOURCE } from "../panopto/media.js";

/**
 * @param {{type: string, url: string, container: string, label: string}} source
 * @param {{signal?: AbortSignal, onProgress?: Function, onLog?: Function,
 *          variantPreference?: 'lowest'|'highest'}} options
 * @returns {Promise<{bytes: Uint8Array, container: 'mp4'|'ts', url: string}>}
 */
export async function downloadStream(source, options = {}) {
  const { signal, onProgress, onLog } = options;

  if (source.type === SOURCE.PROGRESSIVE) {
    if (onLog) onLog(`Fetching ${source.label} from ${short(source.url)}`);
    const bytes = await fetchBytes(source.url, { signal, onProgress });
    return { bytes, container: source.container || "mp4", url: source.url };
  }

  // HLS. Walk down from whatever we were handed to a media playlist.
  let playlistUrl = source.url;
  let text = await fetchText(playlistUrl, { signal });

  if (isMasterPlaylist(text)) {
    const { variants } = parseMasterPlaylist(text, playlistUrl);
    const chosen = pickVariant(variants, options.variantPreference || "lowest");
    if (!chosen) {
      throw Object.assign(new Error("HLS master playlist listed no variants"), {
        fatal: true,
      });
    }
    if (onLog) {
      const rate = Math.round(chosen.bandwidth / 1000);
      onLog(`Chose HLS rendition ${chosen.resolution || `${rate} kbps`} (${chosen.codecs})`);
    }
    playlistUrl = chosen.url;
    text = await fetchText(playlistUrl, { signal });
  }

  const playlist = parseMediaPlaylist(text, playlistUrl);
  if (playlist.segments.length === 0) {
    throw Object.assign(new Error("HLS media playlist contained no segments"), {
      fatal: true,
    });
  }

  const plan = buildFetchPlan(playlist);
  if (onLog) {
    const requestWord = plan.requests.length === 1 ? "request" : "requests";
    onLog(
      `${playlist.segments.length} segments collapse into ${plan.requests.length} ${requestWord}`
    );
  }

  const bytes = await fetchPlan(plan, { signal, onProgress });
  return { bytes, container: plan.container, url: playlistUrl };
}

/** Rough byte estimate for a source, for the progress bar's benefit. */
export function estimateBytes(durationSec, kbps) {
  if (!durationSec || !kbps) return null;
  return Math.round((durationSec * kbps * 1000) / 8);
}
