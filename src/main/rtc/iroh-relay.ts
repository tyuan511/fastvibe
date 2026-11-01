import { randomUUID } from "node:crypto";
import type { IrohRelayConfig, IrohRelayUsage } from "../../shared/iroh-relay.ts";

/** The account half needed by a native iroh transport. No Electron dependency. */
export type IrohRelayLeaseAccount = {
  issueIrohRelay: (deviceId: string, endpointId: string) => Promise<IrohRelayConfig>;
  reportIrohUsage: (input: {
    deviceId: string;
    token: string;
    reportId: string;
    bytesIn: number;
    bytesOut: number;
  }) => Promise<IrohRelayUsage>;
};

export type RelayTraffic = { bytesIn: number; bytesOut: number };
export type RelayLeaseState = {
  config: IrohRelayConfig | null;
  traffic: RelayTraffic;
  reported: RelayTraffic;
  usage: IrohRelayUsage | null;
  reporting: boolean;
};

export type IrohRelayLeaseOptions = {
  account: IrohRelayLeaseAccount;
  deviceId: string;
  endpointId: string;
  /** Refresh before expiry so a live connection can hand its successor a fresh token. */
  refreshMarginMs?: number;
  /** Send a checkpoint once this much new traffic has accumulated. */
  reportEveryBytes?: number;
  /** Also send a checkpoint after this interval when traffic is below the byte threshold. */
  reportIntervalMs?: number;
  now?: () => number;
  onUsage?: (usage: IrohRelayUsage) => void;
  onError?: (error: unknown) => void;
};

const DEFAULT_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_REPORT_EVERY_BYTES = 64 * 1024;
const DEFAULT_REPORT_INTERVAL_MS = 10_000;

/**
 * Owns one iroh relay credential and its cumulative usage checkpoint.
 *
 * The native transport calls `acquire()` before opening a relay path, calls
 * `recordTraffic()` only for bytes that travelled on that path, and calls `flush()`
 * when the connection closes. The report id is stable for the lease, which is what
 * lets Control replace a lost request with the same cumulative checkpoint safely.
 */
export class IrohRelayLease {
  readonly #account: IrohRelayLeaseAccount;
  readonly #deviceId: string;
  readonly #endpointId: string;
  readonly #reportId = randomUUID();
  readonly #refreshMarginMs: number;
  readonly #reportEveryBytes: number;
  readonly #reportIntervalMs: number;
  readonly #now: () => number;
  readonly #onUsage?: (usage: IrohRelayUsage) => void;
  readonly #onError?: (error: unknown) => void;
  #config: IrohRelayConfig | null = null;
  #usage: IrohRelayUsage | null = null;
  #traffic: RelayTraffic = { bytesIn: 0, bytesOut: 0 };
  #reported: RelayTraffic = { bytesIn: 0, bytesOut: 0 };
  #lastReportAt = 0;
  #refreshTimer: NodeJS.Timeout | null = null;
  #reportTimer: NodeJS.Timeout | null = null;
  #refreshFlight: Promise<IrohRelayConfig> | null = null;
  #reportFlight: Promise<IrohRelayUsage> | null = null;
  #closed = false;

  constructor(options: IrohRelayLeaseOptions) {
    if (!options.deviceId || !options.endpointId) throw new Error("relay lease needs a device and endpoint");
    this.#account = options.account;
    this.#deviceId = options.deviceId;
    this.#endpointId = options.endpointId;
    this.#refreshMarginMs = positive(options.refreshMarginMs, DEFAULT_REFRESH_MARGIN_MS);
    this.#reportEveryBytes = positive(options.reportEveryBytes, DEFAULT_REPORT_EVERY_BYTES);
    this.#reportIntervalMs = positive(options.reportIntervalMs, DEFAULT_REPORT_INTERVAL_MS);
    this.#now = options.now ?? Date.now;
    this.#onUsage = options.onUsage;
    this.#onError = options.onError;
  }

