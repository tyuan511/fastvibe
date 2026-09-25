/**
 * Serialises foreground navigation without serialising session loading itself.
 * A caller claims a ticket before an async open and may activate only if its ticket
 * is still current when the load completes.
 */
export class ActivationTicket {
  #current = 0;

  begin(): number {
    return ++this.#current;
  }

  current(): number {
    return this.#current;
  }

  isCurrent(ticket: number): boolean {
    return ticket === this.#current;
  }
}
