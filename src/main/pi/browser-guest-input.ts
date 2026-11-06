import type { WebContents } from "electron";
import type { BrowserRequest } from "../../shared/types.ts";
import { checkBody, clickBody, pageProgram, pressBody, snapshotBody, typeBody } from "../../shared/browser-page.ts";
import { runBrowserInput } from "../engine/browser-input.ts";
import { runBrowserAccessibilitySnapshot } from "../engine/browser-accessibility.ts";

/** Reserved fallback only; attached automation uses a named CDP world. */
export const BROWSER_AUTOMATION_WORLD = 1001;
export const BROWSER_AUTOMATION_WORLD_NAME = "fastvibe-browser-automation";
const attached = new WeakSet<WebContents>();
const queues = new Map<number, Promise<unknown>>();
type RefNode = { ref?: string; children?: RefNode[] };
const observations = new WeakMap<WebContents, { world: string; refs: Set<string> }>();

/** A guest id is a hint from its host renderer, never authority to drive another window. */
export function assertBrowserGuest(owner: WebContents, guest: WebContents | undefined): asserts guest is WebContents {
  if (owner.isDestroyed() || !guest || guest.isDestroyed() || guest.getType() !== "webview" || guest.hostWebContents !== owner) {
    throw new Error("BROWSER_GUEST_OWNER_MISMATCH");
  }
}

