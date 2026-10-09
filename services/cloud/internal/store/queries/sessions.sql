-- name: CreateSession :one
INSERT INTO sessions (user_id, token_hash, kind, device_name, platform, user_agent, ip, expires_at)
VALUES (@user_id, @token_hash, @kind, @device_name, @platform, @user_agent, @ip, @expires_at)
RETURNING *;

-- name: GetLiveSession :one
-- A session counts only while it is neither revoked nor expired, and only for an
-- account that is not disabled. The user's role comes along so a request needs one query.
SELECT s.id, s.user_id, s.kind, s.device_name, s.platform, s.created_at,
       s.last_used_at, s.expires_at, u.role, u.github_login
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.token_hash = @token_hash
  AND s.revoked_at IS NULL
  AND s.expires_at > now()
  AND u.disabled_at IS NULL;

-- name: TouchSession :exec
UPDATE sessions SET last_used_at = now(), expires_at = @expires_at
WHERE id = @id AND revoked_at IS NULL;

-- name: ListLiveSessions :many
SELECT id, kind, device_name, platform, user_agent, created_at, last_used_at, expires_at
FROM sessions
WHERE user_id = @user_id AND revoked_at IS NULL AND expires_at > now()
ORDER BY last_used_at DESC;

-- name: RevokeUserSession :one
-- Scoped to the owner: asking for someone else's session id finds nothing.
UPDATE sessions SET revoked_at = now()
WHERE id = @id AND user_id = @user_id AND revoked_at IS NULL
RETURNING token_hash;

-- name: RevokeSessionByTokenHash :one
UPDATE sessions SET revoked_at = now()
WHERE token_hash = @token_hash AND revoked_at IS NULL
RETURNING id, user_id;

-- name: RevokeAllUserSessions :many
UPDATE sessions SET revoked_at = now()
WHERE user_id = @user_id AND revoked_at IS NULL
RETURNING token_hash;

-- name: PurgeDeadSessions :execrows
-- Sessions are kept for 90 days after they die, for support and audit.
DELETE FROM sessions
WHERE COALESCE(revoked_at, expires_at) < now() - interval '90 days';
