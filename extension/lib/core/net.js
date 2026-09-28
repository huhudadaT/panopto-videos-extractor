// Fetching, with the three things every download here needs: byte ranges,
// progress, and cancellation.
//
// Requests go out with credentials so the Panopto session cookie is attached.
// Extension pages with matching host permissions are exempt from CORS, which is
// why this runs in the offscreen document rather than a content script.

import { concatBytes, retry } from "./util.js";

export class Cancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "Cancelled";
    this.fatal = true;
  }
}

function assertLive(signal) {
  if (signal && signal.aborted) throw new Cancelled();
}

/**
 * GET a URL as bytes.
 * @param {string} url
 * @param {{range?: {start: number, end: number}, signal?: AbortSignal,
 *          onProgress?: (received: number, total: number|null) => void,
 *          credentials?: RequestCredentials}} options
 * @returns {Promise<Uint8Array>}
 */
export async function fetchBytes(url, options = {}) {
  const { range, signal, onProgress } = options;
  assertLive(signal);

  const headers = {};
  if (range) {
    // HTTP ranges are inclusive on both ends; ours are half-open.
    headers.Range = `bytes=${range.start}-${range.end - 1}`;
  }

  const response = await fetch(url, {
    method: "GET",
    headers,
    credentials: options.credentials || "include",
    signal,
    cache: "no-store",
  });

  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText} for ${short(url)}`);
    error.status = response.status;
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      error.fatal = true;
    }
    throw error;
  }

  const declared = Number(response.headers.get("content-length"));
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;

  if (!response.body || !onProgress) {
    const buffer = await response.arrayBuffer();
    if (onProgress) onProgress(buffer.byteLength, total);
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    assertLive(signal);
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received, total);
  }
  return concatBytes(chunks);
}

export async function fetchText(url, options = {}) {
  const bytes = await fetchBytes(url, options);
  return new TextDecoder().decode(bytes);
}

/** HEAD a URL to learn its size without downloading it. */
export async function probeSize(url, options = {}) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      signal: options.signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    const length = Number(response.headers.get("content-length"));
    return Number.isFinite(length) && length > 0 ? length : null;
  } catch {
    return null;
  }
}

/**
 * Try each URL in turn, returning the first that works. Slides have up to four
 * candidate URLs (CDN full, CDN thumb, Image.aspx, Thumb.aspx) and which one
 * resolves varies by tenant.
 */
export async function fetchFirstAvailable(urls, options = {}) {
  const errors = [];
  for (const url of urls) {
    assertLive(options.signal);
    try {
      const bytes = await retry(() => fetchBytes(url, options), {
        attempts: options.attempts ?? 2,
      });
      if (bytes.byteLength > 0) return { url, bytes };
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      errors.push(`${short(url)}: ${error.message}`);
    }
  }
  const error = new Error(`No candidate URL worked.\n  ${errors.join("\n  ")}`);
  error.fatal = true;
  throw error;
}

/**
 * Execute a fetch plan from hls.buildFetchPlan and concatenate the result.
 * @param {{requests: Array<{url: string, range: object|null, bytes: number|null}>}} plan
 */
export async function fetchPlan(plan, options = {}) {
  const { signal, onProgress } = options;
  const parts = [];
  const totalKnown = plan.knownBytes || null;
  let completed = 0;

  for (const request of plan.requests) {
    assertLive(signal);
    const bytes = await retry(
      () =>
        fetchBytes(request.url, {
          range: request.range,
          signal,
          onProgress: onProgress
            ? (received) => onProgress(completed + received, totalKnown)
            : undefined,
        }),
      { attempts: 3 }
    );
    parts.push(bytes);
    completed += bytes.byteLength;
    if (onProgress) onProgress(completed, totalKnown);
  }

  return concatBytes(parts);
}

/** Shorten a URL for log output — these things are 400 characters long. */
export function short(url) {
  try {
    const parsed = new URL(url);
    const file = parsed.pathname.split("/").filter(Boolean).pop() || parsed.pathname;
    return `${parsed.hostname}/…/${file}`;
  } catch {
    return String(url).slice(0, 80);
  }
}
