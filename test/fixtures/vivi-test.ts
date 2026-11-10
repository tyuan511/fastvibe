// SPDX-License-Identifier: MIT
// Test assertion adapters for the cases derived from dsh-superagent/repo
// at 8c32a9dc5d72c033816c6a8110b37f40cf94fba4. See ../../src/main/bot/core/LICENSE.
// Node assertions and mocks run the tests; these patterns preserve the upstream
// partial-object and asymmetric argument comparisons without a test framework dependency.
import assert from 'node:assert/strict';
import { inspect, isDeepStrictEqual } from 'node:util';

const matcher = Symbol('upstream-test-pattern');
type Pattern = { [matcher]: (actual: unknown) => boolean };
const pattern = (test: Pattern[typeof matcher]): Pattern => ({ [matcher]: test });
const record = (value: unknown): value is Record<PropertyKey, unknown> => value !== null && typeof value === 'object';

function matches(actual: unknown, expected: unknown, partial = false): boolean {
  if (record(expected) && matcher in expected) return (expected as Pattern)[matcher](actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length
      && expected.every((value, index) => matches(actual[index], value, partial));
  }
  if (record(expected) && Object.getPrototypeOf(expected) === Object.prototype) {
    if (!record(actual)) return false;
    const keys = Reflect.ownKeys(expected);
    if (!partial && Reflect.ownKeys(actual).length !== keys.length) return false;
    return keys.every(key => key in actual && matches(actual[key], expected[key], partial));
  }
  return isDeepStrictEqual(actual, expected);
}

export const subset = (expected: unknown): Pattern => pattern(actual => matches(actual, expected, true));
export const anything = (): Pattern => pattern(actual => actual !== null && actual !== undefined);
export const any = (constructor: StringConstructor | NumberConstructor | BooleanConstructor | FunctionConstructor | ObjectConstructor): Pattern => pattern(actual => {
  if (constructor === String) return typeof actual === 'string' || actual instanceof String;
  if (constructor === Number) return typeof actual === 'number' || actual instanceof Number;
  if (constructor === Boolean) return typeof actual === 'boolean' || actual instanceof Boolean;
  if (constructor === Function) return typeof actual === 'function';
  return record(actual);
});
export const arrayContaining = (expected: unknown[]): Pattern => pattern(actual => Array.isArray(actual)
  && expected.every(value => actual.some(item => matches(item, value))));
export const stringContaining = (expected: string): Pattern => pattern(actual => typeof actual === 'string' && actual.includes(expected));

export function assertMatches(actual: unknown, expected: unknown, partial = false): void {
  assert.ok(matches(actual, expected, partial), `Expected ${partial ? 'partial' : 'exact'} match\nActual: ${inspect(actual, { depth: 12 })}\nExpected: ${inspect(expected, { depth: 12 })}`);
}

export function assertContains(actual: unknown, expected: unknown, deep = false, negate = false): void {
  const found = typeof actual === 'string' ? typeof expected === 'string' && actual.includes(expected)
    : Array.isArray(actual) && actual.some(value => deep ? matches(value, expected) : Object.is(value, expected));
  assert.equal(found, !negate, `Containment assertion: ${inspect(actual)} / ${inspect(expected)}`);
}

export function assertProperty(actual: unknown, path: string, negate = false): void {
  const keys = path.split('.');
  let value = actual;
  let found = true;
  for (const key of keys) {
    if (!record(value) || !(key in value)) { found = false; break; }
    value = value[key];
  }
  assert.equal(found, !negate, `Property ${path} on ${inspect(actual)}`);
}

export function assertThrows(fn: () => unknown, expected?: string | RegExp | Error | (new (...args: never[]) => Error)): void {
  if (expected === undefined) { assert.throws(fn); return; }
  assert.throws(fn, error => {
    if (!(error instanceof Error)) return false;
    if (typeof expected === 'string') return error.message.includes(expected);
    if (expected instanceof RegExp) return expected.test(error.message);
    if (expected instanceof Error) return error.message === expected.message;
    return error instanceof expected;
  });
}

type RecordedMock = { mock: { calls: { arguments: unknown[] }[]; resetCalls(): void } };
export function resetCalls(fn: unknown): void {
  (fn as RecordedMock).mock.resetCalls();
}
export function assertCallCount(fn: unknown, count: number): void {
  assert.equal((fn as RecordedMock).mock.calls.length, count);
}
export function assertCall(fn: unknown, expected: unknown[], mode: 'some' | 'last' | 'once'): void {
  const calls = (fn as RecordedMock).mock.calls;
  if (mode === 'once') assert.equal(calls.length, 1);
  const candidates = mode === 'some' ? calls : calls.slice(-1);
  assert.ok(candidates.some(call => matches(call.arguments, expected)), `Expected ${mode} call ${inspect(expected)}; received ${inspect(calls.map(call => call.arguments), { depth: 6 })}`);
}
