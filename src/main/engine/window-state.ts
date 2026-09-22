import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

const VERSION = 1;

export type PersistedWindowState = {
  width: number;
  height: number;
  maximized: boolean;
};

type WindowStateFile = PersistedWindowState & {
  version: number;
};

/** Read the last normal window size. Malformed or partial files are ignored. */
export function readWindowState(path: string): PersistedWindowState | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WindowStateFile>;
    if (
      value.version !== VERSION ||
      !isDimension(value.width) ||
      !isDimension(value.height) ||
      typeof value.maximized !== "boolean"
    ) {
      return null;
    }
    return { width: value.width, height: value.height, maximized: value.maximized };
  } catch {
    return null;
  }
}

/** Replace the state atomically so a crash cannot leave a truncated JSON file. */
export function writeWindowState(path: string, state: PersistedWindowState): void {
  const temporary = `${path}.tmp`;
  try {
    const payload: WindowStateFile = { version: VERSION, ...state };
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // ignore cleanup failure; preserve the original write error
    }
    throw error;
  }
}

function isDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
