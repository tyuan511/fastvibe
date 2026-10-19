import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createOfficeWatchManager,
  formatOfficeSelection,
  observeOfficeFile,
  spawnOfficeCliWatch,
  type OfficeWatchChild,
  type OfficeWatchState,
} from "../src/main/engine/office-watch.ts";

function file(): string {
  const dir = mkdtempSync(join(tmpdir(), "office-watch-"));
  const path = join(dir, "demo.docx");
  writeFileSync(path, "x");
  return path;
}

function child(result: { code: number | null; stderr: string } | "hang"): OfficeWatchChild & { killed: boolean } {
  let resolveExit: (value: { code: number | null; stderr: string }) => void = () => undefined;
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    resolveExit = resolve;
  });
  const handle = {
    killed: false,
    exited,
    kill: () => {
      handle.killed = true;
      resolveExit({ code: null, stderr: "" });
    },
  };
  if (result !== "hang") queueMicrotask(() => resolveExit(result));
  return handle;
}

const install = { dir: "/app", binary: "/app/officecli", version: "v1.0.157" };

test("a second open reuses the port, and the last close is what stops it", async () => {
  const path = file();
  let spawned = 0;
  const states: OfficeWatchState[] = [];
  const manager = createOfficeWatchManager({
    install,
    releaseDelayMs: 30,
    spawn: () => {
      spawned += 1;
      return child("hang");
    },
    probe: async () => true,
    pickPort: async () => 41000 + spawned,
    onState: (state) => states.push(state),
  });
  const first = await manager.start(path);
  const second = await manager.start(path);
  assert.equal(first.port, second.port);
  assert.equal(spawned, 1);
  manager.stop(path);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(states.some((state) => state.phase === "stopped"), false);
  manager.stop(path);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(states.some((state) => state.phase === "stopped"), true);
});

test("a taken port is retried, and a watch that never answers is an error", async () => {
  const path = file();
  let attempts = 0;
  const manager = createOfficeWatchManager({
    install,
    readyTimeoutMs: 200,
    spawn: () => {
      attempts += 1;
      return attempts < 3 ? child({ code: 1, stderr: "address already in use" }) : child("hang");
    },
    probe: async () => attempts >= 3,
    pickPort: async () => 42000 + attempts,
  });
  const handle = await manager.start(path);
  assert.equal(attempts, 3);
  assert.equal(handle.port, 42002);
  await manager.stopAll();

  const dead = createOfficeWatchManager({
    install,
    readyTimeoutMs: 150,
    spawn: () => child({ code: 1, stderr: "boom" }),
    probe: async () => false,
    pickPort: async () => 43001,
  });
  await assert.rejects(dead.start(file()), /boom/);
});

test("a file change asks the watch to reload, once the debounce settles", async () => {
  const path = file();
  let changed: (() => void) | null = null;
  const switched: string[] = [];
  const manager = createOfficeWatchManager({
    install,
    releaseDelayMs: 1,
    spawn: () => child("hang"),
    probe: async () => true,
    pickPort: async () => 44001,
    observeFile: (_file, onChange) => {
      changed = onChange;
      return { close: () => undefined };
    },
    switchFile: async (_port, target) => {
      switched.push(target);
    },
  });
  await manager.start(path);
  changed?.();
  changed?.();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(switched.length, 1);
  await manager.stopAll();
});

test("a selection becomes a citation that names the path and a short quote", () => {
  const selection = formatOfficeSelection("/work/demo.docx", {
    data: {
      results: [
        { path: "/body/p[@paraId=00100000]", type: "paragraph", preview: "Hello FastVibe Office" },
        { path: "/slide[1]/shape[@id=2]", type: "shape", text: "x".repeat(120) },
      ],
    },
  });
  assert.equal(selection.items.length, 2);
  assert.match(selection.text, /\/body\/p\[@paraId=00100000\]/);
  assert.match(selection.text, /Hello FastVibe Office/);
  assert.match(selection.text, /…/);
  assert.equal(formatOfficeSelection("/work/demo.docx", { data: { results: [] } }).items.length, 0);
});

test("quitting kills every watch", async () => {
  const path = file();
  const spawned = child("hang");
  const manager = createOfficeWatchManager({
    install,
    spawn: () => spawned,
    probe: async () => true,
    pickPort: async () => 45001,
  });
  await manager.start(path);
  await manager.stopAll();
  assert.equal(spawned.killed, true);
});

test("a stop that lands while the watch is starting, then a new open, keeps the watch alive and still releases it", async () => {
  const path = file();
  const spawned = child("hang");
  let probes = 0;
  const manager = createOfficeWatchManager({
    install,
    releaseDelayMs: 40,
    spawn: () => spawned,
    // Not ready for a few probes, so both opens below overlap the launch.
    probe: async () => (probes += 1) > 3,
    pickPort: async () => 46001,
  });
  const first = manager.start(path);
  manager.stop(path);
  const second = manager.start(path);
  await Promise.all([first, second]);
  // The release the early stop armed fires while the second open still holds the watch.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(spawned.killed, false);
  // …and it must not leave a stale handle that stops the last close from releasing it.
  manager.stop(path);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(spawned.killed, true);
});

test("a save that replaces the file by rename is still noticed", async () => {
  const path = file();
  let changes = 0;
  const observer = observeOfficeFile(path, () => {
    changes += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (let round = 0; round < 2; round += 1) {
    const temporary = `${path}.tmp${round}`;
    writeFileSync(temporary, `v${round}`);
    renameSync(temporary, path);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  // An unrelated neighbour in the same folder is not a change to this document.
  const before = changes;
  writeFileSync(join(path, "..", "other.txt"), "x");
  await new Promise((resolve) => setTimeout(resolve, 150));
  observer.close();
  assert.ok(before >= 2, `both renames should have been seen, saw ${before}`);
  assert.equal(changes, before);
});

test("a watch that ignores SIGTERM is killed anyway", { skip: process.platform === "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "office-watch bin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, "officecli");
  const script = join(dir, "watch.cjs");
  const ready = join(dir, "ready");
  // A shell `trap` does not hold on every platform's /bin/sh; a Node handler does.
  writeFileSync(script, `process.on("SIGTERM", () => undefined);\nrequire("node:fs").writeFileSync(${JSON.stringify(ready)}, "up");\nsetInterval(() => undefined, 1000);\n`);
  // A shebang cannot quote an interpreter path containing spaces (e.g. fnm under
  // Application Support). Let sh quote both paths, then exec Node so it receives signals.
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  writeFileSync(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`);
  chmodSync(binary, 0o755);
  const watch = spawnOfficeCliWatch({ binary, file: join(dir, "demo.docx"), port: 1 });
  t.after(async () => {
    watch.kill();
    await watch.exited;
  });
  let exited: Awaited<typeof watch.exited> | undefined;
  void watch.exited.then((result) => { exited = result; });
  // Wait for the handler to be installed: a cold Node start can take longer than any fixed sleep.
  for (let waited = 0; !existsSync(ready) && waited < 10_000; waited += 50) {
    assert.equal(exited, undefined, `the fake watch exited before startup: ${JSON.stringify(exited)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(ready), "the fake watch never started");
  watch.kill();
  const started = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    watch.exited,
    new Promise<"timeout">((resolve) => { timeout = setTimeout(() => resolve("timeout"), 4_000); }),
  ]).finally(() => clearTimeout(timeout));
  assert.notEqual(result, "timeout");
  // It ignored SIGTERM, so only the SIGKILL fallback a second later can have ended it.
  assert.ok(Date.now() - started >= 800, "the process should have survived SIGTERM");
});
