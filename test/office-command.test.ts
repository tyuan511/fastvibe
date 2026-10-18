import assert from "node:assert/strict";
import { test } from "node:test";
import { officecliWriteTargets } from "../src/shared/office-command.ts";

test("a write command names the Office file and ignores the element path", () => {
  assert.deepEqual(
    officecliWriteTargets('officecli set "My Report.docx" "/body/p[1]" --prop text=Hi'),
    ["My Report.docx"],
  );
});

test("create and add in one line are two files, and a view is not a write", () => {
  assert.deepEqual(
    officecliWriteTargets('officecli create out/deck.pptx && officecli add out/deck.pptx / --type slide && officecli view out/deck.pptx html'),
    ["out/deck.pptx"],
  );
});

test("merge writes the output, not the template", () => {
  assert.deepEqual(officecliWriteTargets("officecli merge template.docx output.docx"), ["output.docx"]);
});

test("a variable is not treated as a file", () => {
  assert.deepEqual(officecliWriteTargets('officecli set "$FILE" /body/p[1]'), []);
});
