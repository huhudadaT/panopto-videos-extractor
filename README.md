# Lectern

A Chrome extension that pulls the audio, the slides, or a combined video out of
a Panopto lecture recording.

It exists for a specific annoyance: many lecture recordings have no video track
at all. The lecturer records audio over a slide deck, and Panopto stores the
result as an audio stream plus a list of slide stills and the moments they
changed. There is nothing to download and nothing to watch offline. Lectern
puts the two back together.

```
┌─────────────────────────────┐
│  Lectern                    │
│  Audio + slides · 137 slides│
├─────────────────────────────┤
│  Thursday, August 27, 2026  │
│  2271_BIOENG_1310_SEC1025   │
├─────────────────────────────┤
│  EXTRACT                    │
│  ┌───────────────────────┐  │
│  │ Audio only    m4a     │  │
│  │ Slides only   zip     │  │
│  │ Audio + slides   mp4  │  │  ◀ selected
│  └───────────────────────┘  │
│  VIDEO                      │
│  Size          720p    ▾    │
│  Encoder       Fast    ▾    │
│  ☐ Show slide titles        │
├─────────────────────────────┤
│  Log  │      START          │
└─────────────────────────────┘
```

## What it produces

**Audio only** → `.m4a`

The AAC track, never re-encoded. When the source contains nothing but audio it
is saved byte-for-byte; when it also has video, the audio track is demuxed and
rewrapped losslessly.

**Slides only** → `.zip`

The slide stills in presentation order, plus:

| File | What it is |
| --- | --- |
| `NN-slide-caption.jpg` | the stills, named so they sort correctly |
| `timeline.json` | every slide with its start time, duration and extracted text |
| `slides.txt` | an ffmpeg concat list with the real durations |
| `outline.txt` | a timecoded text outline of the lecture |
| `build-slidecast.sh` | rebuilds the video offline from the zip plus an audio file |

**Audio + slides** → `.mp4`

The two combined into a video: each slide held for as long as it was on screen,
with the original audio.

## Install

Not on the Chrome Web Store. Load it unpacked:

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.

Chrome 116 or newer. Chromium-based browsers with `chrome.offscreen` support
should work; Firefox and Safari will not, as the extension depends on offscreen
documents.

## Use

Open a Panopto lecture, click the Lectern icon, pick what you want, click
**Start**.

The first run at a new institution will ask for permission to reach the media
host serving your lectures — Panopto uses a different CDN hostname per tenant,
so the extension asks when it finds out rather than requesting broad access up
front.

Closing the popup does not stop a job. Reopening it resyncs.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| Size | 720p | 1080p, 720p or 540p |
| Encoder | Fast | see below |
| Show slide titles | off | burns the slide caption in as a lower third |
| Resolution | Full | full-size slide images, or thumbnails for a much smaller download |

### The two encoders

**Fast** uses WebCodecs and writes MP4. A slidecast has an enormous duration and
very few distinct pictures, so it is encoded at one frame every two seconds with
a keyframe at each slide change — about 1,700 frames for a 56-minute lecture.
The audio is copied rather than decoded. An hour of lecture takes seconds and
comes out at a few megabytes.

**Compatible** uses `MediaRecorder` and writes WebM. It records the lecture as it
plays, so a 56-minute lecture takes 56 minutes. It is there because it depends
on nothing exotic: if WebCodecs H.264 is missing on your platform, this still
works. Lectern falls back to it automatically when the fast path is
unavailable.

If neither suits, extract the audio and the slides separately and run
`build-slidecast.sh` from the slide zip — it rebuilds the video with ffmpeg.

## Repository layout

```
extension/
  manifest.json
  background.js          service worker: orchestration and saving
  content.js             reads the viewer page, fetches DeliveryInfo
  offscreen.{html,js}    the worker: downloads, demuxes, encodes
  popup.{html,css,js}    the UI
  lib/
    core/                constants, utilities, messaging, network, zip
    panopto/             DeliveryInfo, classification, HLS, media, slides
    media/               MP4 demuxer and fragmented MP4 muxer
    encode/              the two slidecast encoders
    tasks/               the registry and the three tasks
docs/
  PANOPTO-NOTES.md       how Panopto serves a lecture, from a real capture
  ARCHITECTURE.md        why the code is split the way it is
  TROUBLESHOOTING.md
tests/
  run.mjs                node tests/run.mjs
```

## Tests

```bash
node tests/run.mjs
```

No dependencies and no mocks — the tests import the shipping modules. The HLS
and DeliveryInfo fixtures are taken from a real capture, so the suite asserts
against real Panopto output rather than something invented to match the parser.

The MP4 muxer and demuxer were validated against ffmpeg during development: a
real AAC file demuxed and remuxed decodes bit-identically, and real H.264 passed
through the muxer produces frame-identical output by `framemd5`.

## Extending it

`lib/tasks/registry.js` is the only wiring point. A new output type is one
module exporting `{ id, label, run(ctx) }` added to that list; the popup builds
its mode list from the registry and the worker dispatches through it. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Captions are the obvious next addition — they appear in DeliveryInfo under
`AvailableCaptions` and the session used for development had none.

## Notes and limits

- Everything happens locally. No server, no telemetry, no network calls except
  to your own institution's Panopto and its CDN.
- Only works on recordings you can already play. Lectern uses the same endpoints
  the Panopto player uses and adds no access of its own.
- Your institution's policy on recording downloads is yours to check.
- Older sessions using MPEG-TS segments are saved as `.ts` rather than remuxed;
  extracting AAC from a transport stream needs a second demuxer that is not
  written yet.
- Fonts are local-first. Extension pages cannot rely on fetching a webfont, so
  the popup uses Fraunces when it is installed and Georgia otherwise.

## Licence

MIT. See [LICENSE](LICENSE).
