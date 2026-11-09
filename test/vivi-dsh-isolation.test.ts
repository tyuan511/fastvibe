import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = join(root, "src/main/bot/core");
const shadow = join(root, "src/main/bot/shadow");
const isStaged = (path: string): boolean => [core, shadow].some(directory => path === directory || path.startsWith(directory + "/"));

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

function specifiers(path: string): string[] {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      result.push(node.moduleReference.expression.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) result.push(argument.text);
      else if (path.startsWith(core + "/")) assert.fail(`Computed module loading is forbidden in the isolated domain: ${path}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}

const configFile = ts.readConfigFile(join(root, "tsconfig.node.json"), ts.sys.readFile);
assert.equal(configFile.error, undefined);
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const options: ts.CompilerOptions = {
  ...config.options,
  paths: { ...config.options.paths, "@/*": ["src/renderer/src/*"] },
};
const cache = ts.createModuleResolutionCache(root, (path) => path, options);
const resolveModule = (specifier: string, containingFile: string) =>
  ts.resolveModuleName(specifier, containingFile, options, ts.sys, cache).resolvedModule?.resolvedFileName;

// This checks the actual source graph rather than an opt-out feature flag: there
// must be no edge from any current application module into the staged domain.
test("staged DSH domain and shadow storage are unreachable from existing production modules", () => {
  const violations: string[] = [];
  for (const path of [...files(join(root, "src")), ...files(join(root, "resources/extensions"))]) {
    if (isStaged(path)) continue;
    for (const specifier of specifiers(path)) {
      const target = resolveModule(specifier, path);
      if (target && isStaged(target)) {
        violations.push(`${relative(root, path)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, [], "M0–M11 preparation must not change runtime, IPC, UI, database registration, or extensions");
});

test("domain dependency closure contains only local modules and node:crypto", () => {
  const sourceFiles = files(core);
  assert.ok(sourceFiles.length >= 15, "the complete upstream domain must be present");
  for (const path of sourceFiles) {
    for (const specifier of specifiers(path)) {
      if (specifier === "node:crypto") continue;
      const target = resolveModule(specifier, path);
      assert.ok(target?.startsWith(core + "/"), `${relative(root, path)} must not depend on a runtime, SDK, network, filesystem, or configuration module: ${specifier}`);
    }
  }
});

test("shadow dependencies stay isolated, with SDK access confined to explicit role adapters", () => {
  const lowLevel = new Set([join(root, "src/main/engine/db.ts"), join(root, "src/main/engine/db-schema.ts")]);
  const builtins = new Set(["node:crypto", "node:fs", "node:os", "node:path"]);
  const bridgeImports = new Map([
    [join(shadow, "git-repository.ts"), new Set(["node:child_process", "node:fs/promises"])],
    [join(shadow, "pi-session.ts"), new Set(["node:async_hooks", "node:url", "@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "typebox"])],
    [join(shadow, "pi-executor.ts"), new Set(["@earendil-works/pi-coding-agent", "typebox"])],
    [join(shadow, "pi-reviewer.ts"), new Set(["@earendil-works/pi-coding-agent", "typebox"])],
    [join(shadow, "pi-workspace.ts"), new Set(["@earendil-works/pi-coding-agent", "typebox", "node:util"])],
  ]);
  for (const path of files(shadow)) {
    for (const specifier of specifiers(path)) {
      if (builtins.has(specifier) || bridgeImports.get(path)?.has(specifier)) continue;
      const target = resolveModule(specifier, path);
      assert.ok(target && (isStaged(target) || lowLevel.has(target)), `${relative(root, path)} has an unexpected dependency: ${specifier}`);
    }
  }
  const schema = readFileSync(join(root, "src/main/engine/db-schema.ts"), "utf8");
  assert.doesNotMatch(schema, /dsh_|shadow|bot\/core/, "production migrations must not register staged tables");
});

test("MIT attribution is distributed alongside the transplanted domain", () => {
  const notice = readFileSync(join(core, "NOTICE.md"), "utf8");
  assert.match(notice, /8c32a9dc5d72c033816c6a8110b37f40cf94fba4/);
  const license = readFileSync(join(core, "LICENSE"), "utf8");
  assert.match(license, /Copyright \(c\) 2026 DeepSeek Harness Team/);
  assert.match(license, /Permission is hereby granted/);
  for (const path of files(core)) {
    assert.match(readFileSync(path, "utf8"), /SPDX-License-Identifier: MIT/, relative(root, path));
  }
});
