// Talking to Panopto's viewer backend and flattening the reply.
//
// Everything here is derived from a real DeliveryInfo capture. The response is
// ~150 KB of which we want maybe thirty fields, so `normalizeDelivery` throws
// the rest away and gives the rest of the app one small, stable shape.

const VIEWER_PATHS = [
  "/Panopto/Pages/Viewer.aspx",
  "/Panopto/Pages/Embed.aspx",
  "/Panopto/Pages/Sessions/Sessions.aspx",
];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pull the delivery id out of a viewer URL.
 * @returns {{origin: string, host: string, deliveryId: string|null, isViewer: boolean}}
 */
export function parseViewerUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { origin: null, host: null, deliveryId: null, isViewer: false };
  }

  const isPanopto = /(^|\.)panopto\.(com|eu|com\.au)$/i.test(url.hostname);
  const onViewerPath = VIEWER_PATHS.some(
    (path) => url.pathname.toLowerCase() === path.toLowerCase()
  );

  let deliveryId = url.searchParams.get("id") || url.searchParams.get("deliveryId");
  if (deliveryId && !GUID.test(deliveryId)) deliveryId = null;

  return {
    origin: url.origin,
    host: url.hostname,
    deliveryId,
    isViewer: isPanopto && onViewerPath && Boolean(deliveryId),
  };
}

/**
 * The DeliveryInfo call the viewer itself makes. Form-encoded POST, JSON back.
 * Must be issued with the user's Panopto cookies attached.
 */
export function buildDeliveryInfoRequest(origin, deliveryId) {
  const body = new URLSearchParams({
    deliveryId,
    invocationId: "",
    isLiveNotes: "false",
    refreshAuthCookie: "true",
    isActiveBroadcast: "false",
    isEditing: "false",
    isKollectiveAgentInstalled: "false",
    isEmbed: "false",
    responseType: "json",
  });

  return {
    url: `${origin}/Panopto/Pages/Viewer/DeliveryInfo.aspx`,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  };
}

/**
 * Media lives on a CDN under /sessions/<sessionFileId>/. Derive that base from
 * any stream URL so we can address slide images directly.
 */
export function cdnSessionBase(streamUrl) {
  try {
    const url = new URL(streamUrl);
    const match = url.pathname.match(/^(.*\/sessions\/[0-9a-f-]{36})\//i);
    if (!match) return null;
    // Panopto hands back ":443" on https URLs; strip it, it breaks nothing but
    // looks alarming in logs and in some fetch stacks.
    const host = url.port === "443" || url.port === "" ? url.hostname : url.host;
    return `${url.protocol}//${host}${match[1]}`;
  } catch {
    return null;
  }
}

function normalizeStream(stream) {
  if (!stream) return null;
  const url = stream.StreamHttpUrl || stream.StreamUrl || null;
  if (!url) return null;
  const typeName = String(stream.ViewerMediaFileTypeName || "").toLowerCase();
  return {
    id: stream.PublicID || stream.StreamFileId || null,
    tag: stream.Tag || "",
    container: typeName || (url.includes(".m3u8") ? "hls" : "mp4"),
    isHls: typeName === "hls" || url.includes(".m3u8"),
    url,
    relativeStart: Number(stream.RelativeStart) || 0,
    relativeEnd: Number(stream.RelativeEnd) || 0,
    variants: Array.isArray(stream.Variants)
      ? stream.Variants.filter((v) => v && v.Url).map((v) => ({
          bandwidth: Number(v.Bandwidth) || 0,
          url: v.Url,
        }))
      : [],
  };
}

function normalizeSlide(timestamp, index) {
  const seq = String(timestamp.ObjectSequenceNumber ?? "");
  if (!seq) return null;
  return {
    index,
    seq,
    objectId: timestamp.ObjectIdentifier ? String(timestamp.ObjectIdentifier) : null,
    objectPid: timestamp.ObjectPublicIdentifier || null,
    time: Number(timestamp.Time) || 0,
    duration: Number(timestamp.Duration) || 0,
    absoluteTime: timestamp.AbsoluteTime ?? null,
    caption: (timestamp.Caption || "").trim(),
    text: (timestamp.Data || "").trim(),
    sourceType: timestamp.EventTargetType || null,
  };
}

/**
 * Flatten a DeliveryInfo payload.
 * @param {object} raw parsed JSON from DeliveryInfo.aspx
 * @param {{origin: string, deliveryId?: string}} context
 */
export function normalizeDelivery(raw, context = {}) {
  const delivery = (raw && raw.Delivery) || {};

  const streams = (delivery.Streams || []).map(normalizeStream).filter(Boolean);
  const podcastStreams = (delivery.PodcastStreams || [])
    .map(normalizeStream)
    .filter(Boolean);

  const slides = (delivery.Timestamps || [])
    .map(normalizeSlide)
    .filter(Boolean)
    .sort((a, b) => a.time - b.time)
    .map((slide, index) => ({ ...slide, index }));

  const sessionFileId = delivery.SessionFileId || delivery.SessionPublicID || null;
  const anyStreamUrl =
    (streams[0] && streams[0].url) || (podcastStreams[0] && podcastStreams[0].url) || null;

  return {
    origin: context.origin || null,
    deliveryId: delivery.PublicID || context.deliveryId || null,
    sessionId: delivery.SessionPublicID || null,
    sessionFileId,
    name: (delivery.SessionName || "").trim() || "Panopto session",
    folder: (delivery.SessionGroupLongName || "").trim() || null,
    presenter:
      (delivery.OwnerDisplayName || "").trim() ||
      (Array.isArray(delivery.Contributors) && delivery.Contributors[0]
        ? String(delivery.Contributors[0].DisplayName || "").trim()
        : "") ||
      null,
    durationSec: Number(delivery.Duration) || 0,
    isPrimaryAudioOnly: Boolean(delivery.IsPrimaryAudioOnly),
    isPodcastReady: Boolean(delivery.IsPodcastEncodeComplete),
    isAudioPodcastReady: Boolean(delivery.IsAudioPodcastEncodeComplete),
    hasCaptions: Boolean(delivery.HasCaptions),
    streams,
    podcastStreams,
    slides,
    cdnSessionBase: anyStreamUrl ? cdnSessionBase(anyStreamUrl) : null,
  };
}

/** Every remote host the job will touch, for the permission check. */
export function mediaUrlsFor(model) {
  const urls = [];
  for (const stream of [...model.streams, ...model.podcastStreams]) {
    urls.push(stream.url);
    for (const variant of stream.variants) urls.push(variant.url);
  }
  if (model.cdnSessionBase) urls.push(`${model.cdnSessionBase}/probe`);
  if (model.origin) urls.push(model.origin);
  return urls.filter(Boolean);
}
