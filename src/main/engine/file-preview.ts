import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { delimitedFormatOf, parseDelimited } from "../../shared/delimited.ts";
import { mediaMime, mediaPreviewKind } from "../../shared/media-preview.ts";
import { isUnsupportedOfficeFile, officeFormatOf } from "../../shared/office.ts";
import type { FilePreview, FilePreviewFailure } from "../../shared/types.ts";
import { uiText } from "./ui-text.ts";
import { MAX_TEXT_FILE_BYTES } from "./workspace-fs.ts";

/**
 * What the side pane will read into memory to draw a preview.
 *
 * Images, PDFs and videos are not read here at all. The preview names the file; the renderer
 * loads it from a URL the main process streams, so a photo or a movie never becomes a base64
 * frame. Text is different — the renderer highlights and lays it out as DOM — so its cap is
 * where a file stops being loaded into the editor.
 *
 * **An Office document is a third case, and it is not read here either.** `office` names the
 * format and nothing more; the renderer asks for a rendered page (`office:render`) and frames
 * it. The extraction this function used to do — `unzip -p word/document.xml`, stripped of tags,
 * handed back as `markdown` — is gone, and deliberately so:
 *
 * - it needed the `unzip` binary, which Windows does not have;
 * - it ran synchronously, `execFileSync`, on the main process, for the whole document;
 * - and what it printed was wrong in ways a reader could not see: formula cells came out empty,
 *   columns lost their alignment because the parse keyed on element order instead of on `r=`,
 *   and only the workbook's first sheet appeared.
 *
 * A degraded layout is not a fallback for a document — it is a different document. So the pane
 * either draws the real thing or says why it cannot, and a legacy format that no version of the
 * renderer accepts is named as unsupported instead of being read as text (which is how a `.doc`
 * came to be shown as a screen of mojibake).
 */
const CODE_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".h": "c",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".yml": "yaml",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
};

const CODE_NAME: Record<string, string> = {
  Makefile: "make",
  GNUmakefile: "make",
  Dockerfile: "docker",
  Containerfile: "docker",
  "CMakeLists.txt": "cmake",
  Gemfile: "ruby",
  Rakefile: "ruby",
  Jenkinsfile: "groovy",
  Justfile: "just",
};

/**
 * The language id for the renderer to resolve, and the rule the two maps above follow: only
 * a name a reader would not guess from the file belongs there, because the renderer resolves
 * an extension on its own (`vue`, `zig`, `hcl`, `hurl` each match a grammar id) and an entry
 * that repeats the extension is dead weight that rots. Anything not named travels as the
 * extension — and a file with no extension at all travels as its own name, which is also what
 * a dotfile is, since `path.extname` counts a leading dot as part of the name, leaving
 * `.editorconfig` and `.zshrc` with the dot-stripped name as the only hint.
 *
 * This is also the label the preview shows, so `.ts` reads `typescript` rather than `ts`.
 * The other half of the lookup is `LANGUAGE_ALIASES` in the renderer (`gd` for gdscript, `pas`
 * for pascal, `kusto` for kql): an extension whose word is not a grammar's id belongs there,
 * not in a map here. `test/file-preview-language.test.ts` is the only thing that checks the pair.
 */
export function codeLanguageOf(name: string, ext: string): string {
  // `hasOwn` on both maps: a file may be named `constructor`, and the prototype chain is not
  // a language — handing back a function would break the IPC reply rather than merely the colour.
  if (Object.hasOwn(CODE_NAME, name)) return CODE_NAME[name];
  if (Object.hasOwn(CODE_EXT, ext)) return CODE_EXT[ext];
  return ext ? ext.slice(1) : name.replace(/^\./, "").toLowerCase();
}

/**
 * Turn a file-system failure into what the reader is told.
 *
 * The host's own words (`ENOENT: no such file or directory, stat '…'`) used to be the whole
 * preview: a red line of jargon that said neither *which* of the three things that can go
 * wrong had happened nor what to do about it. The reason is classified here, once, so every
 * client (the desktop pane, the phone) answers with the same verdict, and the raw error is
 * kept as the small print for whoever has to debug a path.
 *
 * `directory` is where the file should be: the folder it was in, or itself when the "file"
 * turned out to be a folder. That is what 在文件夹中显示 opens — revealing the missing path
 * itself can only fail.
 */
export function previewFailure(
  filePath: string,
  name: string,
  error: unknown,
  reason?: FilePreviewFailure,
): FilePreview {
  const code = (error as NodeJS.ErrnoException | null)?.code ?? "";
  // `ENOENT: no such file or directory, stat '…'` — the code is already in the sentence.
  const detail = error instanceof Error ? error.message : String(error ?? "");
  const kind: FilePreviewFailure =
    reason ??
    (code === "ENOENT" || code === "ENOTDIR" ? "missing"
      : code === "EACCES" || code === "EPERM" ? "permission"
      : code === "EISDIR" ? "not-a-file"
      : "unknown");
  const message =
    kind === "missing" ? uiText("文件不存在", "This file does not exist")
    : kind === "permission" ? uiText("没有读取权限", "You cannot read this file")
    : kind === "not-a-file" ? uiText("这是一个文件夹", "This is a folder")
    : // Nothing classified it, so the host's sentence is the only information there is.
      detail || uiText("无法预览这个文件", "Could not preview this file");
  return {
    kind: "error",
    path: filePath,
    name,
    message,
    reason: kind,
    detail,
    directory: kind === "not-a-file" ? filePath : dirname(filePath),
  };
}

export function readFilePreview(filePath: string): FilePreview {
  const name = basename(filePath);
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return previewFailure(filePath, name, new Error(uiText("这是一个文件夹", "Not a file")), "not-a-file");
    }
    const ext = extname(filePath).toLowerCase();
    const mediaKind = mediaPreviewKind(filePath);
    const mediaType = mediaMime(filePath);
    if (mediaKind && mediaType) {
      return { kind: mediaKind, path: filePath, name, mimeType: mediaType, size: stat.size };
    }
    // The three formats OfficeCLI renders. No bytes are read for them however big they are: a
    // `.pptx` is a zip of media, and the preview is a *page* the media protocol streams.
    const office = officeFormatOf(filePath);
    if (office) return { kind: "office", path: filePath, name, format: office, size: stat.size };
    // Legacy binary Office, ODF and the macro-enabled variants: named, not guessed at.
    if (isUnsupportedOfficeFile(filePath)) {
      return { kind: "unsupported", path: filePath, name, format: ext.replace(".", "").toUpperCase() };
    }
    if (stat.size > MAX_TEXT_FILE_BYTES) {
      return { kind: "binary", path: filePath, name, size: stat.size };
    }
    const text = readFileSync(filePath, "utf8");
    if (ext === ".md" || ext === ".markdown") {
      return { kind: "markdown", path: filePath, name, text };
    }
    if (ext === ".html" || ext === ".htm") {
      return { kind: "html", path: filePath, name, text };
    }
    // `.csv` and `.tsv` stay the app's own table — OfficeCLI does not accept delimited text, and
    // a grid is the right way to show a file whose columns the reader can already count.
    const delimited = delimitedFormatOf(filePath);
    if (delimited) {
      const { rows, truncated, totalRows } = parseDelimited(text, delimited);
      return { kind: "csv", path: filePath, name, rows, truncated, totalRows };
    }
    if (ext === ".diff" || ext === ".patch") {
      return { kind: "diff", path: filePath, name, text };
    }
    return {
      kind: "code",
      path: filePath,
      name,
      language: codeLanguageOf(name, ext),
      text,
    };
  } catch (error) {
    return previewFailure(filePath, name, error);
  }
}
