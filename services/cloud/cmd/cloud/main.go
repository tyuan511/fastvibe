// Command cloud is FastVibe's service: /api and, later, /llm on one Fiber listener.
//
// Configuration comes from defaults, then the YAML file named by -config or
// FASTVIBE_CONFIG, then FASTVIBE_* environment variables (internal/config).
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v3"
	"go.uber.org/zap"

	"github.com/tyuan511/fastvibe/services/cloud/internal/auth"
	"github.com/tyuan511/fastvibe/services/cloud/internal/config"
	"github.com/tyuan511/fastvibe/services/cloud/internal/db"
	"github.com/tyuan511/fastvibe/services/cloud/internal/httpapi"
	"github.com/tyuan511/fastvibe/services/cloud/internal/logger"
)

func main() {
	configPath := flag.String("config", os.Getenv("FASTVIBE_CONFIG"), "YAML configuration file (optional)")
	flag.Parse()

	if err := run(*configPath); err != nil {
		// The logger may not exist yet (a bad configuration is the usual reason).
		fmt.Fprintln(os.Stderr, "cloud:", err)
		os.Exit(1)
	}
}

func run(configPath string) error {
	cfg, err := config.Load(configPath, os.Environ())
	if err != nil {
		return err
	}
	log, err := logger.New(cfg.Log)
	if err != nil {
		return err
	}
	defer func() { _ = log.Sync() }()
	zap.RedirectStdLog(log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Open(ctx, cfg.Database, log)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		return err
	}
	log.Info("database migrated")

	if !cfg.GitHub.Configured() {
		log.Warn("github sign-in is not configured; /api/auth/github/start will answer 503 (set FASTVIBE_GITHUB__CLIENT_ID and FASTVIBE_GITHUB__CLIENT_SECRET)")
	}
	authSvc := auth.New(pool, cfg, auth.NewGitHub(cfg.GitHub.ClientID, cfg.GitHub.ClientSecret), log)
	go authSvc.PurgeLoop(ctx, 24*time.Hour)

	app := httpapi.New(httpapi.Deps{Config: cfg, DB: pool, Log: log, Auth: authSvc})

	log.Info("listening", zap.String("addr", cfg.HTTP.Listen), zap.String("env", cfg.Env))
	// GracefulContext: on SIGTERM Fiber stops accepting connections and waits up to
	// ShutdownTimeout for in-flight requests — streams included — before returning.
	err = app.Listen(cfg.HTTP.Listen, fiber.ListenConfig{
		DisableStartupMessage: true,
		GracefulContext:       ctx,
		ShutdownTimeout:       cfg.HTTP.ShutdownTimeout,
	})
	if err != nil {
		return fmt.Errorf("serve: %w", err)
	}
	log.Info("stopped")
	return nil
}
