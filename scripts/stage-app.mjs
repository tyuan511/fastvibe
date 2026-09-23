#!/usr/bin/env node
/**
 * Build a two-package.json staging dir for electron-builder.
 *
 * electron-builder's `files` allowlist is not a real allowlist: ignore-only
 * globs re-add a catch-all, and a leftover `fastvibe-*.tgz` / `src` / `docs`
 * from the repo root still lands in the asar. Staging copies only the built
 * app (`package.json` + `out/`) into `build/app`, which electron-builder then
 * treats as `directories.app`. Production node_modules are still collected
 * from the project (the collector searches projectDir when appDir has none).
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "out");
const DEST = join(ROOT, "build", "app");

async function main() {
  try {
    if (!(await stat(OUT)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("out/ is missing — run `pnpm build` before staging");
  }

  await rm(DEST, { recursive: true, force: true });
  await mkdir(DEST, { recursive: true });

  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const staged = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    license: pkg.license,
    description: pkg.description,
    author: pkg.author,
    homepage: pkg.homepage,
    repository: pkg.repository,
    type: pkg.type,
    main: pkg.main,
    dependencies: pkg.dependencies,
  };
  await writeFile(join(DEST, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);

  await cp(OUT, join(DEST, "out"), {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  });

  // The SSH deployer needs the runtime release metadata, but it must not make the
  // desktop package depend on the desktop semver. CI downloads this generated file
  // after the independent Agent runtime release job; local packaging can provide it by
  // running `pnpm build:agent-runtime` first.
  const runtimeMetadata = join(ROOT, "release", "agent-runtime", "agent-runtime.json");
  try {
    await stat(runtimeMetadata);
    await mkdir(join(DEST, "agent-runtimes"), { recursive: true });
    await cp(runtimeMetadata, join(DEST, "agent-runtimes", "agent-runtime.json"));
  } catch {
    // SSH remains unavailable in a package built without runtime metadata; the desktop
    // itself still packages normally and Main reports the missing metadata clearly.
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
