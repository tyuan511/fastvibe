import { test } from "node:test";
import assert from "node:assert/strict";
import { Ipc } from "../src/shared/ipc.ts";
import { registeredChannels } from "./registered-channels.ts";
import {
  allowedMethods,
  assertPolicyCoverage,
  deniedMethods,
  remotePolicy,
} from "../src/main/server/policy.ts";

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
    Ipc.enginePrompt, Ipc.engineAbort, Ipc.engineGetSnapshot, Ipc.engineGetMessages,
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
