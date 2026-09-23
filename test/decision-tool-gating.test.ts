import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The decision-engine switches decide which tools a conversation is offered
 * (docs/decision-layer.md §5.2, §7.9): with 浏览器控制 / 电脑控制 off, browser_task /
 * computer_task must not be active and the step-by-step tools must be; with them on, the
 * reverse for the in-page / in-window interaction tools. The switch is re-read every turn,
 * so flipping it applies to conversations that already exist. Loaded through the real
 * extension factories with a stub `pi`, the way a session loads them.
 */

type Session = { active: () => string[]; turn: () => void; registered: string[]; setActive: (names: string[]) => void };

async function session(file: string, switchOn: () => boolean, hostless = false): Promise<Session> {
  const scope = globalThis as Record<string, unknown>;
  for (const key of ["__fastvibeBrowserTask", "__fastvibeBrowserTaskEnabled", "__fastvibeComputerTask", "__fastvibeComputerTaskEnabled"]) delete scope[key];
  if (!hostless) {
    scope.__fastvibeBrowserTask = async () => ({});
    scope.__fastvibeBrowserTaskEnabled = switchOn;
    scope.__fastvibeComputerTask = async () => ({});
    scope.__fastvibeComputerTaskEnabled = switchOn;
  }
  const registered: string[] = [];
  let active: string[] = [];
  const handlers = new Map<string, Array<() => void>>();
  const pi = {
    registerTool: (tool: { name: string }) => registered.push(tool.name),
    on: (event: string, handler: () => void) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => (active = [...names]),
  };
  const module = await import(`../resources/extensions/${file}?t=${Date.now()}-${Math.random()}`);
  module.default(pi as never);
  // The SDK activates every registered tool, then starts the session.
  active = [...registered];
  for (const handler of handlers.get("session_start") ?? []) handler();
  return {
    active: () => active,
    registered,
    setActive: (names) => (active = names),
    turn: () => {
      for (const handler of handlers.get("before_agent_start") ?? []) handler();
    },
  };
}

const BROWSER_STEPS = ["browser_click", "browser_type", "browser_press"];
const COMPUTER_STEPS = ["computer_click", "computer_type", "computer_key", "computer_hotkey", "computer_scroll", "computer_batch"];

for (const [file, task, steps, reading] of [
  ["browser-use.ts", "browser_task", BROWSER_STEPS, ["browser_open", "browser_navigate", "browser_snapshot", "browser_history"]],
  ["computer-use.ts", "computer_task", COMPUTER_STEPS, ["computer_screenshot", "computer_window_state", "computer_menu"]],
] as const) {
  const offersSteps = (tools: string[], label: string) => {
    assert.ok(!tools.includes(task), `${label}: no ${task}`);
    for (const name of [...steps, ...reading]) assert.ok(tools.includes(name), `${label}: ${name}`);
  };
  const offersTask = (tools: string[], label: string) => {
    assert.ok(tools.includes(task), `${label}: ${task}`);
    for (const name of steps) assert.ok(!tools.includes(name), `${label}: no ${name}`);
    for (const name of reading) assert.ok(tools.includes(name), `${label}: ${name}`);
  };

  test(`${task}: switch off from the start offers only the step tools`, async () => {
    const s = await session(file, () => false);
    offersSteps(s.active(), "session start");
  });

  test(`${task}: switch on from the start offers ${task} instead of the step tools`, async () => {
    const s = await session(file, () => true);
    offersTask(s.active(), "session start");
  });

  test(`${task}: flipping the switch applies to an existing conversation from its next turn`, async () => {
    let on = true;
    const s = await session(file, () => on);
    offersTask(s.active(), "on");
    on = false;
    s.turn();
    offersSteps(s.active(), "turned off");
    on = true;
    s.turn();
    offersTask(s.active(), "turned back on");
  });

  test(`${task}: a host without the runner never registers it`, async () => {
    const s = await session(file, () => true, true);
    assert.ok(!s.registered.includes(task));
    offersSteps(s.active(), "headless");
  });

  test(`${task}: tools another extension deactivated stay deactivated`, async () => {
    let on = false;
    const s = await session(file, () => on);
    // Plan mode narrows the set to read-only tools; neither group is active.
    s.setActive(["read", "grep"]);
    on = true;
    s.turn();
    assert.deepEqual(s.active(), ["read", "grep"], "switching on adds nothing to a read-only set");
    on = false;
    s.turn();
    assert.deepEqual(s.active(), ["read", "grep"], "nor does switching off");
  });
}
