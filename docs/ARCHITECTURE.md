# Architecture

## The shape of the problem

Chrome extensions under Manifest V3 split into contexts with different
capabilities, and this job needs capabilities from several of them:

| Needs | Available in |
| --- | --- |
| The Panopto session cookie, same-origin | content script |
| Long-running fetches that survive the popup closing | service worker or offscreen document |
| `URL.createObjectURL` to hand a file to `chrome.downloads` | **not** the service worker |
| Web Audio, `<audio>`, `MediaRecorder` | **not** the service worker |
| `chrome.downloads`, `chrome.permissions` | service worker |
| A user gesture for a permission prompt | popup |

A service-worker-only design cannot actually save a file. So the work is split
four ways, and the split follows capability rather than taste.

```
┌──────────────┐   commands        ┌──────────────────┐
│    popup     │ ────────────────▶ │  service worker  │
│  (UI only)   │ ◀──────────────── │  (orchestrator)  │
└──────────────┘   progress, logs  └──────────────────┘
                                      │           │
              read page, DeliveryInfo │           │ run task
                                      ▼           ▼
                            ┌────────────────┐ ┌──────────────────────┐
                            │ content script │ │ offscreen document   │
                            │  (page origin) │ │ (all the real work)  │
                            └────────────────┘ └──────────────────────┘
```

**popup** — renders state, never holds it. Closing it mid-encode stops nothing;
reopening resyncs from the worker. It owns one thing the others cannot do: the
click that authorises a permission prompt.

**service worker** — routes messages, holds the single job's state, and performs
the download. An open offscreen document keeps it alive, which is why the worker
being killed mid-job is not a concern.

**content script** — answers "which session is this" and fetches DeliveryInfo.
It runs on the Panopto origin, so the cookie is automatic. Declared in the
manifest, therefore a classic script rather than a module, and re-injected via
`chrome.scripting` if the page predates the extension.

**offscreen document** — downloads, demuxes, encodes, packages, and turns the
result into a blob URL. Everything expensive happens here.

## Module layers

```
lib/core/       constants, util, messages, net, zip
lib/panopto/    delivery, classify, hls, media, slides
lib/media/      mp4-demux, mp4-mux
lib/encode/     slidecast-webcodecs, slidecast-recorder
lib/tasks/      registry, audio, slides, slidecast, media-fetch
```

Dependencies point downward only: `tasks` uses `encode`, `media`, `panopto` and
`core`; `panopto` uses `core`; `core` uses nothing. No module imports `chrome.*`
or touches the DOM at load time, which is what lets the test suite import the
shipping files directly instead of mocking them.

## Adding an output type

The registry is the only wiring point. A task is a module exporting
`{ id, label, run(ctx) }`:

```js
export default {
  id: "transcript",
  label: "Transcript",
  async run({ model, options, signal, progress, log }) {
    // …
    return {
      files: [{ filename, bytes, mimeType }],
      summary: "human-readable one-liner",
    };
  },
};
```

Add it to the array in `lib/tasks/registry.js`. The popup builds its mode list
from `listTasks()`, and the offscreen runner dispatches through `getTask()`, so
nothing else changes. Availability comes from
`classify.js → verdict.availability`, which is the one place that decides
whether a mode is offered.

## Two encoders

Combining audio with slides is the only part with a real engineering choice.

**Fast (default)** — WebCodecs `VideoEncoder` into the fragmented MP4 muxer. The
insight is that a lecture slidecast has an enormous duration and almost no
distinct pictures, so it should not be encoded at 30 fps. One frame every two
seconds, with a keyframe at each slide change, gives normal seeking behaviour at
roughly 1,700 frames for a 56-minute lecture. Every frame that is not a slide
change is a near-empty P-frame.

The audio is never decoded. Its AAC frames are copied out of the source file and
into the output, so quality is untouched and memory stays flat. Decoding an hour
of audio to PCM would cost about 650 MB of `Float32Array` and then re-encode it
lossily.

**Compatible** — canvas, `<audio>` and `MediaRecorder`, producing WebM. Bound to
wall-clock time: a 56-minute lecture takes 56 minutes. It exists because it
depends on nothing exotic, and because WebCodecs H.264 availability varies by
platform and driver. `captureStream(0)` with manual `requestFrame()` keeps a
static slide at one frame rather than sixty per second. Audio streams off a blob
URL, so memory stays flat here too.

The slidecast task probes the fast path and falls back on its own if the
encoder, or the audio sample table, is unavailable.

## Error handling

Errors carry a `fatal` flag. `retry()` in `core/util.js` gives up immediately on
a fatal error and backs off otherwise, so a 403 fails fast while a flaky
connection gets three attempts. `net.js` marks 401, 403 and 404 fatal.

Slide downloads are the exception: an individual slide that fails is logged and
skipped, since 136 of 137 slides is a usable result. Only a total failure
aborts.

Cancellation is an `AbortController` in the offscreen document, plumbed through
every fetch and checked between encoder frames.

## Testing

`node tests/run.mjs`. No dependencies, no mocks — the tests import the shipping
modules.

Two fixtures come from a real capture: `fixtures/master.m3u8` and
`fixtures/media.m3u8` are the actual playlists, and
`fixtures/delivery-audio-only.json` reproduces the DeliveryInfo fields from the
same session. That is why the HLS test asserts 376 segments collapsing to one
request, and why the slide test asserts the sparse sequence numbers.

The muxer and demuxer were additionally validated against ffmpeg during
development: a real AAC file demuxed and remuxed decodes bit-identically, and
real H.264 remuxed through the muxer produces frame-identical output by
`framemd5`. Those checks need ffmpeg installed and so are not part of the suite;
`tests/test-mp4.mjs` covers the same ground with a self-contained round trip.

What the suite cannot cover: WebCodecs and MediaRecorder do not exist in Node,
so both encoders are only exercised through `planFrames` and `slideAt`. The
network layer is likewise untested — it is thin on purpose for that reason.
