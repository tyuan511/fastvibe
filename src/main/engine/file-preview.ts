import { execFileSync } from "node:child_process";
import { uiText } from "./ui-text.ts";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { mediaMime, mediaPreviewKind } from "../../shared/media-preview.ts";
import type { FilePreview } from "../../shared/types.ts";

/**
 * What the side pane will read into memory to draw a preview.
 *
 * Images, PDFs and videos are not read here at all. The preview names the file; the
 * renderer loads it from a URL the main process streams, so a photo or a movie never
 * becomes a base64 frame. Text is different — the renderer highlights and lays it out
 * as DOM — so its cap is where a file stops being a preview and should be opened in
 * an editor instead.
 */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const CODE_EXT: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".scss": "css",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".xml": "xml",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".sql": "sql",
  ".toml": "toml",
  ".swift": "swift",
};

export function readFilePreview(filePath: string): FilePreview {
  const name = basename(filePath);
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { kind: "error", path: filePath, name, message: uiText("不是文件", "Not a file") };
    }
    const ext = extname(filePath).toLowerCase();
    const mediaKind = mediaPreviewKind(filePath);
    const mediaType = mediaMime(filePath);
    if (mediaKind && mediaType) {
      return { kind: mediaKind, path: filePath, name, mimeType: mediaType, size: stat.size };
    }
    if (ext === ".docx") {
      const text = extractDocx(filePath);
      if (text) return { kind: "markdown", path: filePath, name, text };
    }
    if (ext === ".xlsx" || ext === ".xlsm") {
      const rows = extractXlsx(filePath);
      if (rows.length > 0) return { kind: "csv", path: filePath, name, rows };
    }
    if (ext === ".pptx") {
      const text = extractPptx(filePath);
      if (text) return { kind: "markdown", path: filePath, name, text };
    }
    if (stat.size > MAX_TEXT_BYTES) {
      return { kind: "binary", path: filePath, name, size: stat.size };
    }
    const text = readFileSync(filePath, "utf8");
    if (ext === ".md" || ext === ".markdown") {
      return { kind: "markdown", path: filePath, name, text };
    }
    if (ext === ".html" || ext === ".htm") {
      return { kind: "html", path: filePath, name, text };
    }
    if (ext === ".csv") {
      return { kind: "csv", path: filePath, name, rows: parseCsv(text) };
    }
    if (ext === ".diff" || ext === ".patch") {
      return { kind: "diff", path: filePath, name, text };
    }
    return {
      kind: "code",
      path: filePath,
      name,
      language: CODE_EXT[ext] ?? ext.replace(".", "") ?? "text",
      text,
    };
  } catch (error) {
    return {
      kind: "error",
      path: filePath,
      name,
      message: error instanceof Error ? error.message : uiText("无法预览", "Could not preview"),
    };
  }
}

function unzipEntry(filePath: string, entry: string): string | null {
  try {
    return execFileSync("unzip", ["-p", filePath, entry], {
      encoding: "utf8",
      maxBuffer: 2_000_000,
      timeout: 8_000,
    });
  } catch {
    return null;
  }
}

function stripXml(xml: string): string {
  return xml
    .replace(/<w:p\b[^>]*>/g, "\n")
    .replace(/<a:p\b[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractDocx(filePath: string): string | null {
  const xml = unzipEntry(filePath, "word/document.xml");
  return xml ? stripXml(xml) : null;
}

function extractPptx(filePath: string): string | null {
  const slides: string[] = [];
  for (let i = 1; i <= 30; i += 1) {
    const xml = unzipEntry(filePath, `ppt/slides/slide${i}.xml`);
    if (!xml) break;
    const text = stripXml(xml);
    if (text) slides.push(`## ${uiText("幻灯片", "Slide")} ${i}\n\n${text}`);
  }
  return slides.length > 0 ? slides.join("\n\n") : null;
}

function extractXlsx(filePath: string): string[][] {
  const stringsXml = unzipEntry(filePath, "xl/sharedStrings.xml") ?? "";
  const shared = [...stringsXml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((match) => match[1] ?? "");
  const sheet = unzipEntry(filePath, "xl/worksheets/sheet1.xml");
  if (!sheet) return [];
  const rows: string[][] = [];
  for (const rowXml of sheet.split(/<row\b/).slice(1)) {
    const cells: string[] = [];
    for (const cell of rowXml.matchAll(/<c\b([^>]*)>(?:<v>([^<]*)<\/v>)?/g)) {
      const attrs = cell[1] ?? "";
      const value = cell[2] ?? "";
      if (/\bt="s"/.test(attrs)) {
        const index = Number(value);
        cells.push(Number.isFinite(index) ? (shared[index] ?? value) : value);
      } else {
        cells.push(value);
      }
    }
    if (cells.some((item) => item.length > 0)) rows.push(cells);
    if (rows.length >= 200) break;
  }
  return rows;
}

function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(0, 200)
    .map((line) => line.split(",").map((cell) => cell.replace(/^"|"$/g, "")));
}
