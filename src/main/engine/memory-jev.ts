import type { Answer, ChoiceQuestion, DecideRequest, JsonValue, NoulQuestion, Question } from "./decision/protocol.ts";
import type { MemoryEdge, MemoryRelationView } from "@shared/memory";

/**
 * Jev-Mem's System-One control plane, ported from the reference implementation
 * (github.com/libingzheren/Jev-Mem @ 81574eb, MIT License, Copyright (c) 2024 Anonymous
 * Authors; paper arXiv:2609.23986). Question texts, heuristics and constants are the
 * reference's own. Kept free of I/O so every threshold and formula is testable;
 * `memory.ts` owns the store, the embeddings and the Jev runtime.
 *
 * Source map — change these together with the file they mirror:
 * - question texts            memory/jev_questions.py
 * - candidates, relations,
 *   budget allocation         memory/jev_mem_policies.py
 * - retrieval loop, scoring   memory/jev_mem_retrieval.py (loop itself in memory.ts)
 * - temporal references       memory/temporal_parser.py (`describe_references`)
 * - entities / keywords       memory/memory_builder.py, memory/keyword_enrichment.py
 * - temporal links            memory/memory_builder.py (`create_temporal_*_links`)
 * - fallback write            memory/memory_builder.py (`_build_magma`) →
 *                             memory/trg_memory.py (`add_event`)
 * - profile                   config/jev_mem.json over memory/jev_mem_config.py
 *
 * FastVibe additions are marked "FastVibe:" where they appear: Chinese patterns for
 * the English-only heuristics, and a per-memory content cap that keeps a request under
 * Jev's size limit (reference inputs are short LoCoMo turns, ours can be long replies).
 */

/** `config/jev_mem.json` (the paper's profile) over `JevMemConfig` defaults. */
export const JEV_MEM_PROFILE = {
  relationThreshold: 0.6,
  candidateTopK: 10,
  anchorCount: 30,
  totalGraphBudget: 80,
  probabilityExponent: 1.0,
  minimumGraphBudget: 1,
  graphActivationThreshold: 0.1,
  beamWidth: 10,
  maximumDepth: 8,
  maximumNodes: 60,
  maximumEdges: 2400,
  maximumJevCalls: 16,
  maxLatencyMs: 15_000,
  evidenceSufficientThreshold: 0.95,
  continueThreshold: 0.15,
  consolidationInterval: 20,
  consolidationThreshold: 0.85,
  /** λ1…λ5 of Eq. 23 — not in the profile, so `JevMemConfig`'s default. */
  transitionWeights: [0.25, 0.35, 0.15, 0.15, 0.1] as const,
  /** Per attempt; each `evaluate` makes at most `maxRetries + 1` attempts. */
  timeoutMs: 3_000,
  maxRetries: 2,
  cacheSize: 1024,
  rrfK: 60,
} as const;

export type JevMemProfile = typeof JEV_MEM_PROFILE;

export const MEMORY_VIEWS: readonly MemoryRelationView[] = ["semantic", "temporal", "causal", "entity"];
export const TYPE_KEYS = ["episodic", "semantic", "procedural", "preference"] as const;

const DAY_SECONDS = 86_400;

/** A memory as the control plane sees it (the reference's `EventNode`). */
export type JevNode = {
  id: string;
  /** `content_narrative`: `[speaker]: text` for a turn, the plain text for a summary. */
  content: string;
  createdAt: number;
  entities: string[];
};

// ---------------------------------------------------------------------------
// Answers

/** Noul values of a fully validated batch; the reference never uses a partial batch. */
export function noulValues(answers: Record<string, Answer> | undefined, ids: string[]): Record<string, number> | undefined {
  if (!answers) return undefined;
  const values: Record<string, number> = {};
  for (const id of ids) {
    const answer = answers[id];
    if (answer?.type !== "noul") return undefined;
    values[id] = answer.noul;
  }
  return values;
}

function noul(instructions: string, whenTrue: string, whenFalse: string): NoulQuestion {
  return { type: "noul", instructions, criteria: { true: whenTrue, false: whenFalse } };
}

// ---------------------------------------------------------------------------
// Node state (`node_state`)

/**
 * FastVibe: characters the memories of one request may use between them. The reference
 * sends content whole; a long assistant reply would push a batch past Jev's 32k-token
 * state limit (§3.7 of docs/decision-layer.md), so each memory gets an even share.
 */
const STATE_CONTENT_CHARS = 18_000;
const MIN_CONTENT_CHARS = 300;
const MAX_CONTENT_CHARS = 12_000;

export function contentCap(memories: number): number {
  return Math.max(MIN_CONTENT_CHARS, Math.min(MAX_CONTENT_CHARS, Math.floor(STATE_CONTENT_CHARS / Math.max(1, memories))));
}

export function nodeState(node: JevNode, options: { temporal?: boolean; cap?: number } = {}): { [key: string]: JsonValue } {
  return {
    id: node.id,
    content: node.content.slice(0, options.cap ?? MAX_CONTENT_CHARS),
    timestamp: new Date(node.createdAt).toISOString(),
    entities: node.entities,
    ...(options.temporal
      ? {
          timestamp_role: "observation_time; not necessarily the event date",
          temporal_references: describeReferences(node.content, node.createdAt),
        }
      : {}),
  };
}

/** `[speaker]: text`, the reference's LoCoMo turn narrative. */
export function narrative(role: string, content: string): string {
  return role === "summary" ? content : `[${role}]: ${content}`;
}

// ---------------------------------------------------------------------------
// Temporal references (`TemporalParser.describe_references`)

export type TemporalReference = { original: string; normalized: string; precision: string; anchor_date: string };

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const WEEKDAYS: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
const REFERENCE_PATTERN = new RegExp(
  "\\b(?:yesterday|today|tomorrow|last night|"
    + "(?:last|this|next|this past)\\s+(?:weekend|week|month|year)|"
    + "(?:last|next)\\s+(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|"
    + "thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|"
    + "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s+"
    + "(?:days?|weeks?|weekends?|months?|years?)\\s+ago)\\b",
  "gi",
);

