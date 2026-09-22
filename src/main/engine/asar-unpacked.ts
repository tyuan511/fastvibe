/**
 * Rewrite a path inside an asar archive to the copy `asarUnpack` placed beside it.
 *
 * Electron's `require.resolve` reports the in-archive path even for a file that was
 * unpacked, and its asar-aware `fs` makes that path look present. That is fine for
 * JavaScript and fatal for a native dependency that opens its library with a raw
 * `dlopen`: the kernel cannot traverse into the archive (`ENOTDIR`). This is the pure half
 * of the fix (see `pi/cua-bridge.ts`); it only computes the twin, the caller decides
 * whether that twin actually exists, so a packed path is never moved.
 *
 * The leading separator is required so a package whose name merely ends in `app.asar`
 * (`myapp.asar`) is not rewritten, and it is captured so a Windows path keeps its `\`.
 */
export function unpackedPath(resolved: string): string {
  return resolved.replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
}
