# How Panopto serves a lecture

Notes taken from a real network capture of a viewer session on
`pitt.hosted.panopto.com` (Panopto 17.9.0). Everything here is observed, not
documented by Panopto, so treat it as accurate for that version and verify
before assuming it holds elsewhere.

The capture covered 374 requests on one audio-only recording: 56 minutes of
audio, 137 slides.

---

## Finding the session

A lecture page looks like:

```
https://<tenant>.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=<deliveryId>
```

`deliveryId` is a GUID and the only identifier needed to start. Embedded players
use `Embed.aspx` with the same parameter.

## DeliveryInfo

Everything else comes from one call, which is what the viewer itself makes:

```
POST /Panopto/Pages/Viewer/DeliveryInfo.aspx
Content-Type: application/x-www-form-urlencoded

deliveryId=<guid>&invocationId=&isLiveNotes=false&refreshAuthCookie=true
&isActiveBroadcast=false&isEditing=false&isKollectiveAgentInstalled=false
&isEmbed=false&responseType=json
```

It needs the user's session cookie and returns ~150 KB of JSON. Lectern issues
it from the content script, where the page origin makes the cookie automatic and
CORS irrelevant.

The fields that matter, all under `Delivery`:

| Field | Meaning |
| --- | --- |
| `PublicID` | the delivery id, echoed back |
| `SessionPublicID` / `SessionFileId` | identifies the session's folder on the CDN |
| `SessionName`, `SessionGroupLongName`, `OwnerDisplayName` | title, course, presenter |
| `Duration` | seconds, fractional |
| `IsPrimaryAudioOnly` | **`true` means no video encode exists at all** |
| `Streams[]` | the playback streams, normally HLS |
| `PodcastStreams[]` | a progressive `.mp4`, when one has been produced |
| `Timestamps[]` | the slide timeline |

`IsPodcastEncodeComplete` and `IsAudioPodcastEncodeComplete` say whether the
podcast encodes have finished. `EventTargets` was empty even though the session
had 137 slide events, so it is not a reliable way to find the slide stream — the
PID has to come from `Timestamps[]` instead.

---

## Audio and video

### The easy route: `PodcastStreams`

```json
{
  "StreamUrl": "https://<cdn>/sessions/<sessionFileId>/<deliveryId>-<streamId>.mp4?InvocationID=…&StreamID=…&ServerName=…",
  "ViewerMediaFileTypeName": "mp4"
}
```

A plain progressive MP4: one GET, no playlist, range-seekable. On an audio-only
session it holds nothing but the AAC track, so it can be saved untouched.

Two quirks. Panopto writes the URL with an explicit `:443`, which is harmless
but worth stripping before it reaches a log. And `StreamHttpUrl` is `null` on
podcast streams, so read `StreamUrl`.

### The general route: `Streams`

```json
{
  "Tag": "AUDIO",
  "ViewerMediaFileTypeName": "hls",
  "StreamHttpUrl": "https://<cdn>/sessions/<id>/<…>.hls/master.m3u8?…",
  "Variants": [{ "Bandwidth": 105954, "Url": "https://<cdn>/…/96003/index.m3u8" }]
}
```

`Tag: "AUDIO"` marks an audio-only ladder. It is a more reliable signal than
`IsPrimaryAudioOnly`, so Lectern checks both and treats either as decisive.

### The media playlist is CMAF

This is the most useful thing in the capture. The media playlist does not list
segment files:

```
#EXT-X-VERSION:7
#EXT-X-MAP:URI="fragmented.mp4",BYTERANGE="762@0"
#EXTINF:9.022358,
#EXT-X-BYTERANGE:111662@762
fragmented.mp4
#EXTINF:8.987098,
#EXT-X-BYTERANGE:111088@112424
fragmented.mp4
…
```

All 376 segments point at one `fragmented.mp4`, and their byte ranges are
contiguous from 0 to 41,720,035. So the whole stream is one ranged GET, and the
file that comes back is already a valid fragmented MP4 — no concatenation, no
remuxing needed to make it playable.

Lectern still parses the playlist properly rather than guessing at the file,
because older sessions use discrete `.ts` segments. `buildFetchPlan` merges
contiguous ranges, which turns the CMAF case into a single request on its own.

Per RFC 8216, an `EXT-X-BYTERANGE` with no `@offset` continues from the previous
range on the same resource. Panopto always writes the offset, but the parser
handles the implicit form too.

### CDN authorisation

