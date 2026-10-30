#!/usr/bin/env node
// Exercise the packaged engine without launching a GUI or touching user data.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";

const executable = resolve(process.argv[2] ?? "native/target/debug/fastvibe-server");
const data = mkdtempSync(join(tmpdir(), "fv-native-smoke-"));
const child = spawn(executable, ["--data-dir", data, "--listen", "stdio", "--model", "echo"], { stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
const timer = setTimeout(() => { console.error("packaged server smoke test timed out", stderr); child.kill("SIGKILL"); process.exitCode = 1; }, 20_000);
let initialized = false;
let passed = false;
createInterface({ input: child.stdout }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.id === 1) {
    if (frame.error || !frame.result?.serverVersion) throw new Error(`initialize failed: ${line}`);
    initialized = true;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/list", params: {} })}\n`);
  } else if (frame.id === 2) {
    if (frame.error || !initialized) throw new Error(`thread/list failed: ${line}`);
    passed = true;
    console.log("Packaged native server: initialize and thread/list passed with isolated data");
    child.kill("SIGTERM");
  }
});
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("close", () => {
  clearTimeout(timer);
  rmSync(data, { recursive: true, force: true });
  if (!passed) { console.error("packaged server smoke test failed", stderr); process.exitCode = 1; }
});
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "native-bundle-smoke", version: "0.1.0" }, protocolVersion: 1, capabilities: {} } })}\n`);
