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
const TX_TAG = '[transaction]';

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
    console.log(`${TX_TAG} buildMultiSigClaim START`);
    console.log(`${TX_TAG}   claimant=${claimantKP.publicKey()} feePayer=${feePayerKP.publicKey()}`);
    console.log(`${TX_TAG}   feePayerAccount=${feePayerAccount.accountID} sequence=${feePayerAccount.sequence}`);
    console.log(`${TX_TAG}   balanceID=${balanceID} amount=${amount} targetAddress=${targetAddress}`);
    console.log(`${TX_TAG}   fee=${fee} networkPassphrase="${networkPassphrase}" claimTime=${claimTime.toISOString()} validForMs=${validForMs}`);

    // Subtract 1 stroop from payment to avoid underfunded errors
    const payStroops = piToStroops(amount) - 1n;
    const payAmount = stroopsToPi(payStroops);
    console.log(`${TX_TAG} STEP 1 — amount calc: ${amount} Pi → ${payStroops} stroops → payAmount=${payAmount} (subtracted 1 stroop)`);

    // Always create a Memo object (even if none)
    let memoObj = Memo.none();
    if (memo && typeof memo === 'string' && memo.trim().length > 0) {
        // Stellar memo text is max 28 bytes.
        const truncated = Buffer.byteLength(memo, 'utf8') > 28
            ? Buffer.from(memo, 'utf8').subarray(0, 28).toString('utf8')
            : memo;
        memoObj = Memo.text(truncated);
        console.log(`${TX_TAG} STEP 2 — memo set: "${truncated}" (original="${memo}"${truncated !== memo ? ' TRUNCATED' : ''})`);
    } else {
        console.log(`${TX_TAG} STEP 2 — memo: none`);
    }

    // MaxTime = max(claimTime, now) + validForMs. MinTime = 0
    // When claimTime is in the past, use current time as the base so the tx isn't born expired.
    const now = Date.now();
    const baseTime = Math.max(claimTime.getTime(), now);
    const maxTime = Math.floor(baseTime / 1000) + Math.floor(validForMs / 1000);
    console.log(`${TX_TAG} STEP 3 — timebounds: now=${now} claimTime=${claimTime.getTime()} baseTime=${baseTime} (${baseTime === now ? 'PAST — using now' : 'FUTURE — using claimTime'})`);
    console.log(`${TX_TAG}   maxTime=${maxTime} = floor(${baseTime}/1000)=${Math.floor(baseTime / 1000)} + floor(${validForMs}/1000)=${Math.floor(validForMs / 1000)} | minTime=0`);
    console.log(`${TX_TAG}   maxTime as UTC: ${new Date(maxTime * 1000).toISOString()}`);

    const account = new Account(feePayerAccount.accountID, feePayerAccount.sequence);
    console.log(`${TX_TAG} STEP 4 — Account object created: id=${feePayerAccount.accountID} seq=${feePayerAccount.sequence}`);

    const builder = new TransactionBuilder(account, {
        fee: fee.toString(),
        networkPassphrase,
        timebounds: { minTime: 0, maxTime },
    });
    console.log(`${TX_TAG} STEP 5 — TransactionBuilder created: fee=${fee} network="${networkPassphrase}"`);

    // Always add memo (even if Memo.none())
    builder.addMemo(memoObj);
    console.log(`${TX_TAG} STEP 6 — memo added`);

    builder.addOperation(
        Operation.claimClaimableBalance({
            balanceId: balanceID,
            source: claimantKP.publicKey(),
        }),
    );
    console.log(`${TX_TAG} STEP 7 — op[0] claimClaimableBalance added: balanceId=${balanceID} source=${claimantKP.publicKey()}`);

    builder.addOperation(
        Operation.payment({
            destination: targetAddress,
            asset: Asset.native(),
            amount: payAmount,
            source: claimantKP.publicKey(),
        }),
    );
    console.log(`${TX_TAG} STEP 8 — op[1] payment added: destination=${targetAddress} amount=${payAmount} XLM source=${claimantKP.publicKey()}`);

    const tx = builder.build();
    console.log(`${TX_TAG} STEP 9 — transaction built`);

    tx.sign(feePayerKP);
    console.log(`${TX_TAG} STEP 10 — signed by feePayer=${feePayerKP.publicKey()}`);
    tx.sign(claimantKP);
    console.log(`${TX_TAG} STEP 11 — signed by claimant=${claimantKP.publicKey()}`);

    const hash = tx.hash().toString('hex');
    console.log(`${TX_TAG} STEP 12 — tx hash=${hash}`);
    console.log(`${TX_TAG} buildMultiSigClaim DONE`);

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