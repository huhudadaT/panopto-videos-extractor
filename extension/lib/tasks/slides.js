// Task: extract the slides.
//
// Output is a zip holding the stills in presentation order plus the metadata
// needed to do something with them later: timeline.json for programmatic use,
// slides.txt as an ffmpeg concat list, outline.txt for pasting into notes, and
// a script that turns the whole thing back into a video offline.

import { MODE, SLIDE_SIZE } from "../core/constants.js";
import { STAGE } from "../core/messages.js";
import { createZip } from "../core/zip.js";
import { Cancelled, fetchFirstAvailable, short } from "../core/net.js";
import { formatBytes, mapLimit } from "../core/util.js";
import { baseFilename, outputFilename } from "../panopto/media.js";
import {
  buildBuildScript,
  buildConcatList,
  buildOutline,
  buildSlideManifest,
  buildTimeline,
} from "../panopto/slides.js";

export const id = MODE.SLIDES;
export const label = "Slides only";

/**
 * Download every slide image. Shared with the slidecast task.
 * @returns {Promise<{manifest: Array, images: Array<{index: number, bytes: Uint8Array|null, url: string|null}>, failures: number}>}
 */
export async function loadSlides(ctx) {
  const { model, options, signal, progress, log } = ctx;
  const size = options.slideSize || SLIDE_SIZE.FULL;
  const manifest = buildSlideManifest(model, { size });

  if (manifest.length === 0) {
    throw Object.assign(new Error("This session has no slide timeline"), { fatal: true });
  }

  log(`${manifest.length} slides to fetch (${size === SLIDE_SIZE.THUMB ? "thumbnails" : "full size"})`);
  progress(STAGE.SLIDES, 0, manifest.length);

  let failures = 0;
  let firstUrlLogged = false;

  const images = await mapLimit(
    manifest,
    options.concurrency || 6,
    async (slide) => {
      try {
        const { url, bytes } = await fetchFirstAvailable(slide.urls, { signal });
        if (!firstUrlLogged) {
          log(`Slide images resolved from ${short(url)}`);
          firstUrlLogged = true;
        }
        return { index: slide.index, bytes, url };
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        failures += 1;
        log(`Slide ${slide.index + 1} unavailable: ${error.message.split("\n")[0]}`);
        return { index: slide.index, bytes: null, url: null };
      }
    },
    (done, total) => progress(STAGE.SLIDES, done, total)
  );

  if (failures === manifest.length) {
    throw Object.assign(
      new Error("Every slide image failed to download. The session may have expired."),
      { fatal: true }
    );
  }
  if (failures > 0) log(`${failures} of ${manifest.length} slides could not be downloaded`);

  return { manifest, images, failures };
}

export async function run(ctx) {
  const { model, options, progress, log } = ctx;
  const { manifest, images, failures } = await loadSlides(ctx);

  progress(STAGE.PACKAGE, 0, 1);

  const byIndex = new Map(images.map((image) => [image.index, image]));
  const entries = [];
  let imageBytes = 0;

  for (const slide of manifest) {
    const image = byIndex.get(slide.index);
    if (!image || !image.bytes) continue;
    entries.push({ name: slide.filename, bytes: image.bytes });
    imageBytes += image.bytes.byteLength;
  }

  if (options.includeTimeline !== false) {
    const encoder = new TextEncoder();
    const present = manifest.filter((slide) => {
      const image = byIndex.get(slide.index);
      return image && image.bytes;
    });

    entries.push({
      name: "timeline.json",
      bytes: encoder.encode(`${JSON.stringify(buildTimeline(model, present), null, 2)}\n`),
    });
    entries.push({ name: "slides.txt", bytes: encoder.encode(buildConcatList(present)) });
    entries.push({ name: "outline.txt", bytes: encoder.encode(buildOutline(model, present)) });
    entries.push({
      name: "build-slidecast.sh",
      bytes: encoder.encode(
        buildBuildScript(
          `${baseFilename(model)}-audio.m4a`,
          `${baseFilename(model)}-slidecast.mp4`
        )
      ),
    });
  }

  const zip = createZip(entries);
  progress(STAGE.PACKAGE, 1, 1);
  log(`Packaged ${entries.length} files, ${formatBytes(zip.byteLength)}`);

  const saved = manifest.length - failures;
  return {
    files: [
      {
        filename: outputFilename(model, MODE.SLIDES, "zip"),
        bytes: zip,
        mimeType: "application/zip",
      },
    ],
    summary: `${saved} slide${saved === 1 ? "" : "s"}, ${formatBytes(imageBytes)} of images`,
  };
}

export default { id, label, run };
