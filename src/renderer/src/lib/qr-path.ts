/**
 * A QR module matrix as one SVG path.
 *
 * Split out of the component for one reason: this is the step that can be wrong without
 * looking wrong. `qrcode` hands back a flat array, and reading it with the two axes
 * swapped produces a transposed symbol — still a plausible-looking field of squares,
 * still with three finder patterns in three corners, and unreadable by a camera. Nothing
 * on screen says so, and the failure surfaces as "the QR code doesn't scan" long after
 * the change that caused it. As a plain module it is pinned by a test instead.
 *
 * The convention is the library's own: index `y * size + x` is the module at column `x`
 * of row `y`, which is what `qrcode`'s renderers use (`col = i % size`).
 */

export type QrModules = {
  size: number;
  data: ArrayLike<number>;
};

/**
 * One `1×1` subpath per dark module.
 *
 * Not merged into runs. `qrcode`'s own renderer coalesces horizontal ones to shorten the
 * string, which matters when the path is going down a wire; here it goes into the DOM of
 * a settings pane, where a few extra kilobytes buy code that can be checked by reading
 * it.
 */
export function qrPath(modules: QrModules): string {
  const { size, data } = modules;
  const parts: string[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (data[y * size + x]) parts.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  return parts.join("");
}
