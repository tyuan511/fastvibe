// Package httpapi is the /api surface on Fiber. /llm will be mounted on the same
// app: Fiber and Bifrost's integrations both run on fasthttp, so one listener
// serves both and nginx needs a single upstream.
package httpapi

import (
	"context"
	"time"

	"github.com/gofiber/fiber/v3"
	"go.uber.org/zap"

	"github.com/tyuan511/fastvibe/services/cloud/internal/auth"
	"github.com/tyuan511/fastvibe/services/cloud/internal/config"
)

// headerXRealIP is set by our nginx to the socket address it accepted, overwriting
// whatever the client sent.
const headerXRealIP = "X-Real-IP"

// Pinger is what readiness needs from the database.
type Pinger interface {
	Ping(ctx context.Context) error
}

type Deps struct {
	Config *config.Config
	DB     Pinger
	Log    *zap.Logger
	// Auth enables sign-in and the account routes; nil leaves only the health checks.
	Auth *auth.Service
}

// New returns the Fiber app with every /api route registered.
func New(deps Deps) *fiber.App {
	httpCfg := deps.Config.HTTP
	cfg := fiber.Config{
		AppName:     "fastvibe-cloud",
		BodyLimit:   httpCfg.BodyLimit,
		ReadTimeout: httpCfg.ReadTimeout,
		IdleTimeout: httpCfg.IdleTimeout,
		// No WriteTimeout: /llm streams for up to 30 minutes, and a server-wide
		// write deadline would cut every long reply. Each route bounds its own work.
		ErrorHandler: errorHandler(deps.Log),
	}
	if len(httpCfg.TrustedProxies) > 0 {
		// Which peers count as our nginx. ClientIP reads X-Real-IP only from them;
		// ProxyHeader is deliberately left unset, because with it Fiber's c.IP()
		// returns "" for a trusted peer that sent no header instead of the peer.
		cfg.TrustProxy = true
		cfg.TrustProxyConfig = fiber.TrustProxyConfig{Proxies: httpCfg.TrustedProxies}
	}
	app := fiber.New(cfg)

	app.Use(requestID())
	app.Use(accessLog(deps.Log))
	app.Use(recoverPanics(deps.Log))

	api := app.Group("/api")
	registerHealth(api, deps)
	if deps.Auth != nil {
		registerAuth(api, deps)
	}

	return app
}

func registerHealth(api fiber.Router, deps Deps) {
	// Liveness: the process is up. Never touches the database, so a database
	// outage does not get the container restarted for nothing.
	api.Get("/healthz", func(c fiber.Ctx) error {
		return noStore(c).JSON(fiber.Map{"status": "ok"})
	})

	// Readiness: this instance can serve requests.
	api.Get("/readyz", func(c fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(c.Context(), 2*time.Second)
		defer cancel()
		if err := deps.DB.Ping(ctx); err != nil {
			deps.Log.Warn("readiness check failed", zap.Error(err), zap.String("request_id", RequestID(c)))
			return noStore(c).Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"status": "unavailable"})
		}
		return noStore(c).JSON(fiber.Map{"status": "ok"})
	})
}

func noStore(c fiber.Ctx) fiber.Ctx {
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c
}