/** `normalize_date_format`: "7 May 2023". */
function normalizeDate(date: Date): string {
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, base.getHours(), base.getMinutes(), base.getSeconds());
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Anchor relative expressions to the observation time without inventing finer event
 * precision: a week, weekend, month or year is never an exact day.
 */
export function describeReferences(text: string, observedAt: number): TemporalReference[] {
  const base = new Date(observedAt);
  const anchor = normalizeDate(base);
  const anchorDate = isoDate(base);
  const weekday = (base.getDay() + 6) % 7; // Python's weekday(): Monday = 0.
  const references: TemporalReference[] = [];
  const push = (original: string, normalized: string | undefined, precision: string | undefined): void => {
    if (normalized && precision) references.push({ original, normalized, precision, anchor_date: anchorDate });
  };
  const resolve = (unit: string, direction: number, count: number): [string | undefined, string | undefined] => {
    if (unit === "day") return [normalizeDate(addDays(base, direction * count)), "day"];
    if (unit === "year") {
      const year = base.getFullYear() + direction * count;
      return year >= 1 && year <= 9999 ? [String(year), "year"] : [undefined, undefined];
    }
    if (unit === "month") {
      const index = base.getFullYear() * 12 + base.getMonth() + direction * count;
      const year = Math.floor(index / 12);
      return year >= 1 && year <= 9999 ? [`${MONTH_NAMES[index - year * 12]} ${year}`, "month"] : [undefined, undefined];
    }
    if (unit === "week" || unit === "weekend") {
      if (direction === 0) return [`The ${unit} of ${anchor}`, unit];
      const label = count === 1 ? `The ${unit}` : `${count} ${unit}s`;
      return [`${label} ${direction < 0 ? "before" : "after"} ${anchor}`, unit];
    }
    return [undefined, undefined];
  };

  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const phrase = match[0].toLowerCase();
    const parts = phrase.split(/\s+/);
    const dayOffset = ({ yesterday: -1, "last night": -1, today: 0, tomorrow: 1 } as Record<string, number>)[phrase];
    if (dayOffset !== undefined) {
      push(match[0], normalizeDate(addDays(base, dayOffset)), "day");
      continue;
    }
    const last = parts[parts.length - 1];
    if (last !== "month" && Object.hasOwn(WEEKDAYS, last.slice(0, 3))) {
      const target = WEEKDAYS[last.slice(0, 3)];
      const forward = phrase.startsWith("next ");
      const delta = ((((forward ? target - weekday : weekday - target) % 7) + 7) % 7) || 7;
      push(match[0], normalizeDate(addDays(base, forward ? delta : -delta)), "day");
      continue;
    }
    let count = 1;
    let direction = -1;
    let unit: string;
    if (last === "ago") {
      count = /^\d+$/.test(parts[0]) ? Number(parts[0]) : NUMBER_WORDS[parts[0]];
      unit = parts[parts.length - 2].replace(/s+$/, "");
    } else {
      unit = last;
      direction = parts[0] === "next" ? 1 : phrase.startsWith("this ") && parts[1] !== "past" ? 0 : -1;
    }
    push(match[0], ...resolve(unit, direction, count));
  }

  // FastVibe: the same expressions in Chinese, resolved by the same rules.
  const chinese: Array<[RegExp, string, number]> = [
    [/昨天|昨晚|昨日/g, "day", -1], [/今天|今日/g, "day", 0], [/明天|明日/g, "day", 1],
    [/上周末/g, "weekend", -1], [/(?:这|本)周末/g, "weekend", 0], [/下周末/g, "weekend", 1],
    [/上个?(?:周|星期)(?![一二三四五六日天末])/g, "week", -1], [/(?:这|本)(?:周|星期)(?![一二三四五六日天末])/g, "week", 0], [/下个?(?:周|星期)(?![一二三四五六日天末])/g, "week", 1],
    [/上个?月/g, "month", -1], [/(?:这个|本)月/g, "month", 0], [/下个?月/g, "month", 1],
    [/去年/g, "year", -1], [/今年/g, "year", 0], [/明年/g, "year", 1],
  ];
  for (const [pattern, unit, direction] of chinese) {
    for (const match of text.matchAll(pattern)) push(match[0], ...resolve(unit, direction, 1));
  }
  for (const match of text.matchAll(/(\d{1,3})\s*(天|周|个星期|个月|年)前/g)) {
    const unit = ({ 天: "day", 周: "week", 个星期: "week", 个月: "month", 年: "year" } as Record<string, string>)[match[2]];
    push(match[0], ...resolve(unit, -1, Number(match[1])));
  }
  return references;
}

// ---------------------------------------------------------------------------
// Query heuristics (`TemporalParser.is_temporal_question`, `QueryEngine.detect_query_intent`)

const TEMPORAL_KEYWORDS = ["when", "what time", "what date", "which day", "how long", "how many days", "how many weeks", "how many months", "how many years", "what year", "what month", "timeline", "schedule", "duration"];
// FastVibe: Chinese equivalents.
const TEMPORAL_KEYWORDS_ZH = ["什么时候", "何时", "哪天", "哪一天", "几号", "几点", "多久", "多长时间", "几天", "几周", "几个月", "几年", "哪年", "哪一年", "哪个月", "时间线", "日程", "时长"];

export function isTemporalQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  return TEMPORAL_KEYWORDS.some((keyword) => lower.includes(keyword)) || TEMPORAL_KEYWORDS_ZH.some((keyword) => question.includes(keyword));
}

