import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyRef,
  collectInlinePreviews,
  inlineSrc,
  scanMediaRefs,
} from "../src/shared/inline-media.ts";
import { toolImagesOf } from "../src/shared/tool-result.ts";
import { authorizeMediaMime } from "../src/shared/media-preview.ts";
import { summarizeToolBlock } from "../src/shared/tool-summary.ts";
import { mapEngineMessages } from "../src/main/engine/map-messages.ts";
import { markdownMedia } from "../src/renderer/src/lib/markdown-media.ts";
import presentExtension, {
  PRESENTABLE_FILE_EXTENSIONS,
  PRESENTABLE_URL_EXTENSIONS,
} from "../resources/extensions/present.ts";
import type { ToolCallBlock } from "../src/shared/types.ts";

/**
 * What a reply shows inline is decided from the transcript alone, so it can be pinned here:
 * which references count, which guesses are made, and what each source may not claim.
 */

function tool(partial: Partial<ToolCallBlock> & { id: string; name: string }): ToolCallBlock {
  return { status: "done", ...partial };
}

test("a reference is an image, a video or a local page — and an https page is none of them", () => {
  assert.equal(classifyRef("/tmp/a.png"), "image");
  assert.equal(classifyRef("out/clip.MP4"), "video");
  assert.equal(classifyRef("/tmp/report.html"), "html");
  assert.equal(classifyRef("remote:srv_abc:/tmp/a.webp"), "image");
  assert.equal(classifyRef("https://cdn.example.com/a.jpg?sig=1"), "image");
  assert.equal(classifyRef("https://example.com/index.html"), null);
  assert.equal(classifyRef("https://example.com/"), null);
  assert.equal(classifyRef("data:image/png;base64,AAAA"), "image");
  assert.equal(classifyRef("data:text/html;base64,AAAA"), null);
  assert.equal(classifyRef("javascript://x/a.png"), null);
  assert.equal(classifyRef("/tmp/notes.txt"), null);
  assert.equal(classifyRef("/tmp/doc.pdf"), null);
});

test("a path becomes a media URL and a URL stays itself", () => {
  assert.match(inlineSrc({ ref: "/tmp/a b.png" }), /^fastvibe-media:\/\/media\/play\?path=/);
  assert.equal(inlineSrc({ ref: "https://x.test/a.png" }), "https://x.test/a.png");
});

test("printed output yields image and video paths, without listings of dependencies", () => {
  const text = [
    "saved to /Users/me/out/chart.png.",
    'wrote {"video":"/tmp/clip.mp4"}',
    "see /Users/me/proj/node_modules/pkg/logo.png",
    "https://cdn.example.com/gen/1.webp?X-Sig=abc",
    "file:///tmp/from%20file.jpg",
    "/Users/me/proj/index.html",
    "relative/shot.png",
    "/tmp/chart.png",
  ].join("\n");
  assert.deepEqual(scanMediaRefs(text), [
    "/Users/me/out/chart.png",
    "/tmp/clip.mp4",
    "https://cdn.example.com/gen/1.webp?X-Sig=abc",
    "/tmp/from file.jpg",
    "/tmp/chart.png",
  ]);
});

test("present shows exactly what its result lists, and a failed item shows nothing", () => {
  const previews = collectInlinePreviews([
    tool({
      id: "p1",
      name: "present",
      args: { items: [{ source: "a.png" }] },
      details: {
        items: [
          { ref: "/w/a.png", title: "A", ok: true },
          { ref: "/w/gone.png", ok: false, error: "file does not exist" },
          { ref: "https://x.test/v.mp4", ok: true },
        ],
      },
    }),
  ]);
  assert.deepEqual(
    previews.get("p1")?.map((item) => [item.kind, item.ref, item.title, item.explicit]),
    [
      ["image", "/w/a.png", "A", true],
      ["video", "https://x.test/v.mp4", undefined, true],
    ],
  );
});

test("a write of an image or a page is shown; a write of code is not", () => {
  const previews = collectInlinePreviews(
    [
      tool({ id: "w1", name: "write", args: { path: "site/index.html", content: "<p>hi</p>" } }),
      tool({ id: "w2", name: "write", args: { path: "src/app.ts", content: "x" } }),
      tool({ id: "w3", name: "write", args: { path: "icon.svg", content: "<svg/>" } }),
    ],
    (path) => `/proj/${path}`,
  );
  assert.deepEqual(previews.get("w1")?.map((item) => [item.kind, item.ref]), [["html", "/proj/site/index.html"]]);
  assert.equal(previews.has("w2"), false);
  assert.deepEqual(previews.get("w3")?.map((item) => item.kind), ["image"]);
});

