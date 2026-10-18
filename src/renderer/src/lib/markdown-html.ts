import { defaultSchema } from "hast-util-sanitize";
import type { Schema } from "hast-util-sanitize";

/**
 * The whitelist that decides what raw HTML may reach the screen.
 *
 * `rehype-raw` is what makes a reply's `<br/>`, `<kbd>` or `<details>` render as markup
 * instead of the literal characters the reader sees without it — react-markdown hands its
 * `raw` nodes over as text on purpose, because it will not judge a model's markup for
 * itself. `rehype-raw` alone judges nothing either: it turns whatever was written into real
 * DOM. So the two are one feature, and this schema is the half that makes it safe.
 *
 * It is `hast-util-sanitize`'s GitHub schema — the one GitHub's own markdown uses — widened
 * only where this app's output would otherwise break, and nothing else:
 *
 * - everything not named is dropped, including the whole of `<script>` / `<style>` /
 *   `<iframe>` / `<object>` / `<embed>` / `<form>` / `<link>` / `<meta>`, which appear nowhere
 *   in it;
 * - event handlers need no rule: allowed attributes come from `property-information`, in which
 *   no key is named `onclick`, so `<img src=x onerror=…>` is inert before it ever becomes a
 *   React element;
 * - `id` and `name` keep GitHub's `user-content-` prefix, so nothing a reply names can collide
 *   with an element id the app itself queries;
 * - `style` is deliberately **not** added: it is how a reply hides its own text or lays a block
 *   over the transcript, and every real layout need here is met by `align` / `width` / `height`,
 *   which the catch-all already allows.
 *
 * Two widenings are load-bearing rather than generous:
 *
 * - **`class`, but only with the values KaTeX is chosen by.** The default strips `class`
 *   everywhere except a few footnote attributes, and `remark-math` marks a formula as
 *   `<code class="language-math math-inline">` — exactly what `rehype-katex` then looks for,
 *   because sanitising runs *before* it: a model's own markup must not be typeset as though the
 *   reader had written a formula, so the marker has to survive the filter that cannot see where
 *   it came from. Listing the values rather than the property is what keeps this from becoming
 *   a free pass for Tailwind — `<div class="fixed inset-0 bg-background">` names utilities the
 *   app's own stylesheet really does define, and without the list a reply could lay a panel over
 *   the window.
 * - **The app's own URL schemes.** A path link arrives as `fvpath:` or `file:` and an image
 *   as `data:image/…`, all before this runs; those are the protocols `urlTransform` lets
 *   through, and relative URLs need no entry (always allowed — that is what keeps
 *   `![](out/report.html)` previewable). `data:` stays off `href`: a link to a `data:` URL is
 *   a page, and this window is not where one gets opened.
 *
 * The added tags are what a README or a form flow actually contains: `u`, `mark`, `abbr`,
 * `small`, `caption`, `colgroup`, `col`, and the legacy `font` / `center` a quoted document
 * still uses. `svg` is not among them — inline SVG is a script-adjacent surface, and a reader
 * who wrote one meant an image, which the media pipeline already shows from a path.
 */
const TAGS = ["u", "mark", "abbr", "small", "caption", "colgroup", "col", "font", "center"];

/**
 * Dropped along with whatever was written inside them.
 *
 * The default drops only `script`'s content and splices every other unsafe element's children
 * back into the document — right for a `<figure>` whose wrapper is not allowed, wrong here: a
 * reply containing a `<style>` block showed its CSS as a paragraph of prose, and a `<svg>`
 * leaked its text nodes. None of these hold anything a reader was meant to read.
 *
 * `math` is on the list although KaTeX's own output contains a `<math>` element: sanitising
 * runs before the typesetting, so what this sees is a model's raw MathML, never the generated
 * markup. `form` is deliberately *not* on it — the elements it holds are the part a reader may
 * need, and the one that could submit something, `<input>`, is already forced into a disabled
 * checkbox by the schema's `required`.
 */
const STRIP = ["style", "svg", "math", "iframe", "object", "embed", "noscript", "noembed", "noframes", "template", "canvas"];

/**
 * What `remark-math` writes and `rehype-katex` recognises, read off the installed versions
 * rather than guessed (remark-math 6 emits `language-math` + `math-inline` on a `code`, and
 * rehype-katex 7 matches those two names). `test/markdown-html.test.ts` renders a formula
 * through the real pipeline, so a rename in either package fails there instead of quietly
 * turning every formula back into its LaTeX source.
 */
const MATH_CLASSES = ["language-math", "math-inline", "math-display"];

export const MARKDOWN_HTML_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...TAGS],
  strip: [...(defaultSchema.strip ?? []), ...STRIP],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), ["className", ...MATH_CLASSES]],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "fvpath", "file"],
    src: [...(defaultSchema.protocols?.src ?? []), "file", "data"],
  },
} satisfies Schema;
