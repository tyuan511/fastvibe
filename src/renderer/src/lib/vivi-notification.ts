const NOTIFICATION_MS = 5_000;

type Notice = { identity: string; expiresAt: number; dismissed: boolean };

/** Keep each source's latest notice from reappearing on polling or focus changes. */
export class ViviNotificationLifetime {
  #notices = new Map<string, Notice>();
  #current: Notice | undefined;
  #hovered = false;
  #now: () => number;

  constructor(now: () => number = Date.now) { this.#now = now; }

  update(source: string, identity: string, suppressed: boolean): void {
    let notice = this.#notices.get(source);
    if (notice?.identity !== identity) {
      notice = { identity, expiresAt: this.#now() + NOTIFICATION_MS, dismissed: suppressed };
      this.#notices.delete(source);
      this.#notices.set(source, notice);
      if (this.#notices.size > 128) this.#notices.delete(this.#notices.keys().next().value!);
    }
    if (suppressed || (notice !== this.#current && notice.expiresAt <= this.#now())) notice.dismissed = true;
    this.#current = notice;
  }

  hover(inside: boolean): void { this.#hovered = inside; }
  dismiss(): void { if (this.#current) this.#current.dismissed = true; }

  get visible(): boolean {
    return Boolean(this.#current && !this.#current.dismissed && (this.#hovered || this.#now() < this.#current.expiresAt));
  }

  get remaining(): number {
    return this.#current ? Math.max(0, this.#current.expiresAt - this.#now()) : 0;
  }
}
