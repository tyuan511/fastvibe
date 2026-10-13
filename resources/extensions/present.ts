import { statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * `present` puts an image, a video or an HTML page into the conversation itself.
 *
 * The tool does nothing to the file: it checks that the reference can be shown and records it in
 * the result's `details`, which the transcript draws as a preview under the call. A model that
 * only writes a path in its reply gives the reader a path; this is how it gives them the thing.
 *
 * The extension ships as a loose file and cannot import `@shared`, so the list of what can be
 * shown is repeated here. `test/inline-media.test.ts` pins it against `classifyRef`.
 */
const TOOL = "present";
const MAX_ITEMS = 8;

const T = (zh: string, en: string): string =>
  process.env.FASTVIBE_UI_LANGUAGE === "en" ? en : zh;

export const PRESENTABLE_FILE_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp",
  ".mp4", ".m4v", ".webm", ".ogv", ".mov",
  ".html", ".htm",
] as const;
/** An https URL is shown only as a picture or a film — never as a page. */
export const PRESENTABLE_URL_EXTENSIONS = PRESENTABLE_FILE_EXTENSIONS.filter((ext) => ext !== ".html" && ext !== ".htm");

type Item = { ref: string; title?: string; ok: boolean; error?: string };

function present(source: string, title: string | undefined, cwd: string): Item {
  const value = source.trim();
  if (!value) return { ref: "", ok: false, error: T("缺少 source", "source is empty") };
  if (/^https:\/\//i.test(value)) {
    let pathname = "";
    try {
      pathname = new URL(value).pathname;
    } catch {
      return { ref: value, title, ok: false, error: T("不是有效的 URL", "not a valid URL") };
    }
    const ext = extname(pathname).toLowerCase();
    if (!(PRESENTABLE_URL_EXTENSIONS as readonly string[]).includes(ext)) {
      return {
        ref: value,
        title,
        ok: false,
        error: T(
          "URL 必须以图片或视频扩展名结尾；网页请先保存成文件，或直接给出链接",
          "the URL must end in an image or video extension; save a page to a file first, or just link it",
        ),
      };
    }
    return { ref: value, title, ok: true };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("data:")) {
    return { ref: value, title, ok: false, error: T("只支持本地文件路径或 https URL", "only a local file path or an https URL is supported") };
  }
  const path = isAbsolute(value) ? value : resolve(cwd, value);
  const ext = extname(path).toLowerCase();
  if (!(PRESENTABLE_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
    return {
      ref: path,
      title,
      ok: false,
      error: T(`不支持内联展示 ${ext || "该类型"}`, `${ext || "this type"} cannot be shown inline`),
    };
  }
  try {
    if (!statSync(path).isFile()) return { ref: path, title, ok: false, error: T("不是文件", "not a file") };
  } catch {
    return { ref: path, title, ok: false, error: T("文件不存在", "file does not exist") };
  }
  return { ref: path, title, ok: true };
}

export default function presentExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL,
    label: "Present",
    description: [
      "Show images, videos or HTML pages to the user inside the conversation, where they can look at them directly.",
      "Give a local file path (absolute, or relative to the working directory) or an https URL that ends in an image or video extension.",
      "An .html file is shown as a live page, so it may use inline <script>/<style> and https CDN libraries; it cannot read local files.",
      "Writing a path in your reply does NOT show anything — use this tool.",
    ].join("\n"),
    promptSnippet: "Show an image, video or HTML file to the user inside the conversation",
    promptGuidelines: [
      "Use present when you have made or fetched something the user should look at — a generated image, a chart, a rendered video, a prototype or report as .html — and name its file or https URL.",
      "Images returned by a tool's own result, and image/html files you create with write, are already shown automatically; do not present those again.",
      "Present only the few results that matter (at most 8 per call), then say in your reply what each one is. Do not present input files you were merely reading.",
    ],
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          source: Type.String({ description: "File path or https URL of an image, video or .html page" }),
          title: Type.Optional(Type.String({ description: "Short caption shown with the item" })),
        }),
        { minItems: 1, maxItems: MAX_ITEMS },
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const items = (params.items ?? []).slice(0, MAX_ITEMS).map((item) => present(String(item.source ?? ""), item.title?.trim() || undefined, ctx.cwd));
      const shown = items.filter((item) => item.ok);
      const failed = items.filter((item) => !item.ok);
      const lines: string[] = [];
      if (shown.length > 0) {
        lines.push(T(`已在对话中展示 ${shown.length} 项：`, `Shown in the conversation (${shown.length}):`));
        for (const item of shown) lines.push(`- ${item.ref}`);
      }
      for (const item of failed) lines.push(`${T("未展示", "Not shown")}: ${item.ref || "(empty)"} — ${item.error}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { items },
        ...(shown.length === 0 ? { isError: true } : {}),
      };
    },
  });
}
