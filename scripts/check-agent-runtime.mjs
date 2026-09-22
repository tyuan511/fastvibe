#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const defaultEntry = fileURLToPath(new URL("../out/main/agent.js", import.meta.url));

/** Check only the entry's reachable local artifacts, never the desktop sibling.
 * Bare packages are external; their installed dependency graphs are not inspected.
 * Computed import/require expressions cannot be resolved statically and are ignored.
 * readSource is injectable so the checker can also operate on an in-memory graph.
 */
export function checkAgentRuntime(entry = defaultEntry, readSource = (file) => readFileSync(file, "utf8")) {
  return walkAgentRuntime(entry, readSource).files;
}

/**
 * The npm packages the Agent actually imports, by name (`@scope/name` or `name`).
 *
 * This is what the runtime archive installs. The desktop's `dependencies` also carry
 * Electron-only packages (the updater, the computer-use driver, icon themes, toasts),
 * which on the remote host are only download weight. Deriving the list from the built
 * graph keeps it honest: a new import in the Agent adds its package here by itself.
 */
export function agentRuntimePackages(entry = defaultEntry, readSource = (file) => readFileSync(file, "utf8")) {
  return walkAgentRuntime(entry, readSource).packages;
}

function walkAgentRuntime(entry, readSource) {
  const visited = new Set();
  const packages = new Set();
  const pending = [{ file: resolve(entry), chain: [] }];
  while (pending.length) {
    const { file, chain } = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const route = [...chain, file];
    let source;
    try {
      source = readSource(file);
    } catch (error) {
      throw new Error(`Cannot read Agent artifact: ${route.join(" -> ")}`, { cause: error });
    }
    // JSON modules have no executable imports.
    if (file.endsWith(".json")) {
      JSON.parse(source);
      continue;
    }
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (ast.parseDiagnostics.length) {
      const diagnostic = ast.parseDiagnostics[0];
      throw new Error(`Cannot parse Agent artifact ${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
    }
    const dependencies = [];
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) dependencies.push(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      )) {
        const argument = node.arguments[0];
        if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) dependencies.push(argument.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    for (const specifier of dependencies) {
      if (specifier === "electron" || specifier.startsWith("electron/")) {
        throw new Error(`Agent runtime must not depend on electron: ${[...route, specifier].join(" -> ")}`);
      }
      if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
        // URL resolution mirrors ESM, including query/hash removal and escaped paths.
        const url = new URL(specifier, pathToFileURL(file));
        pending.push({ file: fileURLToPath(url), chain: route });
      } else {
        const name = packageName(specifier);
        if (name) packages.add(name);
      }
    }
  }
  return { files: visited, packages };
}

const BUILTINS = new Set(builtinModules);

/** `@scope/name/sub/path` → `@scope/name`, `name/sub` → `name`; builtins → null. */
function packageName(specifier) {
  if (specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return BUILTINS.has(name) ? null : name;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const files = checkAgentRuntime(process.argv[2]);
    console.log(`Agent runtime dependency check passed (${files.size} artifacts).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
