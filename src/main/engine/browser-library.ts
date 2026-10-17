import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { visitBrowserPage, type BrowserLibrary, type BrowserHistoryEntry } from "../../shared/browser-workspace.ts";

/** A separate bounded ledger; browser history never rides along with UI settings. */
export class BrowserLibraryStore {
  data: BrowserLibrary = { history: [], downloads: [] };
  private writes: Promise<void> = Promise.resolve();
  private path: string;
  constructor(path: string) { this.path = path; }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as BrowserLibrary;
      if (Array.isArray(raw.history)) {
        this.data.history = raw.history.slice(0, 500).filter((item) =>
          item && typeof item.url === "string" && typeof item.title === "string" && Number.isFinite(item.visitedAt));
      }
      if (Array.isArray(raw.downloads)) {
        this.data.downloads = raw.downloads.slice(0, 100).filter((item) =>
          item && typeof item.id === "string" && typeof item.name === "string" && typeof item.path === "string")
          .map((item) => ({ ...item, state: item.state === "progressing" ? "interrupted" : item.state, paused: false, canResume: false }));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  visit(entry: BrowserHistoryEntry): void {
    this.data.history = visitBrowserPage(this.data.history, entry);
  }

  save(): Promise<void> {
    const json = JSON.stringify(this.data);
    const write = this.writes.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, json, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    });
    this.writes = write;
    return write;
  }
}
