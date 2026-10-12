/**
 * Candidate lines this desktop writes itself, to tell the phone about addresses the WebRTC
 * library cannot know it has.
 *
 * The library reports what its own socket sees: the local addresses and the one public
 * address STUN answered with. Two more are real and reach the same socket — a port the
 * router was asked to forward (`portmap.ts`), and the ports a router that hands them out
 * in order is about to give this socket's next destinations. The phone has to be *told*
 * them, since its router lets nothing out to an address it has not heard of; the library
 * here needs telling nothing, because whatever arrives on its socket with the call's
 * credentials it answers.
 *
 * They are written as server-reflexive candidates, which is what they are to the phone: a
 * public address that leads to this computer's socket.
 */

export type ParsedCandidate = {
  /** `a=` when the line carried it; whatever the library writes is what is written back. */
  prefix: string;
  foundation: string;
  component: string;
  transport: string;
  priority: number;
  address: string;
  port: number;
  type: string;
};

/** A server-reflexive candidate's priority when there is no real one to sit beside (RFC 8445's formula, type preference 100). */
const REFLEXIVE_PRIORITY = 1_694_498_815;

export function parseCandidate(line: string): ParsedCandidate | null {
  const match = /^(a=)?candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)/.exec(line.trim());
  if (!match) return null;
  const priority = Number(match[5]);
  const port = Number(match[7]);
  if (!Number.isSafeInteger(priority) || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { prefix: match[1] ?? "", foundation: match[2], component: match[3], transport: match[4], priority, address: match[6], port, type: match[8] };
}

function reflexiveLine(like: ParsedCandidate | null, foundation: string, priority: number, address: string, port: number): string {
  const prefix = like?.prefix ?? "a=";
  const transport = like?.transport ?? "UDP";
  return `${prefix}candidate:${foundation} ${like?.component ?? "1"} ${transport} ${priority} ${address} ${port} typ srflx raddr 0.0.0.0 rport 0`;
}

/**
 * The ports a router that allocates in order will give this socket next.
 *
 * `reflexive` is the library's own server-reflexive line: the port the router gave the STUN
 * request. Each destination the socket then sends to gets the next free port, and the
 * phone's address is one of them — which one depends on how many candidates are tried
 * before it and on what else in the house opened a connection meanwhile, so a run of ports
 * is offered rather than one. Each is ranked a little below the real line and below the one
 * before it: the nearest port is the likeliest.
 */
export function predictedCandidates(reflexive: string, count: number): string[] {
  const parsed = parseCandidate(reflexive);
  if (!parsed || parsed.type !== "srflx" || !parsed.address.includes(".")) return [];
  const out: string[] = [];
  for (let step = 1; step <= count; step += 1) {
    const port = parsed.port + step;
    if (port > 65_535) break;
    out.push(reflexiveLine(parsed, `fvp${step}`, Math.max(1, parsed.priority - step), parsed.address, port));
  }
  return out;
}

/**
 * A port the router forwards to the call's socket. Ranked just above the library's own
 * server-reflexive line (`like`, when there is one): a forwarded port takes a packet from
 * anywhere, which the other only does for an address this side has already sent to.
 */
export function mappedCandidate(address: string, port: number, like: string | null): string {
  const parsed = like ? parseCandidate(like) : null;
  const template = parsed?.type === "srflx" ? parsed : null;
  return reflexiveLine(parsed, "fvmap", (template?.priority ?? REFLEXIVE_PRIORITY) + 1, address, port);
}
