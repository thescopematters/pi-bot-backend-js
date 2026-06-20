/**
 * Horizon RPC client pool.
 * Mirrors Go's internal/blockchain/client.go ClientPool.
 *
 * Loads active RPC nodes from the `rpcs` DB table (network keyed).
 * Provides round-robin + all-by-network access.
 */

import pkg from '@stellar/stellar-sdk';
const { Horizon } = pkg;
import pool from '../config/db.js';
import logger from '../common/logger.js';

export class ClientPool {
    constructor() {
        /** @type {Map<string, Server[]>} network → Server[] */
        this._clients = new Map();
        this._counter = 0;
    }

    /**
     * Load (or reload) all active RPC URLs from the DB.
     * Must be called once at startup before any claim is executed.
     */
    async load() {
        const result = await pool.query(
            `SELECT url, network FROM rpcs WHERE status = 'ACTIVE'`,
        );
        const rows = result.rows;

        if (rows.length === 0) {
            throw new Error('no active RPC nodes available');
        }

        /** @type {Map<string, Server[]>} */
        const clients = new Map();
        for (const row of rows) {
            const net = row.network.toUpperCase();
            if (!clients.has(net)) clients.set(net, []);
            clients.get(net).push(new Horizon.Server(row.url, { allowHttp: row.url.startsWith('http://') }));
        }

        this._clients = clients;

        for (const [net, list] of clients.entries()) {
            logger.info(`blockchain: loaded ${list.length} active ${net} RPC node(s)`);
        }
    }

    /**
     * Returns all active Server instances for the given network.
     * @param {string} network  'MAINNET' | 'TESTNET'
     * @returns {Server[]}
     */
    getAllByNetwork(network) {
        const key = network.toUpperCase();
        const list = this._clients.get(key) ?? [];
        console.log(`[clientPool] getAllByNetwork — network=${key} clients=${list.length}${list.length > 0 ? ' urls=[' + list.map(c => c.serverURL?.toString() ?? '?').join(', ') + ']' : ' (NONE)'}`);
        return list;
    }

    /**
     * Returns the count of active nodes for the given network.
     * @param {string} network
     * @returns {number}
     */
    lenByNetwork(network) {
        const count = (this._clients.get(network.toUpperCase()) ?? []).length;
        console.log(`[clientPool] lenByNetwork — network=${network.toUpperCase()} count=${count}`);
        return count;
    }

    /**
     * Round-robin: returns any one active client across all networks.
     * @returns {Server}
     */
    get() {
        const all = [];
        for (const list of this._clients.values()) all.push(...list);
        if (all.length === 0) {
            console.error('[clientPool] get FAILED — no active RPC nodes available');
            throw new Error('no active RPC nodes available');
        }
        const idx = this._counter++ % all.length;
        console.log(`[clientPool] get — round-robin idx=${idx}/${all.length} url=${all[idx].serverURL?.toString() ?? '?'}`);
        return all[idx];
    }

    /**
     * Total active clients across all networks.
     * @returns {number}
     */
    len() {
        let total = 0;
        for (const list of this._clients.values()) total += list.length;
        return total;
    }
}

// Singleton instance — call `await clientPool.load()` at startup.
export const clientPool = new ClientPool();
