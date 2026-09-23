import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Answer, Question } from "../src/main/engine/decision/protocol.ts";
import { buildJevBody } from "../src/main/engine/decision/backends/jev.ts";
import {
  JEV_MEM_PROFILE,
  allocateBudget,
  baselineNeeds,
  consolidationPlan,
  consolidationRequest,
  contentCap,
  describeReferences,
  extractEntities,
  extractKeywords,
  isTemporalQuestion,
  narrative,
  rankCandidates,
  reciprocalRankFusion,
  recencyAdjusted,
  relationEdges,
  relationRequest,
  routeFrom,
  routingRequest,
  stopDecision,
  stoppingRequest,
  temporalEdges,
  transitionScore,
  traversalDepth,
  traversalRequest,
  traversalValues,
  typingRequest,
  MEMORY_TYPE_QUESTIONS,
  eventExtractionPrompt,
  magmaSemanticEdges,
  magmaTemporalEdges,
  parseEventExtraction,
  simpleExtractEvent,
  type JevNode,
  type Proposal,
} from "../src/main/engine/memory-jev.ts";

/**
 * Jev-Mem as FastVibe runs it, pinned to the reference implementation
 * (github.com/libingzheren/Jev-Mem @ 81574eb). `fixtures/jev-mem-reference.json` is the
 * reference's own output — question texts, budget allocation, temporal references,
 * keywords, entities, and the fallback write's extraction prompt and simple rules —
 * produced by running its Python modules; a change here that
 * breaks parity is a change away from the paper's implementation.
 */

const reference = JSON.parse(readFileSync(new URL("./fixtures/jev-mem-reference.json", import.meta.url), "utf8"));

const node = (id: string, entities: string[] = [], createdAt = 0, content = "x"): JevNode => ({ id, content, createdAt, entities });
const noul = (value: number): Answer => ({ type: "noul", noul: value });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function wire(questions: Record<string, Question>, prefix = ""): Record<string, unknown> {
  return Object.fromEntries(Object.entries(questions)
    .filter(([id]) => id.startsWith(prefix))
    .map(([id, question]) => [id.slice(prefix.length), {
      type: question.type,
      instructions: question.instructions,
      ...("criteria" in question && question.criteria ? { criteria: question.criteria } : {}),
    }]));
}

function proposal(id: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    node: node(id),
    edge: { sourceId: "p", targetId: id, view: "semantic", relation: "related", weight: 0.7 },
    graph: "semantic",
    structural: 0.7,
    parentId: "p",
    parentCreatedAt: 0,
    ...overrides,
  };
}

test("question texts and criteria match jev_questions.py", () => {
  const questions = reference.questions;
  assert.deepEqual(wire(MEMORY_TYPE_QUESTIONS), questions.type);
  assert.deepEqual(wire(relationRequest(node("n", ["A"]), [node("c", ["B"])])!.questions, "pair_0_"), questions.relation0);
  const exact = relationRequest(node("n", ["A"]), [node("a"), node("b"), node("c"), node("d", ["A"])])!;
  assert.deepEqual(wire(exact.questions, "pair_3_"), questions.relation3_exact);
  assert.deepEqual(wire(consolidationRequest(node("n"), [node("a"), node("b")])!.questions, "pair_1_"), questions.consolidation1);
  assert.deepEqual(wire(routingRequest("q").questions), questions.routing);
  assert.deepEqual(wire(stoppingRequest("q", [], 0, false).questions), questions.stopping);
  assert.deepEqual(wire(traversalRequest("q", [], [proposal("a"), proposal("b"), proposal("c")], false)!.questions, "candidate_2_"), questions.traversal2);
});

test("budget allocation matches allocate_graph_budgets, ties and all", () => {
  const needs = [[0.9, 0.05, 0.4, 0.1], [0.7, 0.8, 0.2, 0.6], [0.3, 0.3, 0.3, 0.3], [0.99, 0.0, 0.12, 0.11], [0.05, 0.02, 0.0, 0.09], [0.61, 0.37, 0.83, 0.29]];
  assert.deepEqual(needs.map(([semantic, temporal, causal, entity]) => allocateBudget({ semantic, temporal, causal, entity })), reference.budgets);
});

