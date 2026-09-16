# Idempotency and Duplicate-Safe Writes

`POST /incidents` is now duplicate-safe. The same logical request — identified by an authenticated tenant and a client-supplied `Idempotency-Key` — is executed exactly once. Subsequent identical requests replay the stored result; requests with the same key but a different body are rejected.

---

## Design Decisions

### 1. Why database uniqueness is needed

A `UNIQUE` constraint on `(tenant_id, operation, key)` in `idempotency_keys` is the single source of truth for "has this key been claimed?". Without it, two concurrent requests that both read "no row exists" would both proceed to insert and both create an incident — the classic lost-update race. The constraint turns the insert into an atomic compare-and-set: only one writer can create the row; every other writer's `INSERT … ON CONFLICT DO NOTHING` silently no-ops, and then the `SELECT … FOR UPDATE` queues them behind the winner until the winner's transaction commits.

### 2. Canonicalization and request binding

`hashRequest(body)` sorts the object keys alphabetically before serializing to JSON and hashing with SHA-256:

```js
const canonical = JSON.stringify(
  Object.fromEntries(Object.keys(body).sort().map(k => [k, body[k]]))
);
crypto.createHash('sha256').update(canonical).digest('hex');
```

Sorting eliminates property-order variance so `{title, severity, serviceId}` and `{serviceId, title, severity}` produce the same digest. The hex digest is stored in `request_hash` at claim time. On every subsequent request for the same key the incoming hash is compared to the stored hash:

- **Match + completed** → replay the stored response.
- **Mismatch** → `409 idempotency_key_conflict` (the key was already used for different content).

### 3. What 24-hour expiry means

Every idempotency record carries an `expires_at = now() + interval '24 hours'`. Within that window:

- Replays return the stored response immediately without touching the database write path.
- Conflict detection remains active — reusing the key with changed content is still rejected.

After 24 hours the row is considered expired. A future cleanup job (outside the scope of this exercise) can delete expired rows, after which the key slot becomes reusable. The 24-hour window is intentionally generous: it covers the realistic retry horizon for any automated client while bounding storage growth.

### 4. Why the paging job lives in the same transaction

Durability requires that "incident exists" and "paging job exists" are always both true or both false. If the paging job were inserted after the transaction committed, a crash between the two writes would leave an incident with no page — the on-call engineer would never be notified. By inserting `paging_jobs` inside the same `db.tx` block that creates the incident and marks the idempotency key `completed`, all three writes are atomic: either every row lands or none do (PostgreSQL rolls back on any error).

### 5. Privacy and size risks of stored responses

The completed response body is stored verbatim as `JSONB` in `idempotency_keys.response_body`. Two risks follow:

- **Privacy**: the incident record (title, severity, service ID, tenant ID) is replicated outside the `incidents` table. If response bodies ever include PII — user names, free-text descriptions, contact details — that data sits in a secondary table with potentially different access controls. Row-level security policies and audit logging should cover `idempotency_keys` with the same rigour as `incidents`.
- **Size**: large response bodies inflate the `idempotency_keys` table. This implementation stores only the incident row (a handful of UUID and text columns), so individual rows are small. If the response schema grows — embedded related resources, arrays, blobs — a size cap or a pointer-based design (store only the incident `id` and re-fetch on replay) should be considered.

---

## Repository Structure

```text
.
├── db/
│   └── schema.sql              # incidents, idempotency_keys, paging_jobs tables
├── scripts/
│   └── resetDb.js              # recreates exercise database
├── src/
│   ├── app.js                  # Express route and error handler
│   ├── auth.js                 # provides authenticated tenant/user from headers
│   ├── db.js                   # PostgreSQL connection via pg-promise
│   └── incidents.js            # duplicate-safe handler + hashRequest export
├── tests/
│   └── idempotency.test.js     # 14 contract tests (unmodified)
├── docker-compose.yml          # local PostgreSQL on port 54329
├── package.json
└── package-lock.json
```

---

## Prerequisites

- Git
- Node.js 18 or newer
- npm
- Docker with Docker Compose
- GitHub account

---

## Setup

```bash
# 1. Fork and clone
git clone https://github.com/<your-username>/idempotency-and-duplicate-safe-writes.git
cd idempotency-and-duplicate-safe-writes
git checkout -b idempotent-incidents

# 2. Start Postgres and install dependencies
docker compose up -d
npm install

# 3. Apply schema and run tests
npm run db:reset
npm test
```

---

## How Idempotency Works (request lifecycle)

```
Client ──► POST /incidents  (Idempotency-Key: K, body: B)
               │
               ▼
        Require header ──► 400 if missing
               │
               ▼
        INSERT idempotency_keys (state=processing)
        ON CONFLICT DO NOTHING
               │
               ▼
        SELECT … FOR UPDATE  ◄─── concurrent requests queue here
               │
       ┌───────┴────────────────────┐
  completed?                  processing?
       │                            │
  hash match?               we_own_it (xmin)?
  yes → 200 replay           yes → create incident
  no  → 409 conflict              + paging_job
                                  + mark completed
                             no  → 409 in_progress
```

`we_own_it` is detected by comparing the row's `xmin` (PostgreSQL transaction ID that last wrote it) with `txid_current()`. Only the transaction that inserted the row will see `xmin = txid_current()`, making the check race-free inside the same transaction.

---

## Troubleshooting

**Docker port conflict** — stop the process using port 54329 or change the port in `docker-compose.yml` and `DATABASE_URL`.

**Database connection failed** — wait for Postgres to pass its health check, then rerun `npm run db:reset`.

**Tests say idempotency table is missing** — run `npm run db:reset` to apply the updated schema.

**Never point `DATABASE_URL` at a shared or production database** — the reset script is destructive.
