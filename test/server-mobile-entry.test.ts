import assert from "node:assert/strict";
import test from "node:test";
import { prefersMobileEntry } from "../src/main/server/server.ts";

test("phones get the phone page; tablets and desktops the full client", () => {
  assert.equal(
    prefersMobileEntry("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"),
    true,
  );
  assert.equal(
    prefersMobileEntry("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"),
    true,
  );
  // An Android tablet omits `Mobile`; an iPad has the width the full client is laid out for.
  assert.equal(prefersMobileEntry("Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"), false);
  assert.equal(prefersMobileEntry("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"), false);
  assert.equal(prefersMobileEntry("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15"), false);
  assert.equal(prefersMobileEntry(undefined), false);
});
