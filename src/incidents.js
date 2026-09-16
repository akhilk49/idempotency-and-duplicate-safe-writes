const crypto = require('crypto');
const { db } = require('./db');

const OPERATION = 'POST:/incidents';

/**
 * Produces a stable SHA-256 hex digest of the request body.
 * Keys are sorted so { a:1, b:2 } and { b:2, a:1 } produce the same hash.
 * Exported so tests can call it directly (test 13).
 */
function hashRequest(body) {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.keys(body).sort().map(k => [k, body[k]]))
  );
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function createIncident(req, res) {
  // ── 1. Require Idempotency-Key header ────────────────────────────────────
  const idempotencyKey = req.get('Idempotency-Key');
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  const { tenantId } = req.user;
  const { title, severity, serviceId } = req.body;
  const requestHash = hashRequest(req.body);

  // ── 2. Serialize via FOR UPDATE on the idempotency row ───────────────────
  //
  // Strategy:
  //   a) INSERT … ON CONFLICT DO NOTHING  – atomically claim the slot if free.
  //   b) SELECT … FOR UPDATE              – lock whoever owns the row (us or a
  //                                        prior request).  Concurrent requests
  //                                        for the same key queue behind the lock
  //                                        and see the completed state when they
  //                                        eventually acquire it.
  //
  const outcome = await db.tx(async t => {
    // Try to claim the slot
    await t.none(
      `INSERT INTO idempotency_keys
         (tenant_id, operation, key, request_hash, state, expires_at)
       VALUES ($1, $2, $3, $4, 'processing', now() + interval '24 hours')
       ON CONFLICT (tenant_id, operation, key) DO NOTHING`,
      [tenantId, OPERATION, idempotencyKey, requestHash]
    );

    // Lock the row – now we are the sole writer for this key until tx ends
    const row = await t.one(
      `SELECT * FROM idempotency_keys
       WHERE tenant_id = $1 AND operation = $2 AND key = $3
       FOR UPDATE`,
      [tenantId, OPERATION, idempotencyKey]
    );

    // ── 3. Route on current state ─────────────────────────────────────────

    if (row.state === 'completed') {
      // Replaying a finished operation
      if (row.request_hash !== requestHash) {
        return { type: 'conflict' };
      }
      return { type: 'replay', status: row.response_status, body: row.response_body };
    }

    if (row.state === 'failed') {
      return { type: 'failed' };
    }

    // state === 'processing'
    // Did WE just insert this row, or was it already there?
    // If the stored hash differs from ours it is definitely someone else's row
    // and we must not overwrite it.
    // If the hash matches but the row was pre-existing (created_at is older)
    // we still must not re-execute – return operation_in_progress.
    //
    // We detect "we just inserted it" by checking whether the INSERT changed a
    // row: pg-promise reports cmdStatus but that is cumbersome.  Instead we
    // compare created_at to now(); a row we just inserted will have
    // created_at within the current transaction timestamp.
    // Simpler and reliable: we use the fact that our INSERT sets expires_at
    // to now()+24h exactly; a pre-existing processing row was set by a
    // different statement.  But clocks are the same within a transaction.
    //
    // The cleanest approach: after INSERT … ON CONFLICT DO NOTHING, do a
    // second query that returns the xmin (transaction ID) of the row.
    // If xmin equals txid_current() we inserted it; otherwise it pre-existed.

    const ownership = await t.one(
      `SELECT (xmin::text::bigint = txid_current()) AS we_own_it
       FROM idempotency_keys
       WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [tenantId, OPERATION, idempotencyKey]
    );

    if (!ownership.we_own_it) {
      // A different request owns this processing row – do not execute
      return { type: 'in_progress' };
    }

    // We own the processing row – execute the work inside this transaction
    let incident;
    try {
      incident = await t.one(
        `INSERT INTO incidents (tenant_id, service_id, title, severity)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [tenantId, serviceId, title, severity]
      );

      await t.none(
        `INSERT INTO paging_jobs (incident_id, tenant_id)
         VALUES ($1, $2)`,
        [incident.id, tenantId]
      );

      // Persist the response so replays never re-execute
      await t.none(
        `UPDATE idempotency_keys
         SET state = 'completed',
             response_status = 201,
             response_body   = $1
         WHERE tenant_id = $2 AND operation = $3 AND key = $4`,
        [incident, tenantId, OPERATION, idempotencyKey]
      );

      return { type: 'created', body: incident };
    } catch (err) {
      // Mark as failed so callers know retrying this key won't help
      await t.none(
        `UPDATE idempotency_keys SET state = 'failed'
         WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
        [tenantId, OPERATION, idempotencyKey]
      );
      throw err;
    }
  });

  // ── 4. Send response based on outcome ────────────────────────────────────
  switch (outcome.type) {
    case 'conflict':
      return res.status(409).json({ error: 'idempotency_key_conflict' });
    case 'failed':
      return res.status(409).json({ error: 'prior_operation_failed' });
    case 'in_progress':
      return res.status(409).json({ error: 'operation_in_progress' });
    case 'replay':
      res.set('Idempotent-Replayed', 'true');
      return res.status(outcome.status).json(outcome.body);
    case 'created':
      return res.status(201).json(outcome.body);
    default:
      return res.status(500).json({ error: 'internal_error' });
  }
}

module.exports = { createIncident, hashRequest };
