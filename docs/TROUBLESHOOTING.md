# Troubleshooting

## "Open a Panopto lecture in this tab"

Lectern reads the tab that is in front. It needs a viewer URL:

```
https://<tenant>.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=<guid>
```

A folder listing, a search page, or the Panopto home page will not do. If you
are on a viewer page and still see this, the URL may be missing its `id`
parameter — click the lecture again from the folder.

## "Could not read the lecture page. Try reloading it."

The content script is not answering. Usually this means the page was already
open when Lectern was installed or reloaded. Reload the lecture tab.

## "DeliveryInfo returned 401" or "403"

Your Panopto session has expired. Reload the lecture page, confirm it plays, and
try again.

A 403 on a lecture that plays normally can also mean your institution has
restricted downloads for that folder. The audio and slide routes Lectern uses
are the same ones the player uses, so if playback works there is usually a way
through — check the log for which URL failed.

## "Lectern needs access to the media host"

Panopto serves media from a per-tenant CDN hostname. Lectern ships permission
for `*.cloudfront.net` and the Panopto domains; anything else is requested when
first needed, which is why the prompt appears on the first run at a new
institution. Accepting it is required for the download to start.

If you dismissed the prompt, click **Start** again.

## Every slide fails to download

The log will name the URLs that were tried. Four routes are attempted per slide;
all four failing usually means the session's CDN assets have been purged, or the
auth query parameters in the DeliveryInfo response have expired. Reload the
lecture page and retry — this refreshes the parameters.

If only some slides fail, Lectern carries on and reports the count. A deck with
136 of 137 slides is still worth having.

## The fast encoder falls back on its own

The log says why. Two common causes:

**No H.264 encoder.** WebCodecs H.264 support depends on the platform and, on
Linux, sometimes on the GPU driver. There is no fix from inside the extension;
use the compatible encoder, or extract audio and slides separately and run the
included `build-slidecast.sh`.

**The audio sample table could not be read.** The fast path muxes the source AAC
directly, so it needs to parse the container. An unusual encode can defeat this.
The compatible encoder plays the audio instead of parsing it, so it is
unaffected.

## The slidecast has no sound

Check whether the output is `.webm` (compatible encoder) or `.mp4` (fast). For
WebM, confirm your player handles Opus — VLC, mpv and Chrome all do; some older
QuickTime setups do not. Try playing it in Chrome to rule the file in or out.

## The audio is slightly out of sync

It should not be, and this is worth reporting. The known cause is the AAC
encoder priming delay: the source signals "skip the first 1024 samples" with an
`edts/elst` box, and dropping it on a remux shifts audio about 21 ms late.
Lectern carries the edit list through. If you see a larger or growing offset,
that is a different bug — include the lecture's duration and the log.

## The compatible encoder is taking forever

It is bound to wall-clock time by design: it records the lecture as it plays, so
a 56-minute lecture takes 56 minutes. Leave the tab open. Closing the popup is
fine; closing the browser is not.

Use the fast encoder if you can, or extract audio and slides separately and
rebuild offline with `build-slidecast.sh`.

## The output MP4 will not open in QuickTime

Lectern writes fragmented MP4, which QuickTime handles less reliably than other
players. Chrome, VLC, mpv, IINA and Firefox all play it. To get a progressive
file, remux without re-encoding:

```bash
ffmpeg -i lecture-slidecast.mp4 -c copy -movflags +faststart out.mp4
```

## The video is choppy when I seek

Frames are emitted every two seconds, so seeking lands on a two-second boundary
at worst. This is deliberate — it is what keeps an hour of slides down to a few
megabytes. There is no UI for it, but `frameIntervalSec` in
`lib/core/constants.js` controls it.

## Reading the log

Click **Log** in the popup. It records which media route was chosen, how many
HTTP requests the stream collapsed into, the audio track's parameters, and every
slide that failed. For a stack trace, open `chrome://extensions`, find Lectern,
and click the **offscreen.html** inspect link — task failures are logged there
in full.

## Nothing works and the popup is blank

Open `chrome://extensions`, enable Developer mode, and check for errors on the
Lectern card. Then click the service worker link to see its console. If the
service worker shows a module resolution error, the `extension/` directory was
probably loaded partially — load the whole folder.
