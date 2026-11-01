export type AgentIdentity = {
  /** Stable display name, generated once per thread. */
  name: string;
  /** Seed used by the renderer to draw the same avatar everywhere. */
  avatarSeed: number;
};

const ADJECTIVES = [
  "Amber", "Brisk", "Calm", "Clever", "Curious", "Daring", "Gentle", "Keen",
  "Mellow", "Nimble", "Quiet", "Swift", "Vivid", "Warm", "Witty", "Zesty",
] as const;
const NOUNS = [
  "Badger", "Comet", "Dolphin", "Finch", "Fox", "Lynx", "Otter", "Panda",
  "Quail", "Raven", "Robin", "Seal", "Sparrow", "Turtle", "Wolf", "Wren",
] as const;

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

/** Generate a Codex-like friendly identity from an unpredictable thread id. */
export function agentIdentityForId(id: string): AgentIdentity {
  const seed = hash(id);
  return {
    name: `${ADJECTIVES[seed % ADJECTIVES.length]} ${NOUNS[(seed >>> 8) % NOUNS.length]}`,
    avatarSeed: seed,
  };
}

export function agentAvatarVariant(seed: number): number {
  return Math.abs(seed | 0) % 8;
}
