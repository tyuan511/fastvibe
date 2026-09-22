import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgentRuntime } from "./check-agent-runtime.mjs";

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
checkAgentRuntime(join(root, "out", "main", "agent.js"));

const outputDir = resolve(root, String(args.get("output") || "release/agent-runtime"));
const staging = join(outputDir, `.staging-${platform}-${arch}`);
const archive = join(outputDir, `fastvibe-agent-${platform}-${arch}.tar.gz`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(outputDir, { recursive: true });

try {
  cpSync(join(root, "package.json"), join(staging, "package.json"));
  cpSync(join(root, "pnpm-lock.yaml"), join(staging, "pnpm-lock.yaml"));
  cpSync(join(root, "pnpm-workspace.yaml"), join(staging, "pnpm-workspace.yaml"));
  execFileSync("pnpm", ["install", "--prod", "--frozen-lockfile"], {
    cwd: staging,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
  pruneAgentDependencies(staging);
  pruneDebugFiles(join(staging, "node_modules"));
  const runtimePackage = JSON.parse(readFileSync(join(staging, "package.json"), "utf8"));
  delete runtimePackage.dependencies?.["node-pty"];
  writeFileSync(join(staging, "package.json"), JSON.stringify(runtimePackage, null, 2) + "\n");
  rmSync(join(staging, "pnpm-lock.yaml"), { force: true });
  rmSync(join(staging, "pnpm-workspace.yaml"), { force: true });

  cpSync(join(root, "out", "main"), join(staging, "out", "main"), { recursive: true });
  cpSync(join(root, "out", "renderer"), join(staging, "out", "renderer"), { recursive: true });
  for (const name of ["extensions", "models-dev", "skills"]) {
    const source = join(root, "resources", name);
    if (existsSync(source)) cpSync(source, join(staging, "resources", name), { recursive: true });
  }
  // Node is intentionally not copied into the Agent archive. The remote bootstrap
  // reuses a compatible system Node, or installs the exact build version under the
  // user's ~/.fastvibe-agent directory when the host has none.
  writeFileSync(join(staging, "manifest.json"), JSON.stringify({
    version: packageJson.version,
    platform,
    arch,
    node: process.version,
  }, null, 2) + "\n");

  execFileSync("tar", ["-czf", archive, "--format=pax", "."], {
    cwd: staging,
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1", GZIP: "-9" },
  });
  console.log(`Agent runtime written to ${archive}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

function pruneAgentDependencies(rootDir) {
  const pnpmRoot = join(rootDir, "node_modules", ".pnpm");
  if (!existsSync(pnpmRoot)) return;
  const nodePtyPackages = readdirSync(pnpmRoot)
    .filter((name) => name.startsWith("node-pty@"));
  // The remote Agent uses Linux's `script` PTY fallback. Removing node-pty is
  // important now that the Agent uses the host's Node: its native ABI would be
  // tied to the Node version used by the build machine.
  for (const packageDir of nodePtyPackages) {
    rmSync(join(pnpmRoot, packageDir), { recursive: true, force: true });
  }
  rmSync(join(rootDir, "node_modules", "node-pty"), { force: true });
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