test("temporal references, keywords and entities match the reference parsers", () => {
  const base = new Date(2024, 4, 16, 10, 0).getTime();
  const texts = [
    "I bought a new bicycle yesterday because my old one broke.",
    "We met last night and again last Friday.",
    "Next monday I start; three weeks ago I quit. This past weekend was fun.",
    "It happened 2 months ago, not last year, maybe this week or next weekend.",
    "Sun is out today, tomorrow too, and last month too.",
  ];
  assert.deepEqual(texts.map((text) => describeReferences(text, base)), reference.refs);
  const turns = [
    "[Caroline]: I went to the LGBTQ support group yesterday and it was so powerful.",
    "[Melanie]: Wow, Caroline! That's great. In May 2023 at 10:30 am on 5/7 we painted a lake sunrise, lake sunrise again.",
    "Hello There. The Quick Brown Fox met Jean Luc in Paris. I'm Mira and I'm happy.",
  ];
  assert.deepEqual(turns.map((turn) => extractKeywords(turn)), reference.keywords);
  assert.deepEqual(turns.map((turn) => extractEntities(turn)), reference.entities);
});

test("FastVibe's Chinese extensions resolve with the same rules", () => {
  const base = new Date(2024, 4, 16, 10, 0).getTime();
  assert.deepEqual(describeReferences("我昨天买了新自行车，3 天前还在修旧的，上个月也坏过", base).map((ref) => ref.normalized), ["15 May 2024", "April 2024", "13 May 2024"]);
  assert.deepEqual(describeReferences("上周一见过", base), []);
  assert.deepEqual(extractEntities("我们在「西湖」见了“张三”"), ["西湖", "张三"]);
  assert.ok(extractKeywords("自行车坏了，买了新自行车").includes("自行"));
  assert.equal(isTemporalQuestion("我什么时候买的自行车？"), true);
  assert.equal(isTemporalQuestion("When did Mira buy a bicycle?"), true);
  assert.equal(isTemporalQuestion("Why did Mira buy a bicycle?"), false);
});

test("the profile is config/jev_mem.json over JevMemConfig defaults", () => {
  assert.deepEqual(
    { ...JEV_MEM_PROFILE, transitionWeights: [...JEV_MEM_PROFILE.transitionWeights] },
    {
      relationThreshold: 0.6, candidateTopK: 10, anchorCount: 30, totalGraphBudget: 80, probabilityExponent: 1,
      minimumGraphBudget: 1, graphActivationThreshold: 0.1, beamWidth: 10, maximumDepth: 8, maximumNodes: 60,
      maximumEdges: 2400, maximumJevCalls: 16, maxLatencyMs: 15_000, evidenceSufficientThreshold: 0.95,
      continueThreshold: 0.15, consolidationInterval: 20, consolidationThreshold: 0.85,
      transitionWeights: [0.25, 0.35, 0.15, 0.15, 0.1], timeoutMs: 3_000, maxRetries: 2, cacheSize: 1024, rrfK: 60,
    },
  );
});

test("typing asks four Nouls over the observation narrative; nothing is ever rejected", () => {
  const request = typingRequest(narrative("user", "I prefer dark mode."));
  assert.deepEqual(request.state, { observation: "[user]: I prefer dark mode." });
  assert.deepEqual(Object.keys(request.questions), ["episodic", "semantic", "procedural", "preference"]);
  assert.equal(narrative("summary", "A pattern."), "A pattern.");
});

test("find_candidates: 2·cos (vector hits) + 2·entity + keyword overlap + time proximity", () => {
  const newest = { ...node("n", ["Mira"], 10 * DAY), keywords: ["bicycle", "broke", "new"] };
  const pool = [
    { ...node("vector", [], 10 * DAY), keywords: [] }, // 2·0.9 + 0.25
    { ...node("entity", ["Mira"], 9 * DAY), keywords: ["bicycle"] }, // 2 + 1/3 + 0.125
    { ...node("words", [], 0), keywords: ["bicycle", "broke", "new"] }, // 1 + 0.25/11
    { ...node("n", ["Mira"], 10 * DAY), keywords: ["bicycle"] }, // itself
  ];
  const ranked = rankCandidates(newest, pool, new Map([["vector", 0.9]]), 3);
  assert.deepEqual(ranked.map((candidate) => candidate.id), ["entity", "vector", "words"]);
});

