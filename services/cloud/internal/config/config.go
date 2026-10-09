// Package config loads the service's settings: built-in defaults, then an optional
// YAML file, then environment variables, each layer overriding the one before.
//
// Environment variables carry the FASTVIBE_ prefix and use a double underscore for
// nesting, so FASTVIBE_DATABASE__URL sets database.url and FASTVIBE_HTTP__LISTEN sets
// http.listen. Secrets belong in the environment, never in the file.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/confmap"
	"github.com/knadh/koanf/providers/env/v2"
	"github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/v2"
)

const envPrefix = "FASTVIBE_"

type Config struct {
	// Env is "development" or "production". It only changes defaults that are
	// about convenience (log format); nothing about security depends on it.
	Env string `koanf:"env"`
	// PublicOrigin is the scheme and host browsers see, e.g. https://app.fastvibe.dev.
	// It is what an Origin header is compared against and what OAuth callbacks are built on.
	PublicOrigin string   `koanf:"public_origin"`
	HTTP         HTTP     `koanf:"http"`
	Database     Database `koanf:"database"`
	Log          Log      `koanf:"log"`
	GitHub       GitHub   `koanf:"github"`
	Admin        Admin    `koanf:"admin"`
	Session      Session  `koanf:"session"`
}

// GitHub is the OAuth App users sign in with. Optional in development, where the
// login routes then answer 503; required in production.
type GitHub struct {
	ClientID     string `koanf:"client_id"`
	ClientSecret string `koanf:"client_secret"`
}

func (g GitHub) Configured() bool { return g.ClientID != "" && g.ClientSecret != "" }

type Admin struct {
	// GitHubIDs are GitHub numeric ids promoted to admin when they sign in. Promotion
	// only: removing an id does not demote anyone, that is done on the user record.
	GitHubIDs []int64 `koanf:"github_ids"`
}

type Session struct {
	// WebTTL is how long a browser session lasts without being used; every use
	// pushes it out again.
	WebTTL time.Duration `koanf:"web_ttl"`
	// CacheTTL is how long a verified token is remembered in process. It bounds how
	// late a revocation made on another instance takes effect.
	CacheTTL time.Duration `koanf:"cache_ttl"`
}

type HTTP struct {
	Listen      string        `koanf:"listen"`
	ReadTimeout time.Duration `koanf:"read_timeout"`
	IdleTimeout time.Duration `koanf:"idle_timeout"`
	// ShutdownTimeout bounds how long in-flight requests get to finish on SIGTERM.
	ShutdownTimeout time.Duration `koanf:"shutdown_timeout"`
	// BodyLimit is the largest request body accepted, in bytes. /llm carries
	// base64 images, hence the generous default.
	BodyLimit int `koanf:"body_limit"`
	// TrustedProxies are the addresses (IPs or CIDRs) of the nginx in front. Only a
	// request arriving from one of them has its X-Forwarded-For believed; from
	// anywhere else the socket address is the client.
	TrustedProxies []string `koanf:"trusted_proxies"`
}

type Database struct {
	URL             string        `koanf:"url"`
	MaxConns        int32         `koanf:"max_conns"`
	MinConns        int32         `koanf:"min_conns"`
	MaxConnLifetime time.Duration `koanf:"max_conn_lifetime"`
}

type Log struct {
	Level  string `koanf:"level"`  // debug | info | warn | error
	Format string `koanf:"format"` // json | console
}

func defaults() map[string]any {
	return map[string]any{
		"env":                        "production",
		"http.listen":                ":9089",
		"http.read_timeout":          "60s",
		"http.idle_timeout":          "120s",
		"http.shutdown_timeout":      "30s",
		"http.body_limit":            32 << 20,
		"http.trusted_proxies":       []string{},
		"database.max_conns":         20,
		"database.min_conns":         2,
		"database.max_conn_lifetime": "30m",
		"log.level":                  "info",
		"log.format":                 "",
		"session.web_ttl":            "720h",
		"session.cache_ttl":          "30s",
	}
}

