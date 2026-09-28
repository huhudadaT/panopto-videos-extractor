// Service worker. The orchestrator, and deliberately nothing more.
//
// MV3 service workers cannot call URL.createObjectURL and have no Web Audio, so
// they cannot build a file or hand one to chrome.downloads. Everything heavy
// therefore lives in the offscreen document; this module wires the four
// contexts together, owns the job state, and performs the save.

import { CHANNEL, MSG, STAGE, TARGET, envelope, isOurs } from "./lib/core/messages.js";
import { DEFAULTS } from "./lib/core/constants.js";
import { errorMessage } from "./lib/core/util.js";
import {
  mediaUrlsFor,
  normalizeDelivery,
  parseViewerUrl,
} from "./lib/panopto/delivery.js";
import { classifySession, describeSession } from "./lib/panopto/classify.js";

const OFFSCREEN_PATH = "offscreen.html";

/** Single job at a time; two encodes at once would just fight for the GPU. */
let job = null;

function freshJob(tabId, mode) {
  return {
    tabId,
    mode,
    startedAt: Date.now(),
    running: true,
    stage: STAGE.INSPECT,
    done: 0,
    total: 0,
    logs: [],
    result: null,
    error: null,
  };
}

// ---------------------------------------------------------------- popup relay

function toPopup(type, payload) {
  // The popup is often closed. A failed send here is expected, not an error.
  chrome.runtime.sendMessage(envelope(type, payload, TARGET.POPUP)).catch(() => {});
}

function pushLog(message) {
  const line = { at: Date.now(), message };
  if (job) {
    job.logs.push(line);
    if (job.logs.length > 200) job.logs.shift();
  }
  toPopup(MSG.LOG, line);
}

function pushProgress(stage, done, total) {
  if (job) {
    job.stage = stage;
    job.done = done;
    job.total = total;
  }
  toPopup(MSG.PROGRESS, { stage, done, total });
}

// ------------------------------------------------------------ offscreen setup

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    return contexts.length > 0;
  }
  return false;
}

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      // BLOBS covers building the output file; AUDIO_PLAYBACK is needed by the
      // compatible encoder, which plays the lecture through an <audio> element.
      reasons: ["BLOBS", "AUDIO_PLAYBACK"],
      justification:
        "Download lecture media, decode slide images, and encode the combined video.",
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

function toOffscreen(type, payload) {
  return chrome.runtime.sendMessage(envelope(type, payload, TARGET.OFFSCREEN));
}

// --------------------------------------------------------------- page reading

async function askTab(tabId, type, payload = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, { channel: CHANNEL, type, ...payload });
  } catch {
    return null;
  }
}

