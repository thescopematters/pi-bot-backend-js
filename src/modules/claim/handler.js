/**
 * Claim HTTP handler.
 * Mirrors Go's internal/modules/claim/handler.go.
 */

import { executeClaim } from './service.js';
import { Errors } from './errors.js';
import { successResponse, errorResponse } from '../../common/response.js';

/**
 * POST /claim/execute
 * Mirrors Go's Handler.Execute — validates body, extracts userID from JWT middleware,
 * calls service, and maps errors to HTTP status codes.
 */
export async function execute(req, res) {
    const { walletId, network, txCount, minFee, maxFee, memo, fireBeforeMs, validForMs } = req.body ?? {};

    // Required field validation (mirrors gin ShouldBindJSON binding:"required")
    if (!walletId || !network || txCount == null || minFee == null || maxFee == null) {
        return errorResponse(res, 400, 'invalid_request');
    }
    if (!['MAINNET', 'TESTNET'].includes(network)) {
        return errorResponse(res, 400, 'invalid_request');
    }
    if (typeof txCount !== 'number' || txCount < 1) {
        return errorResponse(res, 400, 'invalid_request');
    }

    // userID is set by auth middleware (mirrors c.Get("userID"))
    const userId = req.user?.id;
    if (!userId) {
        return errorResponse(res, 401, 'unauthorized');
    }

    try {
        const result = await executeClaim(
            { walletId, network, txCount, minFee, maxFee, memo, fireBeforeMs, validForMs },
            userId,
        );
        return successResponse(res, 'claim_scheduled_successfully', result);
    } catch (err) {
        return writeClaimError(res, err);
    }
}

/** Maps claim errors to HTTP status codes — mirrors Go writeClaimError. */
function writeClaimError(res, err) {
    const msg = typeof err === 'string' ? err : (err?.message ?? 'internal_error');

    if (msg === Errors.ErrWalletNotFound) {
        return errorResponse(res, 404, msg);
    }
    if (msg === Errors.ErrNoClaimTime) {
        return errorResponse(res, 400, msg);
    }
    if (msg === Errors.ErrAlreadyClaimed) {
        return errorResponse(res, 409, msg);
    }
    if (msg.startsWith(Errors.ErrJobAlreadyRunning)) {
        return errorResponse(res, 409, msg);
    }
    if (msg === Errors.ErrNotEnoughFeeAccounts) {
        return errorResponse(res, 400, msg);
    }
    if (msg === Errors.ErrNoTargetAddress) {
        return errorResponse(res, 400, msg);
    }
    if (msg === Errors.ErrNoRPCNodes) {
        return errorResponse(res, 503, msg);
    }
    if (msg === Errors.ErrInvalidFeeRange) {
        return errorResponse(res, 400, msg);
    }

    // Log the complete error stack trace for 500 Internal Server errors to help debugging
    console.error('[claim/handler] 500 internal_error:', err);

    // Fallback: send the exact JS/DB runtime error directly to Postman so we can see what crashed!
    return errorResponse(res, 500, `internal_error: ${err?.message ?? err}`);
}
