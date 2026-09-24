import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBinaryAttachment,
  encodeBinaryAttachment,
  extractBinaryAttachments,
  materializeBinaryAttachments,
} from "../src/shared/binary-attachment.ts";

test("image data is replaced by a binary attachment reference and can be restored", () => {
  const source = {
    kind: "call",
    payload: {
      images: [{ type: "image", mimeType: "image/png", data: "AAEC/w==" }],
      items: [{ images: [{ type: "image", mimeType: "image/jpeg", data: "AQID" }] }],
    },
  };
  const extracted = extractBinaryAttachments(source);
  assert.equal(extracted.attachments.length, 2);
  assert.equal((extracted.message as { payload: { images: Array<{ data?: string; attachmentId?: string }> } }).payload.images[0]?.data, undefined);
  const first = extracted.attachments[0]!;
  assert.deepEqual([...first.bytes], [0, 1, 2, 255]);

  const restored = materializeBinaryAttachments(extracted.message, (id) =>
    extracted.attachments.find((attachment) => attachment.id === id)?.bytes,
  );
  assert.deepEqual(restored.missing, []);
  assert.deepEqual(restored.value, source);
});

test("binary attachment frames have a bounded, self-delimiting header", () => {
  const frame = encodeBinaryAttachment("att_12345678", new Uint8Array([1, 2, 3]));
  const decoded = decodeBinaryAttachment(frame);
  assert.ok(decoded);
  assert.equal(decoded.id, "att_12345678");
  assert.deepEqual([...decoded.bytes], [1, 2, 3]);
  assert.equal(decodeBinaryAttachment(new Uint8Array([1, 2, 3])), null);
});

