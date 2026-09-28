// Work out what kind of recording this is, and therefore which modes make
// sense. The interesting case — and the reason this project exists — is the
// audio-only session: no video encode at all, just an AAC track plus a list of
// slide stills and the moments they changed.

import { SESSION_KIND } from "../core/constants.js";

function hasVideoStream(model) {
  if (model.isPrimaryAudioOnly) return false;
  return model.streams.some((stream) => {
    if (stream.tag && stream.tag.toUpperCase() === "AUDIO") return false;
    return true;
  });
}

/**
 * @param {ReturnType<import("./delivery.js").normalizeDelivery>} model
 */
export function classifySession(model) {
  const slideCount = model.slides.length;
  const hasSlides = slideCount > 0;
  const hasVideo = hasVideoStream(model);
  const hasAnyAudioSource =
    model.podcastStreams.length > 0 || model.streams.length > 0;

  let kind = SESSION_KIND.UNKNOWN;
  if (hasVideo) kind = hasSlides ? SESSION_KIND.VIDEO_SLIDES : SESSION_KIND.VIDEO;
  else if (hasAnyAudioSource)
    kind = hasSlides ? SESSION_KIND.AUDIO_SLIDES : SESSION_KIND.AUDIO_ONLY;

  const notes = [];
  if (model.isPrimaryAudioOnly) {
    notes.push("Primary stream is audio only — no video encode exists.");
  }
  if (hasSlides && !hasVideo) {
    notes.push(`${slideCount} slide stills with timings are available.`);
  }
  if (!hasSlides) {
    notes.push("This session has no slide timeline.");
  }
  if (hasVideo && hasSlides) {
    notes.push("Video and a separate slide track are both present.");
  }

  return {
    kind,
    hasVideo,
    hasSlides,
    slideCount,
    durationSec: model.durationSec,
    availability: {
      audio: hasAnyAudioSource,
      slides: hasSlides,
      slidecast: hasAnyAudioSource && hasSlides,
    },
    notes,
  };
}

/** Human-readable one-liner for the popup header. */
export function describeSession(model, verdict) {
  const bits = [];
  switch (verdict.kind) {
    case SESSION_KIND.AUDIO_ONLY:
      bits.push("Audio only");
      break;
    case SESSION_KIND.AUDIO_SLIDES:
      bits.push("Audio + slides");
      break;
    case SESSION_KIND.VIDEO:
      bits.push("Video");
      break;
    case SESSION_KIND.VIDEO_SLIDES:
      bits.push("Video + slides");
      break;
    default:
      bits.push("Unrecognised");
  }
  if (verdict.hasSlides) bits.push(`${verdict.slideCount} slides`);
  return bits.join(" · ");
}

/** Why a mode is unavailable, phrased for the user. */
export function unavailableReason(mode, verdict) {
  if (verdict.availability[mode]) return null;
  if (mode === "slides" || mode === "slidecast") {
    if (!verdict.hasSlides) return "No slide timeline in this session";
  }
  if (mode === "audio" || mode === "slidecast") {
    if (!verdict.availability.audio) return "No downloadable media stream";
  }
  return "Not available for this session";
}
