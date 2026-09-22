import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isValidServerInstanceId,
  newServerInstanceId,
  type AppServerIdentity,
} from "../../shared/app-protocol.ts";

/** The on-disk identity record is intentionally tiny and never contains credentials. */
type StoredIdentity = { version: 1; serverInstanceId: string };

export function loadOrCreateServerIdentity(
  file: string,
  metadata: { version: string; platform: string },
): AppServerIdentity {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      if (record.version === 1 && isValidServerInstanceId(record.serverInstanceId)) {
        return {
          serverInstanceId: record.serverInstanceId,
          version: metadata.version,
          platform: metadata.platform,
        };
      }
    }
  } catch {
    // A corrupt identity must not prevent the app from starting. It is replaced below;
    // an old binding will simply fail to find the old server, which is safer than
    // accidentally claiming another installation's identity.
  }

  const identity: StoredIdentity = { version: 1, serverInstanceId: newServerInstanceId(randomUUID) };
  const temporary = join(dirname(file), `.${identity.serverInstanceId}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return {
    serverInstanceId: identity.serverInstanceId,
    version: metadata.version,
    platform: metadata.platform,
  };
}
