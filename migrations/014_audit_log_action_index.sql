-- Supports filtering the audit log viewer by action type. user_id,
-- connection_id, and created_at already have indexes (migration 003);
-- action was the one commonly-filtered column left uncovered.
CREATE INDEX idx_audit_log_action ON audit_log(action);
