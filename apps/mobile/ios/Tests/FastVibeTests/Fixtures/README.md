# Approved background references

`approved-backdrop-light.png` and `approved-backdrop-dark.png` were exported on 2026-11-02 from the browser's resolved background of `apps/mobile/design/prototype-standalone.html`, at 390 × 844 CSS pixels. For each explicit color scheme, the original element's computed `background-image` and `background-color` are rendered in an SVG `foreignObject`, drawn into an sRGB canvas, and saved directly with `canvas.toBlob(..., "image/png")`. The export isolates the original background; it excludes content, the demonstration phone frame and system chrome. It never passes through screenshot or image-message compression.

These are design references, not captures of the SwiftUI implementation. `PrototypeRenderTests.testBackdropMatchesApprovedBrowserReference` compares native sRGB pixels against them, allowing at most 2 levels per RGB channel and a mean difference of 0.5 for rasterizer rounding. Update them only when the approved prototype's background changes.
