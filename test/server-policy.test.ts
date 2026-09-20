import { test } from "node:test";
import assert from "node:assert/strict";
import { Ipc } from "../src/shared/ipc.ts";
import { registeredChannels } from "./registered-channels.ts";
import {
  allowedMethods,
  assertPolicyCoverage,
  deniedMethods,
  remoteDenialReason,
  remotePolicy,
} from "../src/shared/remote-policy.ts";

/**
 * The policy decides what the internet can reach. Its failure mode is silence: a method
 * added next month is reachable the day it is written unless something refuses to start.
 * These tests are that something, moved earlier — they read the real call table out of
 * the source rather than trusting a list to have been kept up to date.
 */

test("every registered method is classified", () => {
  // The whole point of the design: adding a method without deciding whether it may be
  // called remotely must break something loudly, here, rather than expose it quietly.
  assert.doesNotThrow(() => assertPolicyCoverage(registeredChannels()));
});

test("the parser actually found the table, not an empty list", () => {
  // A regex that silently matches nothing would make the test above vacuously pass.
  const channels = registeredChannels();
  assert.ok(channels.length > 100, `expected the full table, found ${channels.length}`);
  assert.ok(channels.includes(Ipc.enginePrompt));
  assert.ok(channels.includes(Ipc.workspaceGitPull));
});

test("an unclassified method is refused, and named", () => {
  assert.throws(
    () => assertPolicyCoverage([...registeredChannels(), "engine:brand-new-thing"]),
    /engine:brand-new-thing/,
  );
});

test("a rule guarding a method that no longer exists is refused", () => {
  // A rename that leaves the rule behind reads as protection while protecting nothing.
  const channels = registeredChannels().filter((channel) => channel !== Ipc.workspacePick);
  assert.throws(() => assertPolicyCoverage(channels), /workspace:pick/);
});

test("anything unknown is denied rather than allowed by default", () => {
  const verdict = remotePolicy("engine:something-never-registered");
  assert.equal(verdict.allowed, false);
});

test("the calls that would hang a remote client are denied", () => {
  // Each of these opens a native dialog on the machine running the server. A remote
  // caller would wait on a promise that nobody can settle.
  for (const method of [Ipc.workspacePick, Ipc.projectsAdd, Ipc.engineImportSkill, Ipc.engineExportHtml, Ipc.appExportLogs]) {
    assert.equal(remotePolicy(method).allowed, false, `should be denied: ${method}`);
  }
});

test("calls that act on the server's own desktop are denied", () => {
  for (const method of [Ipc.workspaceReveal, Ipc.workspaceOpenTerminal, Ipc.windowNew, Ipc.windowClose, Ipc.updateInstall, Ipc.providersOAuthLogin]) {
    assert.equal(remotePolicy(method).allowed, false, `should be denied: ${method}`);
  }
});

test("the arbitrary-outbound-request call is denied", () => {
  // `providers:fetch` issues a request to any URL with any credential the caller names,
  // from this machine and this network — a probe that needs no agent to use.
  assert.equal(remotePolicy(Ipc.providersFetch).allowed, false);
});

test("a denial explains itself", () => {
  const verdict = remotePolicy(Ipc.workspacePick);
  assert.equal(verdict.allowed, false);
  if (!verdict.allowed) assert.ok(verdict.reason.length > 0);
});

test("the calls a remote client actually needs are allowed", () => {
  for (const method of [
    Ipc.enginePrompt, Ipc.engineAbort, Ipc.engineFork, Ipc.engineGetSnapshot, Ipc.engineGetMessages,
    Ipc.enginePermissionRespond, Ipc.conversationsList, Ipc.conversationsOpen,
    Ipc.engineGetModels, Ipc.engineSetModel, Ipc.settingsGet,
  ]) {
    assert.equal(remotePolicy(method).allowed, true, `should be allowed: ${method}`);
  }
});

test("allowed and denied do not overlap", () => {
  const denied = new Set(deniedMethods());
  const overlap = allowedMethods().filter((method) => denied.has(method));
  assert.deepEqual(overlap, []);
});

test("the denied set is exactly what the UI explains, so a new denial cannot go silent", () => {
  // A denied method needs a second thing to exist: the control that offers it has to say
  // why, at the click, instead of doing nothing. That is `blockedRemotely`
  // (`renderer/src/lib/remote-unavailable.ts`), asked at each trigger and answered from
  // this same table — but a *new* denial nobody wired up is exactly the failure the
  // arrangement exists to prevent: a button that is there, does nothing, and explains
  // nothing.
  //
  // So the set is pinned. Denying one more method fails here, and the fix is two lines:
  // add it below, and guard whatever offers it.
  assert.deepEqual([...deniedMethods()].sort(), [
    "app:export-logs",
    "browser:import-profile",
    "browser:list-profiles",
    "browser:response",
    // 设置 › 电脑操控 guards every one of these with `blockedRemotely`: the pane renders
    // read-only from a remote client and says why, rather than offering buttons that
    // would prompt on a machine nobody is sitting at.
    "computer:close-grant-overlay",
    "computer:list-apps",
    "computer:open-settings",
    "computer:permissions",
    "computer:request-permissions",
    "computer:show-grant-overlay",
    "computer:start-drag",
    "engine:export-html",
    "engine:import-skill",
    "projects:add",
    "providers:fetch",
    "providers:oauth-answer",
    "providers:oauth-cancel",
    "providers:oauth-login",
    "remote:clear-password",
    "remote:get-state",
    "remote:list-devices",
    "remote:revoke-device",
    "remote:set-password",
    "remote:start",
    "remote:stop",
    "remote:tunnel-set",
    "remote:tunnel-tools",
    "update:check",
    "update:download",
    "update:install",
    "window:close",
    "window:is-maximized",
    "window:minimize",
    "window:new",
    "window:toggle-maximize",
    "workspace:open-terminal",
    "workspace:pick",
    "workspace:reveal",
  ]);
});

test("a denial reason is available to the renderer under its own name", () => {
  // `remoteDenialReason` is what the UI calls; it must answer for a denied method and
  // stay null for an allowed one, or every control would hide itself.
  assert.ok(remoteDenialReason(Ipc.workspacePick));
  assert.equal(remoteDenialReason(Ipc.enginePrompt), null);
  assert.equal(remoteDenialReason("engine:never-registered"), "该方法未开放给远程客户端");
});
