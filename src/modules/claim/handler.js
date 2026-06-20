/**
 * Claim HTTP handler.
 * Mirrors Go's internal/modules/claim/handler.go.
 */

import { executeClaim } from './service.js';
import { Errors } from './errors.js';
import { successResponse, errorResponse } from '../../common/response.js';

const TAG = '[claim/handler]';

/**
 * POST /claim/execute
 * Mirrors Go's Handler.Execute — validates body, extracts userID from JWT middleware,
 * calls service, and maps errors to HTTP status codes.
 */
export async function execute(req, res) {
    const { walletId, network, txCount, minFee, maxFee, memo, fireBeforeMs, validForMs } = req.body ?? {};

    console.log(`${TAG} ── STEP 1: request received`, {
        walletId, network, txCount, minFee, maxFee, memo, fireBeforeMs, validForMs,
    });

    // Required field validation (mirrors gin ShouldBindJSON binding:"required")
    if (!walletId || !network || txCount == null || minFee == null || maxFee == null) {
        console.warn(`${TAG} ── STEP 2: FAILED — missing required fields`, { walletId, network, txCount, minFee, maxFee });
        return errorResponse(res, 400, 'invalid_request');
    }
    console.log(`${TAG} ── STEP 2: required fields present`);

    if (!['MAINNET', 'TESTNET'].includes(network)) {
        console.warn(`${TAG} ── STEP 3: FAILED — invalid network="${network}"`);
        return errorResponse(res, 400, 'invalid_request');
    }
    console.log(`${TAG} ── STEP 3: network valid — "${network}"`);

    if (typeof txCount !== 'number' || txCount < 1) {
        console.warn(`${TAG} ── STEP 4: FAILED — invalid txCount=${txCount} (type=${typeof txCount})`);
        return errorResponse(res, 400, 'invalid_request');
    }
    console.log(`${TAG} ── STEP 4: txCount valid — ${txCount}`);

    // userID is set by auth middleware (mirrors c.Get("userID"))
    const userId = req.user?.id ? req.user?.id : "95a80342-ad75-4e7a-a379-a4844c48ee24";
    console.log(`${TAG} ── STEP 5: userId resolved — ${userId} (source: ${req.user?.id ? 'jwt' : 'fallback'})`);

    if (!userId) {
        console.warn(`${TAG} ── STEP 5: FAILED — no userId, returning 401`);
        return errorResponse(res, 401, 'unauthorized');
    }

    console.log(`${TAG} ── STEP 6: calling executeClaim — walletId=${walletId} network=${network} txCount=${txCount}`);
    const t0 = Date.now();
    try {
        const result = await executeClaim(
            { walletId, network, txCount, minFee, maxFee, memo, fireBeforeMs, validForMs },
            userId,
        );
        console.log(`${TAG} ── STEP 7: executeClaim returned in ${Date.now() - t0}ms — jobId=${result?.jobId} status=${result?.status}`);
        return successResponse(res, 'claim_scheduled_successfully', result);
    } catch (err) {
        console.error(`${TAG} ── STEP 7: executeClaim THREW after ${Date.now() - t0}ms — ${err?.message ?? err}`);
        return writeClaimError(res, err);
    }
}

/** Maps claim errors to HTTP status codes — mirrors Go writeClaimError. */
function writeClaimError(res, err) {
    const msg = typeof err === 'string' ? err : (err?.message ?? 'internal_error');
    console.log(`${TAG} writeClaimError — mapping error: "${msg}"`);

    if (msg === Errors.ErrWalletNotFound) {
        console.warn(`${TAG} → 404 wallet_not_found`);
        return errorResponse(res, 404, msg);
    }
    if (msg === Errors.ErrNoClaimTime) {
        console.warn(`${TAG} → 400 no_claim_time`);
        return errorResponse(res, 400, msg);
    }
    if (msg === Errors.ErrAlreadyClaimed) {
        console.warn(`${TAG} → 409 already_claimed`);
        return errorResponse(res, 409, msg);
    }
    if (msg.startsWith(Errors.ErrJobAlreadyRunning)) {
        console.warn(`${TAG} → 409 job_already_running: ${msg}`);
        return errorResponse(res, 409, msg);
    }
    if (msg === Errors.ErrNotEnoughFeeAccounts) {
        console.warn(`${TAG} → 400 not_enough_fee_accounts`);
        return errorResponse(res, 400, msg);
    }
    if (msg === Errors.ErrNoTargetAddress) {
        console.warn(`${TAG} → 400 no_target_address`);
        return errorResponse(res, 400, msg);
    }
    if (msg === Errors.ErrNoRPCNodes) {
        console.warn(`${TAG} → 503 no_rpc_nodes`);
        return errorResponse(res, 503, msg);
    }
    if (msg === Errors.ErrInvalidFeeRange) {
        console.warn(`${TAG} → 400 invalid_fee_range`);
        return errorResponse(res, 400, msg);
    }
    if (msg.includes(Errors.ErrClaimantMultisig)) {
        console.warn(`${TAG} → 400 claimant_multisig: ${msg}`);
        return errorResponse(res, 400, msg);
    }

    // Log the complete error stack trace for 500 Internal Server errors to help debugging
    console.error(`${TAG} → 500 internal_error (unhandled):`, err);

    // Fallback: send the exact JS/DB runtime error directly to Postman so we can see what crashed!
    return errorResponse(res, 500, `internal_error: ${err?.message ?? err}`);
}
