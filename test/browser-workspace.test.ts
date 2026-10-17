import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserShortcut, normalizeBrowserUrl, nextBrowserZoom, visitBrowserPage } from "../src/shared/browser-workspace.ts";
import { BrowserLibraryStore } from "../src/main/engine/browser-library.ts";

test("browser shortcuts follow the platform and preserve page editing shortcuts", () => {
  assert.equal(browserShortcut({ key: "f", meta: true }, true), "find");
  assert.equal(browserShortcut({ key: "f", control: true }, false), "find");
  assert.equal(browserShortcut({ key: "f", control: true }, true), null);
  assert.equal(browserShortcut({ key: "F", meta: true, shift: true }, true), null);
  assert.equal(browserShortcut({ key: "r", meta: true, shift: true }, true), "reloadIgnoringCache");
  assert.equal(browserShortcut({ key: "+", control: true, shift: true }, false), "zoomIn");
  assert.equal(browserShortcut({ key: "ArrowLeft", alt: true }, false), "back");
  assert.equal(browserShortcut({ key: "c", meta: true }, true), null);
});

test("recent pages deduplicate, preserve ordering, cap retention, and exclude internal content", () => {
  const history = Array.from({ length: 500 }, (_, i) => ({ url: `https://example.com/${i}`, title: `Page ${i}`, visitedAt: i }));
  const updated = visitBrowserPage(history, { url: history[200].url, title: "Updated", visitedAt: 1000 });
  assert.equal(updated.length, 500);
  assert.equal(updated[0].title, "Updated");
  assert.equal(updated[1].url, history[0].url);
  const added = visitBrowserPage(updated, { url: "https://example.com/new", title: "New", visitedAt: 1001 });
  assert.equal(added.length, 500);
  assert.ok(!added.some((entry) => entry.url === history[499].url));
  for (const url of ["about:blank", "data:text/html,secret", "javascript:alert(1)", "not a URL"]) {
    assert.equal(visitBrowserPage(added, { url, title: "", visitedAt: 1002 }), added);
  }
});

test("zoom handles factors between presets and both boundaries", () => {
  assert.equal(nextBrowserZoom(1.17, 1), 1.25);
  assert.equal(nextBrowserZoom(1.17, -1), 1.1);
  assert.equal(nextBrowserZoom(0.25, -1), 0.25);
  assert.equal(nextBrowserZoom(5, 1), 5);
});

test("library writes serialize, survive restart, and cannot revive transfers from the old process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastvibe-browser-test-"));
  try {
    const path = join(directory, "browser-library.json");
    const store = new BrowserLibraryStore(path);
    await store.load();
    store.visit({ url: "https://example.com", title: "Page", visitedAt: 1 });
    const first = store.save();
    store.data.downloads.push({ id: "test", name: "file.zip", url: "https://example.com/file.zip", path: "/tmp/file.zip", total: 100, received: 20, state: "progressing", startedAt: 1, paused: true, canResume: true });
    store.data.history = [];
    const second = store.save();
    await Promise.all([first, second]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).history, []);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    const restored = new BrowserLibraryStore(path);
    await restored.load();
    assert.equal(restored.data.downloads[0].state, "interrupted");
    assert.equal(restored.data.downloads[0].canResume, false);
    assert.equal(restored.data.downloads[0].paused, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("address bar handles local development hosts before interpreting URI schemes", () => {
  for (const address of ["localhost:5173", "127.0.0.1:5173/mock.html", "[::1]:8080", "localhost/path"]) {
    assert.equal(normalizeBrowserUrl(address), `http://${address}`);
  }
  assert.equal(normalizeBrowserUrl("example.com:8443/path"), "https://example.com:8443/path");
  assert.equal(normalizeBrowserUrl("https://example.com"), "https://example.com");
  assert.equal(normalizeBrowserUrl("file:///tmp/index.html"), "file:///tmp/index.html");
  assert.equal(normalizeBrowserUrl("find a page"), "https://www.google.com/search?q=find%20a%20page");
});
