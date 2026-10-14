import type { Plugin } from "unified";
import { createSlugger, headingText } from "../../../shared/file-document.ts";

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const HEADING = /^h[1-6]$/;

/**
 * Give every heading an `id` matching the document outline's slugs.
 *
 * The ids are assigned here rather than by a `components` override so the rendered
 * heading and the contents entry are produced from the same source text by the same
 * slugger — an outline whose links land nowhere is the one failure this view has to
 * avoid, and two independent slug passes is how that happens.
 */
export const rehypeHeadingIds: Plugin = () => (tree) => {
  const slugger = createSlugger();
  visit(tree as HastNode, (node) => {
    if (!node.tagName || !HEADING.test(node.tagName)) return;
    const text = collectText(node);
    if (text === "") return;
    node.properties = { ...node.properties, id: slugger(text) };
  });
};

function visit(node: HastNode, each: (node: HastNode) => void): void {
  each(node);
  for (const child of node.children ?? []) visit(child, each);
}

/** The heading's own text, with the inline markup flattened the way the outline does. */
function collectText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return headingText((node.children ?? []).map(collectText).join(""));
}
