// Command bifrost-spike puts Bifrost's own OpenAI / Anthropic / Gemini HTTP
// integrations behind FastVibe's /llm paths, with an observing plugin that logs the
// usage of every attempt next to the usage the upstream itself reported.
//
// It exists to answer the six P0 questions in docs/cloud-service.md before the real
// /llm is built on the same pieces. See README.md for how to run them.
package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/fasthttp/router"
	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/kvstore"
	"github.com/maximhq/bifrost/framework/logstore"
	"github.com/maximhq/bifrost/transports/bifrost-http/integrations"
	"github.com/maximhq/bifrost/transports/bifrost-http/lib"
	"github.com/valyala/fasthttp"
)

func main() {
	configPath := flag.String("config", "spike.json", "spike configuration")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(*configPath, log); err != nil {
		log.Error("spike exited", "err", err)
		os.Exit(1)
	}
}

func run(configPath string, log *slog.Logger) error {
	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	sp, err := newServer(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer sp.close()
	server := sp.server
	go func() {
		<-ctx.Done()
		_ = server.ShutdownWithContext(context.Background())
	}()

	log.Info("listening", "addr", cfg.Listen, "usage_log", cfg.UsageLog)
	return server.ListenAndServe(cfg.Listen)
}

type spike struct {
	server  *fasthttp.Server
	client  *bifrost.Bifrost
	account *account
	close   func()
}

// newServer assembles Bifrost, its integrations and the gateway in front of them.
func newServer(ctx context.Context, cfg *Config, log *slog.Logger) (*spike, error) {
	requests := &requestTable{}
	plugin, err := newUsagePlugin(cfg.UsageLog, log, requests)
	if err != nil {
		return nil, err
	}

	acct := newAccount(cfg)
	client, err := bifrost.Init(ctx, schemas.BifrostConfig{
		Account:    acct,
		LLMPlugins: []schemas.LLMPlugin{plugin},
		Logger:     bifrost.NewDefaultLogger(schemas.LogLevelWarn),
	})
	if err != nil {
		return nil, fmt.Errorf("init bifrost: %w", err)
	}

	r := router.New()
	store := handlerStore{}
	bfLogger := bifrost.NewDefaultLogger(schemas.LogLevelWarn)
	for _, ext := range []integrations.ExtensionRouter{
		integrations.NewOpenAIRouter(client, store, accessResolver{}, bfLogger),
		integrations.NewAnthropicRouter(client, store, accessResolver{}, bfLogger),
		integrations.NewGenAIRouter(client, store, accessResolver{}, bfLogger),
	} {
		ext.RegisterRoutes(r)
	}

	gw := &gateway{cfg: cfg, inner: r.Handler, requests: requests, log: log}
	server := &fasthttp.Server{
		Handler:            gw.serve,
		Name:               "fastvibe-llm-spike",
		ReadTimeout:        60 * time.Second,
		MaxRequestBodySize: 32 << 20,
	}
	purgeCtx, cancel := context.WithCancel(ctx)
	go requests.purge(purgeCtx)
	return &spike{server: server, client: client, account: acct, close: func() { cancel(); client.Shutdown() }}, nil
}

// gateway is the part the real service owns: authenticate, decide where the public
// model goes, strip everything the client must not be able to steer Bifrost with,
// then hand the request to Bifrost's integration for that protocol.
type gateway struct {
	cfg      *Config
	inner    fasthttp.RequestHandler
	requests *requestTable
	log      *slog.Logger
}

func (g *gateway) serve(ctx *fasthttp.RequestCtx) {
	path := string(ctx.Path())
	if string(ctx.Method()) == fasthttp.MethodGet && (path == "/llm/v1/models" || path == "/llm/v1beta/models") {
		g.listModels(ctx)
		return
	}

	target, clientAPI, ok := integrationPath(path)
	if !ok {
		writeError(ctx, fasthttp.StatusNotFound, "not_found", "no such endpoint")
		return
	}
	if !g.authenticated(ctx) {
		writeError(ctx, fasthttp.StatusUnauthorized, "authentication_error", "missing or invalid token")
		return
	}

	publicModel, err := g.rewriteModel(ctx, clientAPI, &target)
	if err != nil {
		writeError(ctx, fasthttp.StatusNotFound, "model_not_found", err.Error())
		return
	}

	// Nothing the client sends may reach Bifrost's own controls (x-bf-*: direct keys,
	// extra upstream headers, raw-body overrides) or the upstream as a credential.
	stripControlHeaders(&ctx.Request.Header)
	requestID := newRequestID()
	ctx.Request.Header.Set("x-request-id", requestID)
	ctx.Response.Header.Set("x-fastvibe-request-id", requestID)
	g.requests.put(requestID, requestInfo{publicModel: publicModel, clientAPI: clientAPI, started: time.Now()})

	ctx.Request.URI().SetPath(target)
	g.inner(ctx)
}

// integrationPath maps FastVibe's public /llm paths onto Bifrost's integration routes.
func integrationPath(path string) (target, clientAPI string, ok bool) {
	switch {
	case path == "/llm/v1/chat/completions":
		return "/openai/v1/chat/completions", "openai-completions", true
	case path == "/llm/v1/responses":
		return "/openai/v1/responses", "openai-responses", true
	case path == "/llm/v1/messages":
		return "/anthropic/v1/messages", "anthropic-messages", true
	case strings.HasPrefix(path, "/llm/v1beta/models/"):
		return "/genai" + strings.TrimPrefix(path, "/llm"), "google-generative-ai", true
	}
	return "", "", false
}

func (g *gateway) authenticated(ctx *fasthttp.RequestCtx) bool {
	token := strings.TrimSpace(strings.TrimPrefix(string(ctx.Request.Header.Peek("Authorization")), "Bearer "))
	if token == "" {
		token = string(ctx.Request.Header.Peek("x-api-key"))
	}
	if token == "" {
		token = string(ctx.Request.Header.Peek("x-goog-api-key"))
	}
	for _, allowed := range g.cfg.Tokens {
		if token != "" && token == allowed {
			return true
		}
	}
	return false
}

// rewriteModel replaces the public model id with "upstream/model" and lists the other
// candidates as Bifrost fallbacks. For Gemini the model is in the path, not the body.
func (g *gateway) rewriteModel(ctx *fasthttp.RequestCtx, clientAPI string, target *string) (string, error) {
	if clientAPI == "google-generative-ai" {
		rest := strings.TrimPrefix(*target, "/genai/v1beta/models/")
		model, method, _ := strings.Cut(rest, ":")
		routes, ok := g.cfg.Models[model]
		if !ok {
			return "", fmt.Errorf("model %q does not exist", model)
		}
		*target = "/genai/v1beta/models/" + routes[0].Upstream + "/" + routes[0].Model + ":" + method
		return model, nil
	}

	var body map[string]json.RawMessage
	if err := json.Unmarshal(ctx.Request.Body(), &body); err != nil {
		return "", fmt.Errorf("request body is not a JSON object")
	}
	var model string
	_ = json.Unmarshal(body["model"], &model)
	routes, ok := g.cfg.Models[model]
	if !ok {
		return "", fmt.Errorf("model %q does not exist", model)
	}
	first, _ := json.Marshal(routes[0].Upstream + "/" + routes[0].Model)
	body["model"] = first
	delete(body, "fallbacks")
	if len(routes) > 1 {
		var fallbacks []string
		for _, r := range routes[1:] {
			fallbacks = append(fallbacks, r.Upstream+"/"+r.Model)
		}
		body["fallbacks"], _ = json.Marshal(fallbacks)
	}
	out, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	ctx.Request.SetBody(out)
	return model, nil
}

func (g *gateway) listModels(ctx *fasthttp.RequestCtx) {
	if !g.authenticated(ctx) {
		writeError(ctx, fasthttp.StatusUnauthorized, "authentication_error", "missing or invalid token")
		return
	}
	type entry struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		OwnedBy string `json:"owned_by"`
	}
	list := struct {
		Object string  `json:"object"`
		Data   []entry `json:"data"`
	}{Object: "list"}
	for id := range g.cfg.Models {
		list.Data = append(list.Data, entry{ID: id, Object: "model", OwnedBy: "fastvibe"})
	}
	body, _ := json.Marshal(list)
	ctx.SetContentType("application/json")
	ctx.SetBody(body)
}

