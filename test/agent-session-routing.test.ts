import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");

/**
 * Agent IPC must hand `conversationId` to the same engine methods the desktop table
 * does. Importing `src/agent/handlers.ts` would pull the registry (and, through it,
 * Electron) plus the real engine, so the callbacks are lifted out of the source with
 * the TypeScript AST, stripped to JS, and run against a fake engine. A type annotation
 * that merely *mentions* the id is not enough — the call has to receive it.
 */

const handlersPath = fileURLToPath(new URL("../src/agent/handlers.ts", import.meta.url));

type EngineCall = { method: string; args: unknown[] };

type Route = {
  /** Words the failure should name: commands / subagents / abort / autoCompact / steering / followup. */
  label: string;
  /** Property on `Ipc`, as written in `handle(Ipc.<name>, ...)`. */
  ipc: string;
  method: string;
  payload: Record<string, unknown>;
  args: unknown[];
  /** Payload parameter itself is optional, so a missing body must not throw. */
  optionalPayload?: boolean;
};

const ROUTES: Route[] = [
  {
    label: "commands",
    ipc: "engineGetCommands",
    method: "getCommands",
    payload: { conversationId: "conv-1" },
    args: ["conv-1"],
    optionalPayload: true,
  },
  {
    label: "subagents",
    ipc: "engineGetSubagents",
    method: "getSubagents",
    payload: { conversationId: "conv-1" },
    args: ["conv-1"],
    optionalPayload: true,
  },
  {
    label: "abort",
    ipc: "engineAbortSubagent",
    method: "abortSubagent",
    payload: { subagentId: "run-1", conversationId: "conv-1" },
    args: ["run-1", "conv-1"],
  },
  {
    label: "subagent messages",
    ipc: "engineGetSubagentMessages",
    method: "getSubagentMessages",
    payload: { subagentId: "run-1", conversationId: "conv-1" },
    args: ["run-1", "conv-1"],
  },
  {
    label: "autoCompact",
    ipc: "engineSetAutoCompact",
    method: "setAutoCompaction",
    payload: { enabled: true, conversationId: "conv-1" },
    args: [true, "conv-1"],
  },
  {
    label: "steering",
    ipc: "engineSetSteering",
    method: "setSteeringMode",
    payload: { mode: "all", conversationId: "conv-1" },
    args: ["all", "conv-1"],
  },
  {
    label: "followup",
    ipc: "engineSetFollowUp",
    method: "setFollowUpMode",
    payload: { mode: "one-at-a-time", conversationId: "conv-1" },
    args: ["one-at-a-time", "conv-1"],
  },
  // `setInterruptMode(mode, conversationId?)` accepts the id — it is how the returned
  // state is scoped — so the agent table forwards it the same way the desktop one does.
  {
    label: "interrupt",
    ipc: "engineSetInterrupt",
    method: "setInterruptMode",
    payload: { mode: "wait", conversationId: "conv-1" },
    args: ["wait", "conv-1"],
  },
];

function extractHandleCallbacks(source: string, fileName: string): Map<string, string> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "handle" &&
      node.arguments.length >= 2
    ) {
      const channel = node.arguments[0];
      const callback = node.arguments[1];
      if (
        channel &&
        callback &&
        ts.isPropertyAccessExpression(channel) &&
        ts.isIdentifier(channel.expression) &&
        channel.expression.text === "Ipc" &&
        ts.isIdentifier(channel.name)
      ) {
        found.set(channel.name.text, callback.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function compileHandler(callbackText: string): (engine: object) => (payload?: unknown) => unknown {
  const { outputText, diagnostics } = ts.transpileModule(`const __handler = ${callbackText};\n`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    fileName: "handler.ts",
    reportDiagnostics: true,
  });
  if (diagnostics && diagnostics.length > 0) {
    const host: ts.FormatDiagnosticsHost = {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => "",
      getNewLine: () => "\n",
    };
    throw new Error(ts.formatDiagnostics(diagnostics, host));
  }
  const factory = new Function("engine", `${outputText}return __handler;`) as (
    engine: object,
  ) => (payload?: unknown) => unknown;
  return factory;
}

function fakeEngine(): { engine: object; calls: EngineCall[] } {
  const calls: EngineCall[] = [];
  const engine = new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
      };
    },
  });
  return { engine, calls };
}

const callbacks = extractHandleCallbacks(readFileSync(handlersPath, "utf8"), handlersPath);

function callbackFor(ipc: string): string {
  const text = callbacks.get(ipc);
  assert.ok(text, `missing handle(Ipc.${ipc}, ...) in src/agent/handlers.ts`);
  return text;
}

async function run(callbackText: string, payload?: unknown, passPayload = true): Promise<EngineCall[]> {
  const { engine, calls } = fakeEngine();
  const handler = compileHandler(callbackText)(engine);
  assert.equal(typeof handler, "function");
  await (passPayload ? handler(payload) : handler());
  return calls;
}

for (const route of ROUTES) {
  test(`${route.label} forwards conversationId to ${route.method}`, async () => {
    const calls = await run(callbackFor(route.ipc), route.payload);
    assert.equal(calls.length, 1, route.label);
    assert.equal(calls[0]?.method, route.method, route.label);
    assert.deepEqual(calls[0]?.args, route.args, route.label);
  });
}

test("optional payload can be omitted", async () => {
  const optional = ROUTES.filter((route) => route.optionalPayload);
  assert.ok(optional.length >= 2);
  for (const route of optional) {
    const text = callbackFor(route.ipc);
    for (const invoke of [
      () => run(text, undefined),
      () => run(text, undefined, false),
      () => run(text, {}),
    ]) {
      const calls = await invoke();
      assert.equal(calls.length, 1, route.label);
      assert.equal(calls[0]?.method, route.method, route.label);
      assert.equal(calls[0]?.args[0], undefined, route.label);
    }
  }
});
