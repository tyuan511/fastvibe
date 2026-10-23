// Exports the Electron app's theme seeds and the tokens `buildTokens` / `glassTokens`
// derive from them, so the Rust `fv-theme` crate can be generated from and checked
// against the TypeScript original. Run: node native/scripts/export-themes.mjs
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let source = readFileSync(join(root, "src/renderer/src/lib/themes.ts"), "utf8");

source = source
  .replace(/import \{ isGlassEnabled \} from "@shared\/glass";/, "const isGlassEnabled = (s: { glass?: unknown }) => s.glass !== false;")
  .replace(/import \{ HAS_VIBRANCY \} from "@\/lib\/platform";/, "const HAS_VIBRANCY = true;")
  .concat("\nexport { SEEDS, buildTokens, glassTokens };\n");

const dir = mkdtempSync(join(tmpdir(), "fv-themes-"));
const file = join(dir, "themes.ts");
writeFileSync(file, source);
const m = await import(pathToFileURL(file).href);

const ids = Object.keys(m.SEEDS);
const seeds = Object.fromEntries(ids.map((id) => [id, m.SEEDS[id]]));
const snapshot = Object.fromEntries(
  ids.map((id) => [id, { solid: m.buildTokens(m.SEEDS[id]), glass: m.glassTokens(m.SEEDS[id]) }]),
);

const out = join(root, "native/crates/fv-theme/data");
writeFileSync(
  join(out, "themes.json"),
  JSON.stringify({ light: m.LIGHT_THEME_IDS, dark: m.DARK_THEME_IDS, order: ids, seeds }, null, 2) + "\n",
);
writeFileSync(join(out, "tokens.snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n");
console.log(`exported ${ids.length} themes`);
