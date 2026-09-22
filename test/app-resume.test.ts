import assert from "node:assert/strict";
import test from "node:test";
import { planResume, toScopeCursors, unseenScopes } from "../src/shared/app-resume.ts";

test("epoch change is always rebootstrap, even with named-scope cursors", () => {
  const cursors = toScopeCursors("e1", { installation: 4, "conversation:c1": 2 });
  const plan = planResume({ welcomeEpoch: "e2", cursors, wildcard: false });
  assert.deepEqual(plan, { kind: "rebootstrap", reason: "epoch-changed" });
});

test("wildcard resume cannot cover unseen scopes and must rebootstrap", () => {
  const cursors = toScopeCursors("e1", { installation: 3 });
  assert.deepEqual(unseenScopes(cursors, ["installation", "conversation:c1", "conversation:c2"]), [
    "conversation:c1",
    "conversation:c2",
  ]);
  const plan = planResume({
    welcomeEpoch: "e1",
    cursors,
    wildcard: true,
    expectedScopes: ["installation", "conversation:c1"],
  });
  assert.deepEqual(plan, { kind: "rebootstrap", reason: "wildcard" });
});

test("named scopes at the welcome epoch can replay those scopes only", () => {
  const cursors = toScopeCursors("e1", { installation: 3, "conversation:c1": 1 });
  const plan = planResume({ welcomeEpoch: "e1", cursors, wildcard: false });
  assert.equal(plan.kind, "replay");
  if (plan.kind !== "replay") return;
  assert.equal(plan.epoch, "e1");
  assert.deepEqual(plan.since, {
    installation: { epoch: "e1", seq: 3 },
    "conversation:c1": { epoch: "e1", seq: 1 },
  });
});

test("expected scopes missing from the cursor map are unseen, not a complete replay", () => {
  const cursors = toScopeCursors("e1", { installation: 1 });
  const plan = planResume({
    welcomeEpoch: "e1",
    cursors,
    wildcard: false,
    expectedScopes: ["installation", "conversation:new"],
  });
  assert.deepEqual(plan, { kind: "rebootstrap", reason: "unseen-scopes" });
});

test("empty or invalid cursors rebootstrap rather than inventing a watermark", () => {
  assert.deepEqual(
    planResume({ welcomeEpoch: "e1", cursors: {}, wildcard: false }),
    { kind: "rebootstrap", reason: "no-cursors" },
  );
  assert.deepEqual(
    planResume({ welcomeEpoch: "", cursors: toScopeCursors("e1", { installation: 1 }), wildcard: false }),
    { kind: "rebootstrap", reason: "no-cursors" },
  );
  assert.deepEqual(toScopeCursors("e1", { installation: -1, "*": 4, ok: 2 }), {
    ok: { epoch: "e1", seq: 2 },
  });
});
