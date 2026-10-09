-- name: InsertAudit :exec
INSERT INTO audit_log (user_id, action, target, ip, user_agent, meta)
VALUES (@user_id, @action, @target, @ip, @user_agent, @meta);
