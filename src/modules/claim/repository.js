/**
 * ClaimRun DB repository.
 * Mirrors Go's internal/modules/claim/repository.go RunRepository interface.
 *
 * All queries are raw pg — no ORM.
 * Table: claim_runs  (same schema as Go GORM model)
 */

import pool from '../../config/db.js';

/**
 * Insert a new claim_runs row.
 * @param {{ jobId, walletId, network, txCount, minFee, maxFee, memo, fireBeforeMs, scheduledAt, userId }} run
 */
export async function createRun(run) {
    await pool.query(
        `INSERT INTO claim_runs
       (job_id, wallet_id, network, tx_count, min_fee, max_fee, memo, fire_before_ms, scheduled_at, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
            run.jobId,
            run.walletId,
            run.network,
            run.txCount,
            run.minFee,
            run.maxFee,
            run.memo ?? '',
            run.fireBeforeMs,
            run.scheduledAt,
            run.userId,
        ],
    );
}

/**
 * Mark a run as fired.
 * @param {string} jobId
 * @param {Date}   firedAt
 * @param {number} txsSubmitted
 */
export async function updateFired(jobId, firedAt, txsSubmitted) {
    await pool.query(
        `UPDATE claim_runs SET fired_at = $1, txs_submitted = $2 WHERE job_id = $3`,
        [firedAt, txsSubmitted, jobId],
    );
}

/**
 * Mark a run as completed.
 * @param {string} jobId
 * @param {number} txsLanded
 * @param {number} txsSucceeded
 * @param {Date}   completedAt
 */
export async function updateCompleted(jobId, txsLanded, txsSucceeded, completedAt) {
    await pool.query(
        `UPDATE claim_runs
     SET txs_landed = $1, txs_succeeded = $2, completed_at = $3
     WHERE job_id = $4`,
        [txsLanded, txsSucceeded, completedAt, jobId],
    );
}

/**
 * Find all runs paginated, ordered by created_at DESC.
 * @param {number} limit
 * @param {number} offset
 * @returns {Promise<{ runs: any[], total: number }>}
 */
export async function findAll(limit, offset) {
    const countResult = await pool.query('SELECT COUNT(*) FROM claim_runs');
    const total = parseInt(countResult.rows[0].count, 10);

    const result = await pool.query(
        `SELECT * FROM claim_runs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
    );
    return { runs: result.rows, total };
}