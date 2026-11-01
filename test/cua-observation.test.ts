import assert from "node:assert/strict";
import test from "node:test";
import { serializeWindowState } from "../src/shared/cua-observation.ts";

test("window snapshots preserve the accessibility tree and exact bigint indexes", () => {
  const text = serializeWindowState({
    pid: 42,
    windowId: 9007199254740993n,
    snapshotId: "snap-1",
    treeMarkdown: "- Dialog\n  - Save",
    elementsComplete: false,
    degraded: true,
    degradedReason: "partial_accessibility",
    truncated: true,
    truncationReason: "max_elements",
    screenshotScale: 2,
    windowBounds: { x: 10, y: 20, width: 800, height: 600 },
    elements: [
      {
        elementIndex: 0n,
        depth: 0,
        role: "dialog",
        parentIndex: undefined,
      },
      {
        elementIndex: 1n,
        depth: 1,
        parentIndex: 0n,
        elementToken: "e1",
        role: "button",
        label: "Save",
        valueDescription: "Save document",
        inWebContent: false,
        enabled: true,
        actions: ["click"],
        frame: { x: 20, y: 30, w: 100, h: 40 },
        min: 0,
        max: 1,
      },
    ],
    treeElements: [
      {
        elementIndex: 1n,
        depth: 1,
        parentIndex: 0n,
        elementToken: "e1",
        role: "button",
      },
    ],
    images: [{ mimeType: "image/jpeg", width: 900, height: 600 }],
  });

  const snapshot = JSON.parse(text) as Record<string, any>;
  assert.equal(snapshot.windowId, "9007199254740993");
  assert.equal(snapshot.snapshotId, "snap-1");
  assert.equal(snapshot.treeMarkdown, "- Dialog\n  - Save");
  assert.equal(snapshot.elementsComplete, false);
  assert.equal(snapshot.degradedReason, "partial_accessibility");
  assert.equal(snapshot.elements[1].elementIndex, "1");
  assert.equal(snapshot.elements[1].parentIndex, "0");
  assert.equal(snapshot.elements[1].token, "e1");
  assert.equal(snapshot.elements[1].elementToken, "e1");
  assert.equal(snapshot.elements[1].valueDescription, "Save document");
  assert.equal(snapshot.treeElements[0].token, "e1");
  assert.equal(snapshot.imageCount, 1);
  assert.deepEqual(snapshot.imageMimeTypes, ["image/jpeg"]);
  assert.deepEqual(snapshot.imageDimensions, [{ width: 900, height: 600 }]);
  assert.equal("dataBase64" in snapshot, false);
});
