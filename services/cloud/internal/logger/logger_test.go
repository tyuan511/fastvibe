package logger

import (
	"bytes"
	"encoding/json"
	"testing"

	"go.uber.org/zap"

	"github.com/tyuan511/fastvibe/services/cloud/internal/config"
)

func TestJSONLines(t *testing.T) {
	var buf bytes.Buffer
	log, err := newTo(config.Log{Level: "info", Format: "json"}, &buf)
	if err != nil {
		t.Fatal(err)
	}
	log.Debug("hidden")
	log.Info("hello", zap.String("request_id", "r1"))

	var line map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &line); err != nil {
		t.Fatalf("not one JSON line: %q (%v)", buf.String(), err)
	}
	if line["msg"] != "hello" || line["level"] != "info" || line["request_id"] != "r1" || line["time"] == nil {
		t.Errorf("unexpected line: %v", line)
	}
}

func TestRejectsUnknownSettings(t *testing.T) {
	if _, err := New(config.Log{Level: "loud", Format: "json"}); err == nil {
		t.Error("unknown level accepted")
	}
	if _, err := New(config.Log{Level: "info", Format: "xml"}); err == nil {
		t.Error("unknown format accepted")
	}
}
