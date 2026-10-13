import { classifyRef, type InlinePreview } from "../../../shared/inline-media.ts";

/**
 * What a markdown image's `src` means as a thing to show.
 *
 * A model writing `![chart](/tmp/chart.png)` means the file on this machine, which the
 * renderer cannot load as a URL (its CSP has no `file:`); one writing `![](./out/clip.mp4)`
 * means a project file, and `![](report.html)` a page. `https:` and `data:` sources are
 * loaded as they are. Anything else (`http:`, an unknown scheme) is left to the plain `<img>`.
 */
export function markdownMedia(
  src: string | undefined,
  alt: string | undefined,
  resolve: (path: string) => string,
): InlinePreview | null {
  const value = src?.trim();
  if (!value) return null;
  let ref: string;
  if (value.startsWith("data:") || /^https:\/\//i.test(value)) {
    ref = value;
  } else if (value.startsWith("file://")) {
    ref = safeDecode(value.slice("file://".length));
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
    return null;
  } else {
    // A path in markdown is URL-encoded by the parser (`My%20Photo.png`).
    ref = resolve(safeDecode(value.split(/[?#]/)[0] ?? value));
  }
  const kind = classifyRef(ref);
  if (!kind) return null;
  return { key: ref, kind, ref, title: alt?.trim() || undefined, explicit: true };
}

function safeDecode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}
