/**
 * Stellar transaction building for Pi Network claim operations.
 * Mirrors Go's internal/blockchain/transaction.go — specifically BuildMultiSigClaim.
 *
 * Strategy: every fee-payer produces a UNIQUE transaction (different sequence number →
 * different hash). All N land in the ledger simultaneously: 1 succeeds claiming the
 * balance, N-1 fail with op_no_claimable_balance. Matches the JS parallel-race strategy.
 */

import pkg from '@stellar/stellar-sdk';
const {
    TransactionBuilder,
    Networks,
    Operation,
    Asset,
    Memo,
    Account,
} = pkg;
import { piToStroops, stroopsToPi } from './account.js';

/**
 * Build and sign a multi-sig claim transaction where:
 *  - feePayerAccount is the source account (their sequence is consumed, they pay the fee)
 *  - claimantKP is the operation-level source for both ops (claim + payment)
 *  - Both sign the transaction
 *
 * Mirrors Go's BuildMultiSigClaim exactly, including:
 *  - Subtract 1 stroop from payment amount to avoid underfunded errors
 *  - 28-byte memo truncation
 *  - MaxTime = claimTime + validForMs (MinTime = 0)
 *
 * @param {object} params
 * @param {import('@stellar/stellar-sdk').Keypair} params.claimantKP
 * @param {import('@stellar/stellar-sdk').Keypair} params.feePayerKP
 * @param {{ accountID: string, sequence: string }} params.feePayerAccount  loaded account
 * @param {string}  params.balanceID
 * @param {string}  params.amount          Pi amount string e.g. "10.0000000"
 * @param {string}  params.targetAddress
 * @param {string}  params.memo
 * @param {bigint}  params.fee             base fee in stroops
 * @param {string}  params.networkPassphrase
 * @param {Date}    params.claimTime
 * @param {number}  params.validForMs
 * @returns {{ xdr: string, transaction: import('@stellar/stellar-sdk').Transaction }}
 */
export function buildMultiSigClaim({
    claimantKP,
    feePayerKP,
    feePayerAccount,
    balanceID,
    amount,
    targetAddress,
    memo,
    fee,
    networkPassphrase,
    claimTime,
    validForMs,
}) {
    // Subtract 1 stroop from payment to avoid underfunded errors
    const payStroops = piToStroops(amount) - 1n;
    const payAmount = stroopsToPi(payStroops);

    // Always create a Memo object (even if none)
    let memoObj = Memo.none();
    if (memo && typeof memo === 'string' && memo.trim().length > 0) {
        // Stellar memo text is max 28 bytes.
        const truncated = Buffer.byteLength(memo, 'utf8') > 28
            ? Buffer.from(memo, 'utf8').subarray(0, 28).toString('utf8')
            : memo;
        memoObj = Memo.text(truncated);
    }

    // MaxTime = claimTime + validForMs. MinTime = 0
    const maxTime = Math.floor(claimTime.getTime() / 1000) + Math.floor(validForMs / 1000);

    const account = new Account(feePayerAccount.accountID, feePayerAccount.sequence);

    const builder = new TransactionBuilder(account, {
        fee: fee.toString(),
        networkPassphrase,
        timebounds: { minTime: 0, maxTime },
    });

    // Always add memo (even if Memo.none())
    builder.addMemo(memoObj);

    builder.addOperation(
        Operation.claimClaimableBalance({
            balanceId: balanceID,
            source: claimantKP.publicKey(),
        }),
    );

    builder.addOperation(
        Operation.payment({
            destination: targetAddress,
            asset: Asset.native(),
            amount: payAmount,
            source: claimantKP.publicKey(),
        }),
    );

    const tx = builder.build();
    // Both fee payer and claimant must sign
    // tx.sign(feePayerKP, claimantKP);
    tx.sign(feePayerKP);
    tx.sign(claimantKP);

    return {
        xdr: tx.toEnvelope().toXDR('base64'),
        transaction: tx,
    };
}

/**
 * Derive the transaction hash from a base64 XDR envelope string.
 * @param {string} xdrBase64
 * @param {string} networkPassphrase
 * @returns {string}  hex hash
 */
export function transactionHashFromXDR(xdrBase64, networkPassphrase) {
    const tx = TransactionBuilder.fromXDR(xdrBase64, networkPassphrase);
    return tx.hash().toString('hex');
}

export const transactionHashFromXDRSync = transactionHashFromXDR;