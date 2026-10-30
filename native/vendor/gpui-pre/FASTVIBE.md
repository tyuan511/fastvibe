# FastVibe patch

This is the crates.io source of `gpui-pre` 0.3.9 (Apache-2.0), vendored so the scene can
carry one primitive the registry crate has no way to express: `Backdrop`, the GPU-side
analogue of CSS `backdrop-filter`.

- `src/scene.rs`: a `Backdrop` primitive (bounds, content mask, corner radii, blur radius,
  saturation) with its own batch in `Scene::batches()`, ordered like every other primitive.
- `src/window.rs`: `Window::paint_backdrop(bounds, corner_radii, blur, saturation)`, meant to
  be painted by a glass surface before its own fill's readers — see `fv-gui::ui::backdrop`.

Only the macOS Metal renderer (`gpui-pre-apple`, also patched) implements the effect: it
snapshots the pixels painted so far behind the bounds, blurs them at quarter resolution
(downsample → separable gaussian → composite) and composites the result back *in place of*
the region, which is what a CSS backdrop-filter presents. Other platforms draw nothing, so a
glass surface there keeps its (denser) fill.

The pristine upstream copy stays at `gpui-pre-apple/vendor/gpui` for reference; the
shader-binding header in `gpui-pre-apple/build.rs` resolves to this crate first.

Remove this patch when the dependency grows a backdrop primitive of its own; until then the
`fv-gui` glass integration test (`--features capture --test glass`) fails loudly if the blur
or the 84/90 fill regress.
