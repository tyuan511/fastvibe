package main

// Offline checks of the P0 questions against fake upstreams that speak the real wire
// formats. They pin what Bifrost does with the fields FastVibe depends on and what it
// reports as usage. They do not replace the run against real upstreams (README.md):
// a fake only proves Bifrost handles the shape we wrote, not the shape a vendor sends.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const token = "test-session-token"

// fakeUpstream records the last request body per path and answers with canned SSE.
type fakeUpstream struct {
	*httptest.Server
	mu     sync.Mutex
	bodies map[string][]byte
	hits   map[string]int
}

func newFakeUpstream(t *testing.T, handle func(w http.ResponseWriter, r *http.Request, body []byte)) *fakeUpstream {
	f := &fakeUpstream{bodies: map[string][]byte{}, hits: map[string]int{}}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.bodies[r.URL.Path] = body
		f.hits[r.URL.Path]++
		f.mu.Unlock()
		handle(w, r, body)
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeUpstream) body(path string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return string(f.bodies[path])
}

func sse(w http.ResponseWriter, events ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	for _, e := range events {
		_, _ = io.WriteString(w, e)
		if flusher != nil {
			flusher.Flush()
		}
	}
}

func event(name string, data any) string {
	b, _ := json.Marshal(data)
	if name == "" {
		return fmt.Sprintf("data: %s\n\n", b)
	}
	return fmt.Sprintf("event: %s\ndata: %s\n\n", name, b)
}

