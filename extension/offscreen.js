// The worker. Runs inside the offscreen document.
//
// Receives a task name plus the session model, executes it through the
// registry, streams progress back to the service worker, and finishes by
// turning the output into a blob URL — the one thing only a document can do.

import { MSG, TARGET, envelope, isOurs } from "./lib/core/messages.js";
import { errorMessage } from "./lib/core/util.js";
import { getTask } from "./lib/tasks/registry.js";
import { Cancelled } from "./lib/core/net.js";

let controller = null;
/** Blob URLs stay alive until the download completes, then get revoked. */
const liveUrls = new Set();

function toWorker(type, payload) {
  chrome.runtime.sendMessage(envelope(type, payload, TARGET.WORKER)).catch(() => {});
}

/** Coalesce progress so a 137-slide job does not send 137 messages a second. */
function makeReporter() {
  let lastSentAt = 0;
  let pending = null;
  let timer = 0;

  function flush() {
    timer = 0;
    if (!pending) return;
    lastSentAt = Date.now();
    toWorker(MSG.TASK_PROGRESS, pending);
    pending = null;
  }

  return function progress(stage, done, total) {
    pending = { stage, done, total };
    const sinceLast = Date.now() - lastSentAt;
    if (sinceLast >= 120) {
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, 120 - sinceLast);
    }
  };
}

async function execute({ mode, options, model, verdict }) {
  const task = getTask(mode);
  controller = new AbortController();

  const context = {
    model,
    verdict,
    options,
    signal: controller.signal,
    progress: makeReporter(),
    log: (message) => toWorker(MSG.TASK_LOG, { message }),
  };

  try {
    const result = await task.run(context);

    const files = result.files.map((file) => {
      const blob = new Blob([file.bytes], { type: file.mimeType });
      const url = URL.createObjectURL(blob);
      liveUrls.add(url);
      return {
        filename: file.filename,
        url,
        mimeType: file.mimeType,
        byteLength: file.bytes.byteLength,
      };
    });

    toWorker(MSG.TASK_RESULT, { files, summary: result.summary });
  } catch (error) {
    if (error instanceof Cancelled || (error && error.name === "AbortError")) {
      toWorker(MSG.TASK_ERROR, { error: "Cancelled" });
    } else {
      // Log the stack to the offscreen console; the popup only needs the gist.
      console.error("[Lectern] task failed", error);
      toWorker(MSG.TASK_ERROR, { error: errorMessage(error) });
    }
  } finally {
    controller = null;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isOurs(message)) return undefined;
  if (message.target !== TARGET.OFFSCREEN) return undefined;

  switch (message.type) {
    case MSG.RUN_TASK:
      if (controller) {
        sendResponse({ accepted: false, error: "The worker is already busy." });
        return undefined;
      }
      // Reply immediately; the job reports itself as it goes.
      sendResponse({ accepted: true });
      execute(message);
      return undefined;

    case MSG.CANCEL_TASK:
      if (controller) controller.abort();
      sendResponse({ ok: true });
      return undefined;

    case "revoke-url":
      if (message.url) {
        URL.revokeObjectURL(message.url);
        liveUrls.delete(message.url);
      }
      sendResponse({ ok: true });
      return undefined;

    default:
      return undefined;
  }
});

// Anything left when the document is torn down gets released.
addEventListener("pagehide", () => {
  for (const url of liveUrls) URL.revokeObjectURL(url);
  liveUrls.clear();
});
