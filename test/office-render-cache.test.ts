import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { OfficeCliRenderInput } from "../src/main/engine/office-render.ts";
import { renderOfficeSnapshot, setOfficePreviewCacheDir } from "../src/main/engine/office-render.ts";
import type { OfficeCliInstall } from "../src/main/engine/office-cli.ts";

function fixture(): { source: string; cache: string; install: OfficeCliInstall } {
  const root = mkdtempSync(join(tmpdir(), "office-render-"));
  const source = join(root, "demo.docx");
  writeFileSync(source, "not really a docx");
  const cache = join(root, "cache");
  return {
    source,
    cache,
    install: { dir: root, binary: join(root, "officecli"), version: "v1.0.157" },
  };
}

test("a second open of the same file does not render again", async () => {
  const { source, cache, install } = fixture();
  let calls = 0;
  const render = async (input: OfficeCliRenderInput): Promise<void> => {
    calls += 1;
    writeFileSync(input.target, `<html>${input.source}</html>`);
  };
  const first = await renderOfficeSnapshot(source, { install, cacheDir: cache, render });
  const second = await renderOfficeSnapshot(source, { install, cacheDir: cache, render });
  assert.equal(first.path, second.path);
  assert.equal(calls, 1);
  assert.match(readFileSync(first.path, "utf8"), /demo\.docx/);
});

test("two opens at once share one render", async () => {
  const { source, cache, install } = fixture();
  let calls = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const render = async (input: OfficeCliRenderInput): Promise<void> => {
    calls += 1;
    await gate;
    writeFileSync(input.target, "page");
  };
  const pending = Promise.all([
    renderOfficeSnapshot(source, { install, cacheDir: cache, render }),
    renderOfficeSnapshot(source, { install, cacheDir: cache, render }),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  release();
  const [left, right] = await pending;
  assert.equal(left.path, right.path);
  setOfficePreviewCacheDir(null);
});

test("a changed file, and a changed OfficeCLI, are different pages", async () => {
  const { source, cache, install } = fixture();
  const render = async (input: OfficeCliRenderInput): Promise<void> => {
    writeFileSync(input.target, input.source);
  };
  const first = await renderOfficeSnapshot(source, { install, cacheDir: cache, render });
  const stamped = statSync(source);
  // mtime resolution is coarser than a tight loop; step it explicitly.
  const { utimesSync } = await import("node:fs");
  utimesSync(source, stamped.atime, new Date(stamped.mtimeMs + 5_000));
  const edited = await renderOfficeSnapshot(source, { install, cacheDir: cache, render });
  assert.notEqual(edited.path, first.path);
  const upgraded = await renderOfficeSnapshot(source, {
    install: { ...install, version: "v1.0.158" },
    cacheDir: cache,
    render,
  });
  assert.notEqual(upgraded.path, edited.path);
});

test("over budget, the least recently read page is the one removed", async () => {
  const { existsSync, utimesSync } = await import("node:fs");
  const { cache, install } = fixture();
  const root = join(cache, "..");
  const older = join(root, "old.docx");
  const newer = join(root, "new.docx");
  writeFileSync(older, "old");
  writeFileSync(newer, "new");
  const render = async (input: OfficeCliRenderInput): Promise<void> => {
    writeFileSync(input.target, "x".repeat(100));
  };
  const first = await renderOfficeSnapshot(older, { install, cacheDir: cache, render, cacheBudgetBytes: 150 });
  utimesSync(first.path, new Date(0), new Date(0));
  await renderOfficeSnapshot(newer, { install, cacheDir: cache, render, cacheBudgetBytes: 150 });
  assert.equal(existsSync(first.path), false);
});

test("no binary is an error the pane can show, not a throw from the spawn", async () => {
  const { source, cache } = fixture();
  await assert.rejects(
    renderOfficeSnapshot(source, { install: { dir: cache, binary: null, version: null }, cacheDir: cache }),
    /OfficeCLI/,
  );
});
