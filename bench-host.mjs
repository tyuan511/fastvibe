import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { TranscriptReader } from "./src/main/engine/transcript-reader.ts";
import { mapEngineMessages } from "./src/main/engine/map-messages.ts";
import { transcriptWindow, transcriptEntryEnd } from "./src/main/engine/transcript-window.ts";
import { previewTranscript } from "./src/shared/transcript-preview.ts";
import { summarizeToolCalls } from "./src/shared/tool-summary.ts";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
const ts = createRequire(import.meta.url)("typescript");
const mod = { exports: {} };
const code = ts.transpileModule(readFileSync("./src/main/pi/process-manager-transcript.ts", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
new Function("module", "exports", "require", code)(mod, mod.exports, (name) => ({
  "@earendil-works/pi-coding-agent": { sessionEntryToContextMessages },
  "../engine/map-messages": { mapEngineMessages },
  "./tui-bridge": { renderExtensionMessage: () => undefined },
  "./process-manager-events": { isRecord: (v) => v !== null && typeof v === "object" },
  "../engine/transcript-window": { transcriptWindow, transcriptEntryEnd },
  "../engine/tool-images": { externalizeToolResultMessages: (m) => m },
})[name]);
const { projectSessionMessages } = mod.exports;

const file = process.argv[2];
const reader = new TranscriptReader();
let t = performance.now();
const branch = await reader.read(file, "/tmp");
console.log(`read(no cache): ${(performance.now() - t).toFixed(0)}ms entries=${branch.length}`);
t = performance.now();
await reader.read(file, "/tmp");
console.log(`read(cached): ${(performance.now() - t).toFixed(0)}ms`);

function project(page, preview, maxBytes) {
  const deps = { branch, conversationId: "c", page, reasoning: { get: () => undefined }, widgetWidth: 800, running: new Map(), compacting: new Map() };
  const run = () => {
    let v = projectSessionMessages(deps);
    let messages = summarizeToolCalls(v.messages);
    if (preview) messages = previewTranscript(messages, 12_000, false);
    return { ...v, messages };
  };
  let projected = run(); let rounds = 1;
  while (deps.page && deps.page.turnLimit > 1 && maxBytes && Buffer.byteLength(JSON.stringify(projected.messages)) > maxBytes) {
    deps.page = { ...deps.page, turnLimit: Math.max(1, Math.floor(deps.page.turnLimit / 2)) };
    projected = run(); rounds++;
  }
  return { projected, rounds };
}
for (const [label, page, preview, maxBytes] of [
  ["phone now: window3 + preview + 128K", { turnLimit: 3 }, true, 128 * 1024],
  ["desktop: no page", undefined, false, undefined],
  ["old phone: window12", { turnLimit: 12 }, false, undefined],
]) {
  const s = performance.now();
  const { projected, rounds } = project(page, preview, maxBytes);
  const bytes = Buffer.byteLength(JSON.stringify(projected.messages));
  console.log(`${label}: ${(performance.now() - s).toFixed(0)}ms rounds=${rounds} msgs=${projected.messages.length} bytes=${(bytes/1024).toFixed(0)}KB`);
}
