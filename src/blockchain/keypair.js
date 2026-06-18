/**
 * BIP-44 / SLIP-0010 Ed25519 hardened key derivation for Pi Network.
 *
 * Pi Network BIP-44 path: m/44'/314159'/{index}'
 * All segments are hardened (required for Ed25519).
 *
 * Mirrors Go's internal/blockchain/keypair.go exactly.
 */

import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import pkg from '@stellar/stellar-sdk';
const { Keypair } = pkg;
import { validateMnemonic, mnemonicToSeedSync, mnemonicToSeed } from 'bip39';

const SEED_MODIFIER = 'ed25519 seed';
const HARDENED_OFFSET = 0x80000000;
const PATH_REGEX = /^m(\/[0-9]+')+$/;

// ── SLIP-0010 internal helpers ────────────────────────────────────────────────

function newMasterKey(seed) {
    const h = hmac(sha512, SEED_MODIFIER, seed);
    return { key: h.slice(0, 32), chainCode: h.slice(32) };
}

function deriveChild({ key, chainCode }, index) {
    if (index < HARDENED_OFFSET) {
        throw new Error('Only hardened derivation supported for Ed25519');
    }
    const indexBytes = new Uint8Array(4);
    new DataView(indexBytes.buffer).setUint32(0, index, false); // big-endian

    const data = new Uint8Array(1 + 32 + 4);
    data[0] = 0x00;
    data.set(key, 1);
    data.set(indexBytes, 33);

    const h = hmac(sha512, chainCode, data);
    return { key: h.slice(0, 32), chainCode: h.slice(32) };
}

function deriveForPath(path, seed) {
    if (!PATH_REGEX.test(path)) {
        throw new Error(`Invalid BIP-44 derivation path: ${path}`);
    }
    let node = newMasterKey(seed);
    const segments = path.split('/').slice(1); // drop leading "m"
    for (const seg of segments) {
        const idx = parseInt(seg.replace("'", ''), 10);
        node = deriveChild(node, idx + HARDENED_OFFSET);
    }
    return node;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Derives a Stellar Keypair from a BIP-39 mnemonic at the given account index.
 * Path: m/44'/314159'/{index}'
 *
 * @param {string} mnemonic  BIP-39 mnemonic phrase
 * @param {number} index     Account index (default 0)
 * @returns {Keypair}        Stellar SDK Keypair (Full)
 */
export async function mnemonicToKeypairAt(mnemonic, index = 0) {
    const normalized = mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
    if (!validateMnemonic(normalized)) {
        throw new Error('Invalid BIP-39 mnemonic');
    }
    // const seed = mnemonicToSeedSync(normalized); // 64 bytes, no passphrase
    const seed = await mnemonicToSeed(normalized); // 64 bytes, no passphrase
    const path = `m/44'/314159'/${index}'`;
    const { key } = deriveForPath(path, seed);
    // key is 32 bytes — use it as raw ed25519 seed
    return Keypair.fromRawEd25519Seed(Buffer.from(key));
}

/**
 * Convenience: derive at index 0.
 */
export async function mnemonicToKeypair(mnemonic) {
    return mnemonicToKeypairAt(mnemonic, 0);
}
