const NOTIFICATION_MS = 5_000;

type Notice = { identity: string; expiresAt: number; dismissed: boolean };

/** Keep each source's latest notice from reappearing on polling or focus changes. */
export class ViviNotificationLifetime {
  #notices = new Map<string, Notice>();
  #current: Notice | undefined;
  #hovered = false;
  #moving = false;
  #pausedAt: number | undefined;
  #pausedMs = 0;
  #now: () => number;

  constructor(now: () => number = Date.now) { this.#now = now; }

  #time(): number { return (this.#pausedAt ?? this.#now()) - this.#pausedMs; }

  update(source: string, identity: string, suppressed: boolean): void {
    let notice = this.#notices.get(source);
    if (notice?.identity !== identity) {
      notice = { identity, expiresAt: this.#time() + NOTIFICATION_MS, dismissed: suppressed };
      this.#notices.delete(source);
      this.#notices.set(source, notice);
      if (this.#notices.size > 128) this.#notices.delete(this.#notices.keys().next().value!);
    }
    if (suppressed) notice.dismissed = true;
    if (notice !== this.#current && notice.expiresAt <= this.#time()) notice.dismissed = true;
    this.#current = notice;
  }

  setMoving(moving: boolean): void {
    if (moving === this.#moving) return;
    const now = this.#now();
    if (moving) {
      this.#moving = true;
      this.#pausedAt = now;
      return;
    }
    if (this.#pausedAt !== undefined) {
      this.#pausedMs += Math.max(0, now - this.#pausedAt);
    }
    this.#pausedAt = undefined;
    this.#moving = false;
  }

  hover(inside: boolean): void { this.#hovered = inside; }
  dismiss(): void { if (this.#current) this.#current.dismissed = true; }

  get visible(): boolean {
    return !this.#moving && Boolean(this.#current && !this.#current.dismissed && (this.#hovered || this.#time() < this.#current.expiresAt));
  }

  get remaining(): number {
    return this.#current ? Math.max(0, this.#current.expiresAt - this.#time()) : 0;
  }
}
