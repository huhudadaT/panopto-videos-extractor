// The task registry.
//
// Adding a new output type means writing one module with {id, label, run} and
// adding it to this list. Nothing else in the extension needs to change: the
// popup builds its mode list from the registry, and the offscreen runner
// dispatches through it.

import audioTask from "./audio.js";
import slidesTask from "./slides.js";
import slidecastTask from "./slidecast.js";

const TASKS = [audioTask, slidesTask, slidecastTask];

const BY_ID = new Map(TASKS.map((task) => [task.id, task]));

export function listTasks() {
  return TASKS.map((task) => ({ id: task.id, label: task.label }));
}

export function getTask(id) {
  const task = BY_ID.get(id);
  if (!task) {
    throw Object.assign(new Error(`Unknown task: ${id}`), { fatal: true });
  }
  return task;
}

export function hasTask(id) {
  return BY_ID.has(id);
}
