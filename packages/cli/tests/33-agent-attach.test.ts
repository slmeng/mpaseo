#!/usr/bin/env npx tsx

/**
 * Phase 33: Attach Command Tests
 *
 * Tests the attach command - watching an agent stream, optionally in interactive mode.
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - Interactive flag parsing and non-TTY rejection
 */

import assert from "node:assert";
import { $ } from "zx";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

$.verbose = false;

console.log("=== Attach Command Tests ===\n");

const port = 10000 + Math.floor(Math.random() * 50000);
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-test-home-"));

try {
  // Test 1: attach --help shows options
  {
    console.log("Test 1: attach --help shows options");
    const result = await $`npx paseo attach --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "attach --help should exit 0");
    assert(result.stdout.includes("<id>"), "help should mention required id argument");
    assert(result.stdout.includes("--interactive"), "help should mention --interactive");
    console.log("✓ attach --help shows options\n");
  }

  // Test 2: attach requires ID argument
  {
    console.log("Test 2: attach requires ID argument");
    const result = await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo attach`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail without id");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("missing") ||
      output.toLowerCase().includes("required") ||
      output.toLowerCase().includes("argument") ||
      output.toLowerCase().includes("id");
    assert(hasError, "error should mention missing argument");
    console.log("✓ attach requires ID argument\n");
  }

  // Test 3: attach handles daemon not running
  {
    console.log("Test 3: attach handles daemon not running");
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo attach abc123`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail when daemon not running");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("daemon") ||
      output.toLowerCase().includes("connect") ||
      output.toLowerCase().includes("cannot");
    assert(hasError, "error message should mention connection issue");
    console.log("✓ attach handles daemon not running\n");
  }

  // Test 4: attach --interactive is accepted and rejects non-TTY clearly
  {
    console.log("Test 4: attach --interactive rejects non-TTY clearly");
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo attach --interactive abc123`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "interactive attach should fail without a TTY");
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --interactive flag");
    assert(output.toLowerCase().includes("tty"), "should explain that interactive mode needs a TTY");
    console.log("✓ attach --interactive rejects non-TTY clearly\n");
  }

  // Test 5: attach -i alias is accepted and rejects non-TTY clearly
  {
    console.log("Test 5: attach -i rejects non-TTY clearly");
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo attach -i abc123`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "interactive attach should fail without a TTY");
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept -i flag");
    assert(output.toLowerCase().includes("tty"), "should explain that interactive mode needs a TTY");
    console.log("✓ attach -i rejects non-TTY clearly\n");
  }
} finally {
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== All attach tests passed ===");