// Load builds the configuration. path is an optional YAML file ("" for none);
// environ is the environment as KEY=VALUE pairs (os.Environ() in production).
func Load(path string, environ []string) (*Config, error) {
	k := koanf.New(".")
	if err := k.Load(confmap.Provider(defaults(), "."), nil); err != nil {
		return nil, err
	}
	if path != "" {
		if err := k.Load(file.Provider(path), yaml.Parser()); err != nil {
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
	}
	if err := k.Load(envProvider(environ), nil); err != nil {
		return nil, fmt.Errorf("read environment: %w", err)
	}

	var cfg Config
	if err := k.UnmarshalWithConf("", &cfg, koanf.UnmarshalConf{Tag: "koanf"}); err != nil {
		return nil, fmt.Errorf("decode configuration: %w", err)
	}
	cfg.PublicOrigin = strings.TrimRight(cfg.PublicOrigin, "/")
	if cfg.Log.Format == "" {
		cfg.Log.Format = "json"
		if cfg.Env == "development" {
			cfg.Log.Format = "console"
		}
	}
	return &cfg, cfg.validate()
}

// FromProcess loads from FASTVIBE_CONFIG (if set) and the process environment.
func FromProcess() (*Config, error) {
	return Load(os.Getenv(envPrefix+"CONFIG"), os.Environ())
}

// envProvider maps FASTVIBE_HTTP__LISTEN to http.listen. A comma-separated value
// becomes a list, which is how FASTVIBE_HTTP__TRUSTED_PROXIES is written.
func envProvider(environ []string) koanf.Provider {
	return env.Provider(".", env.Opt{
		Prefix: envPrefix,
		EnvironFunc: func() []string {
			return environ
		},
		TransformFunc: func(key, value string) (string, any) {
			key = strings.ToLower(strings.TrimPrefix(key, envPrefix))
			if key == "config" {
				return "", nil // the file's own path, not a setting
			}
			key = strings.ReplaceAll(key, "__", ".")
			if strings.HasSuffix(key, "trusted_proxies") || strings.HasSuffix(key, "github_ids") {
				return key, splitList(value)
			}
			return key, value
		},
	})
}

func splitList(value string) []string {
	var out []string
	for _, part := range strings.Split(value, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func (c *Config) validate() error {
	var errs []error
	if c.Env != "development" && c.Env != "production" {
		errs = append(errs, fmt.Errorf("env must be development or production, got %q", c.Env))
	}
	if err := checkOrigin(c.PublicOrigin); err != nil {
		errs = append(errs, err)
	}
	if c.Database.URL == "" {
		errs = append(errs, errors.New("database.url is required (FASTVIBE_DATABASE__URL)"))
	}
	if c.Database.MaxConns < 1 || c.Database.MinConns < 0 || c.Database.MinConns > c.Database.MaxConns {
		errs = append(errs, fmt.Errorf("database pool: need 0 <= min_conns (%d) <= max_conns (%d), max_conns >= 1",
			c.Database.MinConns, c.Database.MaxConns))
	}
	if c.HTTP.Listen == "" {
		errs = append(errs, errors.New("http.listen is required"))
	}
	if c.HTTP.BodyLimit <= 0 {
		errs = append(errs, errors.New("http.body_limit must be positive"))
	}
	for _, p := range c.HTTP.TrustedProxies {
		if net.ParseIP(p) == nil {
			if _, _, err := net.ParseCIDR(p); err != nil {
				errs = append(errs, fmt.Errorf("http.trusted_proxies: %q is neither an IP nor a CIDR", p))
			}
		}
	}
	if c.Env == "production" && !c.GitHub.Configured() {
		errs = append(errs, errors.New("github.client_id and github.client_secret are required in production"))
	}
	if (c.GitHub.ClientID == "") != (c.GitHub.ClientSecret == "") {
		errs = append(errs, errors.New("github.client_id and github.client_secret must be set together"))
	}
	if c.Session.WebTTL < time.Hour {
		errs = append(errs, fmt.Errorf("session.web_ttl must be at least 1h, got %s", c.Session.WebTTL))
	}
	if c.Session.CacheTTL < 0 || c.Session.CacheTTL > 5*time.Minute {
		errs = append(errs, fmt.Errorf("session.cache_ttl must be between 0 and 5m, got %s", c.Session.CacheTTL))
	}
	switch c.Log.Level {
	case "debug", "info", "warn", "error":
	default:
		errs = append(errs, fmt.Errorf("log.level must be debug, info, warn or error, got %q", c.Log.Level))
	}
	if c.Log.Format != "json" && c.Log.Format != "console" {
		errs = append(errs, fmt.Errorf("log.format must be json or console, got %q", c.Log.Format))
	}
	return errors.Join(errs...)
}

// checkOrigin accepts a bare origin only: a path would make every Origin comparison fail.
func checkOrigin(origin string) error {
	if origin == "" {
		return errors.New("public_origin is required (FASTVIBE_PUBLIC_ORIGIN)")
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return fmt.Errorf("public_origin must be an http(s) origin, got %q", origin)
	}
	if u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return fmt.Errorf("public_origin must be an origin with no path, got %q", origin)
	}
	return nil
}
