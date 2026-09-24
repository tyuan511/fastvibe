import type { MemoryRelationView } from "@shared/memory";

export type TemporalReference = { original: string; normalized: string; precision: string; anchor_date: string };

// ---------------------------------------------------------------------------
// Temporal references (`TemporalParser.describe_references`)

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

