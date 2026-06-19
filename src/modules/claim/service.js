/**
 * Claim service — the core business logic for /claim/execute.
 *
 * This is a 1-to-1 port of Go's internal/modules/claim/service.go.
 * All steps, error paths, concurrent patterns, and timing logic are preserved exactly.
 *
 * Concurrency model:
 *  Go goroutines  →  setImmediate / Promise.all / setTimeout
 *  sync.Map       →  plain Map (safe: Node.js is single-threaded)
 *  time.AfterFunc →  setTimeout
 *  busywait       →  tight while loop with setImmediate yields for coarse phase
 */

import { v4 as uuidv4, validate as uuidValidate } from 'uuid';
import { Errors } from './errors.js';
import * as repo from './repository.js';
import { mnemonicToKeypair, mnemonicToKeypairAt } from '../../blockchain/keypair.js';
import { loadAccount, loadAccountFull, stroopsToPi, piToStroops } from '../../blockchain/account.js';
import { buildMultiSigClaim, transactionHashFromXDRSync } from '../../blockchain/transaction.js';
import { decrypt } from '../../blockchain/crypto.js';
import { clientPool } from '../../blockchain/clientPool.js';
import pool from '../../config/db.js';
import logger from '../../common/logger.js';

// ── Constants (mirrors service.go) ───────────────────────────────────────────

const BUSYWAIT_LEAD_MS = 10;    // CPU busywait final 10ms for precision
const LEDGER_LOOKUP_ATTEMPTS = 6;
const LEDGER_LOOKUP_INTERVAL_MS = 3000;
const DEFAULT_VALID_FOR_MS = 120000; // 5 seconds
const IMMEDIATE_CLAIM_VALID_FOR_MS = 30000; // 30 seconds — generous window for past claims

// ── Active jobs (mirrors sync.Map) ───────────────────────────────────────────
const activeJobs = new Map();

