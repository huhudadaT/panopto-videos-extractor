// Shared constants. Import-safe in Node (no chrome/DOM references).

export const NAME = "Lectern";

/** The three things the user can ask for. */
export const MODE = {
  AUDIO: "audio",
  SLIDES: "slides",
  SLIDECAST: "slidecast",
};

/** How a slidecast gets encoded. */
export const ENCODER = {
  /** WebCodecs -> fragmented MP4. Faster than real time. */
  FAST: "fast",
  /** MediaRecorder -> WebM. Real time, but works almost everywhere. */
  COMPATIBLE: "compatible",
};

export const SLIDE_SIZE = {
  FULL: "full",
  THUMB: "thumb",
};

export const DEFAULTS = {
  mode: MODE.SLIDECAST,
  encoder: ENCODER.FAST,
  slideSize: SLIDE_SIZE.FULL,
  /** Output height for slidecast video; width follows 16:9. */
  videoHeight: 720,
  /** Seconds between emitted video frames. Lower = smoother seeking, bigger file. */
  frameIntervalSec: 2,
  /** Parallel image downloads. */
  concurrency: 6,
  /** Include a timeline.json + ffmpeg concat list in slide bundles. */
  includeTimeline: true,
  /** Bake slide captions into the slidecast as a lower-third. */
  burnCaptions: false,
};

/** Video heights offered in the popup, with the width we pair them with. */
export const VIDEO_SIZES = [
  { height: 1080, width: 1920, label: "1080p" },
  { height: 720, width: 1280, label: "720p" },
  { height: 540, width: 960, label: "540p" },
];

/** Panopto session shapes we care about. */
export const SESSION_KIND = {
  AUDIO_ONLY: "audio-only",
  AUDIO_SLIDES: "audio+slides",
  VIDEO: "video",
  VIDEO_SLIDES: "video+slides",
  UNKNOWN: "unknown",
};

/** Hosts we ship permission for. Anything else is requested on demand. */
export const KNOWN_MEDIA_HOSTS = [
  "https://*.panopto.com/*",
  "https://*.panopto.eu/*",
  "https://*.cloudfront.net/*",
];

/** Palette, mirrored in popup.css. Used by the caption renderer. */
export const PALETTE = {
  ink: "#1c1917",
  paper: "#faf9f7",
  amber: "#b45309",
  stone: "#78716c",
};

export const RETRY = {
  attempts: 3,
  baseDelayMs: 400,
};
