import assert from "node:assert/strict";
import test from "node:test";
import { ActivationTicket } from "../src/main/pi/activation-ticket.ts";

test("a newer foreground activation invalidates a slower earlier open", () => {
  const ticket = new ActivationTicket();
  const first = ticket.begin();
  const second = ticket.begin();

  assert.equal(ticket.isCurrent(first), false);
  assert.equal(ticket.isCurrent(second), true);
});

test("a ticket stays valid while its session is loading", () => {
  const ticket = new ActivationTicket();
  const opening = ticket.begin();

  assert.equal(ticket.current(), opening);
  assert.equal(ticket.isCurrent(opening), true);
});
