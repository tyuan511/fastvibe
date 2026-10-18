import assert from "node:assert/strict";
import { test } from "node:test";
import { delimitedFormatOf, parseDelimited } from "../src/shared/delimited.ts";

test("the extension picks the delimiter, and a name with no extension is not a table", () => {
  assert.equal(delimitedFormatOf("/tmp/a.CSV"), "csv");
  assert.equal(delimitedFormatOf("data.tsv"), "tsv");
  assert.equal(delimitedFormatOf("notes.txt"), null);
  assert.equal(delimitedFormatOf("no-dot"), null);
});

test("a quoted comma stays in the field, and a doubled quote is one quote", () => {
  const table = parseDelimited('city,"1,234","say ""hi"""\nnext,2,3\n');
  assert.deepEqual(table.rows, [
    ["city", "1,234", 'say "hi"'],
    ["next", "2", "3"],
  ]);
  assert.equal(table.truncated, null);
  assert.equal(table.totalRows, 2);
});

test("a newline inside quotes belongs to the field, and a blank line is not a row", () => {
  const table = parseDelimited('a,"b\nc",d\n\ne,f\r\n');
  assert.deepEqual(table.rows, [
    ["a", "b\nc", "d"],
    ["e", "f"],
  ]);
});

test("tabs split a tsv, and a comma inside it does not", () => {
  const table = parseDelimited("a\t1,234\tb\n", "tsv");
  assert.deepEqual(table.rows, [["a", "1,234", "b"]]);
});

test("the preview cap counts every row and says it was cut", () => {
  const text = ["h", "a", "b", "c"].join("\n");
  const table = parseDelimited(text, "csv", { maxRows: 2 });
  assert.deepEqual(table.rows, [["h"], ["a"]]);
  assert.equal(table.totalRows, 4);
  assert.equal(table.truncated, "rows");
});
