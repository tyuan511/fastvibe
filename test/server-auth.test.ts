import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LoginThrottle,
  MIN_PASSWORD_LENGTH,
  createToken,
  hashPassword,
  hashToken,
  passwordProblem,
  tokenMatches,
  verifyPassword,
} from "../src/main/server/auth.ts";

/**
 * The remote server's front door. Every failure mode here is silent — a hash that always
 * verifies, a token comparison that is really `===`, a throttle that never throttles —
 * and none of them show up as a broken screen. They show up as an agent that can run
 * commands on this machine, reachable by whoever finds the URL.
 */

test("a password verifies against its own hash and nothing else", () => {
  const stored = hashPassword("correct horse battery");
  assert.equal(verifyPassword("correct horse battery", stored), true);
  assert.equal(verifyPassword("correct horse batteru", stored), false);
  assert.equal(verifyPassword("", stored), false);
  assert.equal(verifyPassword("correct horse battery ", stored), false);
});

test("the same password hashes differently every time", () => {
  // No salt (or a fixed one) would make two identical passwords visibly identical in the
  // settings file, and make the hashes worth precomputing.
  const a = hashPassword("correct horse battery");
  const b = hashPassword("correct horse battery");
  assert.notEqual(a, b);
  assert.equal(verifyPassword("correct horse battery", a), true);
  assert.equal(verifyPassword("correct horse battery", b), true);
});

test("the stored form keeps its own cost parameters", () => {
  // So raising the cost later does not invalidate every password already set.
  const stored = hashPassword("correct horse battery");
  const [scheme, n, r, p] = stored.split("$");
  assert.equal(scheme, "scrypt");
  assert.ok(Number(n) >= 32_768, "N must stay expensive");
  assert.ok(Number(r) >= 8);
  assert.ok(Number(p) >= 1);
});

test("a malformed stored hash fails closed rather than throwing", () => {
  // A corrupt settings file must deny the login, not crash the server on its first request.
  for (const bad of ["", "nonsense", "scrypt$1$2$3", "scrypt$x$8$1$aa$bb", "bcrypt$1$1$1$aa$bb", "scrypt$32768$8$1$$"]) {
    assert.equal(verifyPassword("correct horse battery", bad), false, `should reject: ${bad}`);
  }
});

test("absurd cost parameters are refused instead of being honoured", () => {
  // A hostile settings file must not be able to ask for a derivation that hangs the
  // process — this is a denial of service written as a config value.
  const stored = `scrypt$99999999$8$1$${Buffer.from("salt").toString("base64url")}$${Buffer.from("x".repeat(32)).toString("base64url")}`;
  assert.equal(verifyPassword("correct horse battery", stored), false);
});

test("a short password is refused, a long one is accepted", () => {
  assert.notEqual(passwordProblem("short"), null);
  assert.notEqual(passwordProblem("x".repeat(MIN_PASSWORD_LENGTH - 1)), null);
  assert.equal(passwordProblem("x".repeat(MIN_PASSWORD_LENGTH)), null);
});

test("a token matches only its own hash", () => {
  const { token, hash } = createToken();
  assert.equal(tokenMatches(token, hash), true);
  assert.equal(tokenMatches(token + "a", hash), false);
  assert.equal(tokenMatches(createToken().token, hash), false);
});

test("the token is not recoverable from what is stored", () => {
  const { token, hash } = createToken();
  assert.notEqual(token, hash);
  assert.equal(hash, hashToken(token));
  // 256 bits, base64url: long enough that guessing is not a strategy.
  assert.ok(token.length >= 40, `token too short: ${token.length}`);
});

test("empty or missing credentials never match", () => {
  const { hash } = createToken();
  assert.equal(tokenMatches("", hash), false);
  assert.equal(tokenMatches("anything", ""), false);
  assert.equal(tokenMatches(undefined as unknown as string, hash), false);
});

test("the first few failures cost nothing, then the wait doubles", () => {
  const throttle = new LoginThrottle({ freeAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 });
  const t0 = 1_000_000;
  assert.equal(throttle.retryAfterMs(t0), 0);
  for (let i = 0; i < 3; i += 1) {
    throttle.recordFailure(t0);
    assert.equal(throttle.retryAfterMs(t0), 0, `failure ${i + 1} should still be free`);
  }
  throttle.recordFailure(t0);
  assert.equal(throttle.retryAfterMs(t0), 1_000);
  throttle.recordFailure(t0);
  assert.equal(throttle.retryAfterMs(t0), 2_000);
  throttle.recordFailure(t0);
  assert.equal(throttle.retryAfterMs(t0), 4_000);
});

test("the wait is capped, so a long attack cannot lock the owner out forever", () => {
  const throttle = new LoginThrottle({ freeAttempts: 0, baseDelayMs: 1_000, maxDelayMs: 5_000 });
  const t0 = 1_000_000;
  for (let i = 0; i < 40; i += 1) throttle.recordFailure(t0);
  assert.equal(throttle.retryAfterMs(t0), 5_000);
});

test("the wait elapses", () => {
  const throttle = new LoginThrottle({ freeAttempts: 0, baseDelayMs: 1_000, maxDelayMs: 60_000 });
  const t0 = 1_000_000;
  throttle.recordFailure(t0);
  assert.equal(throttle.retryAfterMs(t0 + 999), 1);
  assert.equal(throttle.retryAfterMs(t0 + 1_000), 0);
  assert.equal(throttle.retryAfterMs(t0 + 5_000), 0);
});

test("a correct password clears the backoff", () => {
  const throttle = new LoginThrottle({ freeAttempts: 0, baseDelayMs: 1_000, maxDelayMs: 60_000 });
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i += 1) throttle.recordFailure(t0);
  assert.ok(throttle.retryAfterMs(t0) > 0);
  throttle.recordSuccess();
  assert.equal(throttle.retryAfterMs(t0), 0);
  assert.equal(throttle.failures, 0);
});
