import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password and token handling for the remote server.
 *
 * This is the only thing between an agent that can run commands on this machine and
 * whoever finds the tunnel's URL, so the shape matters more than it would for an
 * ordinary login:
 *
 * - The password is never stored, only a scrypt hash of it. A settings file that leaks
 *   must not be a password that leaks.
 * - The password is sent once, at login, and exchanged for a token. Tokens are what
 *   travel on every later connection, so a password is not repeatedly exposed to
 *   whatever sits between the client and here.
 * - Tokens are stored hashed too, and each can be revoked on its own — a phone that is
 *   lost is one entry to delete, not a password everything else has to be told about.
 *
 * Deliberately free of Electron and of any file access: it takes values and returns
 * values, so it can be tested directly and can move out of the desktop app later.
 */

/**
 * scrypt cost. N=2^15 lands around 100ms on a laptop — slow enough that guessing the
 * password offline against a leaked hash is expensive, fast enough that a login does
 * not feel broken. r and p are the usual defaults.
 */
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

/**
 * Memory ceiling for one derivation, and the formula scrypt's cost follows.
 *
 * Node caps scrypt at 32MB unless told otherwise, and N=2^15 with r=8 needs exactly
 * that — so the default refuses the very parameters chosen here. Raising the cap is
 * half the fix; the other half is refusing a *stored* cost that asks for more than
 * this, because those parameters come out of a settings file and "N=2^20, r=32" is a
 * four-gigabyte allocation written as a config value.
 */
const MAX_SCRYPT_MEMORY = 128 * 1024 * 1024;
const scryptMemory = (N: number, r: number): number => 128 * N * r;

/** Shortest password accepted. A public URL makes a four-character password the risk. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Why this password cannot be used, or null when it can.
 *
 * Length only. Refusing a list of "weak" passwords tends to push people toward the
 * pattern the list did not think of, while the throttle below is what actually makes
 * guessing impractical.
 */
export function passwordProblem(password: string): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`;
  }
  return null;
}

/** `scrypt$N$r$p$salt$hash`, all base64url. Self-describing so the cost can be raised later. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_SCRYPT_MEMORY });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/**
 * Whether the password matches the stored hash.
 *
 * Re-derives with the *stored* parameters rather than the current constants, so hashes
 * written by an older build keep working after the cost is raised. Anything malformed is
 * a non-match rather than a throw: a corrupt settings file must fail closed, not crash
 * the server on its first request.
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, rawN, rawR, rawP, rawSalt, rawKey] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A hostile settings file must not be able to ask for a derivation that exhausts
  // memory or pins a core: the cost is bounded by what it would actually allocate,
  // rather than by guessed limits on N and r separately.
  if (N < 1024 || r < 1 || p < 1 || p > 16) return false;
  if (scryptMemory(N, r) > MAX_SCRYPT_MEMORY) return false;
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(rawKey, "base64url");
    if (expected.length === 0) return false;
    actual = scryptSync(password, Buffer.from(rawSalt, "base64url"), expected.length, { N, r, p, maxmem: MAX_SCRYPT_MEMORY });
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * A fresh access token: the secret to hand the client once, and the hash to keep.
 *
 * 256 bits of randomness, so unlike the password it needs no slow KDF — there is nothing
 * to guess. A plain SHA-256 is enough to keep the stored form useless on its own while
 * staying cheap enough to check on every connection.
 */
export function createToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Constant-time comparison of a presented token against a stored hash. */
export function tokenMatches(token: string, storedHash: string): boolean {
  if (typeof token !== "string" || typeof storedHash !== "string" || !token || !storedHash) return false;
  const presented = Buffer.from(hashToken(token));
  const stored = Buffer.from(storedHash);
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

/**
 * Exponential backoff on failed logins.
 *
 * Counted globally rather than per client address, which looks wrong and is not: behind
 * a tunnel every request arrives from the tunnel's own address, so per-address counting
 * would either lock out everyone at once or nobody at all. One user owns this server, so
 * "someone is guessing" is the only thing worth measuring, and slowing *every* attempt is
 * exactly the intended effect.
 *
 * The first few failures are free — a typo should not cost a wait — and past that each
 * one doubles the delay up to the cap, which puts a guessing attack at a dozen tries an
 * hour instead of thousands a second.
 */
export class LoginThrottle {
  #failures = 0;
  #nextAllowedAt = 0;
  readonly #free: number;
  readonly #base: number;
  readonly #max: number;

  constructor(options?: { freeAttempts?: number; baseDelayMs?: number; maxDelayMs?: number }) {
    this.#free = options?.freeAttempts ?? 3;
    this.#base = options?.baseDelayMs ?? 1_000;
    this.#max = options?.maxDelayMs ?? 5 * 60_000;
  }

  /** Milliseconds the caller must wait before trying again; 0 when an attempt is allowed. */
  retryAfterMs(now: number = Date.now()): number {
    return Math.max(0, this.#nextAllowedAt - now);
  }

  /** Record a wrong password and start (or extend) the wait before the next attempt. */
  recordFailure(now: number = Date.now()): void {
    this.#failures += 1;
    if (this.#failures <= this.#free) return;
    const steps = this.#failures - this.#free - 1;
    const delay = Math.min(this.#max, this.#base * 2 ** steps);
    this.#nextAllowedAt = now + delay;
  }

  /** A correct password clears the history: the owner is back, and nothing is pending. */
  recordSuccess(): void {
    this.#failures = 0;
    this.#nextAllowedAt = 0;
  }

  /** Failed attempts since the last success. Shown in the settings pane. */
  get failures(): number {
    return this.#failures;
  }
}