export function detectQueryIntent(question: string): "WHY" | "WHEN" | "ENTITY" {
  const lower = question.toLowerCase();
  if (["why", "because", "cause", "reason", "lead to", "result"].some((word) => lower.includes(word)) || /为什么|为何|原因|因为|导致|结果/.test(question)) return "WHY";
  if (["when", "time", "date", "before", "after", "during", "while"].some((word) => lower.includes(word)) || /什么时候|何时|时间|日期|之前|之后|期间/.test(question)) return "WHEN";
  return "ENTITY";
}

export type Route = {
  needs: Record<MemoryRelationView, number>;
  multiHop: number;
  recency: number;
};

/** The reference's routing baseline, used when the routing call falls back. */
export function baselineNeeds(question: string): Route {
  const intent = detectQueryIntent(question);
  return {
    needs: { semantic: 0.7, temporal: intent === "WHEN" ? 0.8 : 0.2, causal: intent === "WHY" ? 0.8 : 0.2, entity: 0.6 },
    multiHop: 0.5,
    recency: 0.2,
  };
}

// ---------------------------------------------------------------------------
// Entities and keywords (`_simple_entity_extraction`, `KeywordEnricher.extract_keywords`)

const COMMON_WORDS = new Set(["The", "This", "That", "These", "Those", "What", "When", "Where", "Who", "Why", "How", "Image", "Thanks", "Wow", "Yes", "No", "Maybe", "Please", "Sorry", "Hello", "Hi", "Good", "Great", "Nice", "Sure", "Okay", "Well", "Now"]);

export function extractEntities(text: string): string[] {
  const entities: string[] = [];
  for (const match of text.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g)) {
    if (!COMMON_WORDS.has(match[0]) && match[0].length > 2) entities.push(match[0]);
  }
  for (const match of text.matchAll(/I'?m\s+([A-Z][a-z]+)/g)) entities.push(match[1]);
  // FastVibe: a quoted name is the only entity signal Chinese text offers.
  for (const match of text.matchAll(/[“「『]([^”」』\n]{2,40})[”」』]/g)) entities.push(match[1]);
  return [...new Set(entities)].slice(0, 5);
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "was", "are", "were", "been", "be", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "may", "might", "must",
  "can", "shall", "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "but", "or", "and", "if", "so", "yet", "it", "this", "that", "these", "those",
  "i", "you", "he", "she", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "what", "which", "who",
  "when", "where", "why", "how", "all", "each", "every", "both", "few", "more",
  "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "than", "too", "very", "just", "about", "into", "through", "during", "before",
  "after", "above", "below", "between", "under", "again", "further", "then", "once",
]);

/** Counter.most_common: by count, ties in first-seen order. */
function mostCommon(items: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([item]) => item);
}

export function extractKeywords(text: string, maxKeywords = 15): string[] {
  if (!text) return [];
  const keywords: string[] = [];
  const lower = text.toLowerCase();
  for (const match of [...text.matchAll(/(?<![.!?]\s)\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g)].slice(0, 5)) {
    const name = match[0].toLowerCase();
    if (!STOP_WORDS.has(name)) keywords.push(name);
  }
  // `re.findall` with one group returns the group: the reference keeps "19"/"20" of a year.
  keywords.push(...[...text.matchAll(/\b(19|20)\d{2}\b/g)].slice(0, 2).map((match) => match[1]));
  keywords.push(...[...text.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/gi)].slice(0, 2).map((match) => match[1].toLowerCase()));
  keywords.push(...[...text.matchAll(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g)].slice(0, 2).map((match) => match[0]));
  keywords.push(...[...text.matchAll(/\b\d{1,2}:\d{2}(?:\s*[apAP][mM])?\b/g)].slice(0, 2).map((match) => match[0]));
  const words = [...lower.matchAll(/\b[a-zA-Z]+\b/g)].map((match) => match[0]);
  for (const word of mostCommon(words.filter((word) => word.length > 2 && !STOP_WORDS.has(word)), 20)) {
    if (!keywords.includes(word) && keywords.length < maxKeywords) keywords.push(word);
  }
  const bigrams: string[] = [];
  for (let index = 0; index < words.length - 1; index++) {
    const [left, right] = [words[index], words[index + 1]];
    if (!STOP_WORDS.has(left) && !STOP_WORDS.has(right) && left.length > 2 && right.length > 2) bigrams.push(`${left}_${right}`);
  }
  for (const bigram of mostCommon(bigrams, 5).slice(0, 3)) {
    if (keywords.length < maxKeywords) keywords.push(bigram);
  }
  // FastVibe: Chinese has no spaces to split on; frequent character bigrams stand in for words.
  const cjk = [...text.matchAll(/[一-鿿]+/g)].flatMap((match) => {
    const run = match[0];
    return run.length < 2 ? [] : Array.from({ length: run.length - 1 }, (_unused, index) => run.slice(index, index + 2));
  });
  for (const pair of mostCommon(cjk, 20)) {
    if (!keywords.includes(pair) && keywords.length < maxKeywords) keywords.push(pair);
  }
  return [...new Set(keywords.map((keyword) => keyword.toLowerCase()))].slice(0, maxKeywords);
}

// ---------------------------------------------------------------------------
// Write path: candidates (`find_candidates`)

export type CandidatePoolItem = JevNode & { keywords: string[] };

/**
 * Bound the Jev candidate set with vector, keyword, entity and time signals:
 * 2·cos (vector top-k only) + 2·[shared entity] + keyword overlap + 0.25 / (1 + Δdays).
 */
export function rankCandidates<T extends CandidatePoolItem>(
  node: CandidatePoolItem,
  pool: T[],
  vectorHits: Map<string, number>,
  topK: number = JEV_MEM_PROFILE.candidateTopK,
): T[] {
  const entities = new Set(node.entities);
  const keywords = new Set(node.keywords);
  const scored = pool
    .filter((candidate) => candidate.id !== node.id)
    .map((candidate) => {
      let score = vectorHits.has(candidate.id) ? 2 * vectorHits.get(candidate.id)! : 0;
      score += candidate.entities.some((entity) => entities.has(entity)) ? 2 : 0;
      score += new Set(candidate.keywords.filter((keyword) => keywords.has(keyword))).size / Math.max(1, keywords.size);
      score += 0.25 / (1 + Math.abs(node.createdAt - candidate.createdAt) / 1000 / DAY_SECONDS);
      return { candidate, score };
    });
  scored.sort((a, b) => b.score - a.score || byName(a.candidate.id, b.candidate.id));
  return scored.slice(0, topK).map(({ candidate }) => candidate);
}

