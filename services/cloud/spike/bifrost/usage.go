package main

import (
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
)

// Billable is the five non-overlapping token counts a request is charged on
// (docs/cloud-service.md, 计费 → 用量口径). Every count is multiplied by its own price.
type Billable struct {
	Input        int `json:"input"`          // prompt tokens that missed the cache
	CacheRead    int `json:"cache_read"`     // prompt tokens served from the cache
	CacheWrite5m int `json:"cache_write_5m"` // prompt tokens written to the 5-minute cache
	CacheWrite1h int `json:"cache_write_1h"` // prompt tokens written to the 1-hour cache
	Output       int `json:"output"`         // completion tokens, reasoning included
	Reasoning    int `json:"reasoning"`      // display only: already inside Output
}

// billableFrom maps Bifrost's normalized usage onto the five counts. Bifrost reports
// PromptTokens inclusive of cache reads and writes, and CompletionTokens inclusive of
// reasoning, for every provider (it folds Anthropic's cache counts in and Gemini's
// thoughts in). The clamps mirror Bifrost's own computeTextCost, so a malformed
// payload can never produce a negative charge.
func billableFrom(u *schemas.BifrostLLMUsage) Billable {
	if u == nil {
		return Billable{}
	}
	prompt := max(u.PromptTokens, 0)
	var read, write, write1h int
	if d := u.PromptTokensDetails; d != nil {
		read, write = max(d.CachedReadTokens, 0), max(d.CachedWriteTokens, 0)
		if d.CachedWriteTokenDetails != nil {
			write1h = max(d.CachedWriteTokenDetails.CachedWriteTokens1h, 0)
		}
	}
	read = min(read, prompt)
	write = min(write, prompt-read)
	write1h = min(write1h, write)

	b := Billable{
		Input:        prompt - read - write,
		CacheRead:    read,
		CacheWrite5m: write - write1h,
		CacheWrite1h: write1h,
		Output:       max(u.CompletionTokens, 0),
	}
	if d := u.CompletionTokensDetails; d != nil {
		b.Reasoning = max(d.ReasoningTokens, 0)
	}
	return b
}

// usageOf finds the usage on a response the way Bifrost's own pricing does
// (framework/modelcatalog/datasheet/cost.go, extractCostInput), or on an error that
// still consumed tokens (a stream cancelled mid-reply).
func usageOf(resp *schemas.BifrostResponse, berr *schemas.BifrostError) *schemas.BifrostLLMUsage {
	if resp != nil {
		switch {
		case resp.PassthroughResponse != nil && resp.PassthroughResponse.PassthroughUsage != nil:
			return resp.PassthroughResponse.PassthroughUsage.LLMUsage
		case resp.ChatResponse != nil && resp.ChatResponse.Usage != nil:
			return resp.ChatResponse.Usage
		case resp.ResponsesResponse != nil && resp.ResponsesResponse.Usage != nil:
			return resp.ResponsesResponse.Usage.ToBifrostLLMUsage()
		case resp.ResponsesStreamResponse != nil && resp.ResponsesStreamResponse.Response != nil &&
			resp.ResponsesStreamResponse.Response.Usage != nil:
			return resp.ResponsesStreamResponse.Response.Usage.ToBifrostLLMUsage()
		}
	}
	if berr != nil && berr.ExtraFields.BilledUsage != nil {
		return berr.ExtraFields.BilledUsage
	}
	return nil
}

// UsageRecord is one line of the usage log: what Bifrost reported for one attempt,
// next to the usage objects the upstream itself sent, so the two can be compared.
type UsageRecord struct {
	RequestID   string                   `json:"request_id"`
	PublicModel string                   `json:"public_model,omitempty"`
	ClientAPI   string                   `json:"client_api,omitempty"`
	Attempt     int                      `json:"attempt"`
	Provider    string                   `json:"provider"`
	Model       string                   `json:"model"`
	RequestType string                   `json:"request_type"`
	Stream      bool                     `json:"stream"`
	Status      string                   `json:"status"`
	Error       string                   `json:"error,omitempty"`
	Usage       *schemas.BifrostLLMUsage `json:"bifrost_usage"`
	Billable    Billable                 `json:"billable"`
	RawUsage    []json.RawMessage        `json:"upstream_usage,omitempty"`
	Chunks      int                      `json:"chunks"`
	LatencyMs   int64                    `json:"latency_ms"`
	At          time.Time                `json:"at"`
}

// usagePlugin is a Bifrost LLM plugin that only observes. PostLLMHook runs once per
// attempt for a unary call and once per chunk for a stream; the record is written
// when the attempt ends (the final chunk, or an error).
type usagePlugin struct {
	log      *slog.Logger
	requests *requestTable

	mu      sync.Mutex
	out     *os.File
	pending map[string]*attemptState
}

type attemptState struct {
	raw    []json.RawMessage
	chunks int
}

func newUsagePlugin(path string, log *slog.Logger, requests *requestTable) (*usagePlugin, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	return &usagePlugin{log: log, requests: requests, out: f, pending: map[string]*attemptState{}}, nil
}

