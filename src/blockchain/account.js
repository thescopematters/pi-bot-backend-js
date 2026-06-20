/**
 * Horizon account helpers and Pi currency utilities.
 * Mirrors Go's internal/blockchain/account.go.
 */

/**
 * Converts a Pi Horizon amount string (e.g. "1.5000000") to stroops (int64).
 * 1 Pi = 10,000,000 stroops. Uses string parsing to avoid float64 precision loss.
 * Mirrors Go's PiToStroops.
 *
 * @param {string} amount
 * @returns {bigint}
 */
export function piToStroops(amount) {
    const [whole, frac = ''] = String(amount).trim().split('.');
    const wholePart = BigInt(whole) * 10_000_000n;
    const fracPadded = (frac + '0000000').slice(0, 7);
    return wholePart + BigInt(fracPadded);
}

/**
 * Formats stroops as a Pi amount string with 7 decimal places.
 * Mirrors Go's StroopsToPi.
 *
 * @param {bigint|number} stroops
 * @returns {string}
 */
export function stroopsToPi(stroops) {
    const s = BigInt(stroops);
    const base = 10_000_000n;
    let whole = s / base;
    let frac = s % base;
    if (frac < 0n) frac = -frac;
    return `${whole}.${frac.toString().padStart(7, '0')}`;
}

/**
 * Load a Stellar account from any Horizon node and return a SimpleAccount-like object
 * { accountID, sequence } for use in TransactionBuilder.
 *
 * @param {import('@stellar/stellar-sdk').Server} server  Stellar SDK Server instance
 * @param {string} address                                 Stellar public key
 * @returns {Promise<{ accountID: string, sequence: string }>}
 */
const ACC_TAG = '[account]';
const HORIZON_TIMEOUT_MS = 15000; // 15s — Pi Horizon can be slow

function horizonErrorDetail(err) {
    if (!err) return 'unknown error (null/undefined)';

    // Stellar SDK BadResponseError — Horizon returned 4xx/5xx with JSON body
    if (err?.response?.data && typeof err.response.data === 'object') {
        const d = err.response.data;
        return `HTTP ${err.response.status} title="${d.title ?? '?'}" detail="${d.detail ?? '?'}" extras=${JSON.stringify(d.extras ?? {})}`;
    }

    // Stellar SDK NetworkError — real axios error is stored inside err.response
    // err.response here is NOT an HTTP response, it IS the axios error object
    if (err?.response?.code || err?.response?.message) {
        const ne = err.response;
        return `NetworkError code=${ne.code ?? 'none'} axiosMsg="${ne.message ?? 'none'}" url="${ne.config?.url ?? 'unknown'}"`;
    }

    // Axios error sitting at top level
    if (err?.code) {
        return `AxiosError code=${err.code} message="${err.message}" url="${err.config?.url ?? 'unknown'}"`;
    }

    // Fallback: name + message (may both be empty for SDK errors)
    return `name=${err?.name ?? 'Error'} message="${err?.message || '(empty)'}"`;
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        ),
    ]);
}

export async function loadAccount(server, address) {
    const url = server.serverURL?.toString() ?? 'unknown';
    console.log(`${ACC_TAG} loadAccount — address=${address} server=${url} timeout=${HORIZON_TIMEOUT_MS}ms`);
    const t0 = Date.now();
    try {
        const acc = await withTimeout(
            server.loadAccount(address),
            HORIZON_TIMEOUT_MS,
            `loadAccount(${address})`,
        );
        const result = { accountID: acc.accountId(), sequence: acc.sequenceNumber() };
        console.log(`${ACC_TAG} loadAccount OK (${Date.now() - t0}ms) — accountID=${result.accountID} sequence=${result.sequence}`);
        return result;
    } catch (err) {
        const elapsed = Date.now() - t0;
        const detail = horizonErrorDetail(err);
        console.error(`${ACC_TAG} loadAccount FAILED (${elapsed}ms) — address=${address} server=${url}`);
        console.error(`${ACC_TAG} loadAccount ERROR DETAIL — ${detail}`);
        console.error(`${ACC_TAG} loadAccount RAW ERROR name=${err?.name} message="${err?.message}" code=${err?.code}`);
        if (err?.response) console.error(`${ACC_TAG} loadAccount err.response:`, JSON.stringify(err.response, Object.getOwnPropertyNames(err.response), 2));
        throw err;
    }
}