  state(): RelayLeaseState {
    return {
      config: this.#config,
      traffic: { ...this.#traffic },
      reported: { ...this.#reported },
      usage: this.#usage,
      reporting: this.#reportFlight !== null,
    };
  }

  /** Get a usable token, issuing or refreshing it as needed. */
  async acquire(): Promise<IrohRelayConfig> {
    if (this.#closed) throw new Error("relay lease is closed");
    return this.#ensureFresh();
  }

  /**
   * Record wire bytes from the native transport. Counters are cumulative and may only
   * move forward; direct-path bytes must not be passed here.
   */
  recordTraffic(traffic: RelayTraffic): void {
    if (this.#closed) return;
    assertBytes(traffic.bytesIn, "bytesIn");
    assertBytes(traffic.bytesOut, "bytesOut");
    this.#traffic.bytesIn += traffic.bytesIn;
    this.#traffic.bytesOut += traffic.bytesOut;
    if (this.#newBytes() >= this.#reportEveryBytes || this.#now() - this.#lastReportAt >= this.#reportIntervalMs) {
      void this.flush().catch((error: unknown) => this.#onError?.(error));
    }
  }

  /** Send the newest cumulative checkpoint. Concurrent flushes share one request. */
  async flush(): Promise<IrohRelayUsage | null> {
    if (this.#closed && !this.#reportFlight) return this.#usage;
    if (!this.#config) return null;
    if (this.#reportFlight) return this.#reportFlight;
    if (this.#traffic.bytesIn === this.#reported.bytesIn && this.#traffic.bytesOut === this.#reported.bytesOut) return this.#usage;
    const checkpoint = { ...this.#traffic };
    this.#reportFlight = this.#account.reportIrohUsage({
      deviceId: this.#deviceId,
      token: this.#config.token,
      reportId: this.#reportId,
      bytesIn: checkpoint.bytesIn,
      bytesOut: checkpoint.bytesOut,
    }).then((usage) => {
      this.#reported = {
        bytesIn: Math.max(this.#reported.bytesIn, checkpoint.bytesIn),
        bytesOut: Math.max(this.#reported.bytesOut, checkpoint.bytesOut),
      };
      this.#usage = usage;
      this.#lastReportAt = this.#now();
      this.#onUsage?.(usage);
      return usage;
    }).finally(() => {
      this.#reportFlight = null;
      this.#armReportTimer();
    });
    return this.#reportFlight;
  }

  /** Stop refresh/report timers. Callers should await flush() before this when possible. */
  close(): void {
    this.#closed = true;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    if (this.#reportTimer) clearTimeout(this.#reportTimer);
    this.#refreshTimer = null;
    this.#reportTimer = null;
  }

  async #ensureFresh(): Promise<IrohRelayConfig> {
    const expiresAt = this.#config ? Date.parse(this.#config.expiresAt) : 0;
    if (this.#config && expiresAt > this.#now() + this.#refreshMarginMs) return this.#config;
    if (this.#refreshFlight) return this.#refreshFlight;
    this.#refreshFlight = this.#account.issueIrohRelay(this.#deviceId, this.#endpointId).then((config) => {
      if (this.#closed) throw new Error("relay lease is closed");
      this.#config = config;
      this.#armRefreshTimer();
      this.#armReportTimer();
      return config;
    }).finally(() => { this.#refreshFlight = null; });
    return this.#refreshFlight;
  }

  #armRefreshTimer(): void {
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    if (!this.#config || this.#closed) return;
    const expiry = Date.parse(this.#config.expiresAt);
    const delay = Math.max(1, expiry - this.#now() - this.#refreshMarginMs);
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.#ensureFresh().catch((error: unknown) => this.#onError?.(error));
    }, delay);
    this.#refreshTimer.unref();
  }

  #armReportTimer(): void {
    if (this.#reportTimer) clearTimeout(this.#reportTimer);
    if (this.#closed || !this.#config || this.#traffic.bytesIn === this.#reported.bytesIn && this.#traffic.bytesOut === this.#reported.bytesOut) return;
    this.#reportTimer = setTimeout(() => {
      this.#reportTimer = null;
      void this.flush().catch((error: unknown) => this.#onError?.(error));
    }, this.#reportIntervalMs);
    this.#reportTimer.unref();
  }

  #newBytes(): number {
    return this.#traffic.bytesIn - this.#reported.bytesIn + this.#traffic.bytesOut - this.#reported.bytesOut;
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function assertBytes(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}
