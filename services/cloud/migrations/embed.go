// Package migrations holds the schema as goose SQL files, embedded so the binary
// migrates the database it is pointed at without shipping the directory beside it.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
