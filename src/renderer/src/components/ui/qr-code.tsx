import { useMemo, type JSX } from "react";
import QRCode from "qrcode";
import { qrPath } from "@/lib/qr-path";
import { cn } from "@/lib/utils";

/**
 * A QR code, as one SVG path.
 *
 * Drawn rather than rasterised: `toDataURL` would hand back a PNG at a fixed pixel size
 * that a 2× screen has to smooth, and a QR code is the one image where smoothed edges
 * cost something real — the scanner is thresholding those edges. `create` gives the
 * module matrix, and a path of 1×1 rects at `shapeRendering="crispEdges"` scales to any
 * box the layout gives it and stays sharp.
 *
 * Always black on white, in both themes. The colours are not decoration here: a
 * scanner looks for a high-contrast pattern in the orientation it expects, and an
 * inverted code (light modules on a dark card) is refused outright by a good number of
 * phone cameras. So the card brings its own white background rather than inheriting the
 * surface it sits on.
 */
export function QrCode({
  value,
  className,
  title,
}: {
  value: string;
  className?: string;
  title?: string;
}): JSX.Element | null {
  const drawing = useMemo(() => {
    try {
      // Level M: the standard trade-off, and the one every camera app assumes. A URL
      // from either tunnel is 40–60 characters, which fits a version-3/4 symbol — small
      // enough that the modules stay large at the size this renders at.
      const { modules } = QRCode.create(value, { errorCorrectionLevel: "M" });
      return { size: modules.size, path: qrPath(modules) };
    } catch {
      // Only thrown by a value too long for any version, which no tunnel URL is. A
      // missing code is better than a crashed settings pane either way.
      return null;
    }
  }, [value]);

  if (!drawing) return null;

  // The four-module quiet zone is part of the spec, not padding: without it a scanner
  // cannot find the symbol's edge against whatever is next to it.
  const quiet = 4;
  const span = drawing.size + quiet * 2;

  return (
    <svg
      viewBox={`${-quiet} ${-quiet} ${span} ${span}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={title ?? value}
      className={cn("size-40 rounded-lg bg-white", className)}
    >
      <title>{title ?? value}</title>
      <path d={drawing.path} fill="#000000" />
    </svg>
  );
}