test("relations: Nouls at θ = 0.60, exact identifiers link at 1.0, alias only without them", () => {
  const n = node("n", ["Mira", "bicycle"]);
  const exact = node("m1", ["Mira"]);
  const other = node("m2", ["Bike"]);
  const request = relationRequest(n, [exact, other])!;
  assert.ok(!("pair_0_entity" in request.questions));
  assert.ok("pair_1_entity" in request.questions);
  assert.deepEqual(Object.keys(request.state as object), ["new_memory", "candidates"]);

  const answers = {
    pair_0_semantic: noul(0.6), pair_0_causes: noul(0.1), pair_0_caused_by: noul(0.91),
    pair_1_semantic: noul(0.59), pair_1_causes: noul(0.7), pair_1_caused_by: noul(0), pair_1_entity: noul(0.61),
  };
  const edges = relationEdges(n, [exact, other], answers)!;
  assert.deepEqual(edges.map((edge) => `${edge.sourceId}>${edge.targetId}:${edge.view}:${edge.relation}:${edge.weight}`), [
    "n>m1:semantic:related:0.6",
    "m1>n:causal:causes:0.91",
    "n>m1:entity:same_entity:1",
    "n>m2:causal:causes:0.7",
    "n>m2:entity:same_entity:0.61",
  ]);
  // A batch that did not validate completely falls back: no Jev edge at all.
  assert.equal(relationEdges(n, [exact, other], { pair_0_semantic: noul(0.9) }), undefined);
  assert.deepEqual(relationEdges(n, [], undefined), []);
});

test("temporal links are MAGMA's: predecessor pair plus TEMPORALLY_CLOSE within 24 h", () => {
  const peers = Array.from({ length: 12 }, (_unused, index) => node(`p${index}`, [], index * 6 * HOUR));
  const edges = temporalEdges(peers);
  assert.deepEqual(edges.slice(0, 2).map((edge) => `${edge.sourceId}>${edge.targetId}:${edge.relation}`), ["p10>p11:before", "p11>p10:after"]);
  // Only the nine nodes before the newest are looked at, and only those within 24 h link.
  assert.deepEqual(edges.slice(2).map((edge) => edge.sourceId), ["p7", "p8", "p9", "p10"]);
  assert.ok(edges.every((edge) => edge.weight === 0.5 && edge.view === "temporal" && edge.origin === "sequence"));
  assert.deepEqual(temporalEdges([node("only")]), []);
});

test("consolidation: one semantic link per pair at 0.85, obsolete is a decision only, gated System Two", () => {
  const n = node("n");
  const candidates = [node("a"), node("b"), node("c"), node("d")];
  const distribution = (choice: string, p: number) => {
    const rest = (1 - p) / 3;
    return Object.fromEntries(["keep_separate", "merge", "promote", "uncertain"].map((key) => [key, key === choice ? p : rest]));
  };
  const answers: Record<string, Answer> = {};
  const pair = (index: number, values: [number, number, number, number], choice: string, p: number) => {
    const [redundant, contradiction, obsolete, link] = values;
    Object.assign(answers, {
      [`pair_${index}_redundant`]: noul(redundant), [`pair_${index}_contradiction`]: noul(contradiction),
      [`pair_${index}_obsolete`]: noul(obsolete), [`pair_${index}_link`]: noul(link),
      [`pair_${index}_representation`]: { type: "choice", choice, probabilities: distribution(choice, p) },
    });
  };
  pair(0, [0.9, 0.1, 0.95, 0.2], "merge", 0.9); // redundant link, merge approved
  pair(1, [0.9, 0.9, 0.1, 0.9], "promote", 0.95); // contradiction wins; no summary
  pair(2, [0.1, 0.1, 0.99, 0.84], "promote", 0.84); // below 0.85: no link, no summary
  pair(3, [0.1, 0.1, 0.1, 0.86], "promote", 0.86); // related link, promote approved
  const plan = consolidationPlan(n, candidates, answers)!;
  assert.deepEqual(plan.edges.map((edge) => `${edge.targetId}:${edge.relation}:${edge.weight}`), ["a:duplicates:0.9", "b:contradicts:0.9", "d:related:0.86"]);
  // Its own origin, so a consolidation RELATED_TO sits beside the write-time one.
  assert.ok(plan.edges.every((edge) => edge.origin === "consolidation"));
  assert.deepEqual(plan.summaries.map(({ candidate, action }) => `${candidate.id}:${action}`), ["a:merge", "d:promote"]);
  assert.equal(plan.decisions.length, 4);
  assert.equal(plan.decisions[2].obsolete, 0.99);
  assert.equal(consolidationPlan(n, candidates, { pair_0_redundant: noul(1) }), undefined);
});

