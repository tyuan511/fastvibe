import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentRuntimePackages, checkAgentRuntime } from "./check-agent-runtime.mjs";
import { hashRuntimeDirectory } from "./agent-runtime-hash.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.join("=") || true];
}));
const platform = String(args.get("platform") || "linux");
const arch = String(args.get("arch") || (process.arch === "arm64" ? "arm64" : "x64"));
if (platform !== "linux" || !["x64", "arm64"].includes(arch)) {
  throw new Error("Agent runtime 目前只支持 linux-x64 或 linux-arm64");
}
if (process.platform !== "linux") {
  throw new Error("Agent runtime 必须在 Linux 构建机上生成，以获得正确的原生依赖");
}
const expectedArch = arch === "x64" ? "x64" : "arm64";
if (process.arch !== expectedArch) {
  throw new Error(`构建架构不匹配：需要 ${expectedArch}，当前是 ${process.arch}`);
}

// Fail before staging cleanup, dependency installation, or archive creation.
const agentEntry = join(root, "out", "main", "agent.js");
const agentFiles = checkAgentRuntime(agentEntry);
const runtimeDependencies = agentDependencies(agentRuntimePackages(agentEntry));

const outputDir = resolve(root, String(args.get("output") || "release/agent-runtime"));
const staging = join(outputDir, `.staging-${platform}-${arch}`);
const target = `${platform}-${arch}`;
const archive = join(outputDir, `fastvibe-agent-${target}.tar.gz`);
const metadataFile = join(outputDir, `runtime-metadata-${target}.json`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(outputDir, { recursive: true });

try {
  // Only what the Agent imports, not the desktop's whole `dependencies`: the updater, the
  // computer-use driver (~40 MB), node-pty, icon themes and React-based toasts never run
  // on the remote host. The desktop lockfile still pins every version: pnpm keeps the
  // locked resolution of each remaining package and only drops the rest, which is why
  // the lockfile may change here (`--no-frozen-lockfile`) but no version can.
  writeFileSync(join(staging, "package.json"), JSON.stringify({
    name: `${packageJson.name}-agent`,
    // This is an isolated package, not a release of the desktop application. Keeping
    // the desktop semver out of it is important: the runtime is deduplicated by content.
    version: "0.0.0",
    private: true,
    type: packageJson.type,
    packageManager: packageJson.packageManager,
    dependencies: runtimeDependencies,
  }, null, 2) + "\n");
  cpSync(join(root, "pnpm-lock.yaml"), join(staging, "pnpm-lock.yaml"));
  cpSync(join(root, "pnpm-workspace.yaml"), join(staging, "pnpm-workspace.yaml"));
  execFileSync("pnpm", ["install", "--prod", "--no-frozen-lockfile", "--prefer-offline"], {
    cwd: staging,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
  pruneUnreachable(join(staging, "node_modules"));
  pruneDebugFiles(join(staging, "node_modules"));
  rmSync(join(staging, "pnpm-lock.yaml"), { force: true });
  rmSync(join(staging, "pnpm-workspace.yaml"), { force: true });

  // The web client (`out/renderer`) is not shipped: the remote Agent listens on loopback
  // only, on a port the OS picked, with no password set, so no browser can ever load it
  // there. Without a web root the server answers 404 for pages, which is all it can mean.
  cpSync(join(root, "out", "main"), join(staging, "out", "main"), { recursive: true });
  for (const name of ["extensions", "models-dev", "skills"]) {
    const source = join(root, "resources", name);
    if (existsSync(source)) cpSync(source, join(staging, "resources", name), { recursive: true });
  }
  // Node is intentionally not copied into the Agent archive. The remote bootstrap
  // reuses a compatible system Node, or installs the exact build version under the
  // user's ~/.fastvibe-agent directory when the host has none.
  const runtimeHash = hashRuntimeDirectory(staging, {
    target,
    // CI tracks the Node major/minor line. Patch updates do not change the Agent
    // payload and must not manufacture a new runtime release.
    node: process.versions.node.split(".").slice(0, 2).join("."),
    // `out/main` also contains the Electron desktop entry. It is shipped for the
    // existing relative-module layout, but a desktop-only change must not create a new
    // Agent release when no file reachable from agent.js changed.
    ignore: (name) => name === "node_modules/.modules.yaml"
      || name === "node_modules/.pnpm/lock.yaml"
      || (name.startsWith("out/main/") && !agentFiles.has(join(root, name))),
  });
  writeFileSync(join(staging, "manifest.json"), JSON.stringify({
    // `version` remains for old bootstrap readers; new clients validate runtimeHash.
    version: runtimeHash,
    runtimeHash,
    platform,
    arch,
    node: process.version,
  }, null, 2) + "\n");

  await smokeTest(staging);

  execFileSync("tar", ["-czf", archive, "--format=pax", "."], {
    cwd: staging,
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1", GZIP: "-9" },
  });
  const archiveSha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const metadata = {
    schema: 1,
    target,
    runtimeHash,
    archive: `fastvibe-agent-${target}.tar.gz`,
    archiveSha256,
    node: process.version,
  };
  writeFileSync(metadataFile, JSON.stringify(metadata, null, 2) + "\n");
  console.log(`Agent runtime written to ${archive}`);
  console.log(`Agent runtime metadata written to ${metadataFile}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

/** The Agent's packages at the versions the desktop declares; an undeclared one is a bug. */
function agentDependencies(packages) {
  const declared = packageJson.dependencies ?? {};
  const missing = [...packages].filter((name) => !declared[name]);
  if (missing.length) {
    throw new Error(`Agent imports packages that are not production dependencies: ${missing.join(", ")}`);
  }
  return Object.fromEntries([...packages].sort().map((name) => [name, declared[name]]));
}

/**
 * Remove installed files no Agent code path can load.
 *
 * - esbuild and its ~10 MB native binary: pulled in by `@earendil-works/chord`, but only
 *   its `chord/node` bundler entry imports it, and nothing the Agent loads imports that.
 * - `pi-coding-agent/dist/bundle`: the prebuilt `pi` CLI and `rpc-entry`. The library
 *   entry the Agent imports is `dist/index.js`, which never reaches into the bundle.
 *
 * `smokeTest` below starts the staged Agent before anything is archived, so a wrong
 * entry here fails the build rather than a user's connect.
 */
function pruneUnreachable(nodeModules) {
  const pnpmRoot = join(nodeModules, ".pnpm");
  if (!existsSync(pnpmRoot)) return;
  for (const name of readdirSync(pnpmRoot)) {
    if (name.startsWith("esbuild@") || name.startsWith("@esbuild+")) {
      rmSync(join(pnpmRoot, name), { recursive: true, force: true });
    }
    if (name.startsWith("@earendil-works+pi-coding-agent@")) {
      rmSync(join(pnpmRoot, name, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle"), { recursive: true, force: true });
    }
  }
}

function pruneDebugFiles(rootDir) {
  if (!existsSync(rootDir)) return;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const path = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      pruneDebugFiles(path);
      continue;
    }
    // Source maps and TypeScript declarations are not loaded by Node at runtime.
    // They accounted for about 50 MB in the dependency tree of the Agent.
    if (entry.name.endsWith(".map") || entry.name.endsWith(".d.ts")) rmSync(path, { force: true });
  }
}

/**
 * Start the staged Agent exactly as the SSH bootstrap does, and wait for it to listen.
 *
 * Everything pruned above is pruned on a claim that nothing loads it. This is the check
 * of that claim: the Agent's whole module graph is imported at startup, so a package or
 * file it still needed fails here, with its log, before the archive exists.
 */
async function smokeTest(dir) {
  const scratch = mkdtempSync(join(tmpdir(), "fastvibe-agent-smoke-"));
  const stateFile = join(scratch, "agent.json");
  const child = spawn(process.execPath, [join(dir, "out", "main", "agent.js"), "--headless", "--port=0", `--state-file=${stateFile}`, `--data-dir=${join(scratch, "data")}`], {
    env: { ...process.env, HOME: scratch, FASTVIBE_AGENT_SYNC_TOKEN: "0".repeat(64) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  try {
    const deadline = Date.now() + 60_000;
    while (!existsSync(stateFile)) {
      if (child.exitCode !== null) throw new Error(`Agent smoke test: the staged Agent exited (${child.exitCode})\n${log}`);
      if (Date.now() > deadline) throw new Error(`Agent smoke test: no state file after 60s\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (!Number.isInteger(state.port) || state.port < 1) throw new Error(`Agent smoke test: bad state file ${JSON.stringify(state)}`);
    console.log(`Agent smoke test passed: listening on 127.0.0.1:${state.port}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
    rmSync(scratch, { recursive: true, force: true });
  }
}
