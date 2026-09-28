// HLS parsing, sized for what Panopto actually serves.
//
// Panopto's current encoder emits CMAF: the media playlist lists dozens of
// segments that all point at a single `fragmented.mp4`, distinguished only by
// EXT-X-BYTERANGE. Older sessions still use discrete .ts segments. Both end up
// as "fetch these byte spans in this order and concatenate", which is what
// buildFetchPlan produces.

import { mergeRanges } from "../core/util.js";

export function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

function parseAttributes(line) {
  const attrs = {};
  const body = line.slice(line.indexOf(":") + 1);
  // Split on commas that are not inside double quotes.
  const parts = body.match(/(?:[^,"]|"[^"]*")+/g) || [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    attrs[key] = value;
  }
  return attrs;
}

/** "111662@762" -> {length: 111662, offset: 762} (offset may be undefined) */
function parseByteRange(value) {
  if (!value) return null;
  const [lengthPart, offsetPart] = String(value).split("@");
  const length = Number(lengthPart);
  if (!Number.isFinite(length)) return null;
  const offset = offsetPart === undefined ? undefined : Number(offsetPart);
  return { length, offset: Number.isFinite(offset) ? offset : undefined };
}

export function isMasterPlaylist(text) {
  return /^#EXT-X-STREAM-INF/m.test(text);
}

/**
 * @returns {{variants: Array<{bandwidth: number, averageBandwidth: number, codecs: string, resolution: string|null, url: string}>}}
 */
export function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const attrs = parseAttributes(line);
      pending = {
        bandwidth: Number(attrs.BANDWIDTH) || 0,
        averageBandwidth: Number(attrs["AVERAGE-BANDWIDTH"]) || 0,
        codecs: attrs.CODECS || "",
        resolution: attrs.RESOLUTION || null,
      };
      continue;
    }
    if (line.startsWith("#")) continue;
    if (pending) {
      variants.push({ ...pending, url: resolveUrl(baseUrl, line) });
      pending = null;
    }
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return { variants };
}

/**
 * @returns {{
 *   targetDuration: number,
 *   totalDuration: number,
 *   initSegment: {url: string, byteRange: object|null}|null,
 *   segments: Array<{url: string, byteRange: object|null, duration: number}>
 * }}
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let initSegment = null;
  let targetDuration = 0;
  let pendingDuration = 0;
  let pendingRange = null;
  // Per RFC 8216 a byte range without an offset continues from the previous
  // range on the same resource.
  const cursorByUrl = new Map();

  function nextOffset(url, range) {
    if (range.offset !== undefined) return range.offset;
    return cursorByUrl.get(url) || 0;
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-TARGETDURATION")) {
      targetDuration = Number(line.split(":")[1]) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-MAP")) {
      const attrs = parseAttributes(line);
      const url = resolveUrl(baseUrl, attrs.URI || "");
      const range = parseByteRange(attrs.BYTERANGE);
      if (range) {
        const offset = nextOffset(url, range);
        initSegment = { url, byteRange: { offset, length: range.length } };
        cursorByUrl.set(url, offset + range.length);
      } else {
        initSegment = { url, byteRange: null };
      }
      continue;
    }
    if (line.startsWith("#EXTINF")) {
      pendingDuration = parseFloat(line.split(":")[1]) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE")) {
      pendingRange = parseByteRange(line.split(":")[1]);
      continue;
    }
    if (line.startsWith("#")) continue;

    const url = resolveUrl(baseUrl, line);
    let byteRange = null;
    if (pendingRange) {
      const offset = nextOffset(url, pendingRange);
      byteRange = { offset, length: pendingRange.length };
      cursorByUrl.set(url, offset + pendingRange.length);
    }
    segments.push({ url, byteRange, duration: pendingDuration });
    pendingDuration = 0;
    pendingRange = null;
  }

  const totalDuration = segments.reduce((sum, seg) => sum + seg.duration, 0);
  return { targetDuration, totalDuration, initSegment, segments };
}

/**
 * Collapse a playlist into the smallest set of HTTP requests that reproduce the
 * stream byte-for-byte, in order.
 *
 * For CMAF this usually becomes a single entry covering the whole
 * `fragmented.mp4`, which is both the fastest and the most robust thing to do.
 *
 * @returns {{
 *   requests: Array<{url: string, range: {start: number, end: number}|null, bytes: number|null}>,
 *   knownBytes: number,
 *   container: 'mp4'|'ts'
 * }}
 */
export function buildFetchPlan(playlist) {
  const ordered = [];
  if (playlist.initSegment) ordered.push(playlist.initSegment);
  ordered.push(...playlist.segments);

  const requests = [];
  let knownBytes = 0;

  // Group consecutive entries that share a URL so contiguous ranges collapse.
  let group = null;
  for (const entry of ordered) {
    if (!group || group.url !== entry.url) {
      group = { url: entry.url, ranges: [], anyUnranged: false };
      requests.push(group);
    }
    if (entry.byteRange) {
      group.ranges.push({
        start: entry.byteRange.offset,
        end: entry.byteRange.offset + entry.byteRange.length,
      });
    } else {
      group.anyUnranged = true;
    }
  }

  const flat = [];
  for (const item of requests) {
    if (item.anyUnranged || item.ranges.length === 0) {
      flat.push({ url: item.url, range: null, bytes: null });
      continue;
    }
    for (const range of mergeRanges(item.ranges)) {
      flat.push({ url: item.url, range, bytes: range.end - range.start });
      knownBytes += range.end - range.start;
    }
  }

  const firstUrl = flat.length ? flat[0].url : "";
  const container = /\.ts(\?|$)/i.test(firstUrl) ? "ts" : "mp4";

  return { requests: flat, knownBytes, container };
}

/** Pick a variant: lowest bandwidth for audio jobs, highest for video. */
export function pickVariant(variants, preference = "highest") {
  if (!variants || variants.length === 0) return null;
  const sorted = [...variants].sort((a, b) => a.bandwidth - b.bandwidth);
  return preference === "lowest" ? sorted[0] : sorted[sorted.length - 1];
}

/** True when the variant's CODECS attribute only mentions audio. */
export function isAudioOnlyVariant(variant) {
  if (!variant || !variant.codecs) return false;
  const codecs = variant.codecs.split(",").map((c) => c.trim().toLowerCase());
  return codecs.length > 0 && codecs.every((c) => c.startsWith("mp4a") || c.startsWith("opus"));
}