test("routing: all six Nouls, or the reference's intent baseline", () => {
  const answers = Object.fromEntries(["semantic", "temporal", "causal", "entity", "multi_hop_need", "recency_importance"].map((id, index) => [id, noul(index / 10)]));
  assert.deepEqual(routeFrom(answers, "q"), { needs: { semantic: 0, temporal: 0.1, causal: 0.2, entity: 0.3 }, multiHop: 0.4, recency: 0.5 });
  assert.deepEqual(routeFrom(undefined, "Why did Mira buy a bicycle?"), baselineNeeds("Why did Mira buy a bicycle?"));
  assert.deepEqual(baselineNeeds("When did it happen?").needs, { semantic: 0.7, temporal: 0.8, causal: 0.2, entity: 0.6 });
  assert.deepEqual(baselineNeeds("为什么换了自行车").needs.causal, 0.8);
  assert.deepEqual(routingRequest("q").state, { query: "q" });
});

test("Eq. 15 depth", () => {
  assert.deepEqual([0, 0.3, 0.5, 1].map((h) => traversalDepth(h)), [1, 3, 4, 8]);
});

test("stopping (Eqs. 21–22) needs the whole batch", () => {
  const values = (sufficient: number, useful: number, missing: number, contradiction: number) => ({
    evidence_sufficient: noul(sufficient), continue_useful: noul(useful), missing_evidence: noul(missing), contradiction: noul(contradiction),
  });
  assert.equal(stopDecision(values(0.95, 0.9, 0.14, 0.14)), "evidence_sufficient");
  assert.equal(stopDecision(values(0.95, 0.9, 0.15, 0.1)), undefined);
  assert.equal(stopDecision(values(0.2, 0.14, 0.9, 0.9)), "further_retrieval_unhelpful");
  assert.equal(stopDecision({ evidence_sufficient: noul(1) }), undefined);
  assert.deepEqual(Object.keys(stoppingRequest("q", [node("e")], 2, false).state as object), ["query", "evidence", "depth"]);
});

test("traversal: reference defaults on fallback, Eq. 23 weights, recency against newest evidence", () => {
  assert.deepEqual(traversalValues(undefined, [0.4]), [{ relevance: 0.4, relation_usefulness: 0.5, new_information: 0.5, supports_current_evidence: 0.5 }]);
  const values = { relevance: 1, relation_usefulness: 0.5, new_information: 0.5, supports_current_evidence: 0.6 };
  assert.ok(Math.abs(transitionScore(values, 0.5, 0.8, 0.4) - (0.25 * 0.5 + 0.35 * 1 + 0.15 * 0.4 + 0.15 * 0.5 + 0.1 * 0.5)) < 1e-12);
  assert.equal(recencyAdjusted(0.5, 1, 10 * DAY, undefined), 0.5);
  assert.ok(Math.abs(recencyAdjusted(0.5, 1, 9 * DAY, 10 * DAY) - (0.5 + 0.05) / 1.1) < 1e-12);

  const temporal = proposal("t", {
    node: node("t", [], 3 * HOUR),
    edge: { sourceId: "p", targetId: "t", view: "temporal", relation: "temporally_close", origin: "sequence", weight: 0.5 },
    graph: "temporal",
    structural: 0.5,
  });
  const state = traversalRequest("when?", [node("p")], [proposal("s"), temporal], true)!.state as { candidates: Array<Record<string, unknown>> };
  assert.deepEqual(state.candidates[0].relation, { sub_type: "RELATED_TO", confidence: 0.7, probability: 0.7 });
  assert.deepEqual(state.candidates[1].relation, { sub_type: "TEMPORALLY_CLOSE", time_diff_hours: 3, weight: 0.25 });
  assert.equal(state.candidates[1].graph, "temporal");
  assert.equal(state.candidates[1].timestamp_role, "observation_time; not necessarily the event date");
});

test("RRF keeps a single list's order and fuses several by 1/(60 + rank)", () => {
  const a = { id: "a" }, b = { id: "b" }, c = { id: "c" }, d = { id: "d" };
  assert.deepEqual(reciprocalRankFusion([[a, b, c], [b, d, a]]).map((item) => item.id), ["b", "a", "d", "c"]);
  assert.deepEqual(reciprocalRankFusion([[c, a]]).map((item) => item.id), ["c", "a"]);
  assert.deepEqual(reciprocalRankFusion([[], [d]]).map((item) => item.id), ["d"]);
});

test("FastVibe's content cap keeps a batch under Jev's state limit", () => {
  assert.equal(contentCap(1), 12_000);
  assert.equal(contentCap(11), 1_636);
  assert.equal(contentCap(200), 300);
  const long = node("n", [], 0, "y".repeat(20_000));
  const state = relationRequest(long, Array.from({ length: 10 }, (_unused, index) => ({ ...long, id: `c${index}` })))!.state as { new_memory: { content: string } };
  assert.equal(state.new_memory.content.length, 1_636);
});

