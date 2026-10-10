/**
 * Fails when the packaged app is missing a dependency one of its packages needs.
 *
 * electron-builder collects production `node_modules` by asking pnpm where each package
 * lives. When pnpm reports one package under two peer variants (`pi-ai@1.1.0(undici@8.10.2)`
 * and `pi-ai@1.1.0(undici@8.11.2)`), the collector logs "cannot find path for dependency" and
 * carries on: the build succeeds and the app is missing everything under that package. v0.19.0
 * shipped that way and died on launch with `Cannot find package 'cross-spawn'`.
 *
 * This runs as the `afterPack` hook, so a bad package fails the build before any installer or
 * release exists. It is also a CLI, for checking an installed or unpacked app:
 *
 *     node scripts/check-packaged-deps.cjs /Applications/FastVibe.app/Contents/Resources/app.asar
 *
 * For every package in the archive it reads `dependencies` and looks each one up the way
 * Node would: in the package's own `node_modules`, then in each enclosing one. A package
 * with a declared dependency that none of those hold is reported. `optionalDependencies`
 * and `peerDependencies` are not checked: the first are per-platform on purpose.
 */
const path = require("node:path");
const { createRequire } = require("node:module");

/**
 * Dependencies the packaging config removes on purpose (see `files` in electron-builder.yml),
 * as `package -> dependency`. Anything not listed here is a real gap.
 */
const REMOVED_ON_PURPOSE = {
  "@huggingface/transformers": ["onnxruntime-web"],
};

function loadAsar() {
  // electron-builder carries its own copy; this repo does not depend on it directly.
  // pnpm does not hoist it, so it is reached through electron-builder.
  const fromRoot = createRequire(path.join(process.cwd(), "package.json"));
  const fromBuilder = createRequire(fromRoot.resolve("electron-builder/package.json"));
  const fromLib = createRequire(fromBuilder.resolve("app-builder-lib/package.json"));
  return fromLib("@electron/asar");
}

/** Package roots in the archive: `node_modules/<name>` or `node_modules/@scope/<name>`, at any depth. */
function packageRoots(header) {
  const roots = [];
  const walk = (node, segments) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      if (!child.files) continue;
      const here = [...segments, name];
      const parent = segments[segments.length - 1];
      const grand = segments[segments.length - 2];
      if (parent === "node_modules" && !name.startsWith("@")) roots.push(here.join("/"));
      else if (grand === "node_modules" && parent?.startsWith("@")) roots.push(here.join("/"));
      walk(child, here);
    }
  };
  walk(header, []);
  return roots;
}

function lookup(header, pathSegments) {
  let node = header;
  for (const part of pathSegments) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  return node;
}

/** Whether `dep` resolves from the package at `root` (a path such as `node_modules/a/node_modules/b`). */
function resolves(header, root, dep) {
  const parts = root.split("/");
  // Walk up: root/node_modules/dep, then each enclosing node_modules/dep.
  for (let end = parts.length; end >= 0; end--) {
    const base = parts.slice(0, end);
    if (end < parts.length && base[base.length - 1] !== "node_modules" && end !== 0) continue;
    const candidate = base[base.length - 1] === "node_modules" ? base : [...base, "node_modules"];
    if (lookup(header, [...candidate, ...dep.split("/")])) return true;
  }
  return false;
}

function check(asarPath) {
  const asar = loadAsar();
  const header = JSON.parse(JSON.stringify(asar.getRawHeader(asarPath).header));
  const read = (file) => {
    try {
      return JSON.parse(asar.extractFile(asarPath, file).toString("utf8"));
    } catch {
      return null;
    }
  };
  const missing = [];
  const roots = packageRoots(header);
  for (const root of roots) {
    const pkg = read(`${root}/package.json`);
    if (!pkg) continue;
    const skip = new Set(REMOVED_ON_PURPOSE[pkg.name] ?? []);
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (skip.has(dep) || resolves(header, root, dep)) continue;
      missing.push(`${root.replace(/(^|\/)node_modules\//g, "$1")} needs ${dep}`);
    }
  }
  // The app's own package.json sits at the archive root.
  const app = read("package.json");
  for (const dep of Object.keys(app?.dependencies ?? {})) {
    if (!lookup(header, ["node_modules", ...dep.split("/")])) missing.push(`the app needs ${dep}`);
  }
  return { packages: roots.length, missing };
}

function asarPathFor(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    return path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources", "app.asar");
  }
  return path.join(appOutDir, "resources", "app.asar");
}

function report(asarPath) {
  const { packages, missing } = check(asarPath);
  if (missing.length === 0) {
    console.log(`  • packaged dependencies complete  packages=${packages}`);
    return;
  }
  const shown = missing.slice(0, 25).map((line) => `    ${line}`).join("\n");
  throw new Error(
    `The packaged app is missing ${missing.length} dependencies its packages need, and would fail on launch:\n${shown}\n` +
      "Look for a package that pnpm resolved under two peer variants (grep the snapshots in pnpm-lock.yaml), " +
      "and for the 'cannot find path for dependency' warning in this build's log.",
  );
}

/** electron-builder `afterPack`. */
exports.default = async function afterPack(context) {
  report(asarPathFor(context));
};

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/check-packaged-deps.cjs <path to app.asar>");
    process.exit(2);
  }
  try {
    report(path.resolve(target));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
