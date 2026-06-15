# pibot-nodejs-backend

Node.js port of the **`POST /claim/execute`** endpoint from the Go `pibot-backend`.

> **Scope**: Only the `/claim/execute` API is implemented here — including the full
> async pipeline: preload (parallel transaction building), fire (precision busywait +
> parallel Horizon submission), and ledger status polling.

---

## Stack

| Layer | Technology |
|-------|-----------|
| HTTP server | Express.js |
| Database | PostgreSQL via `pg` (same schema as Go backend) |
| Blockchain | `@stellar/stellar-sdk` |
| Key derivation | `@noble/hashes` + `@noble/ed25519` (SLIP-0010 / BIP-44) |
| Encryption | Node.js `crypto` AES-256-GCM (compatible with Go ciphertext) |
| Logging | `winston` |

---

## Folder Structure

```
src/
├── app.js                    Express app setup
├── server.js                 Entry point
├── config/
│   ├── env.js                Env var loader + validation
│   └── db.js                 pg connection pool
├── blockchain/
│   ├── keypair.js            SLIP-0010 Ed25519 key derivation (Pi BIP-44 path)
│   ├── account.js            loadAccount, piToStroops, stroopsToPi
│   ├── transaction.js        buildMultiSigClaim (mirrors Go BuildMultiSigClaim)
│   ├── clientPool.js         Horizon RPC pool (loaded from rpcs DB table)
│   └── crypto.js             AES-256-GCM decrypt/encrypt (compatible with Go)
├── common/
│   ├── logger.js             winston logger
│   └── response.js           successResponse / errorResponse helpers
├── middleware/
│   └── auth.js               JWT Bearer auth middleware
└── modules/claim/
    ├── errors.js             Error string constants
    ├── repository.js         claim_runs DB operations (raw pg)
    ├── service.js            Core business logic (executeClaim + preload + fire)
    ├── handler.js            Express request handler
    └── routes.js             Router: POST /claim/execute
```

---

## Prerequisites

This service connects to the **same PostgreSQL database** as the Go backend.
The following tables must exist: `wallets`, `users`, `rpcs`, `fee_mnemonics`,
`fee_addresses`, `claim_runs`.

---

## Setup

```bash
cd pibot-nodejs-backend
cp .env.example .env
# Edit .env with your DB credentials, JWT_SECRET, and WALLET_ENCRYPTION_KEY
# (WALLET_ENCRYPTION_KEY must match the Go backend's key exactly)

npm install
npm start
or
node src/server.js
```

Server starts on `PORT` (default 5000).

---

## API

### `POST /claim/execute`

**Headers**: `Authorization: Bearer <jwt_token>`

**Body**:
```json
{
  "walletId":    "uuid",
  "network":     "MAINNET | TESTNET",
  "txCount":     3,
  "minFee":      100,
  "maxFee":      500,
  "memo":        "optional memo (max 28 bytes)",
  "fireBeforeMs": 500,
  "validForMs":  15000
}
```

**Success (200)**:
```json
{
  "error": false,
  "statuscode": 200,
  "message": "claim_scheduled_successfully",
  "data": {
    "jobId": "uuid",
    "walletId": "uuid",
    "txCount": 3,
    "claimTime": "2024-01-01T00:00:00Z",
    "fireBeforeMs": 500,
    "status": "scheduled",
    "message": "3 transactions scheduled, firing 500ms before ..."
  }
}
```

The response is returned immediately. The async pipeline runs in the background.

---

## Concurrency Model

| Go pattern | Node.js equivalent |
|---|---|
| `go s.preload(...)` | `setImmediate(() => preload(...))` |
| `sync.WaitGroup` + goroutines | `Promise.all(...)` |
| `time.AfterFunc(delay, fire)` | `setTimeout(fire, delay)` |
| `sync.Map` (activeJobs) | `new Map()` (safe: single-threaded) |
| CPU busywait (10ms precision) | tight `while` loop after coarse `setImmediate` yields |
