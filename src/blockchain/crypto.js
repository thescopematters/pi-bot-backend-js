/**
 * AES-256-GCM encryption/decryption — exact port of Go's wallet/crypto.go.
 *
 * Ciphertext format: base64( nonce(12B) + ciphertext + GCM-tag(16B) )
 * Key: 32-byte Buffer decoded from base64 WALLET_ENCRYPTION_KEY.
 */

import crypto from 'crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const NONCE_SIZE = 12; // Go's GCM NonceSize()
const TAG_SIZE = 16; // GCM auth tag length

/** Lazily decoded key from env */
let _key = null;
function getKey() {
    if (!_key) {
        _key = Buffer.from(env.walletEncryptionKey, 'base64');
        if (_key.length !== 32) {
            throw new Error('WALLET_ENCRYPTION_KEY must decode to exactly 32 bytes');
        }
    }
    return _key;
}

/**
 * Decrypt a mnemonic that was encrypted by Go's encrypt() function.
 *
 * @param {string} encoded  base64( nonce + ciphertext + tag )
 * @returns {string}         plaintext mnemonic
 */
const CRYPTO_TAG = '[crypto]';

export function decrypt(encoded) {
    console.log(`${CRYPTO_TAG} decrypt — encoded length=${encoded?.length ?? 0} chars`);
    const data = Buffer.from(encoded, 'base64');
    console.log(`${CRYPTO_TAG} decrypt — decoded ${data.length} bytes (min required=${NONCE_SIZE + TAG_SIZE})`);
    if (data.length < NONCE_SIZE + TAG_SIZE) {
        console.error(`${CRYPTO_TAG} decrypt FAILED — ciphertext too short (${data.length} < ${NONCE_SIZE + TAG_SIZE})`);
        throw new Error('ciphertext too short');
    }
    const nonce = data.subarray(0, NONCE_SIZE);
    const tag = data.subarray(data.length - TAG_SIZE);
    const ciphertext = data.subarray(NONCE_SIZE, data.length - TAG_SIZE);
    console.log(`${CRYPTO_TAG} decrypt — nonce=${nonce.length}B tag=${tag.length}B ciphertext=${ciphertext.length}B`);

    console.log(`${CRYPTO_TAG} decrypt — creating AES-256-GCM decipher...`);
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), nonce);
    decipher.setAuthTag(tag);

    try {
        const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        console.log(`${CRYPTO_TAG} decrypt OK — plaintext ${plain.length} bytes`);
        return plain.toString('utf8');
    } catch (err) {
        console.error(`${CRYPTO_TAG} decrypt FAILED — AES-GCM auth/decrypt error: ${err.message}`);
        throw err;
    }
}

/**
 * Encrypt plaintext (mirrors Go encrypt — useful for tests).
 *
 * @param {string} plaintext
 * @returns {string}  base64( nonce + ciphertext + tag )
 */
export function encrypt(plaintext) {
    const nonce = crypto.randomBytes(NONCE_SIZE);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), nonce);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, enc, tag]).toString('base64');
}