// openAIResponses answers /v1/responses with a reasoning item carrying
// encrypted_content, one line of text, and usage with cache hits and reasoning.
func openAIResponses(w http.ResponseWriter, r *http.Request, body []byte) {
	if r.URL.Path != "/v1/responses" {
		http.Error(w, "unexpected path "+r.URL.Path, http.StatusNotFound)
		return
	}
	reasoning := map[string]any{"type": "reasoning", "id": "rs_out", "summary": []any{}, "encrypted_content": "ENC_FROM_UPSTREAM"}
	message := map[string]any{"type": "message", "id": "msg_out", "role": "assistant", "status": "completed",
		"content": []any{map[string]any{"type": "output_text", "text": "hello", "annotations": []any{}}}}
	usage := map[string]any{
		"input_tokens": 1000, "input_tokens_details": map[string]any{"cached_tokens": 800},
		"output_tokens": 50, "output_tokens_details": map[string]any{"reasoning_tokens": 30},
		"total_tokens": 1050,
	}
	resp := func(status string, output []any, u any) map[string]any {
		m := map[string]any{"id": "resp_out", "object": "response", "created_at": 1, "model": "gpt-test",
			"status": status, "output": output}
		if u != nil {
			m["usage"] = u
		}
		return m
	}
	if !bytes.Contains(body, []byte(`"stream":true`)) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp("completed", []any{reasoning, message}, usage))
		return
	}
	sse(w,
		event("response.created", map[string]any{"type": "response.created", "sequence_number": 0, "response": resp("in_progress", []any{}, nil)}),
		event("response.output_item.added", map[string]any{"type": "response.output_item.added", "sequence_number": 1, "output_index": 0,
			"item": map[string]any{"type": "reasoning", "id": "rs_out", "summary": []any{}}}),
		event("response.output_item.done", map[string]any{"type": "response.output_item.done", "sequence_number": 2, "output_index": 0, "item": reasoning}),
		event("response.output_item.added", map[string]any{"type": "response.output_item.added", "sequence_number": 3, "output_index": 1,
			"item": map[string]any{"type": "message", "id": "msg_out", "role": "assistant", "status": "in_progress", "content": []any{}}}),
		event("response.content_part.added", map[string]any{"type": "response.content_part.added", "sequence_number": 4, "item_id": "msg_out",
			"output_index": 1, "content_index": 0, "part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}}),
		event("response.output_text.delta", map[string]any{"type": "response.output_text.delta", "sequence_number": 5, "item_id": "msg_out",
			"output_index": 1, "content_index": 0, "delta": "hello"}),
		event("response.output_text.done", map[string]any{"type": "response.output_text.done", "sequence_number": 6, "item_id": "msg_out",
			"output_index": 1, "content_index": 0, "text": "hello"}),
		event("response.content_part.done", map[string]any{"type": "response.content_part.done", "sequence_number": 7, "item_id": "msg_out",
			"output_index": 1, "content_index": 0, "part": map[string]any{"type": "output_text", "text": "hello", "annotations": []any{}}}),
		event("response.output_item.done", map[string]any{"type": "response.output_item.done", "sequence_number": 8, "output_index": 1, "item": message}),
		event("response.completed", map[string]any{"type": "response.completed", "sequence_number": 9,
			"response": resp("completed", []any{reasoning, message}, usage)}),
	)
}

// anthropicMessages answers /v1/messages with a signed thinking block, text, and
// usage that splits cache writes into 5-minute and 1-hour.
func anthropicMessages(w http.ResponseWriter, r *http.Request, body []byte) {
	if r.URL.Path != "/v1/messages" {
		http.Error(w, "unexpected path "+r.URL.Path, http.StatusNotFound)
		return
	}
	startUsage := map[string]any{
		"input_tokens": 10, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 100,
		"cache_creation": map[string]any{"ephemeral_5m_input_tokens": 60, "ephemeral_1h_input_tokens": 40},
		"output_tokens":  1,
	}
	if !bytes.Contains(body, []byte(`"stream":true`)) {
		final := map[string]any{}
		for k, v := range startUsage {
			final[k] = v
		}
		final["output_tokens"] = 70
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-test",
			"content": []any{
				map[string]any{"type": "thinking", "thinking": "let me think", "signature": "SIG_FROM_UPSTREAM"},
				map[string]any{"type": "text", "text": "hello"},
			},
			"stop_reason": "end_turn", "usage": final,
		})
		return
	}
	sse(w,
		event("message_start", map[string]any{"type": "message_start", "message": map[string]any{
			"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-test", "content": []any{},
			"stop_reason": nil, "usage": startUsage}}),
		event("content_block_start", map[string]any{"type": "content_block_start", "index": 0,
			"content_block": map[string]any{"type": "thinking", "thinking": "", "signature": ""}}),
		event("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "thinking_delta", "thinking": "let me think"}}),
		event("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "signature_delta", "signature": "SIG_FROM_UPSTREAM"}}),
		event("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0}),
		event("content_block_start", map[string]any{"type": "content_block_start", "index": 1,
			"content_block": map[string]any{"type": "text", "text": ""}}),
		event("content_block_delta", map[string]any{"type": "content_block_delta", "index": 1,
			"delta": map[string]any{"type": "text_delta", "text": "hello"}}),
		event("content_block_stop", map[string]any{"type": "content_block_stop", "index": 1}),
		event("message_delta", map[string]any{"type": "message_delta",
			"delta": map[string]any{"stop_reason": "end_turn", "stop_sequence": nil},
			"usage": map[string]any{"output_tokens": 70}}),
		event("message_stop", map[string]any{"type": "message_stop"}),
	)
}

type harness struct {
	url      string
	usageLog string
	spike    *spike
}

func startSpike(t *testing.T, upstreams []UpstreamConfig, models map[string][]Route) *harness {
	t.Helper()
	dir := t.TempDir()
	cfg := &Config{UsageLog: filepath.Join(dir, "usage.jsonl"), Tokens: []string{token}, Upstream: upstreams, Models: models}
	for _, u := range upstreams {
		for _, env := range u.KeyEnv {
			t.Setenv(env, "sk-fake-"+u.Name)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	sp, err := newServer(ctx, cfg, log)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = sp.server.Serve(ln) }()
	t.Cleanup(func() {
		_ = sp.server.ShutdownWithContext(context.Background())
		sp.close()
		cancel()
	})
	return &harness{url: "http://" + ln.Addr().String(), usageLog: cfg.UsageLog, spike: sp}
}

func (h *harness) post(t *testing.T, path string, body any, headers map[string]string) (*http.Response, string) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, h.url+path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp, string(out)
}

// record waits for the usage line of a request; a stream's line lands after its last byte.
func (h *harness) record(t *testing.T, requestID string) UsageRecord {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if f, err := os.Open(h.usageLog); err == nil {
			scanner := bufio.NewScanner(f)
			scanner.Buffer(make([]byte, 1<<20), 1<<20)
			for scanner.Scan() {
				var rec UsageRecord
				if json.Unmarshal(scanner.Bytes(), &rec) == nil && rec.RequestID == requestID && rec.Status != "failed" {
					f.Close()
					return rec
				}
			}
			f.Close()
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("no usage record for %s", requestID)
	return UsageRecord{}
}

func expectBillable(t *testing.T, got, want Billable) {
	t.Helper()
	if got != want {
		t.Errorf("billable = %+v, want %+v", got, want)
	}
}

var openAIUpstream = func(base string) UpstreamConfig {
	return UpstreamConfig{Name: "openai", Type: "openai", BaseURL: base, KeyEnv: []string{"SPIKE_OPENAI_KEY"}}
}
var anthropicUpstream = func(base string) UpstreamConfig {
	return UpstreamConfig{Name: "anthropic", Type: "anthropic", BaseURL: base, KeyEnv: []string{"SPIKE_ANTHROPIC_KEY"}}
}

// The Responses request FastVibe sends after a reasoning turn: the previous
// reasoning item comes back as input, encrypted.
func responsesRequest(model string, stream bool) map[string]any {
	return map[string]any{
		"model":   model,
		"stream":  stream,
		"store":   false,
		"include": []string{"reasoning.encrypted_content"},
		"input": []any{
			map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "hi"}}},
			map[string]any{"type": "reasoning", "id": "rs_prev", "summary": []any{}, "encrypted_content": "ENC_FROM_CLIENT"},
			map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "again"}}},
		},
		"reasoning":            map[string]any{"effort": "high", "summary": "auto"},
		"prompt_cache_key":     "conv-123",
		"previous_response_id": "resp_prev",
	}
}