The CDN URLs carry `InvocationID`, `StreamID` and `ServerName` query parameters.
**There are no CloudFront signed cookies** — no `CloudFront-Policy`,
`CloudFront-Signature` or `CloudFront-Key-Pair-Id` appeared anywhere in the
capture. The query string alone authorises the request, so a URL from
DeliveryInfo can be fetched as-is.

The CDN hostname is per-tenant (`d2y36twrtb17ty.cloudfront.net` here), which is
why Lectern ships `https://*.cloudfront.net/*` and asks for anything else at
run time rather than requesting broad access up front.

---

## Slides

`Timestamps[]` is the slide timeline. One entry per slide change:

```json
{
  "Time": 77.923999999999992,
  "Duration": 5.587,
  "AbsoluteTime": 13432338563.418837,
  "Caption": "Common Node Common Node",
  "Data": "…all the text extracted from the slide…",
  "EventTargetType": "PowerPoint",
  "ObjectIdentifier": "348813026",
  "ObjectPublicIdentifier": "e755e98e-85f7-4353-b625-b4b3015c49d2",
  "ObjectSequenceNumber": "131073"
}
```

**`ObjectSequenceNumber` is not an index.** The values in this session run
65537, 131073, 196610, 262147, 327683, 393220 — sparse integers that look like
packed bitfields. They are the filename key on the CDN and must be carried
through verbatim; deriving them from the array position produces 404s.

`ObjectIdentifier` is a separate numeric id, needed by `Image.aspx`.
`ObjectPublicIdentifier` is the event target's GUID, needed for the CDN path. A
session has one event target, so this repeats on every entry.

`Data` holds the full extracted text of the slide, which makes a usable lecture
outline for free.

### Where the images live

Four routes, tried in this order:

```
1  https://<cdn>/sessions/<sessionFileId>/<objectPid>_et/images/slide<seq>.jpg   (~500 KB)
2  https://<cdn>/sessions/<sessionFileId>/<objectPid>_et/thumbs/slide<seq>.jpg   (~60 KB)
3  https://<tenant>/Panopto/Pages/Viewer/Image.aspx?id=<objectIdentifier>&number=<seq>
4  https://<tenant>/Panopto/Pages/Viewer/Thumb.aspx?eventTargetPID=<objectPid>
       &sessionPID=<sessionPublicId>&number=<seq>&isPrimary=false&absoluteTime=<abs>
```

1 and 2 are direct CDN hits with no query string at all — they returned 200 in
the capture. 3 and 4 are same-origin proxies that 302 to the CDN; they cost a
redirect but work when the CDN path guess is wrong for a tenant.

The `_et` suffix on the directory presumably stands for "event target".

### Timing

`Duration` and the gap to the next slide's `Time` disagree by a few
milliseconds. Lectern derives durations from the gaps instead, so the timeline
sums to `Delivery.Duration` exactly and the last slide runs to the end.

---

## Things that bit us

**Audio drifts one frame late without the edit list.** A remuxed AAC track
decoded 1024 samples (~21 ms) later than the source. AAC encoders prepend
priming samples and signal "skip these" with a `trak/edts/elst` box; dropping it
on a remux shifts everything. Carrying `elst` through makes the decoded output
bit-identical.

**`stsd` and sample-entry boxes are not plain containers.** `stsd` has 8 bytes
of version, flags and entry count before its children; `avc1` has 78 bytes of
`VisualSampleEntry`; `mp4a` has 28 bytes of `AudioSampleEntry`. Walking a box
path without skipping those parses a version field as a box header. Hence the
`CHILD_OFFSETS` table in `mp4-demux.js`.

**`esds` descriptor lengths come in two forms.** The MPEG-4 descriptor length is
7 bits per byte with a continuation bit, so the same value can be written in one
byte or padded to four (`0x80 0x80 0x80 n`). Both appear in the wild.

---

## Endpoints seen but not used

| Endpoint | Note |
| --- | --- |
| `/Panopto/Api/Sessions/<id>/commentThreads` | discussion, not needed |
| `/Panopto/Services/Analytics.svc/AddStreamRequests` | view tracking; Lectern does not call it |
| `/Panopto/Podcast/Download/<id>.mp4?mediaTargetType=videoPodcast` | tenant download endpoint, usually disabled by folder policy; kept as a documented fallback |

Captions were absent here (`HasCaptions: false`, `AvailableCaptions: []`). When
present they would appear under `AvailableCaptions` and are a natural addition.