// ---------------------------------------------------------------------------
// Write path: typing and relations (`WritePolicy`)

export const MEMORY_TYPE_QUESTIONS: Record<(typeof TYPE_KEYS)[number], NoulQuestion> = {
  episodic: noul(
    "Does `observation` describe a particular experience or event involving a participant?",
    "A specific past, current or planned event, even if its exact time is unstated.",
    "Only a general fact, procedure or preference with no particular event."),
  semantic: noul(
    "Does `observation` state a fact about a person, entity or the world that remains useful beyond this conversational turn?",
    "An attributable fact or relationship, even when it also appears in an episodic account.",
    "Only a transient conversational acknowledgement or a question with no asserted fact."),
  procedural: noul(
    "Does `observation` describe how to carry out a task?",
    "An instruction, ordered step, method or actionable rule for performing a task.",
    "Merely mentions doing a task without describing how."),
  preference: noul(
    "Does `observation` express a participant's preference, aversion or habitual choice?",
    "An attributable like, dislike, preferred option or habitual choice.",
    "An isolated action alone, another person's unattributed preference, or no preference evidence."),
};

/** Typing only; admission is disabled in the paper's profile, so nothing is ever rejected. */
export function typingRequest(observation: string): DecideRequest {
  return { version: 1, binding: "memory.write", state: { observation: observation.slice(0, MAX_CONTENT_CHARS) }, questions: { ...MEMORY_TYPE_QUESTIONS } };
}

function relationQuestions(index: number, inferIdentity: boolean): Record<string, NoulQuestion> {
  const pair = `Compare \`new_memory.content\` with \`candidates[${index}].content\`. `;
  const questions: Record<string, NoulQuestion> = {
    semantic: noul(`${pair}Would a semantic link between these observations help retrieve a shared specific topic or fact?`,
      "A specific shared topic, fact or event makes the connection useful.",
      "Only generic conversational vocabulary or no meaningful semantic connection."),
    causes: noul(`${pair}Does the event in \`new_memory.content\` cause, enable or explain the candidate event?`,
      "The supplied accounts support this direction of causal influence.",
      "Only similarity, chronology, a shared entity, or insufficient causal evidence."),
    caused_by: noul(`${pair}Does the candidate event cause, enable or explain the event in \`new_memory.content\`?`,
      "The supplied accounts support this direction of causal influence.",
      "Only similarity, chronology, a shared entity, or insufficient causal evidence."),
  };
  if (inferIdentity) {
    questions.entity = noul(`${pair}Using \`new_memory.entities\` and \`candidates[${index}].entities\`, do any names or aliases refer to the same real-world entity?`,
      "Context supports a shared identity despite differing names or aliases.",
      "Distinct entities or insufficient evidence to resolve the alias; similar names alone are insufficient.");
  }
  return questions;
}

function sharesEntity(a: JevNode, b: JevNode): boolean {
  return a.entities.some((entity) => b.entities.includes(entity));
}

export function relationRequest(node: JevNode, candidates: JevNode[]): DecideRequest | undefined {
  if (candidates.length === 0) return undefined;
  const questions: Record<string, Question> = {};
  candidates.forEach((candidate, index) => {
    for (const [name, question] of Object.entries(relationQuestions(index, !sharesEntity(node, candidate)))) {
      questions[`pair_${index}_${name}`] = question;
    }
  });
  const cap = contentCap(candidates.length + 1);
  return {
    version: 1,
    binding: "memory.relation",
    state: { new_memory: nodeState(node, { cap }), candidates: candidates.map((candidate) => nodeState(candidate, { cap })) },
    questions,
  };
}

/** `WritePolicy.relations`; `undefined` means the call fell back and no edge is written. */
export function relationEdges(node: JevNode, candidates: JevNode[], answers: Record<string, Answer> | undefined, threshold: number = JEV_MEM_PROFILE.relationThreshold): MemoryEdge[] | undefined {
  const request = relationRequest(node, candidates);
  if (!request) return [];
  const values = noulValues(answers, Object.keys(request.questions));
  if (!values) return undefined;
  const edges: MemoryEdge[] = [];
  candidates.forEach((other, index) => {
    const prefix = `pair_${index}_`;
    const add = (view: MemoryRelationView, relation: MemoryEdge["relation"], probability: number, reverse = false): void => {
      if (probability < threshold) return;
      const [sourceId, targetId] = reverse ? [other.id, node.id] : [node.id, other.id];
      edges.push({ sourceId, targetId, view, relation, origin: "jev", weight: probability, confidence: probability });
    };
    add("semantic", "related", values[`${prefix}semantic`]);
    add("causal", "causes", values[`${prefix}causes`]);
    add("causal", "causes", values[`${prefix}caused_by`], true);
    add("entity", "same_entity", sharesEntity(node, other) ? 1 : values[`${prefix}entity`]);
  });
  return edges;
}

/**
 * MAGMA's temporal links, added for the newest node only (`latest_only=True`): a
 * PRECEDES/SUCCEEDS pair with its predecessor, and TEMPORALLY_CLOSE from each of the up
 * to nine nodes before it observed within 24 hours. Neither link carries a probability,
 * which is why traversal reads them at the reference's structural default of 0.5.
 */
export const TEMPORAL_STRUCTURAL_WEIGHT = 0.5;

