import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const outputDir = resolve(root, String(args.get("output") || "release/agent-runtime"));
const staging = join(outputDir, `.staging-${platform}-${arch}`);
const archive = join(outputDir, `fastvibe-agent-${platform}-${arch}.tar.gz`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(outputDir, { recursive: true });

try {
  if (!existsSync(join(root, "out", "main", "agent.js"))) {
    throw new Error("缺少 out/main/agent.js，请先执行 pnpm build");
  }

  cpSync(join(root, "package.json"), join(staging, "package.json"));
  cpSync(join(root, "pnpm-lock.yaml"), join(staging, "pnpm-lock.yaml"));
  cpSync(join(root, "pnpm-workspace.yaml"), join(staging, "pnpm-workspace.yaml"));
  execFileSync("pnpm", ["install", "--prod", "--frozen-lockfile"], {
    cwd: staging,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
  rmSync(join(staging, "pnpm-lock.yaml"), { force: true });
  rmSync(join(staging, "pnpm-workspace.yaml"), { force: true });

  cpSync(join(root, "out", "main"), join(staging, "out", "main"), { recursive: true });
  cpSync(join(root, "out", "renderer"), join(staging, "out", "renderer"), { recursive: true });
  for (const name of ["extensions", "models-dev", "skills"]) {
    const source = join(root, "resources", name);
    if (existsSync(source)) cpSync(source, join(staging, "resources", name), { recursive: true });
  }
  mkdirSync(join(staging, "bin"), { recursive: true });
  cpSync(process.execPath, join(staging, "bin", "node"));
  chmodSync(join(staging, "bin", "node"), 0o755);
  writeFileSync(join(staging, "manifest.json"), JSON.stringify({
    version: packageJson.version,
    platform,
    arch,
    node: process.version,
  }, null, 2) + "\n");

  execFileSync("tar", ["-czf", archive, "--format=pax", "."], {
    cwd: staging,
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  console.log(`Agent runtime written to ${archive}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
