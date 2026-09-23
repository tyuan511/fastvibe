import { test } from "node:test";
import assert from "node:assert/strict";
import { pageFingerprint, runBrowserAgent, StalePage, type BrowserControl, type ObservedPage } from "../src/main/engine/decision/browser-agent.ts";
import type { ObservedAction } from "../src/main/engine/decision/browser-snapshot.ts";
import { acceptValid } from "../src/main/engine/decision/dispatch.ts";
import type { DecideRequest, DecideResponse } from "../src/main/engine/decision/protocol.ts";
import { DecisionRuntime, type DecisionBackend } from "../src/main/engine/decision/runtime.ts";

/**
 * The loop's contract (ported from jev-ultrafast agent.py): each decision executes at
 * most once, a stale page is re-observed instead of acted on, a generated value is not
 * paid for twice, and a loop that changes nothing stops.
 */

function page(url: string, actions: ObservedAction[], text = ""): ObservedPage {
  const base = { url, title: url, w: 1120, h: 780, text, scroll: { y: 0, height: 780 }, actions, marker: url + text, page_key: null, guards: {}, omitted_actions: 0 };
  return { ...base, fingerprint: pageFingerprint(base) };
}

const search: ObservedAction = { id: "e1", kind: "fill", node: 1, role: "searchbox", label: "Search", value: "" };
const go: ObservedAction = { id: "e2", kind: "click", node: 2, role: "button", label: "Go" };

/** A browser whose pages and staleness are scripted. */
function fakeControl(options: { staleOnce?: boolean; changes?: boolean } = {}) {
  let typed = "";
  let onResults = false;
  let staleOnce = options.staleOnce ?? false;
  const acted: string[] = [];
  const control: BrowserControl = {
    async observe() {
      if (onResults) return page("https://x.test/results", [], "Results for " + typed);
      return page("https://x.test/", [{ ...search, value: typed }, go]);
    },
    async fresh() {
      return true;
    },
    async act(action, _page, text) {
      if (staleOnce) {
        staleOnce = false;
        throw new StalePage();
      }
      acted.push(action.id + (text ? `=${text}` : ""));
      if (options.changes === false) return;
      if (action.id === "e1") typed = text ?? "";
      if (action.id === "e2") onResults = true;
    },
  };
  return { control, acted };
}

/** Answers `operation` (and the matching target) from a script of [operation, target] pairs. */
function scripted(script: Array<[string, string?]>): DecisionBackend & { calls: number } {
  const backend = {
    id: "fake",
    calls: 0,
    async decide(request: DecideRequest): Promise<DecideResponse> {
      const [operation, target] = script[Math.min(backend.calls, script.length - 1)];
      backend.calls++;
      const answers: Record<string, unknown> = { operation: { type: "choice", choice: operation } };
      const head = `${operation.toLowerCase()}_target`;
      if (target && request.questions[head]) answers[head] = { type: "choice", choice: target };
      return { version: 1, backend: "fake", answers };
    },
  };
  return backend;
}

const FAST = { intervalMs: 1, stableMs: 2, quietMs: 3, maxMs: 20 };

const run = (backend: DecisionBackend) => new DecisionRuntime({ backend }).startRun({ budgetKey: "t", deadlineAt: Date.now() + 60_000 });

test("type, click, done: each step executes once and the value comes from the helper", async () => {
  const { control, acted } = fakeControl();
  const backend = scripted([["TYPE_TEXT", "1"], ["CLICK", "2"], ["DONE"]]);
  const texts: unknown[] = [];
  const result = await runBrowserAgent({
    goal: "search for cats",
    control,
    run: run(backend),
    policy: acceptValid("t"),
    settle: FAST,
    fieldText: async (context) => {
      texts.push(context.field.label);
      return "cats";
    },
  });
  assert.equal(result.status, "done");
  assert.deepEqual(acted, ["e1=cats", "e2"]);
  assert.deepEqual(texts, ["Search"]);
  assert.deepEqual(result.steps.map((s) => [s.operation, s.page_changed]), [["TYPE_TEXT", true], ["CLICK", true]]);
  assert.equal(result.finalPage.url, "https://x.test/results");
});

