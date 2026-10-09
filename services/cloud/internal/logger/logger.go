// Package logger builds the service's zap logger: JSON lines in production, a
// readable console format in development. Request content is never logged — only
// the metadata around it (docs/cloud-service.md, 不存请求内容).
package logger

import (
	"fmt"
	"io"
	"os"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"

	"github.com/tyuan511/fastvibe/services/cloud/internal/config"
)

// New returns a logger writing to stdout. Call Sync before the process exits.
func New(cfg config.Log) (*zap.Logger, error) {
	return newTo(cfg, os.Stdout)
}

func newTo(cfg config.Log, out io.Writer) (*zap.Logger, error) {
	level, err := zapcore.ParseLevel(cfg.Level)
	if err != nil {
		return nil, fmt.Errorf("log level: %w", err)
	}

	enc := zapcore.EncoderConfig{
		TimeKey:        "time",
		LevelKey:       "level",
		NameKey:        "logger",
		CallerKey:      "caller",
		MessageKey:     "msg",
		StacktraceKey:  "stack",
		LineEnding:     zapcore.DefaultLineEnding,
		EncodeLevel:    zapcore.LowercaseLevelEncoder,
		EncodeTime:     zapcore.RFC3339NanoTimeEncoder,
		EncodeDuration: zapcore.MillisDurationEncoder,
		EncodeCaller:   zapcore.ShortCallerEncoder,
	}
	var encoder zapcore.Encoder
	switch cfg.Format {
	case "json":
		encoder = zapcore.NewJSONEncoder(enc)
	case "console":
		enc.EncodeLevel = zapcore.CapitalColorLevelEncoder
		enc.EncodeTime = zapcore.TimeEncoderOfLayout("15:04:05.000")
		encoder = zapcore.NewConsoleEncoder(enc)
	default:
		return nil, fmt.Errorf("log format %q", cfg.Format)
	}

	core := zapcore.NewCore(encoder, zapcore.Lock(zapcore.AddSync(out)), level)
	return zap.New(core, zap.AddCaller(), zap.AddStacktrace(zapcore.ErrorLevel)), nil
}
