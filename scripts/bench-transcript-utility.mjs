#!/usr/bin/env node
import { app, utilityProcess } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const output = process.argv.find((value) => value.startsWith("--json="))?.slice("--json=".length) ?? "artifacts/perf-utility.json";
const rounds = 5;
const rows = Array.from({ length: 10_000 }, (_, index) => JSON.stringify({ type: "message", id: `m${index}`, parentId: index ? `m${index - 1}` : null, message: { role: index % 2 ? "assistant" : "user", content: `payload-${index}-${"x".repeat(120)}` } })).join("\n") + "\n";

function cpuMs() {
  const usage = process.resourceUsage();
  return (usage.userCPUTime + usage.systemCPUTime) / 1000;
}

async function main() {
  await app.whenReady();
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-utility-bench-"));
  const file = join(dir, "transcript.jsonl");
  await writeFile(file, rows);
  const workerPath = resolve("out/main/transcript-utility.js");
  const child = utilityProcess.fork(workerPath, [], { serviceName: "fastvibe-benchmark-transcript-utility" });
  let nextId = 1;
  const pending = new Map();
  child.on("message", (event) => {
    const message = event?.data ?? event;
    const current = pending.get(message?.id);
    if (!current) return;
    pending.delete(message.id);
    message.ok ? current.resolve(message.result) : current.reject(new Error(message.error ?? "utility failed"));
  });
  child.on("exit", (code) => {
    for (const current of pending.values()) current.reject(new Error(`utility exited ${code}`));
    pending.clear();
  });
  const request = (payload) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.postMessage({ id, ...payload });
  });
  const sample = async (name, operation) => {
    const values = [];
    for (let round = 0; round < rounds; round += 1) {
      if (globalThis.gc) globalThis.gc();
      const beforeCpu = cpuMs();
      const started = performance.now();
      const beforeRss = process.memoryUsage().rss;
      await operation();
      values.push({ wallMs: performance.now() - started, cpuMs: cpuMs() - beforeCpu, rssDelta: process.memoryUsage().rss - beforeRss });
    }
    values.sort((a, b) => a.wallMs - b.wallMs);
    return { name, median: values[Math.floor(values.length / 2)], samples: values };
  };
  const results = [
    await sample("main-jsonl-scan", async () => {
      const text = await (await import("node:fs/promises")).readFile(file, "utf8");
      let count = 0;
      for (const line of text.split("\n")) if (line) { JSON.parse(line); count += 1; }
      if (count !== 10_000) throw new Error(`main count ${count}`);
    }),
    await sample("utility-jsonl-scan", async () => {
      const result = await request({ method: "scan-jsonl", file });
      if (result.parsedCount !== 10_000) throw new Error(`utility count ${result.parsedCount}`);
    }),
    await sample("utility-jsonl-parse-and-clone", async () => {
      const result = await request({ method: "parse-jsonl", mode: "entries", file });
      if (result.parsedCount !== 10_000 || result.entries.length !== 10_000) throw new Error("utility parse count mismatch");
    }),
  ];
  child.kill();
  await rm(dir, { recursive: true, force: true });
  const report = { label: "utility-process", node: process.version, platform: process.platform, arch: process.arch, fileBytes: Buffer.byteLength(rows), rows: 10_000, results };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  app.quit();
}

main().catch((error) => { console.error(error); app.exit(1); });
