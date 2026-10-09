package httpapi

import (
	"fmt"
	"net"
	"runtime/debug"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

const (
	requestIDHeader = "X-Request-ID"
	requestIDLocal  = "request_id"
)

// requestID gives every request a fresh UUIDv7, echoed in X-Request-ID. An incoming
// X-Request-ID is ignored on purpose: the id ends up as usage_events.request_id and
// in support conversations, so a client must not be able to choose it.
func requestID() fiber.Handler {
	return func(c fiber.Ctx) error {
		id := uuid.Must(uuid.NewV7()).String()
		c.Locals(requestIDLocal, id)
		c.Set(requestIDHeader, id)
		return c.Next()
	}
}

// RequestID returns the id requestID assigned to this request.
func RequestID(c fiber.Ctx) string {
	id, _ := c.Locals(requestIDLocal).(string)
	return id
}

// ClientIP is the address of the person on the other end. nginx overwrites
// X-Real-IP with the socket address it accepted, so from a trusted proxy that header
// is the answer; from anywhere else it is whatever the caller chose to send, and the
// socket address is used instead.
func ClientIP(c fiber.Ctx) string {
	if c.IsProxyTrusted() {
		if ip := net.ParseIP(strings.TrimSpace(c.Get(headerXRealIP))); ip != nil {
			return ip.String()
		}
	}
	if ip := c.RequestCtx().RemoteIP(); ip != nil {
		return ip.String()
	}
	return ""
}

// accessLog writes one line per request. It records the path but never the query
// string or a body: an OAuth callback's query carries a one-time code, and request
// content is not stored anywhere (docs/cloud-service.md, 不存请求内容).
func accessLog(log *zap.Logger) fiber.Handler {
	// A request line is not where a stack belongs: it would be the access log's own
	// frames, identical every time. A genuine failure logs its own stack where it happens.
	log = log.WithOptions(zap.AddStacktrace(zapcore.FatalLevel+1), zap.WithCaller(false))
	return func(c fiber.Ctx) error {
		start := time.Now()
		// Fiber hands out strings that point into the connection's reusable buffer, valid
		// only until the handler returns. Copy what the log line keeps, so it stays right
		// if the sink ever buffers or writes asynchronously.
		method, path := strings.Clone(c.Method()), strings.Clone(c.Path())
		if chainErr := c.Next(); chainErr != nil {
			// Render the error now rather than after this middleware returns, so the
			// line below records the status and size the client actually receives.
			if err := c.App().ErrorHandler(c, chainErr); err != nil {
				_ = c.SendStatus(fiber.StatusInternalServerError)
			}
		}
		status := c.Response().StatusCode()

		level := zapcore.InfoLevel
		switch {
		case status == fiber.StatusServiceUnavailable:
			level = zapcore.WarnLevel // a state we report on purpose (not configured, not ready), not a bug
		case status >= 500:
			level = zapcore.ErrorLevel
		case strings.HasSuffix(path, "/healthz") || strings.HasSuffix(path, "/readyz"):
			level = zapcore.DebugLevel // probes every few seconds would drown everything else
		}
		if ce := log.Check(level, "request"); ce != nil {
			ce.Write(
				zap.String("request_id", RequestID(c)),
				zap.String("method", method),
				zap.String("path", path),
				zap.Int("status", status),
				zap.Float64("latency_ms", float64(time.Since(start).Microseconds())/1000),
				zap.String("ip", ClientIP(c)),
				zap.Int("bytes_out", len(c.Response().Body())),
			)
		}
		return nil
	}
}

// recoverPanics turns a panic into a 500 and logs it with its stack, instead of
// letting it take the process down with every other request in flight.
func recoverPanics(log *zap.Logger) fiber.Handler {
	return func(c fiber.Ctx) (err error) {
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic serving request",
					zap.String("request_id", RequestID(c)),
					zap.String("panic", fmt.Sprint(r)),
					zap.ByteString("stack", debug.Stack()),
				)
				err = fiber.ErrInternalServerError
			}
		}()
		return c.Next()
	}
}
