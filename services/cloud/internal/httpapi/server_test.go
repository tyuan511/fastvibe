package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"

	"github.com/tyuan511/fastvibe/services/cloud/internal/config"
)

type pinger struct{ err error }

func (p pinger) Ping(context.Context) error { return p.err }

func testConfig() *config.Config {
	return &config.Config{HTTP: config.HTTP{BodyLimit: 1 << 20}}
}

func newTestApp(t *testing.T, db Pinger, cfg *config.Config) (*fiber.App, *observer.ObservedLogs) {
	t.Helper()
	core, logs := observer.New(zapcore.DebugLevel)
	if cfg == nil {
		cfg = testConfig()
	}
	return New(Deps{Config: cfg, DB: db, Log: zap.New(core)}), logs
}

func do(t *testing.T, app *fiber.App, req *http.Request) (*http.Response, map[string]any) {
	t.Helper()
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	return resp, body
}

func get(t *testing.T, app *fiber.App, path string) (*http.Response, map[string]any) {
	return do(t, app, httptest.NewRequest(http.MethodGet, path, nil))
}

func TestHealthAndReadiness(t *testing.T) {
	up, _ := newTestApp(t, pinger{}, nil)
	if resp, _ := get(t, up, "/api/healthz"); resp.StatusCode != http.StatusOK {
		t.Errorf("healthz = %d", resp.StatusCode)
	}
	if resp, _ := get(t, up, "/api/readyz"); resp.StatusCode != http.StatusOK {
		t.Errorf("readyz = %d", resp.StatusCode)
	}

	down, _ := newTestApp(t, pinger{err: errors.New("refused")}, nil)
	if resp, _ := get(t, down, "/api/healthz"); resp.StatusCode != http.StatusOK {
		t.Errorf("healthz must not depend on the database, got %d", resp.StatusCode)
	}
	if resp, _ := get(t, down, "/api/readyz"); resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("readyz with the database down = %d", resp.StatusCode)
	}
}

func TestErrorsAreJSONWithTheRequestID(t *testing.T) {
	app, logs := newTestApp(t, pinger{}, nil)
	resp, body := get(t, app, "/api/nope")
	line := logs.FilterMessage("request").All()
	if len(line) != 1 || line[0].ContextMap()["status"] != int64(http.StatusNotFound) || line[0].ContextMap()["bytes_out"] == int64(0) {
		t.Errorf("the access line should record the rendered error: %v", line)
	}
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	e, _ := body["error"].(map[string]any)
	if e["code"] != "not_found" {
		t.Errorf("error body = %v", body)
	}
	if e["request_id"] == "" || e["request_id"] != resp.Header.Get(requestIDHeader) {
		t.Errorf("error should carry the same request id as the header: %v vs %q", e["request_id"], resp.Header.Get(requestIDHeader))
	}
}

