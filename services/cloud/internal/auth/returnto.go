package auth

import (
	"net/url"
	"strings"
)

// DefaultReturnTo is where sign-in lands when the caller did not say.
const DefaultReturnTo = "/console"

// SafeReturnTo returns raw if it is a path on this site, else DefaultReturnTo. The value
// ends up in a redirect, so anything that could point elsewhere is refused: another
// host ("//evil.example", "https://…"), a backslash a browser may read as a slash, or a
// control character that could split a header.
func SafeReturnTo(raw string) string {
	if raw == "" || len(raw) > 512 {
		return DefaultReturnTo
	}
	if raw[0] != '/' || strings.HasPrefix(raw, "//") || strings.ContainsAny(raw, "\\") {
		return DefaultReturnTo
	}
	for _, r := range raw {
		if r < 0x20 || r == 0x7f {
			return DefaultReturnTo
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "" || u.Host != "" || u.User != nil {
		return DefaultReturnTo
	}
	// Never bounce back into the API: a login that lands on a JSON endpoint is a dead end.
	if strings.HasPrefix(u.Path, "/api/") || strings.HasPrefix(u.Path, "/llm/") {
		return DefaultReturnTo
	}
	return raw
}
