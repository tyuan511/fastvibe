import assert from "node:assert/strict";
import test from "node:test";
import {
  authorize,
  authorizePush,
  assertCapabilityCoverage,
  DESKTOP_CAPABILITIES,
  HEADLESS_CAPABILITIES,
} from "../src/main/app-server/capabilities.ts";
import { Ipc } from "../src/shared/ipc.ts";
import { remoteDenialReason } from "../src/shared/remote-policy.ts";
import { registeredChannels } from "./registered-channels.ts";

const remoteAll = {
  caller: "remote" as const,
  serverCapabilities: DESKTOP_CAPABILITIES,
  clientCapabilities: DESKTOP_CAPABILITIES,
};

test("local windows are permitted admin, native dialogs, and provider fetch", () => {
  const window = { caller: "window" as const, serverCapabilities: DESKTOP_CAPABILITIES };
  assert.equal(authorize(Ipc.remoteGetState, window).allowed, true);
  assert.equal(authorize(Ipc.sshHosts, window).allowed, true);
  assert.equal(authorize(Ipc.workspacePick, window).allowed, true);
  assert.equal(authorize(Ipc.providersFetch, window).allowed, true);
});

test("remote policy denials are never relaxed by capabilities or declarations", () => {
  for (const method of [Ipc.workspacePick, Ipc.projectsAdd, Ipc.providersFetch, Ipc.remoteGetState, Ipc.sshConnect]) {
    const verdict = authorize(method, remoteAll);
    assert.equal(verdict.allowed, false, method);
    if (!verdict.allowed) {
      assert.equal(verdict.reason, remoteDenialReason(method));
    }
  }
  const nativeOnly = authorize(Ipc.windowClose, {
    caller: "remote",
    serverCapabilities: DESKTOP_CAPABILITIES,
    clientCapabilities: ["native"],
  });
  assert.equal(nativeOnly.allowed, false);
});

test("a client declaration cannot grant a capability the server lacks", () => {
  const granted = authorize(Ipc.updateGetState, {
    caller: "remote",
    serverCapabilities: HEADLESS_CAPABILITIES,
    clientCapabilities: ["native", "engine"],
  });
  assert.equal(granted.allowed, false);
  if (!granted.allowed) assert.equal(granted.code, "capability.unsupported");

  const engine = authorize(Ipc.enginePrompt, {
    caller: "remote",
    serverCapabilities: HEADLESS_CAPABILITIES,
    clientCapabilities: ["engine", "browser", "native"],
  });
  assert.equal(engine.allowed, true);
});

test("declaring a subset only narrows", () => {
  const verdict = authorize(Ipc.enginePrompt, {
    caller: "remote",
    serverCapabilities: DESKTOP_CAPABILITIES,
    clientCapabilities: ["conversations"],
  });
  assert.equal(verdict.allowed, false);
  if (!verdict.allowed) assert.equal(verdict.code, "capability.unsupported");
});

test("headless servers reject native/browser even when policy would allow a sibling", () => {
  const updateState = authorize(Ipc.updateGetState, {
    caller: "remote",
    serverCapabilities: HEADLESS_CAPABILITIES,
  });
  assert.equal(updateState.allowed, false);
});

test("push policy: windows get everything; remote skips admin and missing caps", () => {
  const window = { caller: "window" as const, serverCapabilities: DESKTOP_CAPABILITIES };
  assert.equal(authorizePush("remote:state", window), true);
  assert.equal(authorizePush("engine:event", remoteAll), true);
  assert.equal(authorizePush("remote:state", remoteAll), false);
  assert.equal(
    authorizePush("browser:request", {
      caller: "remote",
      serverCapabilities: DESKTOP_CAPABILITIES,
      clientCapabilities: ["engine"],
    }),
    false,
  );
});

test("every registered method is classified as a capability or as admin", () => {
  assert.doesNotThrow(() => assertCapabilityCoverage(registeredChannels()));
});
