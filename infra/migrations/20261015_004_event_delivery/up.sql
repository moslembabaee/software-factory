-- Lease deliveries without keeping a SQL transaction open during sandbox execution.
ALTER TABLE outbox ADD COLUMN delivery_token uuid;
ALTER TABLE outbox ADD COLUMN delivery_expires_at timestamptz;
ALTER TABLE outbox ADD CONSTRAINT outbox_delivery_lease
  CHECK ((delivery_token IS NULL) = (delivery_expires_at IS NULL));
CREATE INDEX outbox_pending ON outbox(event_id) WHERE published_at IS NULL;
