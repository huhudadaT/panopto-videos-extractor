// Popup. Stateless by design: the job lives in the service worker, so closing
// this window mid-encode does not stop anything, and reopening it resyncs.

import { MSG, STAGE_LABEL, TARGET, envelope, isOurs } from "./lib/core/messages.js";
import { DEFAULTS, ENCODER, MODE } from "./lib/core/constants.js";
import { formatBytes, formatDuration } from "./lib/core/util.js";
import { unavailableReason } from "./lib/panopto/classify.js";
import { listTasks } from "./lib/tasks/registry.js";

const el = (id) => document.getElementById(id);

const ui = {
  kind: el("session-kind"),
  session: el("session"),
  name: el("session-name"),
  detail: el("session-detail"),
  notice: el("notice"),
  noticeText: el("notice-text"),
  noticeAction: el("notice-action"),
  controls: el("controls"),
  modes: el("modes"),
  videoOptions: el("video-options"),
  slideOptions: el("slide-options"),
  videoHeight: el("video-height"),
  encoder: el("encoder"),
  burnCaptions: el("burn-captions"),
  slideSize: el("slide-size"),
  progress: el("progress"),
  stageLabel: el("stage-label"),
  stageCount: el("stage-count"),
  fill: el("fill"),
  result: el("result"),
  resultText: el("result-text"),
  go: el("go"),
  cancel: el("cancel"),
  logToggle: el("log-toggle"),
  log: el("log"),
};

let inspection = null;
let options = { ...DEFAULTS };
let mode = DEFAULTS.mode;
let pendingPermissions = [];

function send(type, payload = {}) {
  return chrome.runtime.sendMessage(envelope(type, payload, TARGET.WORKER));
}

// ------------------------------------------------------------------- rendering

function showNotice(text, { bad = false, actionLabel = null, onAction = null } = {}) {
  ui.noticeText.textContent = text;
  ui.notice.classList.toggle("bad", bad);
  ui.notice.hidden = false;
  if (actionLabel) {
    ui.noticeAction.textContent = actionLabel;
    ui.noticeAction.hidden = false;
    ui.noticeAction.onclick = onAction;
  } else {
    ui.noticeAction.hidden = true;
    ui.noticeAction.onclick = null;
  }
}

function hideNotice() {
  ui.notice.hidden = true;
}

function renderModes() {
  ui.modes.replaceChildren();
  const tasks = listTasks();

  for (const task of tasks) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mode";
    button.role = "radio";

    const available = inspection ? inspection.verdict.availability[task.id] : false;
    button.disabled = !available;
    button.setAttribute("aria-checked", String(mode === task.id && available));

    const title = document.createElement("strong");
    title.textContent = task.label;
    button.append(title);

    const hint = document.createElement("span");
    hint.textContent = available ? modeHint(task.id) : unavailableReason(task.id, inspection.verdict);
    button.append(hint);

    button.addEventListener("click", () => {
      mode = task.id;
      renderModes();
      renderOptionVisibility();
    });

    ui.modes.append(button);
  }
}

function modeHint(id) {
  if (!inspection) return "";
  const { verdict, model } = inspection;
  if (id === MODE.AUDIO) return `m4a · ${formatDuration(model.durationSec)}`;
  if (id === MODE.SLIDES) return `zip · ${verdict.slideCount} images`;
  if (id === MODE.SLIDECAST) return `mp4 · ${formatDuration(model.durationSec)}`;
  return "";
}

function renderOptionVisibility() {
  ui.videoOptions.hidden = mode !== MODE.SLIDECAST;
  ui.slideOptions.hidden = mode === MODE.AUDIO;
}

function renderSession() {
  const { model, verdict, description } = inspection;
  ui.kind.textContent = `${description} · ${formatDuration(model.durationSec)}`;
  ui.name.textContent = model.name;
  ui.detail.textContent = [model.folder, model.presenter].filter(Boolean).join(" · ");
  ui.session.hidden = false;
  ui.controls.hidden = false;
  ui.logToggle.hidden = false;

  // Default to the most useful mode this session actually supports.
  const preference = [MODE.SLIDECAST, MODE.SLIDES, MODE.AUDIO];
  if (!verdict.availability[mode]) {
    mode = preference.find((candidate) => verdict.availability[candidate]) || MODE.AUDIO;
  }

  renderModes();
  renderOptionVisibility();
  ui.go.disabled = !verdict.availability[mode];
}

function setRunning(running) {
  ui.go.hidden = running;
  ui.cancel.hidden = !running;
  ui.progress.hidden = !running;
  for (const control of ui.controls.querySelectorAll("button, select, input")) {
    control.disabled = running || control.dataset.permanentlyDisabled === "true";
  }
  if (running) renderModes();
}

