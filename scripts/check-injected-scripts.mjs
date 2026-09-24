#!/usr/bin/env node
/**
 * Guards the page scripts the side pane injects into its browser webview.
 *
 * Electron reports a script that never compiles as
 * `GUEST_VIEW_MANAGER_CALL: Script failed to execute, this normally means an error
 * was thrown` — which names neither the script nor the reason, and a `browser_snapshot`
 * with one missing brace fails on every call. Nothing else in the toolchain catches
 * that: `tsc` is happy with the contents of a template literal, and the failure only
 * exists at runtime, in another process.
 *
 * So: pull every injected script out of the module, substitute a placeholder for each
 * `${...}`, and parse the result. A script that parses alone will parse in the guest.
 *
 *   node scripts/check-injected-scripts.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const TARGETS = [
  join(here, "..", "src", "renderer", "src", "components", "layout", "browser-guest.ts"),
  // The same scripts the system-browser CDP backend evaluates. A brace missing here
  // fails every browser-use call once that backend is on, and tsc cannot see it.
  join(here, "..", "src", "shared", "browser-page.ts"),
];

/** Script fragments held in constants and handed to `inject` by name. */
const FRAGMENT_CONSTANTS = ["PAGE_HELPERS", "SNAPSHOT_BODY", "PICK_BODY", "PICK_READ_BODY"];

/** Functions whose returned template literal is a page script. */
const SCRIPT_FUNCTIONS = ["clickBody", "typeBody", "pressBody"];

/** Read the template literal that starts at `text[start]` (a backtick), tracking
 * `${}` nesting so an interpolation containing a backtick or brace cannot end it. */
const BACKTICK = String.fromCharCode(96);

function readTemplateLiteral(text, start) {
  let depth = 0;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "$" && text[i + 1] === "{") {
      depth++;
      i++;
      continue;
    }
    if (depth > 0) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      continue;
    }
    if (ch === "`") return { body: text.slice(start + 1, i), end: i };
  }
  return null;
}

/**
 * Replace each `${...}` with `0`. The interpolated values are always a
 * `JSON.stringify(...)` result or another script fragment, so a placeholder keeps
 * the surrounding code parseable while still exposing a missing brace or paren in
 * the parts we author by hand.
 */
function neutralise(body) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      out += body.slice(i, i + 2);
      i++;
      continue;
    }
    if (depth === 0 && ch === "$" && body[i + 1] === "{") {
      depth = 1;
      out += "0";
      i++;
      continue;
    }
    if (depth > 0) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      continue;
    }
    out += ch;
  }
  return out;
}

/** The scripts an injected call site passes, found by its call shape. */
function collect(source) {
  const found = [];
  const site = /(?:inject|execute|act)\(\s*entry\s*,\s*`/g;
  for (let match = site.exec(source); match; match = site.exec(source)) {
    const literal = readTemplateLiteral(source, match.index + match[0].length - 1);
    if (literal) found.push({ name: `call site @${match.index}`, body: literal.body });
  }
  for (const name of FRAGMENT_CONSTANTS) {
    const declaration = new RegExp(`const\\s+${name}\\s*=\\s*` + BACKTICK, "g").exec(source);
    if (!declaration) continue;
    const literal = readTemplateLiteral(source, declaration.index + declaration[0].length - 1);
    if (literal) found.push({ name, body: literal.body });
  }
  for (const name of SCRIPT_FUNCTIONS) {
    const declaration = new RegExp(`function\\s+${name}\\b[\\s\\S]*?return\\s*` + BACKTICK).exec(source);
    if (!declaration) continue;
    const start = declaration.index + declaration[0].length - 1;
    const literal = readTemplateLiteral(source, start);
    if (literal) found.push({ name, body: literal.body });
  }
  return found;
}

const scripts = [];
for (const target of TARGETS) {
  const source = readFileSync(target, "utf8");
  const found = collect(source);
  if (found.length === 0) {
    scripts.push({ name: target, body: "/* extractor matched nothing */" });
  }
  for (const script of found) scripts.push({ name: `${target} ${script.name}`, body: script.body });
}
const problems = [];

if (scripts.length < 4) {
  problems.push(
    `only ${scripts.length} injected script(s) found — the extractor no longer matches the code, so this check is not covering anything`,
  );
}

for (const script of scripts) {
  if (script.body.startsWith("/* extractor")) {
    problems.push(`${script.name}: no injected script found`);
    continue;
  }
  const code = `(() => { const value = (() => { ${neutralise(script.body)} })(); return { ok: true, value: value }; })()`;
  try {
    // Parse only: nothing here ever runs.
    new Function(code);
  } catch (error) {
    problems.push(`${script.name}: ${error.message}\n${neutralise(script.body)}`);
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} injected browser script(s) would fail to compile in the page:\n`);
  for (const problem of problems) console.error(`${problem}\n`);
  console.error("(verbatim source, with every ${...} replaced by 0)");
  console.error("Electron reports these as `Script failed to execute` at tool-call time, not here.");
  process.exit(1);
}

console.log(`✓ ${scripts.length} injected browser scripts compile`);
