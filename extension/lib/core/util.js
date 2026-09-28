// Small pure helpers. No chrome/DOM at module scope so tests can import this.

import { RETRY } from "./constants.js";

/** Trim a string to a filesystem-safe slug, preserving readability. */
export function slugify(input, maxLength = 70) {
  const base = String(input || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\w\s.-]+/g, " ")
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return base.slice(0, maxLength) || "panopto-session";
}

/** 1234567 -> "1.2 MB" */
export function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** 3375 -> "56:15" */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 77.92 -> "00:01:17.924" (ffmpeg-friendly) */
export function timecode(seconds) {
  const clamped = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s
    .toFixed(3)
    .padStart(6, "0")}`;
}

export function pad(value, width) {
  return String(value).padStart(width, "0");
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Origin pattern for chrome.permissions, e.g. "https://x.cloudfront.net/*" */
export function originPattern(url) {
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return null;
  }
}

/** Unique origin patterns for a list of URLs. */
export function collectOrigins(urls) {
  const set = new Set();
  for (const url of urls) {
    const pattern = originPattern(url);
    if (pattern) set.add(pattern);
  }
  return [...set];
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry with linear-ish backoff. `fn` receives the attempt number (1-based). */
export async function retry(fn, options = {}) {
  const attempts = options.attempts ?? RETRY.attempts;
  const baseDelayMs = options.baseDelayMs ?? RETRY.baseDelayMs;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (error && error.fatal) throw error;
      if (attempt < attempts) await sleep(baseDelayMs * attempt);
    }
  }
  throw lastError;
}

/**
 * Map over items with bounded concurrency, preserving order.
 * `onSettled(doneCount, total)` fires after each item.
 */
export async function mapLimit(items, limit, worker, onSettled) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;
  let done = 0;
  const width = Math.max(1, Math.min(limit, list.length));

  async function runner() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(list[index], index);
      done += 1;
      if (onSettled) onSettled(done, list.length);
    }
  }

  await Promise.all(Array.from({ length: width }, runner));
  return results;
}

/** Concatenate Uint8Arrays into one buffer. */
export function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Merge sorted [start,end) ranges that touch or overlap. */
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

/** Wrap text to a max character width. Used by the caption renderer. */
export function wrapText(text, maxChars) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Turn an unknown throwable into a readable string. */
export function errorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