func stripControlHeaders(h *fasthttp.RequestHeader) {
	var drop []string
	h.VisitAll(func(key, _ []byte) {
		k := strings.ToLower(string(key))
		if strings.HasPrefix(k, "x-bf-") || k == "authorization" || k == "x-api-key" ||
			k == "x-goog-api-key" || k == "cookie" || k == "x-request-id" {
			drop = append(drop, string(key))
		}
	})
	for _, k := range drop {
		h.Del(k)
	}
}

func writeError(ctx *fasthttp.RequestCtx, status int, code, message string) {
	body, _ := json.Marshal(map[string]any{"error": map[string]string{"type": code, "code": code, "message": message}})
	ctx.SetStatusCode(status)
	ctx.SetContentType("application/json")
	ctx.SetBody(body)
}

// newRequestID returns a UUIDv7: time-ordered, so it doubles as an index key.
func newRequestID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	ms := uint64(time.Now().UnixMilli())
	b[0], b[1], b[2], b[3], b[4], b[5] = byte(ms>>40), byte(ms>>32), byte(ms>>24), byte(ms>>16), byte(ms>>8), byte(ms)
	b[6] = b[6]&0x0f | 0x70
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

type requestInfo struct {
	publicModel string
	clientAPI   string
	started     time.Time
}

type requestTable struct{ m sync.Map }

func (t *requestTable) put(id string, info requestInfo) { t.m.Store(id, info) }

func (t *requestTable) get(id string) (requestInfo, bool) {
	v, ok := t.m.Load(id)
	if !ok {
		return requestInfo{}, false
	}
	return v.(requestInfo), true
}

func (t *requestTable) purge(ctx context.Context) {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			t.m.Range(func(k, v any) bool {
				if time.Since(v.(requestInfo).started) > time.Hour {
					t.m.Delete(k)
				}
				return true
			})
		}
	}
}

// handlerStore is the transport configuration Bifrost's integrations read. Every
// switch that lets a request override something is off.
type handlerStore struct{}

func (handlerStore) GetHeaderMatcher() *lib.HeaderMatcher                  { return nil }
func (handlerStore) GetStreamChunkInterceptor() lib.StreamChunkInterceptor { return nil }
func (handlerStore) GetAsyncJobExecutor() *logstore.AsyncJobExecutor       { return nil }
func (handlerStore) GetAsyncJobResultTTL() int                             { return 0 }
func (handlerStore) GetKVStore() *kvstore.Store                            { return nil }
func (handlerStore) GetMCPHeaderCombinedAllowlist() schemas.WhiteList      { return nil }
func (handlerStore) ShouldAllowPerRequestStorageOverride() bool            { return false }
func (handlerStore) ShouldAllowPerRequestRawOverride() bool                { return false }
func (handlerStore) ShouldAllowDirectKeys() bool                           { return false }
func (handlerStore) GetMCPExternalClientURL() string                       { return "" }

type accessResolver struct{}

func (accessResolver) NarrowListModelsProviders(*schemas.BifrostContext) {}
