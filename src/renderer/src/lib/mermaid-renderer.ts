import mermaid from "mermaid";
import DOMPurify from "dompurify";
import type { ThemeDefinition } from "./themes";
import { MAX_MERMAID_CHARS } from "./mermaid-source";

// Mermaid has process-wide configuration. Serialize initialize + render together so
// diagrams of different themes cannot borrow one another's configuration.
let pending: Promise<unknown> = Promise.resolve();
let sequence = 0;

/** Mermaid's color arithmetic needs hex values rather than CSS color-mix(). */
function mixColor(base: string, tint: string, amount: number): string {
  const blend = [1, 3, 5].map((offset) => {
    const from = Number.parseInt(base.slice(offset, offset + 2), 16);
    const to = Number.parseInt(tint.slice(offset, offset + 2), 16);
    return Math.round(from + (to - from) * amount).toString(16).padStart(2, "0");
  });
  return `#${blend.join("")}`;
}

export function renderMermaid(code: string, theme: ThemeDefinition, cancelled: () => boolean): Promise<string | null> {
  const task = pending.then(async () => {
    if (cancelled()) return null;
    const tokens = theme.tokens;
    const dark = theme.kind === "dark";
    const nodeFill = mixColor(theme.surface, theme.accent, dark ? 0.10 : 0.035);
    const nodeBorder = mixColor(theme.surface, theme.accent, dark ? 0.42 : 0.26);
    const line = mixColor(theme.bg, theme.fg, dark ? 0.55 : 0.46);
    const divider = mixColor(theme.bg, theme.fg, dark ? 0.24 : 0.18);
    const fontFamily = '"Instrument Sans", system-ui, sans-serif';
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: MAX_MERMAID_CHARS,
      maxEdges: 500,
      // Source directives must not override the host's security or theme settings.
      secure: [
        "secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges",
        "suppressErrorRendering", "dompurifyConfig", "theme", "themeVariables",
        "themeCSS", "fontFamily", "htmlLabels",
      ],
      htmlLabels: false,
      theme: "base",
      fontFamily,
      flowchart: {
        curve: "rounded",
        nodeSpacing: 36,
        rankSpacing: 48,
        padding: 16,
        diagramPadding: 12,
      },
      sequence: {
        mirrorActors: false,
        actorMargin: 56,
        width: 136,
        height: 48,
        diagramMarginX: 16,
        diagramMarginY: 16,
        boxMargin: 12,
        messageMargin: 36,
        actorFontSize: 14,
        actorFontWeight: 500,
        messageFontSize: 14,
        noteFontSize: 14,
      },
      // These rules are scoped by Mermaid to this SVG. Keep source-defined fills
      // intact while giving the default shapes and connectors the app's quiet style.
      themeCSS: `
        .node rect, .node circle, .node ellipse, .node polygon, .node path {
          filter: none;
          stroke-width: 1px;
        }
        .node rect, .actor { rx: 8px; ry: 8px; }
        .flowchart-link, .transition {
          stroke-width: 1.35px;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .edgeLabel { font-size: 12px; }
        .actor { stroke-width: 1px; filter: none; }
        .actor-line { stroke: ${divider}; stroke-width: 1px; stroke-dasharray: 3 5; }
        .messageLine0, .messageLine1 { stroke-width: 1.25px; stroke-linecap: round; }
      `,
      themeVariables: {
        darkMode: dark,
        fontFamily,
        fontSize: "14px",
        radius: 8,
        useGradient: false,
        dropShadow: "none",
        background: tokens.background,
        primaryColor: nodeFill,
        primaryTextColor: tokens.foreground,
        primaryBorderColor: nodeBorder,
        secondaryColor: tokens.secondary,
        secondaryTextColor: tokens.foreground,
        secondaryBorderColor: nodeBorder,
        tertiaryColor: tokens.card,
        tertiaryTextColor: tokens.foreground,
        tertiaryBorderColor: divider,
        lineColor: line,
        arrowheadColor: line,
        defaultLinkColor: line,
        textColor: tokens.foreground,
        mainBkg: nodeFill,
        nodeBorder,
        clusterBkg: tokens.card,
        clusterBorder: divider,
        edgeLabelBackground: tokens.background,
        actorBkg: nodeFill,
        actorTextColor: tokens.foreground,
        actorBorder: nodeBorder,
        actorLineColor: divider,
        signalColor: line,
        signalTextColor: tokens.foreground,
        labelBoxBkgColor: tokens.card,
        labelBoxBorderColor: nodeBorder,
        labelTextColor: tokens.foreground,
        loopTextColor: tokens.foreground,
        noteBkgColor: tokens.muted,
        noteTextColor: tokens.foreground,
        noteBorderColor: divider,
      },
    });
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
    document.body.append(host);
    try {
      const { svg } = await mermaid.render(`fv-mermaid-${++sequence}`, code, host);
      if (cancelled()) return null;
      // The SVG is displayed as an image document, never as active DOM in the app.
      // Strip foreign content and links as well; no bindFunctions/click callbacks.
      const clean = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ["foreignObject", "image", "a"],
        FORBID_ATTR: ["href", "xlink:href"],
      });
      const svgDocument = new DOMParser().parseFromString(clean, "image/svg+xml");
      const root = svgDocument.documentElement;
      const box = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
      // Mermaid emits width="100%". An <img> would otherwise give that SVG the
      // browser's 300px intrinsic width, shrinking even a large flowchart's labels.
      if (box?.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0) {
        root.setAttribute("width", String(box[2]));
        root.setAttribute("height", String(box[3]));
      }
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
    } finally {
      host.remove();
    }
  });
  pending = task.catch(() => undefined);
  return task;
}
