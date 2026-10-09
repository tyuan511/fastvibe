// Package auth owns sign-in with GitHub and the session tokens that follow it.
//
// There is one kind of credential: an opaque session token. The browser carries it in a
// cookie, a desktop or phone client in an Authorization header, and /llm will accept the
// header form only. The database stores a SHA-256 of the token, never the token.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strings"
)

// tokenPrefix makes a leaked token recognisable to secret scanners and to a person
// reading a log, and lets the server reject obvious garbage without a database query.
const tokenPrefix = "fvs_"

// newToken returns 32 bytes of randomness as a prefixed base64url string.
func newToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("read randomness: %w", err)
	}
	return tokenPrefix + base64.RawURLEncoding.EncodeToString(b[:]), nil
}

// tokenLen is the length of every token newToken returns.
const tokenLen = len(tokenPrefix) + 43

func wellFormed(token string) bool {
	return len(token) == tokenLen && strings.HasPrefix(token, tokenPrefix)
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// randomString is n random bytes as base64url, for state and PKCE values.
func randomString(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("read randomness: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
