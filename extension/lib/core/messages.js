// The wire protocol between the four contexts.
//
//   popup  <-> service worker : commands + progress relay
//   worker <-> content script : read the Panopto page
//   worker <-> offscreen doc  : do the heavy lifting
//
// Every message is {channel, type, ...payload}. The channel keeps our traffic
// distinguishable from anything else on the runtime bus.

export const CHANNEL = "lectern";

export const MSG = {
  // popup -> worker
  INSPECT: "inspect",
  START: "start",
  CANCEL: "cancel",
  GET_STATE: "get-state",

  // worker -> popup
  STATE: "state",
  PROGRESS: "progress",
  LOG: "log",
  DONE: "done",
  FAILED: "failed",

  // worker -> content script
  READ_PAGE: "read-page",
  FETCH_DELIVERY: "fetch-delivery",

  // worker -> offscreen
  RUN_TASK: "run-task",
  CANCEL_TASK: "cancel-task",
  PROBE_SUPPORT: "probe-support",

  // offscreen -> worker
  TASK_PROGRESS: "task-progress",
  TASK_LOG: "task-log",
  TASK_RESULT: "task-result",
  TASK_ERROR: "task-error",
};

export const TARGET = {
  WORKER: "worker",
  OFFSCREEN: "offscreen",
  POPUP: "popup",
  CONTENT: "content",
};

export function envelope(type, payload = {}, target) {
  return { channel: CHANNEL, type, target, ...payload };
}

export function isOurs(message) {
  return Boolean(message) && message.channel === CHANNEL;
}

/** Progress stages, in the order they appear. Drives the popup's stage list. */
export const STAGE = {
  INSPECT: "inspect",
  AUDIO: "audio",
  SLIDES: "slides",
  DECODE: "decode",
  ENCODE: "encode",
  PACKAGE: "package",
  SAVE: "save",
};

export const STAGE_LABEL = {
  [STAGE.INSPECT]: "Reading session",
  [STAGE.AUDIO]: "Downloading audio",
  [STAGE.SLIDES]: "Downloading slides",
  [STAGE.DECODE]: "Reading audio track",
  [STAGE.ENCODE]: "Building video",
  [STAGE.PACKAGE]: "Packaging",
  [STAGE.SAVE]: "Saving",
};
