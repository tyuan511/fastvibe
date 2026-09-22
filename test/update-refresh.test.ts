import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UPDATE_RECHECK_AFTER_MS,
  shouldRecheckBeforeDownload,
} from "../src/main/update-refresh.ts";

/**
 * The download path and this rule have to agree, because the failure it prevents is
 * silent and costs the user a restart: electron-updater's `downloadUpdate()` downloads
 * the version the *last check* resolved, and nothing re-reads the feed on its own. A
 * notice that has been on screen since before a newer release landed therefore installs
 * the older one — and the app comes back up showing 更新 again for the release that was
 * published in between. The rule is pure, so the timing is enumerated here rather than
 * discovered by waiting out a real feed.
 */

test("a version found moments ago is trusted, so the click starts downloading at once", () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldRecheckBeforeDownload({ version: "0.10.1", checkedAt: now - 5_000, now }), false);
  // Right up to the boundary; not one millisecond past it.
  assert.equal(
    shouldRecheckBeforeDownload({ version: "0.10.1", checkedAt: now - UPDATE_RECHECK_AFTER_MS + 1, now }),
    false,
  );
});

test("a notice old enough to be superseded is re-read before downloading", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    shouldRecheckBeforeDownload({ version: "0.10.1", checkedAt: now - UPDATE_RECHECK_AFTER_MS, now }),
    true,
  );
  // The reported case: checked at launch, acted on a quarter of an hour later.
  assert.equal(shouldRecheckBeforeDownload({ version: "0.10.1", checkedAt: now - 15 * 60_000, now }), true);
});

test("nothing known means nothing to download, so the feed decides", () => {
  const now = 1_700_000_000_000;
  // No check has answered yet, or the release went away with it.
  assert.equal(shouldRecheckBeforeDownload({ version: undefined, checkedAt: 0, now }), true);
  assert.equal(shouldRecheckBeforeDownload({ version: undefined, checkedAt: now - 1_000, now }), true);
});

test("a caller can tighten the window", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    shouldRecheckBeforeDownload({ version: "0.10.1", checkedAt: now - 1_000, now, recheckAfterMs: 500 }),
    true,
  );
  assert.equal(
    shouldRecheckBeforeDownload({ version: "0.10.1", checkedAt: now - 1_000, now, recheckAfterMs: 5_000 }),
    false,
  );
});
