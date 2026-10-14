import { test } from "node:test";
import assert from "node:assert/strict";
import { documentOutline } from "../src/shared/file-document.ts";
import { rehypeHeadingIds } from "../src/renderer/src/lib/rehype-heading-ids.ts";

/**
 * The document view's one hard requirement: a contents entry must point at a heading
 * that exists.
 *
 * The outline reads the source and the rendered headings are stamped by the same
 * slugger from the same text, so the two agree by construction. "By construction" is
 * exactly what drifts when one side is edited, so it is checked here against the real
 * plugin rather than trusted.
 */

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function text(value: string): HastNode {
  return { type: "text", value };
}

function heading(level: number, children: HastNode[]): HastNode {
  return { type: "element", tagName: `h${level}`, properties: {}, children };
}

/** The ids the renderer would produce, in document order. */
function renderedIds(tree: HastNode): string[] {
  rehypeHeadingIds()(tree);
  const ids: string[] = [];
  const walk = (node: HastNode): void => {
    if (node.tagName && /^h[1-6]$/.test(node.tagName)) ids.push(String(node.properties?.id ?? ""));
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return ids;
}

test("every outline slug is the id the renderer stamps on that heading", () => {
  const source = "# Install\n\n## `npm run build`\n\n## Install\n\n### Notes & tips\n";
  const tree: HastNode = {
    type: "root",
    children: [
      heading(1, [text("Install")]),
      heading(2, [text("npm run build")]),
      heading(2, [text("Install")]),
      heading(3, [text("Notes & tips")]),
    ],
  };
  const outline = documentOutline(source);
  assert.deepEqual(
    outline.map((entry) => entry.slug),
    renderedIds(tree),
  );
});

test("markup inside a heading does not change the id it gets", () => {
  // The outline strips `**` and backticks; the plugin flattens the element's text.
  const tree: HastNode = {
    type: "root",
    children: [
      heading(2, [{ type: "element", tagName: "strong", properties: {}, children: [text("Bold")] }, text(" and "), { type: "element", tagName: "code", properties: {}, children: [text("code")] }]),
    ],
  };
  const outline = documentOutline("## **Bold** and `code`\n");
  assert.equal(outline[0]!.text, "Bold and code");
  assert.deepEqual(outline.map((entry) => entry.slug), renderedIds(tree));
});

test("a heading that already has an id is overwritten, so duplicates cannot collide", () => {
  const tree: HastNode = {
    type: "root",
    children: [heading(2, [text("Same")]), { ...heading(2, [text("Same")]), properties: { id: "hand-written" } }],
  };
  assert.deepEqual(renderedIds(tree), ["same", "same-1"]);
});

test("headings nested in other elements are stamped too", () => {
  const tree: HastNode = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "blockquote",
        properties: {},
        children: [heading(3, [text("Quoted")])],
      },
    ],
  };
  assert.deepEqual(renderedIds(tree), ["quoted"]);
});

test("an empty heading is left alone rather than given a meaningless anchor", () => {
  const tree: HastNode = { type: "root", children: [heading(2, [])] };
  assert.deepEqual(renderedIds(tree), [""]);
});
