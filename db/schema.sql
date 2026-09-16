CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  service_id  UUID NOT NULL,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('P1','P2','P3','P4')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency key store.
-- Scoped by (tenant_id, operation, key) so the same client key is independent
-- across tenants and across different operations on the same tenant.
CREATE TABLE idempotency_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL,
  operation     TEXT        NOT NULL,   -- e.g. 'POST:/incidents'
  key           TEXT        NOT NULL,   -- client-supplied Idempotency-Key header value
  request_hash  TEXT        NOT NULL,   -- SHA-256 of canonical request body (hex)
  state         TEXT        NOT NULL    -- 'processing' | 'completed' | 'failed'
                CHECK (state IN ('processing','completed','failed')),
  response_status  INT,                 -- stored HTTP status on completion
  response_body    JSONB,               -- stored response body on completion
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One key per tenant+operation combination; prevents duplicate claims.
  CONSTRAINT uq_idempotency_keys UNIQUE (tenant_id, operation, key)
);

-- Durable paging job created atomically with each new incident.
CREATE TABLE paging_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id),
  tenant_id   UUID NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
