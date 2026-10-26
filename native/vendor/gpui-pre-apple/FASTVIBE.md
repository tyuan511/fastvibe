# FastVibe patch

This is the crates.io source of `gpui-pre-apple` 0.3.9 (Apache-2.0).
In `src/metal_renderer.rs`, the final primitive
and path-sprite pipelines use `OneMinusSourceAlpha` for destination alpha instead
of `One`. RGB blending already uses source-over in both pipelines.

The original alpha equation adds each layer's opacity. A 46% white page under a
56% white composer then produces alpha 1 instead of 0.7624, while RGB contains
0.7624: Core Animation displays a grey, opaque composer. Source-over alpha keeps
the window translucent and its white cards white, matching the Electron renderer.
Intermediate path rasterization is unchanged.

In `src/shaders.metal`, outer shadows are clipped out of their element's border box,
as CSS does. Otherwise a translucent card reveals the black shadow underneath its
entire fill instead of only outside its edge. Inset shadows are unchanged.

Remove this patch when the dependency fixes both final pipelines. The opt-in
`fv-gui` glass integration test checks the actual rendered alpha against the theme
tokens so a dependency update cannot silently reintroduce the issue.
