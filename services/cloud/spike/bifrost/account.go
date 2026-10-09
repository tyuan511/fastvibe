package main

import (
	"context"
	"fmt"
	"os"
	"sync"

	"github.com/maximhq/bifrost/core/schemas"
)

// account answers Bifrost's three questions — which providers exist, which keys
// each has, how to reach it — from a snapshot. The real service rebuilds the
// snapshot from Postgres on LISTEN/NOTIFY and calls UpdateProvider.
type account struct {
	mu        sync.RWMutex
	upstreams map[schemas.ModelProvider]UpstreamConfig
}

func newAccount(cfg *Config) *account {
	a := &account{upstreams: map[schemas.ModelProvider]UpstreamConfig{}}
	for _, u := range cfg.Upstream {
		a.upstreams[schemas.ModelProvider(u.Name)] = u
	}
	return a
}

// setBaseURL changes where an upstream points, as an admin edit would. The caller
// then asks Bifrost to re-read the provider (UpdateProvider).
func (a *account) setBaseURL(name, baseURL string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	u := a.upstreams[schemas.ModelProvider(name)]
	u.BaseURL = baseURL
	a.upstreams[schemas.ModelProvider(name)] = u
}

func (a *account) GetConfiguredProviders() ([]schemas.ModelProvider, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := make([]schemas.ModelProvider, 0, len(a.upstreams))
	for name := range a.upstreams {
		out = append(out, name)
	}
	return out, nil
}

func (a *account) GetKeysForProvider(_ context.Context, provider schemas.ModelProvider) ([]schemas.Key, error) {
	a.mu.RLock()
	u, ok := a.upstreams[provider]
	a.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown upstream %q", provider)
	}
	keys := make([]schemas.Key, 0, len(u.KeyEnv))
	for i, env := range u.KeyEnv {
		value := os.Getenv(env)
		if value == "" {
			continue
		}
		keys = append(keys, schemas.Key{
			ID:     fmt.Sprintf("%s-%d", u.Name, i),
			Name:   env,
			Value:  *schemas.NewSecretVar(value),
			Models: schemas.WhiteList{"*"},
			Weight: 1,
		})
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("upstream %q: none of %v is set", u.Name, u.KeyEnv)
	}
	return keys, nil
}

func (a *account) GetConfigForProvider(provider schemas.ModelProvider) (*schemas.ProviderConfig, error) {
	a.mu.RLock()
	u, ok := a.upstreams[provider]
	a.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown upstream %q", provider)
	}
	network := schemas.DefaultNetworkConfig
	network.BaseURL = u.BaseURL
	// Bifrost retries an attempt itself before falling back; keep that small so a
	// failing upstream hands over to the next candidate quickly.
	network.MaxRetries = 1
	network.DefaultRequestTimeoutInSeconds = 1800
	cfg := &schemas.ProviderConfig{
		NetworkConfig:            network,
		ConcurrencyAndBufferSize: schemas.DefaultConcurrencyAndBufferSize,
		// Keep the upstream's own bytes for the usage log, without handing them to the client.
		StoreRawRequestResponse: true,
	}
	if u.Name != u.Type {
		cfg.CustomProviderConfig = &schemas.CustomProviderConfig{BaseProviderType: schemas.ModelProvider(u.Type)}
	}
	return cfg, nil
}