// Check 1 (Responses → OpenAI): what FastVibe depends on survives, both ways.
func TestResponsesToOpenAIKeepsFields(t *testing.T) {
	up := newFakeUpstream(t, openAIResponses)
	h := startSpike(t, []UpstreamConfig{openAIUpstream(up.URL)}, map[string][]Route{"gpt-x": {{Upstream: "openai", Model: "gpt-5.5"}}})

	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", stream), func(t *testing.T) {
			resp, out := h.post(t, "/llm/v1/responses", responsesRequest("gpt-x", stream), nil)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status %d: %s", resp.StatusCode, out)
			}
			sent := up.body("/v1/responses")
			for _, want := range []string{`"ENC_FROM_CLIENT"`, `"previous_response_id":"resp_prev"`, `"prompt_cache_key":"conv-123"`,
				`"reasoning.encrypted_content"`, `"model":"gpt-5.5"`, `"effort":"high"`} {
				if !strings.Contains(sent, want) {
					t.Errorf("upstream request lost %s\n%s", want, sent)
				}
			}
			if strings.Contains(sent, "fallbacks") {
				t.Errorf("our fallbacks field leaked upstream: %s", sent)
			}
			if !strings.Contains(out, "ENC_FROM_UPSTREAM") {
				t.Errorf("client response lost encrypted_content:\n%s", out)
			}
			rec := h.record(t, resp.Header.Get("x-fastvibe-request-id"))
			expectBillable(t, rec.Billable, Billable{Input: 200, CacheRead: 800, Output: 50, Reasoning: 30})
		})
	}
}