async function bounded<T>(work: Promise<T>, method: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Browser guest command timed out (${method}); delivery may be unknown`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

function unwrap(result: { ok?: boolean; value?: unknown; error?: string } | undefined): unknown {
  if (!result?.ok) throw new Error(result?.error || "Browser guest script failed");
  return result.value;
}

async function guestChannel(guest: WebContents, signal?: AbortSignal) {
  let fallbackReason: string | undefined;
  try {
    if (!guest.debugger.isAttached()) {
      // Even if Chromium retains the named world across detach, old refs must not revive.
      guest.debugger.attach("1.3");
      observations.delete(guest);
      attached.add(guest);
      guest.debugger.once("detach", () => {
        attached.delete(guest);
        observations.delete(guest);
      });
    } else if (!attached.has(guest)) {
      fallbackReason = "debugger-already-owned";
    }
  } catch {
    fallbackReason = "debugger-attach-unavailable";
  }
  signal?.throwIfAborted();
  const send = (method: string, params: Record<string, unknown> = {}) => bounded(guest.debugger.sendCommand(method, params), method);
  if (fallbackReason) {
    return {
      world: `electron:${BROWSER_AUTOMATION_WORLD}`, fallbackReason, contextId: undefined,
      send,
      evaluate: async (body: string) => unwrap(await bounded(guest.executeJavaScriptInIsolatedWorld(BROWSER_AUTOMATION_WORLD, [{ code: pageProgram(body) }]), "Electron.executeJavaScriptInIsolatedWorld")),
    };
  }
  // A world creation/evaluation error is not an attach failure. Never switch worlds on it.
  const tree = await send("Page.getFrameTree");
  signal?.throwIfAborted();
  const world = await send("Page.createIsolatedWorld", {
    frameId: tree.frameTree.frame.id, worldName: BROWSER_AUTOMATION_WORLD_NAME,
  });
  signal?.throwIfAborted();
  const contextId = world.executionContextId;
  if (typeof contextId !== "number") throw new Error("Browser automation isolated world unavailable");
  return {
    world: `cdp:${contextId}`, contextId, fallbackReason, send,
    evaluate: async (body: string) => {
      const result = await send("Runtime.evaluate", { contextId, expression: pageProgram(body), returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser guest script failed");
      return unwrap(result.result?.value);
    },
  };
}

function staleRef(request: BrowserRequest) {
  return { ok: false, ...(request.action === "click" ? { clicked: false } : request.action === "type" ? { filled: false } : {}), code: "STALE_REF", error: "Ref expired; take a new browser_snapshot" };
}

/** Only attach failure may use world 1001. A possibly delivered input is never replayed. */
async function executeInput(guest: WebContents, request: BrowserRequest, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const channel = await guestChannel(guest, signal);
  let observation = observations.get(guest);
  if (observation?.world !== channel.world) {
    observation = { world: channel.world, refs: new Set() };
    observations.set(guest, observation);
  }
  // Host authority prevents refs from reappearing in a retained but superseded world.
  if ((request.ref && !observation.refs.has(request.ref)) || (request.rootRef && !observation.refs.has(request.rootRef))) return staleRef(request);
  if (request.action === "snapshot" || request.action === "check" || request.action === "evaluate") {
    if (request.action === "evaluate" && !request.script) throw new Error("BROWSER_SCRIPT_REQUIRED");
    if (request.action === "snapshot" && request.snapshotMode === "accessibility" && channel.contextId === undefined) {
      throw new Error(`BROWSER_ACCESSIBILITY_UNAVAILABLE: ${channel.fallbackReason}`);
    }
    if (request.action === "snapshot") observation.refs.clear();
    const result = request.action === "snapshot" && request.snapshotMode === "accessibility"
      ? await runBrowserAccessibilitySnapshot(request, { send: channel.send, evaluate: channel.evaluate, contextId: async () => channel.contextId! }, signal)
      : await channel.evaluate(request.action === "snapshot" ? snapshotBody(request) : request.action === "check" ? checkBody(request) : request.script!);
    signal?.throwIfAborted();
    if (request.action === "snapshot") {
      const snapshot = result as { snapshotId?: string; elements?: RefNode[]; nodes?: RefNode[] };
      if (snapshot.snapshotId) {
        const collect = (nodes: RefNode[]): string[] => nodes.flatMap(node => [...(node.ref ? [node.ref] : []), ...collect(node.children ?? [])]);
        observation.refs = new Set(collect([...(snapshot.elements ?? []), ...(snapshot.nodes ?? [])]));
      }
    }
    return result;
  }
  let emulationAttempted = false;
  let inputFallbackReason = channel.fallbackReason;
  try {
    if (!inputFallbackReason) {
      // Parked/hidden guests have no OS focus. Semantic fallback stays in this CDP world.
      emulationAttempted = true;
      try { await channel.send("Emulation.setFocusEmulationEnabled", { enabled: true }); }
      catch { inputFallbackReason = "focus-emulation-unavailable"; }
    }
    signal?.throwIfAborted();
    if (inputFallbackReason) {
      const body = request.action === "click" ? clickBody(request)
        : request.action === "type" ? typeBody(request) : pressBody(request.key ?? "Enter");
      try {
        signal?.throwIfAborted();
        const result = await channel.evaluate(body) as Record<string, unknown>;
        signal?.throwIfAborted();
        const delivered = !["ok", "clicked", "filled"].some(key => result[key] === false);
        return { ...result, route: "page-script-fallback", fallbackReason: inputFallbackReason, delivery: delivered ? "delivered" : "not_delivered", verification: "not-checked" };
      } catch (error) {
        throw new Error(JSON.stringify({ code: signal?.aborted ? "BROWSER_INPUT_ABORTED" : "BROWSER_INPUT_FAILED", route: "page-script-fallback", delivery: "unknown", retry: "unsafe", error: String(error) }));
      }
    }
    const result = await runBrowserInput(request, {
      evaluate: channel.evaluate,
      // Releases are allowed after cancellation: runBrowserInput owns the cleanup boundary.
      send: (method, params) => method === "Input.insertText"
        // Electron targets the parked guest directly without activating its window.
        ? bounded(guest.insertText(String(params.text ?? "")), "Electron.insertText") : channel.send(method, params),
    }, signal) as Record<string, unknown>;
    return request.action === "type" && result.route === "cdp-input" ? { ...result, route: "electron-input" } : result;
  } finally {
    // A lost enable response can still have applied. Never touch a foreign debugger.
    if (emulationAttempted && attached.has(guest)) {
      await channel.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined);
    }
  }
}

/** Serialise automation to a guest, including cleanup after cancellation. */
export async function runBrowserGuestAction(owner: WebContents, guest: WebContents | undefined, request: BrowserRequest, signal?: AbortSignal): Promise<unknown> {
  assertBrowserGuest(owner, guest);
  if (!["snapshot", "check", "evaluate", "click", "type", "press"].includes(request.action)) throw new Error("BROWSER_GUEST_ACTION_NOT_ALLOWED");
  signal?.throwIfAborted();
  const destroyed = new AbortController();
  const onDestroyed = () => destroyed.abort(new Error("Browser guest was destroyed"));
  guest.once("destroyed", onDestroyed);
  const combined = signal ? AbortSignal.any([signal, destroyed.signal]) : destroyed.signal;
  const previous = queues.get(guest.id) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => {
    combined.throwIfAborted();
    assertBrowserGuest(owner, guest);
    return executeInput(guest, request, combined);
  });
  queues.set(guest.id, current);
  try { return await current; }
  finally {
    guest.removeListener("destroyed", onDestroyed);
    if (queues.get(guest.id) === current) queues.delete(guest.id);
  }
}
