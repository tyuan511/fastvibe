package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// Config is the spike's whole world: upstream providers and how public model ids map
// onto them. The real service reads the same shape from Postgres (channels,
// channel_keys, model_routes).
type Config struct {
	Listen   string             `json:"listen"`
	UsageLog string             `json:"usage_log"`
	Tokens   []string           `json:"tokens"` // bearer tokens the spike accepts, standing in for session tokens
	Upstream []UpstreamConfig   `json:"upstreams"`
	Models   map[string][]Route `json:"models"` // public model id -> ordered candidates
}

type UpstreamConfig struct {
	// Name is the Bifrost provider key. When it differs from Type the upstream is a
	// custom provider built on Type (an OpenAI-compatible relay, say).
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	BaseURL string   `json:"base_url,omitempty"`
	KeyEnv  []string `json:"key_env"` // environment variables holding the keys; never the keys themselves
}

type Route struct {
	Upstream string `json:"upstream"`
	Model    string `json:"model"`
}

func loadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:8090"
	}
	if cfg.UsageLog == "" {
		cfg.UsageLog = "usage.jsonl"
	}
	names := map[string]bool{}
	for _, u := range cfg.Upstream {
		if u.Name == "" || u.Type == "" {
			return nil, fmt.Errorf("upstream needs name and type: %+v", u)
		}
		if names[u.Name] {
			return nil, fmt.Errorf("duplicate upstream %q", u.Name)
		}
		names[u.Name] = true
	}
	for id, routes := range cfg.Models {
		if len(routes) == 0 {
			return nil, fmt.Errorf("model %q has no routes", id)
		}
		for _, r := range routes {
			if !names[r.Upstream] {
				return nil, fmt.Errorf("model %q routes to unknown upstream %q", id, r.Upstream)
			}
		}
	}
	return &cfg, nil
}
