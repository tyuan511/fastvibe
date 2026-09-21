import { test } from "node:test";
import assert from "node:assert/strict";
import { unpackedPath } from "../src/main/engine/asar-unpacked.ts";

/**
 * A packaged FastVibe loads the Cua driver's native library by the path `require.resolve`
 * hands back — an in-archive path, which the Rust side then `dlopen`s directly and cannot
 * open. The rewrite to the unpacked twin is the whole fix, so its edges are pinned here
 * rather than discovered on a user's machine.
 */

test("an in-archive path maps to the copy beside the archive", () => {
  assert.equal(
    unpackedPath(
      "/Applications/FastVibe.app/Contents/Resources/app.asar/node_modules/@trycua/cua-driver-darwin-arm64/libcua_driver_sdk.dylib",
    ),
    "/Applications/FastVibe.app/Contents/Resources/app.asar.unpacked/node_modules/@trycua/cua-driver-darwin-arm64/libcua_driver_sdk.dylib",
  );
});

test("a Windows separator is preserved", () => {
  assert.equal(
    unpackedPath("C:\\Program Files\\FastVibe\\resources\\app.asar\\node_modules\\x\\a.dll"),
    "C:\\Program Files\\FastVibe\\resources\\app.asar.unpacked\\node_modules\\x\\a.dll",
  );
});

test("packed paths and look-alike names are left alone", () => {
  assert.equal(unpackedPath("/app/out/main/index.js"), "/app/out/main/index.js");
  assert.equal(unpackedPath("/x/myapp.asar/y"), "/x/myapp.asar/y");
  assert.equal(unpackedPath("app.asar/relative"), "app.asar/relative");
});
