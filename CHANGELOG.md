# Changelog

All notable changes to Lectern are recorded here. Versions follow
[semantic versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2026-09-27

First working version.

### Added
- Three extraction modes: audio only, slides only, and the two combined into a
  video. Availability is decided per session, so a recording without a slide
  timeline only offers audio.
- Session detection from the Panopto viewer page, with DeliveryInfo fetched
  same-origin from a content script so the session cookie applies.
- Audio extraction that never re-encodes. An audio-only source is saved
  byte-for-byte; a source containing video has its AAC track demuxed and
  rewrapped as `.m4a`.
- Slide extraction to a zip containing the stills plus `timeline.json`,
  `slides.txt` (ffmpeg concat list), `outline.txt`, and a `build-slidecast.sh`
  that rebuilds the video offline.
- Two slidecast encoders: a WebCodecs path writing fragmented MP4 at one frame
  per two seconds with a keyframe per slide change, and a `MediaRecorder` path
  writing WebM in real time. The fast path falls back to the slow one on its own
  when H.264 or the audio sample table is unavailable.
- A self-contained ISO BMFF audio demuxer handling both progressive sample
  tables and fragmented `moof`/`trun` layouts, and a fragmented MP4 muxer.
- HLS parsing that recognises Panopto's CMAF byte-range playlists and collapses
  contiguous ranges — the captured 376-segment playlist becomes one request.
- Four fallback routes per slide image, since which one resolves varies by
  tenant.
- On-demand host permission requests, because Panopto's CDN hostname differs per
  institution.
- Test suite with no dependencies, run with `node tests/run.mjs`, using HLS and
  DeliveryInfo fixtures taken from a real capture.

### Notes
- The MP4 muxer and demuxer were validated against ffmpeg: a real AAC file
  demuxed and remuxed decodes bit-identically, and real H.264 passed through the
  muxer is frame-identical by `framemd5`.
- Carrying the source `edts`/`elst` edit list through a remux was required to
  avoid a 21 ms audio offset from the AAC encoder priming delay.
- Sessions using MPEG-TS segments are saved as `.ts` rather than remuxed.

[Unreleased]: https://github.com/OWNER/lectern/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/lectern/releases/tag/v0.1.0