func (p *usagePlugin) GetName() string { return "fastvibe-usage" }

func (p *usagePlugin) Cleanup() error { return p.out.Close() }

func (p *usagePlugin) PreRequestHook(*schemas.BifrostContext, *schemas.BifrostRequest) error {
	return nil
}

func (p *usagePlugin) PreLLMHook(_ *schemas.BifrostContext, req *schemas.BifrostRequest) (*schemas.BifrostRequest, *schemas.LLMPluginShortCircuit, error) {
	return req, nil, nil
}

func (p *usagePlugin) PostLLMHook(ctx *schemas.BifrostContext, resp *schemas.BifrostResponse, berr *schemas.BifrostError) (*schemas.BifrostResponse, *schemas.BifrostError, error) {
	requestID := bifrost.GetStringFromContext(ctx, schemas.BifrostContextKeyRequestID)
	attempt := bifrost.GetIntFromContext(ctx, schemas.BifrostContextKeyFallbackIndex)
	requestType, provider, _, resolved := bifrost.GetResponseFields(resp, berr)
	stream := bifrost.IsStreamRequestType(requestType)
	key := requestID + "#" + string(provider) + "#" + resolved

	p.mu.Lock()
	state := p.pending[key]
	if state == nil {
		state = &attemptState{}
		p.pending[key] = state
	}
	state.chunks++
	if resp != nil {
		if extra := resp.GetExtraFields(); extra != nil {
			state.raw = append(state.raw, usageObjects(extra.RawResponse)...)
		}
	}
	final := berr != nil || !stream || bifrost.IsFinalChunk(ctx)
	if final {
		delete(p.pending, key)
	}
	p.mu.Unlock()
	if !final {
		return resp, berr, nil
	}

	rec := UsageRecord{
		RequestID:   requestID,
		Attempt:     attempt + 1,
		Provider:    string(provider),
		Model:       resolved,
		RequestType: string(requestType),
		Stream:      stream,
		Status:      "completed",
		Usage:       usageOf(resp, berr),
		RawUsage:    state.raw,
		Chunks:      state.chunks,
		At:          time.Now().UTC(),
	}
	if info, ok := p.requests.get(requestID); ok {
		rec.PublicModel, rec.ClientAPI = info.publicModel, info.clientAPI
		rec.LatencyMs = time.Since(info.started).Milliseconds()
	}
	if berr != nil {
		rec.Status = "failed"
		if berr.Error != nil {
			rec.Error = berr.Error.Message
		}
		if berr.ExtraFields.BilledUsage != nil {
			rec.Status = "aborted"
		}
	}
	rec.Billable = billableFrom(rec.Usage)
	p.write(rec)
	return resp, berr, nil
}

func (p *usagePlugin) write(rec UsageRecord) {
	line, err := json.Marshal(rec)
	if err != nil {
		p.log.Error("encode usage record", "err", err)
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, err := p.out.Write(append(line, '\n')); err != nil {
		p.log.Error("write usage record", "err", err)
	}
	p.log.Info("usage", "request_id", rec.RequestID, "attempt", rec.Attempt, "provider", rec.Provider,
		"model", rec.Model, "status", rec.Status, "billable", rec.Billable)
}

// usageObjects pulls every usage object out of one raw upstream payload: OpenAI's
// "usage", Anthropic's "usage" (top level, or under "message" in message_start),
// Responses' "response.usage", Gemini's "usageMetadata". The raw payload is whatever
// Bifrost kept — a JSON string, bytes or an already decoded value.
func usageObjects(raw any) []json.RawMessage {
	var doc any
	switch v := raw.(type) {
	case nil:
		return nil
	case string:
		doc = decodeLoose([]byte(v))
	case []byte:
		doc = decodeLoose(v)
	case json.RawMessage:
		doc = decodeLoose(v)
	default:
		doc = v
	}
	var out []json.RawMessage
	var walk func(node any, depth int)
	walk = func(node any, depth int) {
		if depth > 4 {
			return
		}
		switch n := node.(type) {
		case map[string]any:
			for k, v := range n {
				if k == "usage" || k == "usageMetadata" {
					if b, err := json.Marshal(v); err == nil && string(b) != "null" {
						out = append(out, b)
					}
					continue
				}
				walk(v, depth+1)
			}
		case []any:
			for _, v := range n {
				walk(v, depth+1)
			}
		}
	}
	walk(doc, 0)
	return out
}

// decodeLoose accepts a JSON document or an SSE frame carrying one ("data: {...}").
func decodeLoose(b []byte) any {
	var v any
	if json.Unmarshal(b, &v) == nil {
		if s, ok := v.(string); ok {
			return decodeLoose([]byte(s))
		}
		return v
	}
	var docs []any
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "data:"))
		if line == "" || line == "[DONE]" {
			continue
		}
		if json.Unmarshal([]byte(line), &v) == nil {
			docs = append(docs, v)
		}
	}
	return docs
}