function renderProgress({ stage, done, total }) {
  ui.progress.hidden = false;
  ui.stageLabel.textContent = STAGE_LABEL[stage] || "Working";

  const known = Number.isFinite(total) && total > 0;
  ui.fill.classList.toggle("indeterminate", !known);
  if (!known) {
    ui.stageCount.textContent = done ? formatBytes(done) : "";
    return;
  }

  const ratio = Math.max(0, Math.min(1, done / total));
  ui.fill.style.width = `${(ratio * 100).toFixed(1)}%`;
  // Byte counts and item counts want different phrasing.
  ui.stageCount.textContent =
    total > 5000 ? `${formatBytes(done)} / ${formatBytes(total)}` : `${done} / ${total}`;
}

function appendLog(line) {
  const stamp = new Date(line.at || Date.now()).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  ui.log.textContent += `${stamp}  ${line.message}\n`;
  ui.log.scrollTop = ui.log.scrollHeight;
}

function showResult(text, bad = false) {
  ui.resultText.textContent = text;
  ui.result.classList.toggle("bad", bad);
  ui.result.hidden = false;
}

// ---------------------------------------------------------------------- wiring

ui.videoHeight.addEventListener("change", (event) => {
  options.videoHeight = Number(event.target.value);
});
ui.encoder.addEventListener("change", (event) => {
  options.encoder = event.target.value;
  if (options.encoder === ENCODER.COMPATIBLE && inspection) {
    showNotice(
      `Compatible encoding runs in real time — about ${Math.ceil(
        inspection.model.durationSec / 60
      )} minutes for this lecture. Output is WebM.`
    );
  } else {
    hideNotice();
  }
});
ui.burnCaptions.addEventListener("change", (event) => {
  options.burnCaptions = event.target.checked;
});
ui.slideSize.addEventListener("change", (event) => {
  options.slideSize = event.target.value;
});

ui.logToggle.addEventListener("click", () => {
  ui.log.hidden = !ui.log.hidden;
});

ui.cancel.addEventListener("click", async () => {
  ui.cancel.disabled = true;
  await send(MSG.CANCEL);
});

ui.go.addEventListener("click", async () => {
  hideNotice();
  ui.result.hidden = true;
  ui.log.textContent = "";

  // A permission prompt needs the click that is still on the stack, so this has
  // to happen here rather than in the service worker.
  if (pendingPermissions.length > 0) {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: pendingPermissions });
    } catch {
      granted = false;
    }
    if (!granted) {
      showNotice(
        "Lectern needs access to the media host serving this lecture. Without it the download cannot start.",
        { bad: true }
      );
      return;
    }
    pendingPermissions = [];
  }

  setRunning(true);
  renderProgress({ stage: "inspect", done: 0, total: 0 });

  const response = await send(MSG.START, { mode, options });
  if (!response || !response.ok) {
    setRunning(false);
    showResult((response && response.error) || "Could not start.", true);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!isOurs(message) || message.target !== TARGET.POPUP) return;

  switch (message.type) {
    case MSG.PROGRESS:
      renderProgress(message);
      break;
    case MSG.LOG:
      appendLog(message);
      break;
    case MSG.DONE:
      setRunning(false);
      ui.progress.hidden = true;
      showResult(`Saved ${message.files.join(", ")}${message.summary ? ` — ${message.summary}` : ""}`);
      break;
    case MSG.FAILED:
      setRunning(false);
      ui.progress.hidden = true;
      showResult(message.error, true);
      if (!ui.log.textContent) ui.log.hidden = true;
      break;
    default:
      break;
  }
});

// ----------------------------------------------------------------------- start

async function init() {
  const stored = await chrome.storage.local.get("options");
  options = { ...DEFAULTS, ...(stored.options || {}) };
  mode = options.mode || DEFAULTS.mode;
  ui.videoHeight.value = String(options.videoHeight);
  ui.encoder.value = options.encoder;
  ui.burnCaptions.checked = Boolean(options.burnCaptions);
  ui.slideSize.value = options.slideSize;

  // Resync with a job that may already be running.
  const state = await send(MSG.GET_STATE).catch(() => null);

  const result = await send(MSG.INSPECT).catch((error) => ({
    ok: false,
    error: error.message,
  }));

  if (!result || !result.ok) {
    ui.kind.textContent = "No lecture open";
    showNotice(
      (result && result.error) || "Could not read this tab.",
      { bad: !result?.notPanopto }
    );
    return;
  }

  inspection = result;
  if (result.permission && !result.permission.granted) {
    pendingPermissions = result.permission.requested;
  }
  renderSession();

  if (state && state.ok && state.state.running) {
    setRunning(true);
    for (const line of state.state.logs) appendLog(line);
    renderProgress(state.state);
    ui.log.hidden = false;
  }
}

window.addEventListener("beforeunload", () => {
  chrome.storage.local.set({ options: { ...options, mode } });
});

init();
