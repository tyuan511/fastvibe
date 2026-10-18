/**
 * The file-icon pipeline: how a VS Code icon theme becomes FastVibe's lookup table
 * (`scripts/lib/file-icons-normalize.mjs`), and how a name resolves against the manifest that
 * ships in `resources/file-icons`.
 *
 * The rules worth pinning are the ones that fail silently: a language id that never folds leaves
 * `.ts` a blank page, an extension claimed by the wrong language draws the wrong glyph, and a
 * manifest naming an icon that was not vendored is a broken image in the file tree.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeIconTheme } from "../scripts/lib/file-icons-normalize.mjs";
import { resolveFileIcon } from "../src/shared/file-icons.ts";
import type { FileIconMapping } from "../src/shared/types.ts";

const ICONS_ROOT = join(import.meta.dirname, "..", "resources", "file-icons");

test("an extension the theme maps itself always beats a folded language id", () => {
  const { manifest } = normalizeIconTheme(
    {
      iconDefinitions: {
        _file: { iconPath: "../../icons/default_file.svg" },
        _folder: { iconPath: "../../icons/default_folder.svg" },
        _folder_open: { iconPath: "../../icons/default_folder_opened.svg" },
        _mine: { iconPath: "../../icons/file_type_mine.svg" },
        _theirs: { iconPath: "../../icons/file_type_theirs.svg" },
      },
      file: "_file",
      folder: "_folder",
      folderExpanded: "_folder_open",
      fileExtensions: { py: "_mine" },
      fileNames: { "Package.JSON": "_theirs" },
      languageIds: { python: "_theirs" },
    },
    { languageExtensions: { python: ["py"] } },
  );

  assert.equal(manifest.fileExtensions.py, "file_type_mine");
  // File names are folded to lower case, because every lookup compares lower case.
  assert.equal(manifest.fileNames["package.json"], "file_type_theirs");
  assert.equal(manifest.file, "default_file");
  assert.equal(manifest.folderExpanded, "default_folder_opened");
});

test("the language whose id *is* the extension owns it, so .yaml is YAML and not Ansible", () => {
  const { manifest } = normalizeIconTheme(
    {
      iconDefinitions: {
        _file: { iconPath: "./default_file.svg" },
        _f_yaml: { iconPath: "./file_type_yaml.svg" },
        _f_ansible: { iconPath: "./file_type_ansible.svg" },
      },
      file: "_file",
      folder: "_file",
      folderExpanded: "_file",
      languageIds: { ansible: "_f_ansible", yaml: "_f_yaml" },
    },
    { languageExtensions: { ansible: ["yaml"], yaml: ["yaml", "yml"] } },
  );

  assert.equal(manifest.fileExtensions.yaml, "file_type_yaml");
  assert.equal(manifest.fileExtensions.yml, "file_type_yaml");
});

test("a language id with no entry in the fold table is reported, not quietly dropped", () => {
  const { manifest, skippedLanguages } = normalizeIconTheme(
    {
      iconDefinitions: { _file: { iconPath: "./default_file.svg" }, _f_x: { iconPath: "./x.svg" } },
      file: "_file",
      folder: "_file",
      folderExpanded: "_file",
      languageIds: { befunge: "_f_x" },
    },
    { languageExtensions: {} },
  );

  assert.deepEqual(skippedLanguages, ["befunge"]);
  assert.equal(Object.keys(manifest.fileExtensions).length, 0);
});

/* ------------------------------------------------------------------ what actually ships */

const manifest = JSON.parse(readFileSync(join(ICONS_ROOT, "manifest.json"), "utf8")) as FileIconMapping & {
  source?: string;
};
const shippedIcons = new Set(readdirSync(join(ICONS_ROOT, "icons")).map((file) => file.replace(/\.svg$/, "")));

test("the vendored manifest names nothing that was not vendored", () => {
  assert.match(manifest.source ?? "", /vscode-icons/);
  const referenced = new Set([
    ...Object.values(manifest.fileExtensions),
    ...Object.values(manifest.fileNames),
    ...Object.values(manifest.folderNames ?? {}),
    ...Object.values(manifest.folderNamesExpanded ?? {}),
    ...Object.values(manifest.light?.fileExtensions ?? {}),
    ...Object.values(manifest.light?.fileNames ?? {}),
    ...Object.values(manifest.light?.folderNames ?? {}),
    ...Object.values(manifest.light?.folderNamesExpanded ?? {}),
    manifest.file,
    manifest.folder,
    manifest.folderExpanded,
    ...(manifest.light?.file ? [manifest.light.file] : []),
  ]);
  const missing = [...referenced].filter((name) => !shippedIcons.has(name));
  assert.deepEqual(missing, [], `icons referenced by manifest.json but absent from icons/: ${missing.join(", ")}`);
  assert.ok(existsSync(join(ICONS_ROOT, "LICENSE.txt")), "vscode-icons is MIT; its licence must ship with it");
});