/**
 * Load a Stellar account with full details (signers, thresholds, flags).
 * Used for pre-flight checks like multisig validation.
 *
 * @param {import('@stellar/stellar-sdk').Server} server
 * @param {string} address
 * @returns {Promise<{
 *   accountID: string,
 *   sequence: string,
 *   signers: Array<{ key: string, weight: number, type: string }>,
 *   thresholds: { low_threshold: number, med_threshold: number, high_threshold: number }
 * }>}
 */
export async function loadAccountFull(server, address) {
    const url = server.serverURL?.toString() ?? 'unknown';
    console.log(`${ACC_TAG} loadAccountFull — address=${address} server=${url} timeout=${HORIZON_TIMEOUT_MS}ms`);
    const t0 = Date.now();
    try {
        console.log(`${ACC_TAG} loadAccountFull STEP 1 — calling server.loadAccount(${address})...`);
        const acc = await withTimeout(
            server.loadAccount(address),
            HORIZON_TIMEOUT_MS,
            `loadAccountFull(${address})`,
        );
        console.log(`${ACC_TAG} loadAccountFull STEP 2 — Horizon responded in ${Date.now() - t0}ms`);
        const result = {
            accountID: acc.accountId(),
            sequence: acc.sequenceNumber(),
            signers: acc.signers,
            thresholds: acc.thresholds,
        };
        console.log(`${ACC_TAG} loadAccountFull OK — accountID=${result.accountID} sequence=${result.sequence} signerCount=${result.signers.length} thresholds=${JSON.stringify(result.thresholds)}`);
        for (const s of result.signers) {
            console.log(`${ACC_TAG}   signer key=${s.key} weight=${s.weight} type=${s.type}`);
        }
        return result;
    } catch (err) {
        const elapsed = Date.now() - t0;
        const detail = horizonErrorDetail(err);
        console.error(`${ACC_TAG} loadAccountFull FAILED (${elapsed}ms) — address=${address} server=${url}`);
        console.error(`${ACC_TAG} loadAccountFull ERROR DETAIL — ${detail}`);
        console.error(`${ACC_TAG} loadAccountFull RAW ERROR name=${err?.name} message="${err?.message}" code=${err?.code}`);
        if (err?.response) {
            console.error(`${ACC_TAG} loadAccountFull err.response:`, JSON.stringify(err.response, Object.getOwnPropertyNames(err.response), 2));
        }

        // ── Raw HTTP probe: bypass the SDK to see exactly what Pi TESTNET returned ──
        const rawUrl = `${url}accounts/${address}`;
        console.error(`${ACC_TAG} RAW HTTP PROBE — GET ${rawUrl}`);
        try {
            const rawResp = await fetch(rawUrl, {
                signal: AbortSignal.timeout(10000),
                headers: { Accept: 'application/json' },
            });
            const rawText = await rawResp.text();
            console.error(`${ACC_TAG} RAW HTTP RESPONSE — status=${rawResp.status} content-type="${rawResp.headers.get('content-type')}"`);
            console.error(`${ACC_TAG} RAW HTTP BODY — ${rawText.slice(0, 2000)}`);
        } catch (probeErr) {
            console.error(`${ACC_TAG} RAW HTTP PROBE FAILED — ${probeErr.name}: ${probeErr.message}`);
            // Node 18+ wraps the real network error in .cause (undici)
            if (probeErr.cause) {
                console.error(`${ACC_TAG} RAW HTTP PROBE CAUSE — code=${probeErr.cause?.code} msg="${probeErr.cause?.message}"`);
            }
        }

        throw err;
    }
}