// Bifrost decides whether an OpenAI model reasons from its *name* (o1/o3/o4/gpt-5…)
// unless a model catalog says otherwise, and for a model it judges non-reasoning it
// drops both the reasoning parameter and replayed encrypted_content. A relay serving a
// reasoning model under another name would silently lose both. This pins the
// behaviour; the real service must supply capabilities from the models table
// (BifrostConfig.ModelCatalog) for every model it serves.
func TestUnknownOpenAIModelNameLosesReasoning(t *testing.T) {
	up := newFakeUpstream(t, openAIResponses)
	h := startSpike(t, []UpstreamConfig{openAIUpstream(up.URL)}, map[string][]Route{"gpt-x": {{Upstream: "openai", Model: "relay-model"}}})
	resp, out := h.post(t, "/llm/v1/responses", responsesRequest("gpt-x", false), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", resp.StatusCode, out)
	}
	sent := up.body("/v1/responses")
	if strings.Contains(sent, "ENC_FROM_CLIENT") || strings.Contains(sent, `"effort"`) {
		t.Fatalf("expected Bifrost to strip reasoning for an unrecognised name; it no longer does — revisit the catalog requirement\n%s", sent)
	}
}

// Check 3 (Messages → Anthropic): thinking signatures and cache_control survive, and
// cache writes are split by duration.
func TestMessagesToAnthropicKeepsFields(t *testing.T) {
	up := newFakeUpstream(t, anthropicMessages)
	h := startSpike(t, []UpstreamConfig{anthropicUpstream(up.URL)}, map[string][]Route{"claude-x": {{Upstream: "anthropic", Model: "claude-test"}}})

	request := func(stream bool) map[string]any {
		return map[string]any{
			"model": "claude-x", "max_tokens": 2048, "stream": stream,
			"thinking": map[string]any{"type": "enabled", "budget_tokens": 1024},
			"system": []any{map[string]any{"type": "text", "text": "be brief",
				"cache_control": map[string]any{"type": "ephemeral", "ttl": "1h"}}},
			"messages": []any{
				map[string]any{"role": "user", "content": "hi"},
				map[string]any{"role": "assistant", "content": []any{
					map[string]any{"type": "thinking", "thinking": "earlier thought", "signature": "SIG_FROM_CLIENT"},
					map[string]any{"type": "text", "text": "earlier answer"},
				}},
				map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "again",
					"cache_control": map[string]any{"type": "ephemeral"}}}},
			},
		}
	}
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", stream), func(t *testing.T) {
			resp, out := h.post(t, "/llm/v1/messages", request(stream), map[string]string{"anthropic-version": "2023-06-01"})
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status %d: %s", resp.StatusCode, out)
			}
			sent := up.body("/v1/messages")
			for _, want := range []string{`"SIG_FROM_CLIENT"`, `"earlier thought"`, `"ttl":"1h"`, `"cache_control"`, `"model":"claude-test"`} {
				if !strings.Contains(sent, want) {
					t.Errorf("upstream request lost %s\n%s", want, sent)
				}
			}
			if strings.Contains(sent, "fallbacks") {
				t.Errorf("our fallbacks field leaked upstream: %s", sent)
			}
			if !strings.Contains(out, "SIG_FROM_UPSTREAM") {
				t.Errorf("client response lost the thinking signature:\n%s", out)
			}
			rec := h.record(t, resp.Header.Get("x-fastvibe-request-id"))
			expectBillable(t, rec.Billable, Billable{Input: 10, CacheRead: 900, CacheWrite5m: 60, CacheWrite1h: 40, Output: 70})
		})
	}
}