export function temporalEdges(peers: JevNode[]): MemoryEdge[] {
  if (peers.length < 2) return [];
  const newest = peers[peers.length - 1];
  const previous = peers[peers.length - 2];
  const weight = TEMPORAL_STRUCTURAL_WEIGHT;
  const edges: MemoryEdge[] = [
    { sourceId: previous.id, targetId: newest.id, view: "temporal", relation: "before", origin: "sequence", weight, confidence: weight },
    { sourceId: newest.id, targetId: previous.id, view: "temporal", relation: "after", origin: "sequence", weight, confidence: weight },
  ];
  for (const peer of peers.slice(Math.max(0, peers.length - 10), -1)) {
    const hours = Math.abs(newest.createdAt - peer.createdAt) / 3_600_000;
    if (hours <= 24) edges.push({ sourceId: peer.id, targetId: newest.id, view: "temporal", relation: "temporally_close", origin: "sequence", weight, confidence: weight });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Fallback write (`MemoryBuilder._build_magma` → `TemporalResonanceGraphMemory.add_event`)
//
// When the typing or relation call falls back, the reference drops the Jev node and
// writes the observation the way MAGMA does: an LLM extracts a narrative, entities,
// keywords and emotion (simple rules if that fails), the node is linked to its
// predecessor in time, and both ways to its three nearest neighbours by vector.

/** `_extract_event`'s prompt, verbatim — indentation included, it is part of the string. */
export function eventExtractionPrompt(content: string): string {
  return "Extract structured event information from the following content.\n"
    + "            Identify the main narrative, key entities, keywords, and emotional tone.\n\n"
    + `            Content: ${content}\n\n`
    + "            Return as JSON with:\n"
    + "            - content_narrative: Concise narrative summary\n"
    + "            - entities: List of named entities (people, places, organizations)\n"
    + "            - keywords: List of important keywords\n"
    + "            - emotion: Dominant emotional tone (if any)\n"
    + "            ";
}

/**
 * FastVibe: the reference enforces this shape with a strict JSON schema
 * (`response_format`); the model call here has no such parameter, so it is stated.
 */
export const EVENT_EXTRACTION_SYSTEM = "Respond with only a JSON object with exactly these keys: "
  + "content_narrative (string), entities (array of strings), keywords (array of strings), emotion (string or null).";

export type EventExtraction = {
  narrative: string;
  entities: string[];
  keywords: string[];
  emotion: string | null;
};

/** The model's JSON, read as `_extract_event` reads it; `undefined` sends the caller to the simple rules. */
export function parseEventExtraction(raw: string, content: string): EventExtraction | undefined {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  return {
    narrative: typeof record.content_narrative === "string" ? record.content_narrative : content,
    entities: strings(record.entities),
    keywords: strings(record.keywords),
    emotion: typeof record.emotion === "string" ? record.emotion : null,
  };
}

/**
 * `_simple_extract_event`: words longer than five characters, capitalised words, and the
 * first 500 characters. The reference collects entities through a `set`, whose order is
 * arbitrary; first-seen order is the deterministic choice.
 */
export function simpleExtractEvent(content: string): EventExtraction {
  const keywords = content.split(/\s+/).filter((word) => word.length > 5).slice(0, 5);
  const entities = [...new Set([...content.matchAll(/\b[A-Z][a-z]+\b/g)].map((match) => match[0]))].slice(0, 5);
  return { narrative: content.slice(0, 500), entities, keywords, emotion: null };
}

/** `_create_temporal_links`: PRECEDES from the predecessor in time, SUCCEEDS back. */
export function magmaTemporalEdges(previous: JevNode | undefined, node: JevNode): MemoryEdge[] {
  if (!previous) return [];
  const weight = TEMPORAL_STRUCTURAL_WEIGHT;
  return [
    { sourceId: previous.id, targetId: node.id, view: "temporal", relation: "before", origin: "magma", weight, confidence: weight },
    { sourceId: node.id, targetId: previous.id, view: "temporal", relation: "after", origin: "magma", weight, confidence: weight },
  ];
}

/**
 * `_create_semantic_links`: RELATED_TO both ways with the three nearest neighbours.
 * The link carries a `similarity_score`, not a probability, so traversal reads it at
 * the structural default of 0.5; the score is kept in `confidence`.
 */
export function magmaSemanticEdges(node: JevNode, nearest: Array<{ id: string; similarity: number }>): MemoryEdge[] {
  return nearest
    .filter((other) => other.id !== node.id)
    .slice(0, 3)
    .flatMap((other) => [
      { sourceId: node.id, targetId: other.id, view: "semantic" as const, relation: "related" as const, origin: "magma" as const, weight: TEMPORAL_STRUCTURAL_WEIGHT, confidence: other.similarity },
      { sourceId: other.id, targetId: node.id, view: "semantic" as const, relation: "related" as const, origin: "magma" as const, weight: TEMPORAL_STRUCTURAL_WEIGHT, confidence: other.similarity },
    ]);
}

// ---------------------------------------------------------------------------
// Consolidation (`MemoryBuilder.consolidate`)

function consolidationQuestions(index: number): Record<string, Question> {
  const pair = `Compare \`new_memory.content\` with \`candidates[${index}].content\`. `;
  return {
    redundant: noul(`${pair}Do these observations repeat the same fact with no additional recallable detail?`,
      "One is a duplicate or paraphrase without a new detail or time-specific update.",
      "They provide different details or describe distinct occurrences."),
    contradiction: noul(`${pair}Do these accounts assert incompatible facts about the same subject at the same time?`,
      "Claims cannot both hold at the stated time and context.",
      "Compatible claims, uncertainty, or a change over time that explains the difference."),
    obsolete: noul(`${pair}Does the new memory explicitly replace the candidate's previously valid fact with an updated fact?`,
      "An explicit update supersedes the earlier fact for current-state questions.",
      "No explicit replacement; mere recency or a separate event is insufficient."),
    link: noul(`${pair}Would following a link between these observations help answer a future recall question?`,
      "The connection supplies related, corroborating, correcting or contrasting evidence.",
      "There is no specific connection useful for recall."),
    representation: {
      type: "choice",
      instructions: `${pair}Which representation best fits the relationship between these two observations? Judge from the supplied accounts; do not assume answers to other questions.`,
      criteria: {
        keep_separate: "Contradictory accounts, unique details that a combined representation would lose, or distinct facts/events without a supported general pattern.",
        merge: "Compatible accounts of the same fact or event can be combined without losing unique details.",
        promote: "Distinct repeated episodes explicitly support a stable general pattern suitable for semantic abstraction; prefer this over merge for repeated events.",
        uncertain: "Insufficient evidence to choose a safe combined or separate representation.",
      },
    } satisfies ChoiceQuestion,
  };
}

export function consolidationRequest(node: JevNode, candidates: JevNode[]): DecideRequest | undefined {
  if (candidates.length === 0) return undefined;
  const questions: Record<string, Question> = {};
  candidates.forEach((_candidate, index) => {
    for (const [name, question] of Object.entries(consolidationQuestions(index))) questions[`pair_${index}_${name}`] = question;
  });
  const cap = contentCap(candidates.length + 1);
  return {
    version: 1,
    binding: "memory.maintenance",
    state: { new_memory: nodeState(node, { cap }), candidates: candidates.map((candidate) => nodeState(candidate, { cap })) },
    questions,
  };
}

export type ConsolidationDecision = {
  candidateId: string;
  redundant: number;
  contradiction: number;
  obsolete: number;
  link: number;
  representation: { choice: string; probabilities: Record<string, number> };
};

export type ConsolidationPlan = {
  decisions: ConsolidationDecision[];
  edges: MemoryEdge[];
  /** Pairs System Two may turn into a new representation. */
  summaries: Array<{ candidate: JevNode; action: "merge" | "promote" }>;
};

/**
 * One SEMANTIC link per pair — CONTRADICTS over REDUNDANT_WITH over RELATED_TO — when
 * the strongest of link/redundant/contradiction reaches the consolidation threshold.
 * Obsolescence is recorded as a decision, not an edge. System Two may write a pair's
 * summary only when merge/promote is selected at that threshold and contradiction
 * stays below it. `undefined` means the call fell back.
 */
export function consolidationPlan(node: JevNode, candidates: JevNode[], answers: Record<string, Answer> | undefined, threshold: number = JEV_MEM_PROFILE.consolidationThreshold): ConsolidationPlan | undefined {
  const request = consolidationRequest(node, candidates);
  if (!request) return { decisions: [], edges: [], summaries: [] };
  const noulIds = Object.keys(request.questions).filter((id) => request.questions[id].type === "noul");
  const values = noulValues(answers, noulIds);
  if (!values || !answers) return undefined;
  const plan: ConsolidationPlan = { decisions: [], edges: [], summaries: [] };
  for (let index = 0; index < candidates.length; index++) {
    const other = candidates[index];
    const representation = answers[`pair_${index}_representation`];
    if (representation?.type !== "choice" || !representation.probabilities) return undefined;
    const score = (name: string): number => values[`pair_${index}_${name}`];
    const decision: ConsolidationDecision = {
      candidateId: other.id,
      redundant: score("redundant"),
      contradiction: score("contradiction"),
      obsolete: score("obsolete"),
      link: score("link"),
      representation: { choice: representation.choice, probabilities: representation.probabilities },
    };
    plan.decisions.push(decision);
    const relation = decision.contradiction >= threshold ? "contradicts" : decision.redundant >= threshold ? "duplicates" : "related";
    const strongest = Math.max(decision.link, decision.redundant, decision.contradiction);
    if (strongest >= threshold) plan.edges.push({ sourceId: node.id, targetId: other.id, view: "semantic", relation, origin: "consolidation", weight: strongest, confidence: strongest });
    const action = representation.choice;
    if ((action === "merge" || action === "promote") && representation.probabilities[action] >= threshold && decision.contradiction < threshold) {
      plan.summaries.push({ candidate: other, action });
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Read path: routing and budgets

const ROUTING_QUESTIONS: Record<string, NoulQuestion> = {
  semantic: noul("Would finding topically or semantically related memories help answer `query`?",
    "Recall of related facts is useful.", "No related-memory lookup is needed."),
  temporal: noul("Does answering `query` require event dates, durations, ordering or changes over time?",
    "A time relation is needed to answer correctly.", "Dates or ordering are incidental to the answer."),
  causal: noul("Does answering `query` require explaining a cause, motivation, enabling condition or effect?",
    "Causal or explanatory evidence is needed.", "Only factual association or chronology is requested."),
  entity: noul("Would connecting mentions of the same person, place, object or organization help answer `query`?",
    "Combining entity-specific facts or aliases is useful.", "Entity identity is irrelevant to the answer."),
  multi_hop_need: noul("Does `query` require combining at least two distinct pieces of remembered evidence?",
    "The question asks for a comparison, aggregation or chained inference.", "One direct remembered fact suffices."),
  recency_importance: noul("Does `query` require the latest applicable fact rather than a historical fact?",
    "Current state, latest update or recent status is requested.", "Historical or timeless facts answer the question."),
};

export function routingRequest(query: string): DecideRequest {
  return { version: 1, binding: "memory.read.route", state: { query }, questions: { ...ROUTING_QUESTIONS } };
}

/** The routed needs, or the reference's intent baseline when routing fell back. */
export function routeFrom(answers: Record<string, Answer> | undefined, query: string): Route {
  const values = noulValues(answers, Object.keys(ROUTING_QUESTIONS));
  if (!values) return baselineNeeds(query);
  return {
    needs: { semantic: values.semantic, temporal: values.temporal, causal: values.causal, entity: values.entity },
    multiHop: values.multi_hop_need,
    recency: values.recency_importance,
  };
}

/** `allocate_graph_budgets`: largest remainder, ties by graph name; the total never exceeds B. */
export function allocateBudget(
  needs: Record<MemoryRelationView, number>,
  profile: Pick<JevMemProfile, "graphActivationThreshold" | "totalGraphBudget" | "minimumGraphBudget" | "probabilityExponent"> = JEV_MEM_PROFILE,
): Record<MemoryRelationView, number> {
  const budgets: Record<MemoryRelationView, number> = { semantic: 0, temporal: 0, causal: 0, entity: 0 };
  let active = MEMORY_VIEWS.filter((graph) => needs[graph] > 0 && needs[graph] >= profile.graphActivationThreshold);
  if (active.length === 0 || !profile.totalGraphBudget) return budgets;
  active.sort((a, b) => needs[b] - needs[a] || byName(a, b));
  let minimum: number = profile.minimumGraphBudget;
  if (minimum) {
    // A small budget can activate only the highest-need graphs.
    active = active.slice(0, Math.max(1, Math.floor(profile.totalGraphBudget / minimum)));
    minimum = Math.min(minimum, profile.totalGraphBudget);
  }
  for (const graph of active) budgets[graph] = minimum;
  const remaining = profile.totalGraphBudget - sum(MEMORY_VIEWS.map((graph) => budgets[graph]));
  const largest = Math.max(...active.map((graph) => needs[graph]));
  const weights = new Map(active.map((graph) => [graph, (needs[graph] / largest) ** profile.probabilityExponent]));
  const total = sum([...weights.values()]);
  const shares = new Map(active.map((graph) => [graph, (remaining * weights.get(graph)!) / total]));
  for (const graph of active) budgets[graph] += Math.trunc(shares.get(graph)!);
  const left = profile.totalGraphBudget - sum(MEMORY_VIEWS.map((graph) => budgets[graph]));
  const order = [...active].sort((a, b) => (shares.get(b)! % 1) - (shares.get(a)! % 1) || byName(a, b));
  for (const graph of order.slice(0, Math.max(0, left))) budgets[graph] += 1;
  return budgets;
}

/** Eq. 15: D(q) = min{D_max, max(1, ⌈D_max · h(q)⌉)}. */
export function traversalDepth(multiHop: number, maxDepth: number = JEV_MEM_PROFILE.maximumDepth): number {
  return Math.min(maxDepth, Math.max(1, Math.ceil(maxDepth * multiHop)));
}

// ---------------------------------------------------------------------------
// Read path: stopping

const STOPPING_QUESTIONS: Record<string, NoulQuestion> = {
  evidence_sufficient: noul("Does `evidence` contain support for every factual part of an answer to `query`?",
    "A grounded answer can be given from these memories without inventing missing facts.",
    "Any required fact or reasoning link is unsupported; related topics alone are insufficient."),
  continue_useful: noul("Given `query` and `evidence`, is another retrieval round likely to fill a specific gap or resolve a conflict?",
    "An identifiable missing fact or conflict could benefit from more memory retrieval.",
    "No identifiable retrieval need remains or more memories are unlikely to help."),
  missing_evidence: noul("Is at least one fact required by `query` absent from `evidence`?",
    "A required detail, date, identity, count or linking fact is not supported.",
    "All required facts have explicit support in the supplied evidence."),
  contradiction: noul("Does `evidence` contain conflicting claims relevant to `query` that the supplied time/context cannot reconcile?",
    "A conflict still affects which answer is correct.",
    "Claims agree, differ only by explained temporal updates, or do not affect the answer."),
};

export function stoppingRequest(query: string, evidence: JevNode[], depth: number, temporal: boolean): DecideRequest {
  const cap = contentCap(evidence.length);
  return {
    version: 1,
    binding: "memory.read.assess",
    state: { query, evidence: evidence.map((node) => nodeState(node, { temporal, cap })), depth },
    questions: { ...STOPPING_QUESTIONS },
  };
}

/** Eqs. 21–22. A fallen-back stopping call decides nothing; the hard limits still apply. */
export function stopDecision(
  answers: Record<string, Answer> | undefined,
  profile: Pick<JevMemProfile, "evidenceSufficientThreshold" | "continueThreshold"> = JEV_MEM_PROFILE,
): "evidence_sufficient" | "further_retrieval_unhelpful" | undefined {
  const values = noulValues(answers, Object.keys(STOPPING_QUESTIONS));
  if (!values) return undefined;
  if (values.evidence_sufficient >= profile.evidenceSufficientThreshold
    && values.missing_evidence < profile.continueThreshold && values.contradiction < profile.continueThreshold) return "evidence_sufficient";
  if (values.continue_useful < profile.continueThreshold) return "further_retrieval_unhelpful";
  return undefined;
}

// ---------------------------------------------------------------------------
// Read path: traversal scoring

function traversalQuestions(index: number): Record<string, NoulQuestion> {
  const candidate = `candidates[${index}]`;
  return {
    relevance: noul(`Does \`${candidate}.content\` contain a fact needed to answer \`query\`?`,
      "Direct answer evidence or a necessary intermediate fact.", "Only topic overlap or unrelated content."),
    relation_usefulness: noul(`Does the stated graph relation of \`${candidate}\` connect \`evidence\` to information useful for \`query\`?`,
      "The relation and its direction support an answer-relevant connection.", "A graph edge exists but has no demonstrated usefulness for this question."),
    new_information: noul(`Does \`${candidate}.content\` add an answer-relevant detail absent from \`evidence\`?`,
      "A distinct relevant detail or missing reasoning link.", "Only duplicated evidence or irrelevant new details."),
    supports_current_evidence: noul(`Does \`${candidate}.content\` independently corroborate a claim in \`evidence\` relevant to \`query\`?`,
      "Provides compatible corroborating evidence for a specific claim.", "No specific corroboration, or contradicts that claim."),
  };
}

const TRAVERSAL_FIELDS = ["relevance", "relation_usefulness", "new_information", "supports_current_evidence"] as const;

/** A neighbour proposed for scoring: the node, the edge that reached it, and its view. */
export type Proposal = {
  node: JevNode;
  edge: MemoryEdge;
  graph: MemoryRelationView;
  /** The edge's probability, or 0.5 where it has none. */
  structural: number;
  /** Id and observation time of the evidence node the edge was followed from. */
  parentId: string;
  parentCreatedAt: number;
};

/** The reference's `sub_type` names, so the relation Jev reads is the one the paper describes. */
const SUB_TYPES: Partial<Record<MemoryEdge["relation"], string>> = {
  related: "RELATED_TO",
  causes: "LEADS_TO",
  same_entity: "SHARED_ENTITY",
  before: "PRECEDES",
  after: "SUCCEEDS",
  temporally_close: "TEMPORALLY_CLOSE",
  contradicts: "CONTRADICTS",
  duplicates: "REDUNDANT_WITH",
};

/** The link's `properties` as the reference stores them for the stage that made it. */
function relationProperties(proposal: Proposal): { [key: string]: JsonValue } {
  const { relation, origin = "jev", weight, confidence } = proposal.edge;
  const subType = SUB_TYPES[relation] ?? relation.toUpperCase();
  const seconds = Math.abs(proposal.node.createdAt - proposal.parentCreatedAt) / 1000;
  switch (origin) {
    case "sequence":
      // The reference's PRECEDES/SUCCEEDS also carry a `sequence_index`, a position in
      // its in-memory node list with no counterpart here.
      return relation === "temporally_close"
        ? { sub_type: subType, time_diff_hours: seconds / 3600, weight: 1 / (1 + seconds / 3600) }
        : { sub_type: subType };
    case "magma":
      return proposal.graph === "temporal"
        ? { sub_type: subType, time_delta: seconds }
        : { sub_type: subType, similarity_score: confidence ?? 0 };
    case "consolidation":
      return { sub_type: subType, probability: weight };
    default:
      return { sub_type: subType, confidence: weight, probability: weight };
  }
}

export function traversalRequest(query: string, evidence: JevNode[], proposals: Proposal[], temporal: boolean): DecideRequest | undefined {
  if (proposals.length === 0) return undefined;
  const questions: Record<string, Question> = {};
  proposals.forEach((_proposal, index) => {
    for (const [field, question] of Object.entries(traversalQuestions(index))) questions[`candidate_${index}_${field}`] = question;
  });
  const cap = contentCap(evidence.length + proposals.length);
  return {
    version: 1,
    binding: "memory.read.score",
    state: {
      query,
      evidence: evidence.map((node) => nodeState(node, { temporal, cap })),
      candidates: proposals.map((proposal) => ({
        ...nodeState(proposal.node, { temporal, cap }),
        relation: relationProperties(proposal),
        graph: proposal.graph,
        source_id: proposal.edge.sourceId,
        target_id: proposal.edge.targetId,
      })),
    },
    questions,
  };
}

export type TraversalValues = Record<(typeof TRAVERSAL_FIELDS)[number], number>;

/** Validated traversal values per proposal, or the reference's defaults when the call fell back. */
export function traversalValues(answers: Record<string, Answer> | undefined, similarities: number[]): TraversalValues[] {
  const ids = similarities.flatMap((_similarity, index) => TRAVERSAL_FIELDS.map((field) => `candidate_${index}_${field}`));
  const values = noulValues(answers, ids);
  return similarities.map((similarity, index) => values
    ? Object.fromEntries(TRAVERSAL_FIELDS.map((field) => [field, values[`candidate_${index}_${field}`]])) as TraversalValues
    : { relevance: similarity, relation_usefulness: 0.5, new_information: 0.5, supports_current_evidence: 0.5 });
}

/** Eq. 23 with the reference's component order and weights. */
export function transitionScore(values: TraversalValues, similarity: number, need: number, structural: number, weights: readonly number[] = JEV_MEM_PROFILE.transitionWeights): number {
  const components = [
    similarity,
    values.relevance,
    need * values.relation_usefulness,
    values.new_information,
    (structural + values.supports_current_evidence) / 2,
  ];
  return sum(components.map((component, index) => weights[index] * component)) / sum([...weights]);
}

/** Eqs. 24–25, with τ* the newest observation time among the evidence gathered so far. */
export function recencyAdjusted(score: number, recencyImportance: number, candidateAt: number | undefined, newestObservedAt: number | undefined): number {
  if (candidateAt === undefined || newestObservedAt === undefined) return score;
  const recency = 1 / (1 + Math.max(0, newestObservedAt - candidateAt) / 1000 / DAY_SECONDS);
  return (score + 0.1 * recencyImportance * recency) / (1 + 0.1 * recencyImportance);
}

/** `cosine` from the reference: clipped to [0, 1], 0 when either vector is missing. */
export function clippedCosine(left: number[] | undefined, right: number[] | undefined): number {
  if (!left || !right || left.length !== right.length) return 0;
  let dot = 0; let aa = 0; let bb = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    aa += left[index] * left[index];
    bb += right[index] * right[index];
  }
  const norm = Math.sqrt(aa) * Math.sqrt(bb);
  return norm ? Math.min(1, Math.max(0, dot / norm)) : 0;
}

/** Eq. 16 (`_rrf_fusion`): Σ 1 / (κ + rank). A single list keeps its own order. */
export function reciprocalRankFusion<T extends { id: string }>(lists: T[][], k: number = JEV_MEM_PROFILE.rrfK): T[] {
  if (lists.every((list) => list.length === 0)) return [];
  if (lists.length === 1) return [...lists[0]];
  const scores = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const existing = scores.get(item.id);
      scores.set(item.id, { item: existing?.item ?? item, score: (existing?.score ?? 0) + 1 / (k + rank + 1) });
    });
  }
  // Python's `sorted` is stable, so equal scores keep first-seen order.
  return [...scores.values()].sort((a, b) => b.score - a.score).map(({ item }) => item);
}

// ---------------------------------------------------------------------------

function sum(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
