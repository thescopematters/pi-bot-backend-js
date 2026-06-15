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
export async function loadAccount(server, address) {
    const acc = await server.loadAccount(address);
    return { accountID: acc.accountId(), sequence: acc.sequenceNumber() };
}
