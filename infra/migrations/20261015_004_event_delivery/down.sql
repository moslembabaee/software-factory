DROP INDEX outbox_pending;
ALTER TABLE outbox DROP CONSTRAINT outbox_delivery_lease;
ALTER TABLE outbox DROP COLUMN delivery_expires_at;
ALTER TABLE outbox DROP COLUMN delivery_token;
