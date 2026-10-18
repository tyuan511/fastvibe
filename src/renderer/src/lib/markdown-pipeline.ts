import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { remarkStrictInlineMath } from "./remark-strict-inline-math.ts";
import { rehypeHeadingIds } from "./rehype-heading-ids.ts";
import { remarkPathLinks } from "./remark-path-links.ts";
import { MARKDOWN_HTML_SCHEMA } from "./markdown-html.ts";

/**
 * The markdown pipeline the app renders with, in one module.
 *
 * `markdown-view.tsx` cannot be imported by a test — it reaches i18n, the session store and
 * the path menu, and `pnpm test` runs pure modules in bare node. Everything the *result* of a
 * parse depends on therefore lives here: what a `$` is, whether a reply's raw HTML is markup,
 * what that markup may keep, where a heading's id comes from. The view only supplies the
 * components those tokens are drawn with, and `test/markdown-html.test.ts` parses through
 * these same constants, so the two cannot drift into different documents — which is also why
 * the app-relative imports below carry an explicit `.ts`: `node --test` reads no tsconfig and
 * resolves neither the `@/*` alias nor a bare extensionless path.
 *
 * They are module-level constants for a second reason: `react-markdown` builds its processor
 * from these props, and an inline array would be a new identity on every render of every
 * streamed token — the one thing `memo` on the block component exists to prevent.
 */

/**
 * `remark-math` + `rehype-katex` are wired in with the options the app needs, and
 * `remarkStrictInlineMath` follows `remark-math` because it inspects what that plugin
 * tokenized: `$HOME`, `$PATH` and `$5 到 $10` are prose here, not formulas.
 */
export const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkMath, remarkStrictInlineMath, remarkPathLinks];

/**
 * The KaTeX options the app needs: a half-streamed formula is the normal case, not an error,
 * so it must never throw into React nor warn about constructs it merely tolerates — the
 * offending fragment is drawn in the error colour and the log stays quiet.
 */
const KATEX_OPTIONS = {
  throwOnError: false,
  strict: false,
  errorColor: "var(--destructive)",
} as const;

/**
 * Raw HTML is rendered, then whitelisted, then typeset — and that order is the whole design.
 *
 * `rehype-raw` consumes the `raw` nodes react-markdown is handed and reparses the document, so
 * a `<details>` block whose answer sits under a blank line still ends up around it. It runs
 * first because everything after it has to see real elements. Sanitising comes before KaTeX
 * for two independent reasons: a model's `<span class="math inline">` must not be typeset as if
 * the reader had written a formula, and KaTeX's own output — thousands of classes and inline
 * styles — must not be judged by a schema written for other people's markup.
 */
export const REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, MARKDOWN_HTML_SCHEMA],
  [rehypeKatex, KATEX_OPTIONS],
];

/**
 * The same pipeline plus heading ids, for the file pane's document view.
 *
 * Ids are generated *after* sanitising, so a model cannot claim an id by writing it into raw
 * HTML — that one arrives prefixed as `user-content-…`.
 */
export const REHYPE_PLUGINS_WITH_HEADING_IDS: PluggableList = [...REHYPE_PLUGINS, rehypeHeadingIds];