test("a stale page is re-observed and re-decided, and the generated value is reused", async () => {
  const { control, acted } = fakeControl({ staleOnce: true });
  const backend = scripted([["TYPE_TEXT", "1"], ["TYPE_TEXT", "1"], ["DONE"]]);
  let helperCalls = 0;
  const result = await runBrowserAgent({
    goal: "search for cats",
    control,
    run: run(backend),
    policy: acceptValid("t"),
    settle: FAST,
    fieldText: async () => {
      helperCalls++;
      return "cats";
    },
  });
  assert.equal(result.staleDecisions, 1);
  assert.deepEqual(acted, ["e1=cats"], "the stale attempt executed nothing");
  assert.equal(helperCalls, 1, "the same helper input is not paid for twice");
  assert.equal(result.status, "done");
});

test("three actions that change nothing stop the run", async () => {
  const { control, acted } = fakeControl({ changes: false });
  const result = await runBrowserAgent({
    goal: "g",
    control,
    run: run(scripted([["CLICK", "2"]])),
    policy: acceptValid("t"),
    settle: FAST,
    fieldText: async () => "x",
  });
  assert.equal(result.status, "no_progress");
  assert.equal(acted.length, 3);
});

test("an invented target hands off without acting", async () => {
  const { control, acted } = fakeControl();
  const result = await runBrowserAgent({
    goal: "g",
    control,
    run: run(scripted([["CLICK", "99"]])),
    policy: acceptValid("t"),
    settle: FAST,
    fieldText: async () => "x",
  });
  assert.equal(result.status, "handed_off");
  assert.match(result.detail ?? "", /invalid_response/);
  assert.deepEqual(acted, []);
});

test("a missing field value stops rather than guessing", async () => {
  const { control, acted } = fakeControl();
  const result = await runBrowserAgent({
    goal: "g",
    control,
    run: run(scripted([["TYPE_TEXT", "1"]])),
    policy: acceptValid("t"),
    settle: FAST,
    fieldText: async () => null,
  });
  assert.equal(result.status, "missing_value");
  assert.deepEqual(acted, []);
});

test("after a click, the next decision waits for a single-page app to finish swapping content", async () => {
  // The click changes the URL at once, then the listing arrives two reads later.
  let clicked = false;
  let readsAfterClick = 0;
  const acted: string[] = [];
  const list = page("https://x.test/repo", [{ id: "e1", kind: "click", node: 1, role: "link", label: "Lib" }], "README");
  const control: BrowserControl = {
    async observe() {
      if (!clicked) return list;
      readsAfterClick++;
      if (readsAfterClick < 3) return page("https://x.test/repo/Lib", [{ id: "e1", kind: "click", node: 1, role: "link", label: "Lib" }], "README");
      return page("https://x.test/repo/Lib", [{ id: "e2", kind: "click", node: 2, role: "link", label: "json" }], "Lib listing");
    },
    async fresh() {
      return true;
    },
    async act(action) {
      acted.push(action.label);
      clicked = true;
    },
  };
  const seen: string[] = [];
  const backend: DecisionBackend = {
    id: "fake",
    async decide(request) {
      const state = request.state as { page: { text: string } };
      seen.push(state.page.text);
      if (state.page.text === "Lib listing") return { version: 1, backend: "fake", answers: { operation: { type: "choice", choice: "DONE" } } };
      return { version: 1, backend: "fake", answers: { operation: { type: "choice", choice: "CLICK" }, click_target: { type: "choice", choice: "1" } } };
    },
  };
  const result = await runBrowserAgent({ goal: "open Lib", control, run: run(backend), policy: acceptValid("t"), fieldText: async () => null, settle: { intervalMs: 1, stableMs: 20, quietMs: 50, maxMs: 300 } });
  assert.equal(result.status, "done");
  assert.deepEqual(acted, ["Lib"], "Lib is clicked once, not again on the half-loaded page");
  assert.deepEqual(seen, ["README", "Lib listing"]);
});

test("a page that never holds still stops after five stale decisions, with the reason", async () => {
  const { control, acted } = fakeControl();
  const unstable: BrowserControl = {
    ...control,
    async fresh() {
      return "page scrollY 0→3";
    },
    async act(action, page) {
      const fresh = await unstable.fresh(page, action);
      if (fresh !== true) throw new StalePage(String(fresh));
    },
  };
  const backend = scripted([["CLICK", "2"]]);
  const result = await runBrowserAgent({ goal: "g", control: unstable, run: run(backend), policy: acceptValid("t"), settle: FAST, fieldText: async () => "x" });
  assert.equal(result.status, "unstable");
  assert.equal(result.detail, "page scrollY 0→3");
  assert.equal(result.decisions, 5, "not the whole 120-decision budget");
  assert.deepEqual(acted, []);
});