/** Inject the content script if the page loaded before the extension did. */
async function ensureContentScript(tabId) {
  const probe = await askTab(tabId, MSG.READ_PAGE);
  if (probe && probe.ok) return probe;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (error) {
    throw new Error(
      `Could not reach the lecture page (${errorMessage(error)}). Try reloading it.`
    );
  }
  const retry = await askTab(tabId, MSG.READ_PAGE);
  if (!retry || !retry.ok) {
    throw new Error("Could not read the lecture page. Try reloading it.");
  }
  return retry;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/** Read the open tab and turn DeliveryInfo into our session model. */
async function inspectActiveTab() {
  const tab = await activeTab();
  if (!tab || !tab.id) {
    return { ok: false, error: "No active tab." };
  }

  const parsed = parseViewerUrl(tab.url || "");
  if (!parsed.isViewer) {
    return {
      ok: false,
      notPanopto: true,
      error: "Open a Panopto lecture in this tab, then reopen Lectern.",
    };
  }

  const page = await ensureContentScript(tab.id);
  const reply = await askTab(tab.id, MSG.FETCH_DELIVERY, {
    deliveryId: page.deliveryId || parsed.deliveryId,
  });
  if (!reply) {
    return { ok: false, error: "The lecture page stopped responding. Reload it and retry." };
  }
  if (!reply.ok) {
    return { ok: false, error: reply.error };
  }

  const model = normalizeDelivery(reply.payload, {
    origin: reply.origin,
    deliveryId: reply.deliveryId,
  });
  const verdict = classifySession(model);

  return {
    ok: true,
    tabId: tab.id,
    model,
    verdict,
    description: describeSession(model, verdict),
  };
}

// ----------------------------------------------------------------- permissions

/**
 * Media can sit on a CDN host we did not ship permission for. Ask for it rather
 * than failing at the first fetch. Requires a user gesture, which is why the
 * popup calls this before START.
 */
async function ensureMediaPermissions(model) {
  const origins = [];
  for (const url of mediaUrlsFor(model)) {
    try {
      origins.push(`${new URL(url).origin}/*`);
    } catch {
      /* skip unparseable */
    }
  }
  const unique = [...new Set(origins)];
  if (unique.length === 0) return { granted: true, requested: [] };

  const missing = [];
  for (const origin of unique) {
    const already = await chrome.permissions.contains({ origins: [origin] });
    if (!already) missing.push(origin);
  }
  if (missing.length === 0) return { granted: true, requested: [] };

  return { granted: false, requested: missing };
}

// -------------------------------------------------------------------- the save

async function saveFile(file) {
  // The offscreen document made the blob URL, because we cannot.
  const downloadId = await chrome.downloads.download({
    url: file.url,
    filename: file.filename,
    saveAs: false,
  });
  return downloadId;
}

function revokeIn(url, ms = 120000) {
  setTimeout(() => {
    toOffscreen("revoke-url", { url }).catch(() => {});
  }, ms);
}

// ------------------------------------------------------------------- job start

async function startJob(request) {
  if (job && job.running) {
    return { ok: false, error: "A job is already running." };
  }

  const inspection = await inspectActiveTab();
  if (!inspection.ok) return inspection;

  const mode = request.mode || DEFAULTS.mode;
  if (!inspection.verdict.availability[mode]) {
    return { ok: false, error: `${mode} is not available for this session.` };
  }

  const options = { ...DEFAULTS, ...(request.options || {}) };
  job = freshJob(inspection.tabId, mode);

  toPopup(MSG.STATE, publicState());
  pushLog(`${inspection.model.name}`);
  pushLog(`${inspection.description} · ${Math.round(inspection.model.durationSec)}s`);

  await ensureOffscreen();

  try {
    const response = await toOffscreen(MSG.RUN_TASK, {
      mode,
      options,
      model: inspection.model,
      verdict: inspection.verdict,
    });
    if (!response || !response.accepted) {
      throw new Error((response && response.error) || "The worker did not start.");
    }
  } catch (error) {
    job.running = false;
    job.error = errorMessage(error);
    toPopup(MSG.FAILED, { error: job.error });
    return { ok: false, error: job.error };
  }

  return { ok: true };
}

async function cancelJob() {
  if (!job || !job.running) return { ok: true };
  pushLog("Cancelling…");
  try {
    await toOffscreen(MSG.CANCEL_TASK, {});
  } catch {
    /* offscreen may already be gone */
  }
  job.running = false;
  job.error = "Cancelled";
  toPopup(MSG.FAILED, { error: "Cancelled" });
  return { ok: true };
}

function publicState() {
  if (!job) return { running: false };
  return {
    running: job.running,
    mode: job.mode,
    stage: job.stage,
    done: job.done,
    total: job.total,
    logs: job.logs.slice(-60),
    result: job.result,
    error: job.error,
    elapsedMs: Date.now() - job.startedAt,
  };
}

// ---------------------------------------------------------------- message pump

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isOurs(message)) return undefined;
  // Ignore anything addressed elsewhere, or we would answer the offscreen
  // document's own mail.
  if (message.target && message.target !== TARGET.WORKER) return undefined;

  switch (message.type) {
    case MSG.INSPECT:
      inspectActiveTab()
        .then((result) => {
          if (result.ok) {
            return ensureMediaPermissions(result.model).then((permission) =>
              sendResponse({ ...result, permission })
            );
          }
          return sendResponse(result);
        })
        .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
      return true;

    case MSG.START:
      startJob(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
      return true;

    case MSG.CANCEL:
      cancelJob().then(sendResponse);
      return true;

    case MSG.GET_STATE:
      sendResponse({ ok: true, state: publicState() });
      return undefined;

    // ---- from the offscreen document ----

    case MSG.TASK_PROGRESS:
      pushProgress(message.stage, message.done, message.total);
      return undefined;

    case MSG.TASK_LOG:
      pushLog(message.message);
      return undefined;

    case MSG.TASK_RESULT:
      (async () => {
        try {
          const saved = [];
          for (const file of message.files) {
            pushProgress(STAGE.SAVE, saved.length, message.files.length);
            await saveFile(file);
            revokeIn(file.url);
            saved.push(file.filename);
          }
          pushProgress(STAGE.SAVE, saved.length, message.files.length);
          if (job) {
            job.running = false;
            job.result = { files: saved, summary: message.summary };
          }
          pushLog(`Saved ${saved.join(", ")}`);
          toPopup(MSG.DONE, { files: saved, summary: message.summary });
        } catch (error) {
          if (job) {
            job.running = false;
            job.error = errorMessage(error);
          }
          toPopup(MSG.FAILED, { error: errorMessage(error) });
        }
      })();
      return undefined;

    case MSG.TASK_ERROR:
      if (job) {
        job.running = false;
        job.error = message.error;
      }
      pushLog(`Failed: ${message.error}`);
      toPopup(MSG.FAILED, { error: message.error });
      return undefined;

    default:
      return undefined;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("options").then((stored) => {
    if (!stored.options) chrome.storage.local.set({ options: DEFAULTS });
  });
});