test("the Jev body carries a Noul's true/false criteria", () => {
  const body = buildJevBody(typingRequest("[user]: hi")) as { questions: Record<string, { criteria?: { true?: string; false?: string } }> };
  assert.deepEqual(body.questions.episodic.criteria, MEMORY_TYPE_QUESTIONS.episodic.criteria);
});

test("fallback extraction: the reference's prompt verbatim and its simple rules", () => {
  const fallback = reference.fallback;
  assert.equal(eventExtractionPrompt("CONTENT"), fallback.extractionPrompt.replace("{content}", "CONTENT"));
  const texts = [
    "[Caroline]: I went to the LGBTQ support group yesterday and it was so powerful.",
    "Hello There. Mira met Jean in Paris; Mira laughed." + " filler".repeat(100),
  ];
  texts.forEach((text, index) => {
    const simple = simpleExtractEvent(text);
    const expected = fallback.simple[index];
    assert.equal(simple.narrative, expected.content_narrative);
    assert.deepEqual(simple.keywords, expected.keywords);
    // The reference collects entities through a set; only membership is defined.
    assert.deepEqual([...simple.entities].sort(), expected.entities);
  });
});

test("fallback extraction reads the model's JSON as _extract_event does", () => {
  assert.deepEqual(parseEventExtraction('```json\n{"content_narrative":"Mira bought a bike.","entities":["Mira",3],"keywords":["bike"],"emotion":"happy"}\n```', "raw"), {
    narrative: "Mira bought a bike.", entities: ["Mira"], keywords: ["bike"], emotion: "happy",
  });
  assert.deepEqual(parseEventExtraction('{"entities":[]}', "raw"), { narrative: "raw", entities: [], keywords: [], emotion: null });
  assert.equal(parseEventExtraction("not json", "raw"), undefined);
});

test("fallback links: predecessor in time, and both ways with the three nearest", () => {
  const n = node("n", [], 2 * HOUR);
  assert.deepEqual(magmaTemporalEdges(node("p", [], HOUR), n).map((edge) => `${edge.sourceId}>${edge.targetId}:${edge.relation}:${edge.origin}`), ["p>n:before:magma", "n>p:after:magma"]);
  assert.deepEqual(magmaTemporalEdges(undefined, n), []);
  const nearest = [{ id: "a", similarity: 0.9 }, { id: "n", similarity: 1 }, { id: "b", similarity: 0.8 }, { id: "c", similarity: 0.7 }, { id: "d", similarity: 0.6 }];
  const semantic = magmaSemanticEdges(n, nearest);
  assert.deepEqual(semantic.map((edge) => `${edge.sourceId}>${edge.targetId}`), ["n>a", "a>n", "n>b", "b>n", "n>c", "c>n"]);
  assert.ok(semantic.every((edge) => edge.view === "semantic" && edge.relation === "related" && edge.origin === "magma" && edge.weight === 0.5));
  assert.equal(semantic[0].confidence, 0.9);
});

test("traversal shows each link with the properties its stage gives it", () => {
  const at = (origin: "jev" | "sequence" | "consolidation" | "magma", view: "semantic" | "temporal", relation: "related" | "before", weight: number, confidence?: number) => proposal("x", {
    node: node("x", [], 3 * HOUR),
    edge: { sourceId: "p", targetId: "x", view, relation, origin, weight, ...(confidence === undefined ? {} : { confidence }) },
    graph: view,
    structural: weight,
  });
  const state = traversalRequest("q", [node("p")], [
    at("jev", "semantic", "related", 0.7),
    at("consolidation", "semantic", "related", 0.9),
    at("magma", "semantic", "related", 0.5, 0.83),
    at("magma", "temporal", "before", 0.5),
    at("sequence", "temporal", "before", 0.5),
  ], false)!.state as { candidates: Array<{ relation: unknown }> };
  assert.deepEqual(state.candidates.map((candidate) => candidate.relation), [
    { sub_type: "RELATED_TO", confidence: 0.7, probability: 0.7 },
    { sub_type: "RELATED_TO", probability: 0.9 },
    { sub_type: "RELATED_TO", similarity_score: 0.83 },
    { sub_type: "PRECEDES", time_delta: 10_800 },
    { sub_type: "PRECEDES" },
  ]);
});
