# Bifrost spike

P0 prototype for `/llm` (docs/cloud-service.md → 动手前的原型验证). It puts Bifrost's own
OpenAI / Anthropic / Gemini HTTP integrations behind FastVibe's `/llm` paths and logs the
usage of every attempt — Bifrost's normalized numbers, the five billable counts we derive
from them, and the usage objects the upstream itself sent — to `usage.jsonl`.

It is a separate Go module so Bifrost's dependency tree stays out of `services/cloud`
until the real `/llm` is built on it.

```
client ─▶ gateway (ours: auth, model → upstream/model + fallbacks, strip x-bf-* and credentials)
        ─▶ Bifrost integration router (/openai, /anthropic, /genai)
        ─▶ Bifrost core ─▶ upstream
                       └▶ usage plugin (PostLLMHook, once per attempt) ─▶ usage.jsonl
```

## Offline checks

```bash
go test -race ./...
```

Fake upstreams speak each wire format and record what they were sent, so these pin
field fidelity in both directions and the billable counts:

| Test | P0 check | Result |
| --- | --- | --- |
| `TestResponsesToOpenAIKeepsFields` | 1 | `encrypted_content`, `previous_response_id`, `prompt_cache_key`, `reasoning` reach OpenAI; `encrypted_content` comes back |
| `TestUnknownOpenAIModelNameLosesReasoning` | 1 | **for a model name Bifrost does not recognise as reasoning, it drops `reasoning` and `encrypted_content`** |
| `TestMessagesToAnthropicKeepsFields` | 3 | thinking signatures, `cache_control` (with `ttl`) survive both ways; cache writes split 5m / 1h |
| `TestResponsesToAnthropicConverts` | 2 | Responses → Anthropic answers in Responses format, billed on Anthropic usage |
| `TestFallbackBeforeFirstByte` | 4 | a 500 before any output falls over to the next candidate; only that attempt is billed |
| `TestClientDisconnectMidStream` | 5 | a hang-up yields an `aborted` record with the input already consumed; output so far is **not** counted |
| `TestUpstreamChangeWithoutRestart` | 6 | `UpdateProvider` after an account change moves traffic without a restart |
| `TestGatewayRefusesAndStrips` | — | no token → 401, unknown model → 404, client `x-bf-*` headers never reach Bifrost or the upstream |

## Against real upstreams

The offline run proves Bifrost handles the shapes we wrote, not the shapes vendors
send. Before `/llm` takes real traffic, run the same requests against real keys and
compare `bifrost_usage` with `upstream_usage` in `usage.jsonl`:

```bash
cp spike.example.json spike.json        # edit models to what your keys can reach
export OPENAI_API_KEY=... ANTHROPIC_API_KEY=... GEMINI_API_KEY=...
go run . -config spike.json
```

```bash
curl -sN http://127.0.0.1:8090/llm/v1/responses \
  -H 'Authorization: Bearer local-dev-token' -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.5","stream":true,"input":"hi","reasoning":{"effort":"low"}}'
```

Cover, per upstream: plain, cache hit (send the same long prompt twice), cache write
5m and 1h (Anthropic `cache_control.ttl`), reasoning, image input, tool call, streaming
and not, and a hang-up mid-stream.
