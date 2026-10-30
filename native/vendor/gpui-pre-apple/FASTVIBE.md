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

## Graphics memory

Path targets are allocated on demand from visible, clipped path bounds, rounded
up to 64-pixel buckets with sampling padding. Unused right/bottom pixels are
omitted; the origin stays at the window origin. Path sprites sample by window
pixel position divided by the actual texture dimensions. Gradients, masks,
premultiplied blending, 4x MSAA, and triple buffering remain unchanged. Same-size
targets are reused, and a scene without visible paths releases them. GPU command
buffers retain textures still in flight when the renderer releases its copy.

The shared instance buffer pool retains at most 8 MiB of completed buffers;
in-flight buffers and large scenes are unrestricted. This avoids keeping peak
frame allocations alive after closing a busy view. Pure unit tests check target
geometry without creating a window or GPU device.
