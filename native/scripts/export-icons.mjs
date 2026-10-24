// Writes every Hugeicons glyph the Electron renderer imports as an SVG file for fv-gui,
// so the two apps draw the same icons. Run from the repository root:
//
//   node native/scripts/export-icons.mjs
//
// The renderer draws them with `strokeWidth={2}`, so that is baked in here.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const icons = await import("@hugeicons/core-free-icons");
const root = "src/renderer/src";
const out = "native/crates/fv-gui/assets/icons";

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.tsx?$/.test(name)) yield p;
  }
}

const used = new Set();
const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@hugeicons\/core-free-icons["']/g;
for (const f of files(root)) {
  for (const m of readFileSync(f, "utf8").matchAll(importRe)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0];
      if (name) used.add(name);
    }
  }
}

const kebab = (s) =>
  s.replace(/Icon$/, "").replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").toLowerCase();
const attr = (k) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const missing = [];
let n = 0;
for (const name of [...used].sort()) {
  const data = icons[name];
  if (!Array.isArray(data)) {
    missing.push(name);
    continue;
  }
  const body = data
    .map(([tag, a]) => {
      const attrs = Object.entries(a)
        .filter(([k]) => k !== "key")
        .map(([k, v]) => `${attr(k)}="${k === "strokeWidth" ? 2 : v}"`)
        .join(" ");
      return `<${tag} ${attrs}/>`;
    })
    .join("");
  writeFileSync(
    join(out, kebab(name) + ".svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none">${body}</svg>\n`,
  );
  n++;
}
console.log(`wrote ${n} icons to ${out}`);
if (missing.length) console.log(`not in the icon set: ${missing.join(", ")}`);
