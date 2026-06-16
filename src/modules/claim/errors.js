/**
 * Claim module error constants.
 * Mirrors Go's internal/modules/claim/errors.go.
 */

export const Errors = {
    ErrWalletNotFound: 'wallet_not_found',
    ErrNoClaimTime: 'wallet_has_no_claim_time',
    ErrAlreadyClaimed: 'wallet_already_claimed',
    ErrJobAlreadyRunning: 'claim_job_already_running_for_this_wallet',
    ErrNotEnoughFeeAccounts: 'not_enough_active_fee_accounts',
    ErrNoTargetAddress: 'target_address_not_configured',
    ErrNoRPCNodes: 'no_rpc_nodes_available',
    ErrInvalidFeeRange: 'min_fee_cannot_exceed_max_fee',
    ErrClaimantMultisig: 'claimant_requires_multisig',
};