// Check 2 (Responses → Anthropic): the cross-protocol path answers in Responses
// format and is billed on Anthropic's usage, cache split included.
func TestResponsesToAnthropicConverts(t *testing.T) {
	up := newFakeUpstream(t, anthropicMessages)
	h := startSpike(t, []UpstreamConfig{anthropicUpstream(up.URL)}, map[string][]Route{"claude-x": {{Upstream: "anthropic", Model: "claude-test"}}})

	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", stream), func(t *testing.T) {
			req := map[string]any{"model": "claude-x", "stream": stream, "max_output_tokens": 2048,
				"input":     []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "hi"}}}},
				"reasoning": map[string]any{"effort": "high"}}
			resp, out := h.post(t, "/llm/v1/responses", req, nil)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status %d: %s", resp.StatusCode, out)
			}
			if up.hits["/v1/messages"] == 0 {
				t.Fatal("the request never reached the Anthropic upstream")
			}
			if !strings.Contains(out, "hello") {
				t.Errorf("client response lost the text:\n%s", out)
			}
			if stream && !strings.Contains(out, "response.completed") {
				t.Errorf("stream did not end with response.completed:\n%s", out)
			}
			rec := h.record(t, resp.Header.Get("x-fastvibe-request-id"))
			expectBillable(t, rec.Billable, Billable{Input: 10, CacheRead: 900, CacheWrite5m: 60, CacheWrite1h: 40, Output: 70})
		})
	}
}

// Check 4: an upstream that fails before any output hands over to the next candidate.
func TestFallbackBeforeFirstByte(t *testing.T) {
	broken := newFakeUpstream(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `{"error":{"message":"upstream exploded","type":"server_error"}}`)
	})
	good := newFakeUpstream(t, openAIResponses)
	h := startSpike(t,
		[]UpstreamConfig{
			{Name: "relay-a", Type: "openai", BaseURL: broken.URL, KeyEnv: []string{"SPIKE_RELAY_A"}},
			{Name: "relay-b", Type: "openai", BaseURL: good.URL, KeyEnv: []string{"SPIKE_RELAY_B"}},
		},
		map[string][]Route{"gpt-x": {{Upstream: "relay-a", Model: "gpt-5.5"}, {Upstream: "relay-b", Model: "gpt-5.5"}}})

	resp, out := h.post(t, "/llm/v1/responses", responsesRequest("gpt-x", true), nil)
	if resp.StatusCode != http.StatusOK || !strings.Contains(out, "hello") {
		t.Fatalf("fallback did not answer: %d %s", resp.StatusCode, out)
	}
	if broken.hits["/v1/responses"] == 0 {
		t.Error("the first candidate was never tried")
	}
	rec := h.record(t, resp.Header.Get("x-fastvibe-request-id"))
	if rec.Provider != "relay-b" {
		t.Errorf("billed attempt was on %q, want relay-b", rec.Provider)
	}
	expectBillable(t, rec.Billable, Billable{Input: 200, CacheRead: 800, Output: 50, Reasoning: 30})
}

// The gateway, not Bifrost, decides who may call and with what: no token, no call;
// a client's own Bifrost control headers never take effect.
func TestGatewayRefusesAndStrips(t *testing.T) {
	var gotHeaders http.Header
	up := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		gotHeaders = r.Header.Clone()
		openAIResponses(w, r, body)
	})
	h := startSpike(t, []UpstreamConfig{openAIUpstream(up.URL)}, map[string][]Route{"gpt-x": {{Upstream: "openai", Model: "gpt-5.5"}}})

	raw, _ := json.Marshal(responsesRequest("gpt-x", false))
	req, _ := http.NewRequest(http.MethodPost, h.url+"/llm/v1/responses", bytes.NewReader(raw))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("no token: status %d", resp.StatusCode)
	}

	resp2, _ := h.post(t, "/llm/v1/responses", responsesRequest("nope", false), nil)
	if resp2.StatusCode != http.StatusNotFound {
		t.Errorf("unknown model: status %d", resp2.StatusCode)
	}

	resp3, out := h.post(t, "/llm/v1/responses", responsesRequest("gpt-x", false), map[string]string{
		"x-bf-eh-x-injected": "evil",
		"x-bf-direct-key":    "sk-attacker",
	})
	if resp3.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", resp3.StatusCode, out)
	}
	if gotHeaders.Get("x-injected") != "" {
		t.Error("a client x-bf-eh-* header reached the upstream")
	}
	if auth := gotHeaders.Get("Authorization"); auth != "Bearer sk-fake-openai" {
		t.Errorf("upstream saw Authorization %q, want the channel key", auth)
	}
}

