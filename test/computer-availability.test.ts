import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveComputerAvailability } from "../src/shared/computer-availability.ts";

/**
 * The verdict decides both what Settings renders and what the tools refuse, so the two
 * cannot be allowed to drift. These pin the answers that are product decisions rather
 * than facts about the code.
 */

test("the two desktops the driver is actually shipped for are supported", () => {
  assert.deepEqual(resolveComputerAvailability("darwin", false), { kind: "local-macos", supported: true });
  assert.deepEqual(resolveComputerAvailability("win32", false), { kind: "local-windows", supported: true });
});

test("Linux is refused rather than half-supported", () => {
  // cua's Linux input path needs compositor-specific helpers this app does not ship, so
  // whether it worked would depend on which session manager the user logged into.
  assert.deepEqual(resolveComputerAvailability("linux", false), { kind: "local-linux", supported: false });
});

test("a remote client is refused even when the host could be driven", () => {
  // The tools would drive the host's desktop — the screen nobody is watching — while the
  // person issuing them sees a different one. Being on a Mac does not make that useful.
  assert.deepEqual(resolveComputerAvailability("darwin", true), { kind: "remote", supported: false });
  assert.deepEqual(resolveComputerAvailability("win32", true), { kind: "remote", supported: false });
});

test("an unknown platform is not assumed to work", () => {
  assert.equal(resolveComputerAvailability("freebsd", false).supported, false);
});
