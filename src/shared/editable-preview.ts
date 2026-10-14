import type { FilePreview } from "./types.ts";

/**
 * Text the preview holds is the file itself, so the pane may write it back.
 *
 * A `.docx` / `.pptx` preview is also `markdown`, but that text was extracted.
 * Saving it would replace the document with the extraction.
 */
export function editableFileText(preview: FilePreview): string | null {
  switch (preview.kind) {
    case "code":
    case "html":
    case "diff":
      return preview.text;
    case "markdown":
      return markdownExtension(preview.path) ? preview.text : null;
    default:
      return null;
  }
}

/** Code and diffs open on their source. Markdown and HTML open rendered, like a document. */
export function prefersSourceEditor(preview: FilePreview): boolean {
  return editableFileText(preview) !== null && (preview.kind === "code" || preview.kind === "diff");
}

function markdownExtension(path: string): boolean {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = base.slice(dot).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}