func TestRequestIDIsOurs(t *testing.T) {
	app, _ := newTestApp(t, pinger{}, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/healthz", nil)
	req.Header.Set(requestIDHeader, "chosen-by-client")
	resp, _ := do(t, app, req)
	id := resp.Header.Get(requestIDHeader)
	parsed, err := uuid.Parse(id)
	if err != nil || parsed.Version() != 7 {
		t.Errorf("request id %q should be a fresh UUIDv7, not the client's", id)
	}
}

func TestPanicBecomesA500(t *testing.T) {
	app, logs := newTestApp(t, pinger{}, nil)
	app.Get("/api/boom", func(fiber.Ctx) error { panic("kaboom") })
	resp, body := get(t, app, "/api/boom")
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if strings.Contains(toJSON(body), "kaboom") {
		t.Error("panic details leaked into the response")
	}
	if logs.FilterMessage("panic serving request").Len() != 1 {
		t.Error("panic was not logged")
	}
}

func TestUnexpectedErrorsStayInTheLog(t *testing.T) {
	app, logs := newTestApp(t, pinger{}, nil)
	app.Get("/api/fail", func(fiber.Ctx) error { return errors.New("pq: password authentication failed") })
	app.Get("/api/teapot", func(fiber.Ctx) error { return NewError(http.StatusTeapot, "teapot", "short and stout") })

	resp, body := get(t, app, "/api/fail")
	if resp.StatusCode != http.StatusInternalServerError || strings.Contains(toJSON(body), "password") {
		t.Errorf("internal error leaked: %d %v", resp.StatusCode, body)
	}
	if logs.FilterMessage("unhandled error").Len() != 1 {
		t.Error("internal error was not logged")
	}

	resp, body = get(t, app, "/api/teapot")
	e, _ := body["error"].(map[string]any)
	if resp.StatusCode != http.StatusTeapot || e["code"] != "teapot" || e["message"] != "short and stout" {
		t.Errorf("API error not rendered as given: %d %v", resp.StatusCode, body)
	}
}

func TestAccessLogNeverRecordsTheQuery(t *testing.T) {
	app, logs := newTestApp(t, pinger{}, nil)
	app.Get("/api/callback", func(c fiber.Ctx) error { return c.SendStatus(http.StatusNoContent) })
	get(t, app, "/api/callback?code=secret-oauth-code")

	entries := logs.FilterMessage("request").All()
	if len(entries) != 1 {
		t.Fatalf("expected one access line, got %d", len(entries))
	}
	fields := entries[0].ContextMap()
	if fields["path"] != "/api/callback" || fields["status"] != int64(http.StatusNoContent) {
		t.Errorf("access line = %v", fields)
	}
	if _, ok := fields["latency_ms"].(float64); !ok {
		t.Errorf("latency_ms should be fractional milliseconds: %v", fields["latency_ms"])
	}
	if strings.Contains(toJSON(fields), "secret-oauth-code") {
		t.Error("the query string reached the log")
	}
}

func TestAccessLogLevels(t *testing.T) {
	app, logs := newTestApp(t, pinger{}, nil)
	app.Get("/api/ok", func(c fiber.Ctx) error { return c.SendStatus(http.StatusOK) })
	app.Get("/api/missing", func(c fiber.Ctx) error { return NewError(http.StatusNotFound, "not_found", "x") })
	app.Get("/api/off", func(c fiber.Ctx) error { return NewError(http.StatusServiceUnavailable, "off", "x") })
	app.Get("/api/bug", func(c fiber.Ctx) error { return errors.New("bug") })

	level := map[string]zapcore.Level{}
	for _, p := range []string{"ok", "missing", "off", "bug"} {
		get(t, app, "/api/"+p)
	}
	get(t, app, "/api/healthz")
	for _, e := range logs.FilterMessage("request").All() {
		level[e.ContextMap()["path"].(string)] = e.Level
	}
	want := map[string]zapcore.Level{
		"/api/ok": zapcore.InfoLevel, "/api/missing": zapcore.InfoLevel,
		"/api/off": zapcore.WarnLevel, "/api/bug": zapcore.ErrorLevel, "/api/healthz": zapcore.DebugLevel,
	}
	for path, lvl := range want {
		if level[path] != lvl {
			t.Errorf("%s logged at %s, want %s", path, level[path], lvl)
		}
	}
}

func TestClientIPOnlyFromTrustedProxies(t *testing.T) {
	var seen string
	handler := func(c fiber.Ctx) error { seen = ClientIP(c); return nil }

	cfg := testConfig()
	cfg.HTTP.TrustedProxies = []string{"0.0.0.0/0"} // app.Test connects from 0.0.0.0
	trusting, _ := newTestApp(t, pinger{}, cfg)
	trusting.Get("/api/ip", handler)
	req := httptest.NewRequest(http.MethodGet, "/api/ip", nil)
	req.Header.Set(headerXRealIP, "203.0.113.7")
	do(t, trusting, req)
	if seen != "203.0.113.7" {
		t.Errorf("behind a trusted proxy the client is X-Real-IP, got %q", seen)
	}
	do(t, trusting, httptest.NewRequest(http.MethodGet, "/api/ip", nil))
	if seen == "" {
		t.Error("a trusted peer that sent no X-Real-IP must still yield its own address")
	}

	direct, _ := newTestApp(t, pinger{}, nil)
	direct.Get("/api/ip", handler)
	req = httptest.NewRequest(http.MethodGet, "/api/ip", nil)
	req.Header.Set(headerXRealIP, "203.0.113.7")
	do(t, direct, req)
	if seen == "203.0.113.7" {
		t.Error("with no trusted proxy a client-sent X-Real-IP must be ignored")
	}
}

// Over the wire, not app.Test: an oversized body is refused by fasthttp while it
// reads the request, and that path must still answer in our JSON error format. Only
// the headers are sent. The server decides from Content-Length and closes at once,
// so a client still pushing megabytes races the reply and sometimes sees a reset.
func TestBodyLimit(t *testing.T) {
	app, _ := newTestApp(t, pinger{}, nil)
	app.Post("/api/echo", func(c fiber.Ctx) error { return c.SendStatus(http.StatusNoContent) })
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = app.Listener(ln, fiber.ListenConfig{DisableStartupMessage: true}) }()
	t.Cleanup(func() { _ = app.Shutdown() })

	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.WriteString(conn, "POST /api/echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: 2097152\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body: %d %s", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), `"payload_too_large"`) {
		t.Errorf("oversized body should get the JSON error format: %s", raw)
	}
}

func toJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