test("a result's picture is shown for an MCP tool and not for a read or a screenshot", () => {
  const images = [{ mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" }];
  const previews = collectInlinePreviews([
    tool({ id: "m1", name: "mcp_img_generate", images }),
    tool({ id: "r1", name: "read", images }),
    tool({ id: "b1", name: "browser_snapshot", images }),
  ]);
  assert.deepEqual(previews.get("m1")?.map((item) => item.explicit), [true]);
  assert.equal(previews.has("r1"), false);
  assert.equal(previews.has("b1"), false);
});

test("a shell result is scanned unless the command only lists files", () => {
  const previews = collectInlinePreviews([
    tool({ id: "s1", name: "bash", args: { command: "python gen.py" }, result: "saved /tmp/out/a.png" }),
    tool({ id: "s2", name: "bash", args: { command: "ls -R /tmp/out" }, result: "/tmp/out/a.png\n/tmp/out/b.png" }),
    tool({ id: "s3", name: "read", result: "mentions /tmp/out/c.png" }),
  ]);
  assert.deepEqual(previews.get("s1")?.map((item) => [item.ref, item.explicit]), [["/tmp/out/a.png", false]]);
  assert.equal(previews.has("s2"), false);
  assert.equal(previews.has("s3"), false);
});

test("a file shown once is not shown again, and a reply is bounded", () => {
  const same = collectInlinePreviews([
    tool({ id: "a", name: "write", args: { path: "/w/i.html", content: "" } }),
    tool({ id: "b", name: "present", details: { items: [{ ref: "/w/i.html", ok: true }] } }),
  ]);
  assert.equal(same.has("a"), true);
  assert.equal(same.has("b"), false);

  const many = collectInlinePreviews(
    Array.from({ length: 5 }, (_, call) =>
      tool({
        id: `t${call}`,
        name: "present",
        details: { items: Array.from({ length: 4 }, (_, i) => ({ ref: `/w/${call}-${i}.png`, ok: true })) },
      }),
    ),
  );
  assert.equal([...many.values()].flat().length, 12);
});

test("an unfinished or nested call shows nothing yet", () => {
  const previews = collectInlinePreviews([
    tool({ id: "x", name: "present", status: "running", details: { items: [{ ref: "/w/a.png", ok: true }] } }),
    tool({ id: "y", name: "present", parentId: "z", details: { items: [{ ref: "/w/b.png", ok: true }] } }),
  ]);
  assert.equal(previews.size, 0);
});

test("image blocks of a result are bounded and carried with the transcript", () => {
  assert.deepEqual(toolImagesOf([{ type: "text", text: "x" }]), []);
  const [image] = toolImagesOf([{ type: "image", data: "QUJD", mimeType: "image/webp" }]);
  assert.equal(image?.dataUrl, "data:image/webp;base64,QUJD");
  assert.equal(toolImagesOf(Array.from({ length: 9 }, () => ({ type: "image", data: "QUJD" }))).length, 4);

  const [row] = mapEngineMessages([
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "mcp_img_gen", arguments: {} }], timestamp: 1 },
    { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }, { type: "image", data: "QUJD", mimeType: "image/png" }] },
  ]);
  assert.equal(row?.tools[0]?.images?.[0]?.dataUrl, "data:image/png;base64,QUJD");
  assert.equal(row?.tools[0]?.result, "ok");

  const slim = summarizeToolBlock(row!.tools[0]!);
  assert.equal(slim.images, undefined);
  assert.equal(slim.omitted?.images, 1);
});

test("an HTML file is servable with its own content type, and only if both names say so", () => {
  assert.match(authorizeMediaMime("/a/page.html", "/a/page.html") ?? "", /^text\/html/);
  assert.match(authorizeMediaMime("/a/link.png", "/a/real.png") ?? "", /^image\/png/);
  // a symlink named like a page that points at something else is refused, both ways
  assert.equal(authorizeMediaMime("/a/x.html", "/a/secret.txt"), null);
  assert.equal(authorizeMediaMime("/a/x.png", "/a/secret.html"), null);
  assert.equal(authorizeMediaMime("/a/x.html", "/a/real.png"), null);
  assert.equal(authorizeMediaMime("/a/notes.txt", "/a/notes.txt"), null);
});

test("a markdown image is read as the thing it points at", () => {
  const resolve = (path: string): string => (path.startsWith("/") ? path : `/proj/${path.replace(/^\.\//, "")}`);
  assert.equal(markdownMedia("/tmp/My%20Chart.png", "chart", resolve)?.ref, "/tmp/My Chart.png");
  assert.equal(markdownMedia("./out/clip.mp4", "", resolve)?.kind, "video");
  assert.equal(markdownMedia("file:///tmp/a.png", undefined, resolve)?.ref, "/tmp/a.png");
  assert.equal(markdownMedia("report.html", "r", resolve)?.kind, "html");
  assert.equal(markdownMedia("https://x.test/a.png", "a", resolve)?.kind, "image");
  assert.equal(markdownMedia("http://x.test/a.png", "a", resolve), null);
  assert.equal(markdownMedia("https://x.test/page", "a", resolve), null);
  assert.equal(markdownMedia("", "a", resolve), null);
});

test("the present tool's accepted types are the ones the transcript can show", () => {
  for (const ext of PRESENTABLE_FILE_EXTENSIONS) assert.notEqual(classifyRef(`/w/file${ext}`), null, ext);
  for (const ext of PRESENTABLE_URL_EXTENSIONS) assert.notEqual(classifyRef(`https://x.test/file${ext}`), null, ext);
  assert.equal(PRESENTABLE_URL_EXTENSIONS.includes(".html" as never), false);
});

test("present checks the file before it claims to show it", async () => {
  type Tool = { execute: (id: string, params: unknown, ...rest: unknown[]) => Promise<{ content: Array<{ text: string }>; details: { items: Array<{ ref: string; ok: boolean }> }; isError?: boolean }> };
  let registered: Tool | undefined;
  presentExtension({ registerTool: (definition: Tool) => (registered = definition) } as never);
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-present-"));
  try {
    await writeFile(join(dir, "a.png"), "x");
    await writeFile(join(dir, "n.txt"), "x");
    const result = await registered!.execute(
      "id",
      { items: [{ source: "a.png" }, { source: "missing.png" }, { source: "n.txt" }, { source: "https://x.test/page" }, { source: "data:image/png;base64,AA" }] },
      undefined,
      undefined,
      { cwd: dir },
    );
    assert.deepEqual(
      result.details.items.map((item) => item.ok),
      [true, false, false, false, false],
    );
    assert.equal(result.details.items[0]?.ref, join(dir, "a.png"));
    assert.equal(result.isError, undefined);
    const none = await registered!.execute("id", { items: [{ source: "missing.png" }] }, undefined, undefined, { cwd: dir });
    assert.equal(none.isError, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
