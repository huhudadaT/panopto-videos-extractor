#!/usr/bin/env node
// Test runner. No dependencies — node tests/run.mjs
//
// Each test file default-exports a function receiving the assertion helpers.
// Modules under extension/lib are imported directly, so what the tests exercise
// is exactly what ships.
//
// Tests run sequentially, in declaration order, and async tests are awaited.
// That matters: the integration tests replace globalThis.fetch, so overlapping
// execution would have them stealing each other's stubs.

import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const state = { passed: 0, failed: 0, failures: [] };
let currentFile = "";

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message || "values differ"}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`
    );
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message || "values differ"}\n    expected: ${b}\n    actual:   ${a}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${message || "values differ"}\n    expected: ${expected} ±${tolerance}\n    actual:   ${actual}`
    );
  }
}

function assertThrows(fn, message) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message || "expected the call to throw");
}

/** Tests declared by the file currently being loaded. */
let queue = [];

function test(name, fn) {
  queue.push({ name, fn });
}

async function runQueue() {
  const batch = queue;
  queue = [];
  for (const { name, fn } of batch) {
    try {
      await fn();
      state.passed += 1;
      process.stdout.write(`  \u2713 ${name}\n`);
    } catch (error) {
      state.failed += 1;
      state.failures.push({ file: currentFile, name, error });
      const detail = String((error && error.message) || error).replace(/\n/g, "\n      ");
      process.stdout.write(`  \u2717 ${name}\n      ${detail}\n`);
    }
  }
}

const helpers = { test, assert, assertEqual, assertDeepEqual, assertClose, assertThrows };

process.on("unhandledRejection", (error) => {
  state.failed += 1;
  state.failures.push({
    file: currentFile,
    name: "(unhandled rejection)",
    error: error instanceof Error ? error : new Error(String(error)),
  });
  process.stdout.write(`  \u2717 unhandled rejection\n      ${error}\n`);
});

const files = (await readdir(here))
  .filter((name) => name.startsWith("test-") && name.endsWith(".mjs"))
  .sort();

if (files.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

const started = Date.now();

for (const file of files) {
  currentFile = file;
  process.stdout.write(`\n${file}\n`);
  const module = await import(join(here, file));
  if (typeof module.default !== "function") {
    console.error(`  ${file} has no default export`);
    state.failed += 1;
    continue;
  }
  // The file registers its tests, then we run them one at a time.
  await module.default(helpers);
  await runQueue();
}

process.stdout.write(
  `\n${state.passed} passed, ${state.failed} failed in ${((Date.now() - started) / 1000).toFixed(2)}s\n`
);

if (state.failed > 0) {
  process.stdout.write("\nFailures:\n");
  for (const failure of state.failures) {
    process.stdout.write(`  ${failure.file} \u2192 ${failure.name}\n`);
  }
  process.exit(1);
}