// Check 6: pointing a channel somewhere else takes effect without a restart.
func TestUpstreamChangeWithoutRestart(t *testing.T) {
	first := newFakeUpstream(t, openAIResponses)
	second := newFakeUpstream(t, openAIResponses)
	h := startSpike(t, []UpstreamConfig{openAIUpstream(first.URL)}, map[string][]Route{"gpt-x": {{Upstream: "openai", Model: "gpt-5.5"}}})

	if resp, out := h.post(t, "/llm/v1/responses", responsesRequest("gpt-x", false), nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", resp.StatusCode, out)
	}
	h.spike.account.setBaseURL("openai", second.URL)
	if err := h.spike.client.UpdateProvider("openai"); err != nil {
		t.Fatalf("UpdateProvider: %v", err)
	}
	if resp, out := h.post(t, "/llm/v1/responses", responsesRequest("gpt-x", false), nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d after the change: %s", resp.StatusCode, out)
	}
	if first.hits["/v1/responses"] != 1 || second.hits["/v1/responses"] != 1 {
		t.Errorf("hits: first=%d second=%d, want 1 and 1", first.hits["/v1/responses"], second.hits["/v1/responses"])
	}
}

// Check 5: a client that hangs up mid-stream. Anthropic reports input usage in its
// first event, so what was consumed by then must reach the usage log.
func TestClientDisconnectMidStream(t *testing.T) {
	release := make(chan struct{})
	up := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		write := func(s string) { _, _ = io.WriteString(w, s); flusher.Flush() }
		write(event("message_start", map[string]any{"type": "message_start", "message": map[string]any{
			"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-test", "content": []any{},
			"usage": map[string]any{"input_tokens": 500, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 1}}}))
		write(event("content_block_start", map[string]any{"type": "content_block_start", "index": 0,
			"content_block": map[string]any{"type": "text", "text": ""}}))
		for i := 0; i < 5; i++ {
			write(event("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0,
				"delta": map[string]any{"type": "text_delta", "text": "word "}}))
		}
		select {
		case <-release:
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	})
	defer close(release)
	h := startSpike(t, []UpstreamConfig{anthropicUpstream(up.URL)}, map[string][]Route{"claude-x": {{Upstream: "anthropic", Model: "claude-test"}}})

	raw, _ := json.Marshal(map[string]any{"model": "claude-x", "max_tokens": 1024, "stream": true,
		"messages": []any{map[string]any{"role": "user", "content": "hi"}}})
	req, _ := http.NewRequest(http.MethodPost, h.url+"/llm/v1/messages", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-version", "2023-06-01")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	requestID := resp.Header.Get("x-fastvibe-request-id")
	buf := make([]byte, 256)
	if _, err := resp.Body.Read(buf); err != nil {
		t.Fatalf("no first bytes: %v", err)
	}
	resp.Body.Close() // hang up mid-reply

	deadline := time.Now().Add(15 * time.Second)
	var recs []UsageRecord
	for time.Now().Before(deadline) {
		recs = recordsFor(t, h.usageLog, requestID)
		if len(recs) > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if len(recs) == 0 {
		t.Fatal("a stream the client hung up on left no usage record at all")
	}
	rec := recs[len(recs)-1]
	t.Logf("disconnect record: status=%s usage=%+v billable=%+v err=%q", rec.Status, rec.Usage, rec.Billable, rec.Error)
	if rec.Billable.Input != 500 {
		t.Errorf("the 500 input tokens consumed before the hang-up were not reported: %+v", rec.Billable)
	}
}

func recordsFor(t *testing.T, path, requestID string) []UsageRecord {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []UsageRecord
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var rec UsageRecord
		if json.Unmarshal(scanner.Bytes(), &rec) == nil && rec.RequestID == requestID {
			out = append(out, rec)
		}
	}
	return out
}
