package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var minimal = []string{
	"FASTVIBE_PUBLIC_ORIGIN=https://app.fastvibe.dev/",
	"FASTVIBE_DATABASE__URL=postgres://localhost/cloud",
	"FASTVIBE_GITHUB__CLIENT_ID=id",
	"FASTVIBE_GITHUB__CLIENT_SECRET=secret",
	"UNRELATED=ignored",
}

func TestDefaults(t *testing.T) {
	cfg, err := Load("", minimal)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PublicOrigin != "https://app.fastvibe.dev" {
		t.Errorf("trailing slash should be trimmed, got %q", cfg.PublicOrigin)
	}
	if cfg.HTTP.Listen != ":9089" || cfg.HTTP.ReadTimeout != time.Minute || cfg.HTTP.BodyLimit != 32<<20 {
		t.Errorf("http defaults: %+v", cfg.HTTP)
	}
	if cfg.Database.MaxConns != 20 || cfg.Database.MaxConnLifetime != 30*time.Minute {
		t.Errorf("database defaults: %+v", cfg.Database)
	}
	if cfg.Log.Level != "info" || cfg.Log.Format != "json" {
		t.Errorf("production logs should be json/info: %+v", cfg.Log)
	}
	if cfg.Session.WebTTL != 30*24*time.Hour || cfg.Session.CacheTTL != 30*time.Second {
		t.Errorf("session defaults: %+v", cfg.Session)
	}
}

func TestFileThenEnvironment(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cloud.yaml")
	yaml := `
env: development
public_origin: http://localhost:8000
http:
  listen: ":9000"
  read_timeout: 5s
  trusted_proxies: ["10.0.0.0/8"]
database:
  url: postgres://from-file/cloud
  max_conns: 5
log:
  level: debug
`
	if err := os.WriteFile(path, []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path, []string{
		"FASTVIBE_DATABASE__URL=postgres://from-env/cloud",
		"FASTVIBE_HTTP__TRUSTED_PROXIES=172.16.0.0/12, 127.0.0.1",
		"FASTVIBE_ADMIN__GITHUB_IDS=583231, 9919",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Database.URL != "postgres://from-env/cloud" {
		t.Errorf("environment should override the file: %q", cfg.Database.URL)
	}
	if cfg.HTTP.Listen != ":9000" || cfg.HTTP.ReadTimeout != 5*time.Second || cfg.Database.MaxConns != 5 {
		t.Errorf("file values lost: %+v %+v", cfg.HTTP, cfg.Database)
	}
	if got := strings.Join(cfg.HTTP.TrustedProxies, ","); got != "172.16.0.0/12,127.0.0.1" {
		t.Errorf("trusted proxies = %q", got)
	}
	if len(cfg.Admin.GitHubIDs) != 2 || cfg.Admin.GitHubIDs[0] != 583231 || cfg.Admin.GitHubIDs[1] != 9919 {
		t.Errorf("admin ids = %v", cfg.Admin.GitHubIDs)
	}
	if cfg.GitHub.Configured() {
		t.Error("development may run without GitHub credentials")
	}
	if cfg.Log.Format != "console" || cfg.Log.Level != "debug" {
		t.Errorf("development logs should default to console: %+v", cfg.Log)
	}
}

func TestReportsEveryProblem(t *testing.T) {
	_, err := Load("", []string{
		"FASTVIBE_ENV=staging",
		"FASTVIBE_LOG__LEVEL=loud",
		"FASTVIBE_HTTP__TRUSTED_PROXIES=nginx",
		"FASTVIBE_DATABASE__MIN_CONNS=50",
		"FASTVIBE_SESSION__WEB_TTL=1m",
		"FASTVIBE_GITHUB__CLIENT_ID=only-half",
	})
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"env must be", "public_origin", "database.url", "min_conns", "trusted_proxies", "log.level", "session.web_ttl"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should mention %q:\n%v", want, err)
		}
	}
}

func TestMissingFileIsAnError(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "nope.yaml"), minimal); err == nil {
		t.Fatal("a named config file that does not exist must not be silently skipped")
	}
}

func TestOriginMustBeBare(t *testing.T) {
	for _, origin := range []string{
		"app.fastvibe.dev",
		"ftp://app.fastvibe.dev",
		"https://app.fastvibe.dev/console",
		"https://app.fastvibe.dev?x=1",
		"https://user@app.fastvibe.dev",
	} {
		if err := checkOrigin(origin); err == nil {
			t.Errorf("%q should be rejected", origin)
		}
	}
	for _, origin := range []string{"https://app.fastvibe.dev", "http://localhost:8080"} {
		if err := checkOrigin(origin); err != nil {
			t.Errorf("%q should be accepted: %v", origin, err)
		}
	}
}

func TestProductionNeedsGitHub(t *testing.T) {
	_, err := Load("", []string{
		"FASTVIBE_PUBLIC_ORIGIN=https://app.fastvibe.dev",
		"FASTVIBE_DATABASE__URL=postgres://localhost/cloud",
	})
	if err == nil || !strings.Contains(err.Error(), "required in production") {
		t.Errorf("production without GitHub credentials must not start: %v", err)
	}
}