test("the file types a chat and a file tree are made of resolve to their own glyph", () => {
  const file = (name: string) => resolveFileIcon(manifest, name);
  const generic = manifest.file;

  for (const [name, expected] of [
    ["index.ts", "file_type_typescript"],
    ["App.tsx", "file_type_reactts"],
    ["app.py", "file_type_python"],
    ["main.go", "file_type_go"],
    ["lib.rs", "file_type_rust"],
    ["README.md", "file_type_markdown"],
    ["config.yaml", "file_type_yaml"],
    ["quarterly-report.docx", "file_type_word"],
    ["budget.xlsx", "file_type_excel"],
    ["deck.pptx", "file_type_powerpoint"],
    ["invoice.pdf", "file_type_pdf"],
    // No extension to read: the whole name is the key.
    ["Dockerfile", "file_type_docker"],
    ["Makefile", manifest.fileExtensions.makefile ?? "file_type_gnu"],
    [".gitignore", "file_type_git"],
    ["package.json", "file_type_npm"],
  ] as const) {
    assert.notEqual(file(name), generic, `${name} fell back to the generic file icon`);
    assert.equal(file(name), expected, `${name} resolved to the wrong glyph`);
  }

  assert.equal(file("definitely-not-a-real-type.xyz"), generic);
});

test("folders follow the theme's own folder glyphs, open state included", () => {
  assert.equal(resolveFileIcon(manifest, "src", { kind: "folder" }), "folder_type_src");
  assert.equal(resolveFileIcon(manifest, "src", { kind: "folder", expanded: true }), "folder_type_src_opened");
  assert.equal(resolveFileIcon(manifest, "random-directory", { kind: "folder" }), manifest.folder);
  assert.equal(
    resolveFileIcon(manifest, "random-directory", { kind: "folder", expanded: true }),
    manifest.folderExpanded,
  );
});

test("a dotted extension is matched longest-first, so d.ts is not plain ts", () => {
  const mapping: FileIconMapping = {
    fileExtensions: { ts: "file_type_typescript", "d.ts": "file_type_typescriptdef" },
    fileNames: {},
    file: "default_file",
    folder: "default_folder",
    folderExpanded: "default_folder_opened",
  };
  assert.equal(resolveFileIcon(mapping, "types.d.ts"), "file_type_typescriptdef");
  assert.equal(resolveFileIcon(mapping, "index.ts"), "file_type_typescript");
});

/* ------------------------------------------------------------------ light-theme artwork */

test("the manifest carries only what the light theme draws differently", () => {
  const light = manifest.light;
  assert.ok(light, "vscode-icons ships a light block; the vendored manifest must keep it");
  assert.ok(Object.keys(light?.fileExtensions ?? {}).length > 0);
  for (const [key, map] of Object.entries(light ?? {})) {
    if (typeof map !== "object") continue;
    for (const [name, icon] of Object.entries(map as Record<string, string>)) {
      const base = (manifest[key] as Record<string, string>)[name];
      assert.notEqual(icon, base, `light.${key}.${name} repeats the default and should be dropped`);
    }
  }
});

test("a light override wins on a light theme and the default set wins otherwise", () => {
  const [extension, lightIcon] = Object.entries(manifest.light!.fileExtensions!)[0];
  const baseIcon = manifest.fileExtensions[extension];
  const file = `sample.${extension}`;

  assert.equal(resolveFileIcon(manifest, file, { light: true }), lightIcon);
  assert.equal(resolveFileIcon(manifest, file), baseIcon);
  assert.equal(resolveFileIcon(manifest, file, { light: false }), baseIcon);

  // A name with no light artwork is not a hole: light mode falls back to the default glyph.
  assert.equal(resolveFileIcon(manifest, "index.ts", { light: true }), resolveFileIcon(manifest, "index.ts"));
});

test("normalizeIconTheme keeps only the differing entries of a theme's light block", () => {
  const { manifest: made } = normalizeIconTheme({
    iconDefinitions: {
      _file: { iconPath: "./default_file.svg" },
      _file_light: { iconPath: "./default_file_light.svg" },
      _a: { iconPath: "./a.svg" },
      _a_light: { iconPath: "./a_light.svg" },
      _b: { iconPath: "./b.svg" },
    },
    file: "_file",
    folder: "_file",
    folderExpanded: "_file",
    fileExtensions: { one: "_a", two: "_b" },
    light: {
      // Same icon for `one`, a different one for `two`, and a default glyph that differs.
      fileExtensions: { one: "_a", two: "_a_light" },
      file: "_file_light",
    },
  });

  assert.deepEqual(made.light?.fileExtensions, { two: "a_light" });
  assert.equal(made.light?.file, "default_file_light");
  assert.equal(made.light?.folderNames, undefined);
});