// ── Network passphrase ───────────────────────────────────────────────────────
function networkPassphrase(network) {
    return network.toUpperCase() === 'MAINNET' ? 'Pi Network' : 'Pi Testnet';
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getWalletByID(walletId) {
    const result = await pool.query('SELECT * FROM wallets WHERE id = $1', [walletId]);
    return result.rows[0] ?? null;
}

async function getTargetAddress(userId) {
    const result = await pool.query('SELECT target_address FROM users WHERE id = $1', [userId]);
    const row = result.rows[0];
    if (!row || !row.target_address) throw new Error(Errors.ErrNoTargetAddress);
    return row.target_address;
}

async function markClaimStatusCond(walletId, newStatus, reason, txHash, ifStatus) {
    const now = new Date();
    const result = await pool.query(
        `UPDATE wallets
         SET claim_status = $1::varchar,
             fail_reason  = $2::varchar,
             tx_hash      = CASE WHEN $3::text != '' THEN $3::text ELSE tx_hash END,
             claimed_at   = CASE WHEN $1::varchar = 'CLAIMED' THEN $4 ELSE claimed_at END,
             updated_at   = $4
         WHERE id = $5 AND claim_status = $6::varchar`,
        [newStatus, reason, txHash ?? '', now, walletId, ifStatus],
    );
    return result.rowCount === 1;
}

async function updateClaimedBlock(walletId, blockNumber) {
    await pool.query('UPDATE wallets SET claimed_block_number = $1 WHERE id = $2', [blockNumber, walletId]);
}

async function getDecryptedFeeAccounts(n, network) {
    const result = await pool.query(
        `SELECT fa.id AS address_id, fa.address, fa.derivation_index, fm.encrypted_mnemonic
         FROM fee_addresses fa
         JOIN fee_mnemonics fm ON fm.id = fa.fee_mnemonic_id
         WHERE fa.status = 'ACTIVE' AND fm.status = 'ACTIVE' AND fm.network = $1
         LIMIT $2`,
        [network, n],
    );
    return result.rows.map(row => ({
        id: row.address_id,
        address: row.address,
        mnemonic: decrypt(row.encrypted_mnemonic),
        derivationIndex: row.derivation_index,
    }));
}

async function getDecryptedMnemonic(walletId) {
    const result = await pool.query('SELECT encrypted_mnemonic FROM wallets WHERE id = $1', [walletId]);
    const row = result.rows[0];
    if (!row) throw new Error(Errors.ErrWalletNotFound);
    return decrypt(row.encrypted_mnemonic);
}

async function failWallet(walletId, reason, cleanup) {
    await markClaimStatusCond(walletId, 'FAILED', reason, '', 'PROCESSING');
    cleanup();
}

function formatReasonCounts(reasons) {
    if (!reasons || reasons.size === 0) return '-';
    return [...reasons.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([r, c]) => `${r}=${c}`)
        .join(' | ');
}

// ── Preload function ─────────────────────────────────────────────────────────
async function preload(jobId, job, feeAccounts, cleanup) {
    const log = (level, msg) => logger[level](`[claim/preload] job=${jobId} claimTime=${job.claimTime.toISOString()} ${msg}`);

    log('info', `═══ START PREPARING ═══ walletID=${job.walletId} network=${job.network} txCount=${feeAccounts.length} balanceID=${job.balanceId} claimTime=${job.claimTime.toISOString()}`);

    const clients = clientPool.getAllByNetwork(job.network);
    if (clients.length === 0) {
        await failWallet(job.walletId, 'no RPC clients available at preload time', cleanup);
        return;
    }

    let claimantKP;
    try {
        claimantKP = await mnemonicToKeypair(job.mnemonic);
    } catch (err) {
        await failWallet(job.walletId, `keypair derivation failed: ${err.message}`, cleanup);
        return;
    }

    try {
        await loadAccount(clients[0], claimantKP.publicKey());
    } catch (err) {
        await failWallet(job.walletId, `load claimant account failed: ${err.message}`, cleanup);
        return;
    }

    // ── Detect past claim BEFORE building transactions ─────────────────────
    const isPastClaim = job.claimTime.getTime() <= Date.now();
    let effectiveValidForMs = job.validForMs;
    if (isPastClaim) {
        effectiveValidForMs = IMMEDIATE_CLAIM_VALID_FOR_MS;
        feeAccounts = [feeAccounts[0]]; // Only 1 tx needed — no race to win
        log('info', `⚡ IMMEDIATE CLAIM MODE — claimTime ${job.claimTime.toISOString()} is ${((Date.now() - job.claimTime.getTime()) / 1000).toFixed(1)}s in the past — using ${effectiveValidForMs}ms validity window, 1 tx`);
    }

    log('info', `claimant verified on-chain: ${claimantKP.publicKey()} | balanceID=${job.balanceId} amount=${job.balanceAmount} | building ${feeAccounts.length} transactions (validForMs=${effectiveValidForMs})...`);

    const results = await Promise.all(
        feeAccounts.map(async (fa, i) => {
            try {
                const feeKP = await mnemonicToKeypairAt(fa.mnemonic, fa.derivationIndex);
                const client = clients[i % clients.length];
                const feePayerAccount = await loadAccount(client, feeKP.publicKey());

                const { xdr, transaction } = buildMultiSigClaim({
                    claimantKP,
                    feePayerKP: feeKP,
                    feePayerAccount,
                    balanceID: job.balanceId,
                    amount: job.balanceAmount,
                    targetAddress: job.targetAddress,
                    memo: job.memo,
                    // fee: BigInt(job.maxFee),
                    fee: job.maxFee,
                    networkPassphrase: job.passphrase,
                    claimTime: job.claimTime,
                    validForMs: effectiveValidForMs,
                });

                const hash = transaction.hash().toString('hex');
                return { ok: true, tx: { index: i, xdr, transaction, hash, fee: job.maxFee, feeAccount: feeKP.publicKey() } };
            } catch (err) {
                log('warn', `tx ${i} build failed: ${err.message}`);
                return { ok: false, index: i };
            }
        }),
    );

    const txs = results.filter(r => r.ok).map(r => r.tx).sort((a, b) => a.index - b.index);
    if (txs.length === 0) {
        await failWallet(job.walletId, 'all transactions failed to build', cleanup);
        return;
    }

    log('info', `✅ ALL ${txs.length}/${feeAccounts.length} TRANSACTIONS BUILT & SIGNED — ready to fire`);
    for (const tx of txs) {
        log('info', `  tx ${tx.index} — hash=${tx.hash} feeAccount=${tx.feeAccount} baseFee=${tx.fee}`);
    }

    if (isPastClaim) {
        // ── Immediate fire: no scheduling, no busywait ───────────────────────
        log('info', `⚡ FIRING IMMEDIATELY — past claim, submitting now`);
        // Call fire directly (not via setImmediate) to minimize delay
        await fire(jobId, job.walletId, txs, new Date(), clients, cleanup, job.runJobId);
    } else {
        // ── Scheduled claim: normal timed fire ───────────────────────────────
        const now = Date.now();
        const adjustedFireTime = new Date(job.claimTime.getTime() - job.fireBeforeMs);
        const fireDelay = Math.max(0, adjustedFireTime.getTime() - now);
        log('info', `⏰ FIRE SCHEDULED AT ${adjustedFireTime.toISOString()} (in ${(fireDelay / 1000).toFixed(1)}s) — ${job.fireBeforeMs}ms before claimTime ${job.claimTime.toISOString()}`);
        setTimeout(() => fire(jobId, job.walletId, txs, adjustedFireTime, clients, cleanup, job.runJobId), fireDelay);
    }
}

// ── Fire function ────────────────────────────────────────────────────────────
async function fire(jobId, walletId, feeBumps, fireTime, clients, cleanup, runJobId) {
    const log = (level, msg) => logger[level](`[claim/fire] job=${jobId} ${msg}`);

    const deadline = fireTime.getTime();
    /**
     * Commented to improve the tx submittion speed
     */
    // while (Date.now() < deadline - BUSYWAIT_LEAD_MS) {
    //     await new Promise(resolve => setImmediate(resolve));
    // }
    // while (Date.now() < deadline) { /* spin */ }

    const actual = new Date();
    const drift = actual.getTime() - deadline;
    log('info', `🚀 FIRING NOW at ${actual.toISOString()} (drift=${drift.toFixed(3)}ms) — submitting ${feeBumps.length} txs across ${clients.length} nodes`);

    const firedAt = actual;
    try {
        await repo.updateFired(runJobId, firedAt, feeBumps.length);
    } catch (err) {
        log('warn', `failed to update fired_at: ${err.message}`);
    }

    log('info', `submitting ${feeBumps.length} fee bumps partitioned across ${clients.length} nodes (~${Math.ceil(feeBumps.length / clients.length)} per node)`);

    let successCount = 0;
    let lastErr = '';
    let winningHash = '';
    const stats = feeBumps.map(() => ({ accepted: 0, rejected: 0, hash: '', reasons: new Map() }));

    // await Promise.all(
    await Promise.allSettled(
        feeBumps.map(async (bump, idx) => {
            const client = clients[idx % clients.length];
            const submitStart = Date.now();

            try {
                // Submit the stored Transaction object, not the XDR string
                const resp = await client.submitTransaction(bump.transaction);
                console.log("Response for Submited Transaction: ", resp);
                const elapsed = Date.now() - submitStart;
                let queued = false;
                let reason = '';

                //Update transaction in DB after submit
                if (resp && (resp?.successful === true && resp?.hash)) {
                    await updateTxStatus(walletId, resp.hash, resp.ledger);
                }

                if (resp && (resp.hash || resp.id)) {
                    queued = true;
                } else if (resp && resp.status === 'ERROR') {
                    reason = `tx_status=ERROR ${resp.extras?.result_codes?.transaction ?? ''}`;
                } else {
                    reason = `unexpected response: ${JSON.stringify(resp)}`;
                }

                if (!queued) {
                    log('warn', `bump ${bump.index} via ${client.serverURL} — REJECTED (${elapsed}ms) hash=${bump.hash} feeAccount=${bump.feeAccount} baseFee=${bump.fee} reason=${reason}`);
                    stats[idx].rejected++;
                    stats[idx].reasons.set(reason, (stats[idx].reasons.get(reason) ?? 0) + 1);
                    lastErr = reason;
                    return;
                }

                stats[idx].accepted++;
                if (!stats[idx].hash) stats[idx].hash = bump.hash;
                log('info', `bump ${bump.index} via ${client.serverURL} — QUEUED (${elapsed}ms) hash=${bump.hash} feeAccount=${bump.feeAccount} baseFee=${bump.fee}`);
                successCount++;
                if (!winningHash) winningHash = bump.hash;
            } catch (err) {
                const elapsed = Date.now() - submitStart;
                let reason = err.message;
                if (err.response?.data) {
                    const d = err.response.data;
                    console.log('Full error response:', JSON.stringify(d, null, 2));
                    reason = `http=${err.response.status} title=${JSON.stringify(d.title)} detail=${JSON.stringify(d.detail)}`;
                }
                log('warn', `bump ${bump.index} via ${client.serverURL} — REJECTED (${elapsed}ms) hash=${bump.hash} feeAccount=${bump.feeAccount} baseFee=${bump.fee} reason=${reason}`);
                stats[idx].rejected++;
                stats[idx].reasons.set(reason, (stats[idx].reasons.get(reason) ?? 0) + 1);
                lastErr = reason;
            }
        }),
    );

    for (let i = 0; i < feeBumps.length; i++) {
        const bump = feeBumps[i];
        const st = stats[i];
        const reasons = formatReasonCounts(st.reasons);
        if (st.accepted > 0) {
            log('info', `bump ${bump.index} summary — PASS accepted=${st.accepted} failed=${st.rejected} firstHash=${st.hash} reasons=${reasons}`);
        } else {
            log('warn', `bump ${bump.index} summary — FAIL accepted=0 failed=${st.rejected} reasons=${reasons}`);
        }
    }
    log('info', `all submissions complete — ${successCount}/${feeBumps.length} unique bumps accepted by node`);

    if (successCount === 0) {
        await markClaimStatusCond(walletId, 'FAILED', lastErr, '', 'PROCESSING');
        log('warn', `job ${jobId} — wallet marked FAILED (no bumps accepted by node)`);
        cleanup();
        return;
    }

    log('info', `job ${jobId} — ${successCount} bumps accepted`);
    //log('info', `job ${jobId} — ${successCount} bumps accepted, waiting for ledger confirmation...`);
    //await logLedgerStatuses(jobId, walletId, feeBumps, clients, runJobId);
    cleanup();
}


/** Update transaction status in DB */
async function updateTxStatus(walletId, txHash, blockNumber) {
    try {
        await markClaimStatusCond(walletId, 'CLAIMED', '', txHash, 'PROCESSING');
        log('Claimed info: ', `Wallet marked CLAIMED (ledger=${blockNumber} hash=${txHash})`);

        await updateClaimedBlock(walletId, blockNumber);
    } catch (err) {
        log('warn', `failed to persist claimed_block_number: ${err.message}`);
    }
    return true;
}

// ── Ledger status polling ────────────────────────────────────────────────────
async function logLedgerStatuses(jobId, walletId, feeBumps, clients, runJobId) {
    if (feeBumps.length === 0 || clients.length === 0) return;
    const log = (level, msg) => logger[level](`[claim/ledger] job=${jobId} ${msg}`);
    log('info', `checking final block status for ${feeBumps.length} fee bumps`);

    const results = await Promise.all(
        feeBumps.map(async (bump) => {
            let lastErr = '';
            for (let attempt = 1; attempt <= LEDGER_LOOKUP_ATTEMPTS; attempt++) {
                const client = clients[(bump.index + attempt - 1) % clients.length];
                try {
                    const tx = await client.transactions().transaction(bump.hash).call();
                    const status = tx.successful ? 'SUCCESS' : 'FAILED';
                    log('info', `bump ${bump.index} — LANDED ${status} hash=${bump.hash} ledger=${tx.ledger} feeCharged=${tx.fee_charged} maxFee=${tx.max_fee} feeAccount=${bump.feeAccount}`);
                    return { index: bump.index, hash: bump.hash, ledger: tx.ledger, success: tx.successful, landed: true };
                } catch (err) {
                    lastErr = err.message;
                    if (attempt < LEDGER_LOOKUP_ATTEMPTS) await new Promise(r => setTimeout(r, LEDGER_LOOKUP_INTERVAL_MS));
                }
            }
            log('warn', `bump ${bump.index} — NOT_FOUND hash=${bump.hash} feeAccount=${bump.feeAccount} baseFee=${bump.fee} lastErr=${lastErr}`);
            return { index: bump.index, hash: bump.hash, ledger: 0, success: false, landed: false };
        }),
    );

    let landed = 0, notFound = 0, succeeded = 0;
    let winningHash = '', winningLedger = 0;
    const seenLedgers = new Set();
    for (const r of results) {
        if (r.landed) {
            landed++;
            seenLedgers.add(r.ledger);
            if (r.success) {
                succeeded++;
                if (!winningHash) { winningHash = r.hash; winningLedger = r.ledger; }
            }
        } else {
            notFound++;
        }
    }
    log('info', `summary — landed=${landed} notFound=${notFound} succeeded=${succeeded} blocks=[${[...seenLedgers].join(',')}]`);

    const completedAt = new Date();
    if (succeeded > 0) {
        await markClaimStatusCond(walletId, 'CLAIMED', '', winningHash, 'PROCESSING');
        log('info', `job ${jobId} — wallet marked CLAIMED (ledger=${winningLedger} hash=${winningHash})`);
        try { await updateClaimedBlock(walletId, winningLedger); } catch (err) { log('warn', `failed to persist claimed_block_number: ${err.message}`); }
        await repo.updateCompleted(runJobId, landed, succeeded, completedAt);
    } else {
        let reason = 'all transactions failed — balance not yet claimable, already claimed, or does not exist';
        if (landed === 0) reason = 'transactions not found on chain';
        await markClaimStatusCond(walletId, 'FAILED', reason, '', 'PROCESSING');
        log('warn', `job ${jobId} — wallet marked FAILED (${reason})`);
        await repo.updateCompleted(runJobId, landed, succeeded, completedAt);
    }
}

// ── Public ExecuteClaim ──────────────────────────────────────────────────────
export async function executeClaim(req, userId) {
    logger.info(`[claim/execute] request received — walletID=${req.walletId} network=${req.network} txCount=${req.txCount} minFee=${req.minFee} maxFee=${req.maxFee} fireBeforeMs=${req.fireBeforeMs} memo="${req.memo ?? ''}"`);

    if (req.minFee > req.maxFee) throw Errors.ErrInvalidFeeRange;
    let validForMs = req.validForMs ?? 0;
    if (validForMs <= 0) validForMs = DEFAULT_VALID_FOR_MS;
    logger.info(`[claim/execute] tx valid window = ${validForMs}ms after claimTime (MaxTime)`);

    const rpcCount = clientPool.lenByNetwork(req.network);
    console.log("Rpc count: ", rpcCount);

    if (rpcCount === 0) throw Errors.ErrNoRPCNodes;
    if (!uuidValidate(req.walletId)) throw Errors.ErrWalletNotFound;

    const w = await getWalletByID(req.walletId);
    if (!w) throw Errors.ErrWalletNotFound;
    if (!w.claim_time) throw Errors.ErrNoClaimTime;
    if (w.claim_status !== 'UNCLAIMED') throw Errors.ErrAlreadyClaimed;

    const jobId = uuidv4();
    if (activeJobs.has(req.walletId)) throw `${Errors.ErrJobAlreadyRunning}: ${activeJobs.get(req.walletId)}`;
    activeJobs.set(req.walletId, jobId);

    try {
        const marked = await markClaimStatusCond(req.walletId, 'PROCESSING', '', '', 'UNCLAIMED');
        if (!marked) {
            activeJobs.delete(req.walletId);
            throw Errors.ErrAlreadyClaimed;
        }

        const targetAddress = await getTargetAddress(userId);
        let feeAccounts = await getDecryptedFeeAccounts(req.txCount, req.network);
        if (feeAccounts.length === 0) throw new Error(Errors.ErrNotEnoughFeeAccounts);
        const mnemonic = await getDecryptedMnemonic(req.walletId);

        // ── Pre-flight: verify claimant can authorize payments (med threshold) ──
        const claimantKP = await mnemonicToKeypair(mnemonic);
        const claimantAddr = claimantKP.publicKey();
        const clients = clientPool.getAllByNetwork(req.network);
        const claimantAccount = await loadAccountFull(clients[0], claimantAddr);

        const medThreshold = claimantAccount.thresholds.med_threshold;
        const masterSigner = claimantAccount.signers.find(s => s.key === claimantAddr);
        const masterWeight = masterSigner?.weight ?? 0;

        logger.info(`[claim/execute] claimant ${claimantAddr} — masterWeight=${masterWeight} medThreshold=${medThreshold} signers=${claimantAccount.signers.length}`);

        if (masterWeight < medThreshold) {
            const detail = `claimant master key weight (${masterWeight}) is below medium threshold (${medThreshold}) — payment operation will fail with op_bad_auth. Account has ${claimantAccount.signers.length} signer(s).`;
            logger.warn(`[claim/execute] REJECTED — ${detail}`);
            // Reset status back to UNCLAIMED so it can be retried after fixing signers
            await markClaimStatusCond(req.walletId, 'UNCLAIMED', '', '', 'PROCESSING');
            throw new Error(`${Errors.ErrClaimantMultisig}: ${detail}`);
        }

        const actualTxCount = feeAccounts.length;

        await repo.createRun({
            jobId,
            walletId: req.walletId,
            network: req.network,
            txCount: actualTxCount,
            minFee: req.minFee,
            maxFee: req.maxFee,
            memo: req.memo ?? '',
            fireBeforeMs: req.fireBeforeMs ?? 0,
            scheduledAt: new Date(),
            userId,
        }).catch(err => logger.warn(`[claim/execute] failed to create run record: ${err.message}`));

        const claimTime = new Date(w.claim_time);
        const job = {
            walletId: req.walletId,
            mnemonic,
            claimTime,
            txCount: actualTxCount,
            minFee: req.minFee,
            maxFee: req.maxFee,
            validForMs,
            targetAddress,
            memo: req.memo ?? '',
            fireBeforeMs: req.fireBeforeMs ?? 0,
            network: req.network,
            passphrase: networkPassphrase(req.network),
            balanceId: w.balance_id,
            balanceAmount: stroopsToPi(BigInt(w.claim_amount)),
            runJobId: jobId,
        };

        const cleanup = () => activeJobs.delete(req.walletId);
        setImmediate(() => preload(jobId, job, feeAccounts, cleanup).catch(err => {
            logger.error(`[claim/preload] unhandled error: ${err.message ?? err}`);
            cleanup();
        }));

        logger.info(`[claim] job ${jobId} scheduled — walletID=${req.walletId} txCount=${actualTxCount} claimTime=${claimTime.toISOString()} fireBeforeMs=${req.fireBeforeMs ?? 0} memo="${req.memo ?? ''}" — preload starting immediately`);
        return {
            jobId,
            walletId: req.walletId,
            txCount: actualTxCount,
            claimTime,
            fireBeforeMs: req.fireBeforeMs ?? 0,
            status: 'scheduled',
            message: `${actualTxCount} transactions scheduled, firing ${req.fireBeforeMs ?? 0}ms before ${claimTime.toISOString()}`,
        };
    } catch (err) {
        activeJobs.delete(req.walletId);
        if (err.message?.includes(Errors.ErrNotEnoughFeeAccounts)) throw Errors.ErrNotEnoughFeeAccounts;
        if (err.message?.includes(Errors.ErrNoTargetAddress)) throw Errors.ErrNoTargetAddress;
        throw err;
    }
}

export function clearActiveJobs() { activeJobs.clear(); }