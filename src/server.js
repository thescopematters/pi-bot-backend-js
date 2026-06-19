/**
 * Server entry point — loads env, initialises DB pool & RPC client pool, starts Express.
 */

import 'dotenv/config';
import app from './app.js';
import { env } from './config/env.js';
import { configureProxy } from './config/proxy.js';
import { clientPool } from './blockchain/clientPool.js';
import logger from './common/logger.js';

async function main() {
    // Configure outbound proxy for all Horizon/Stellar requests (if PROXY_URL is set)
    configureProxy();

    // Load Horizon RPC clients from DB
    try {
        await clientPool.load();
    } catch (err) {
        // Non-fatal at startup: server still starts but claims will fail until RPCs are added.
        logger.warn(`[startup] RPC pool load failed (no active nodes yet): ${err.message}`);
    }

    app.listen(env.port, () => {
        logger.info(`[startup] pibot-nodejs-backend listening on port ${env.port}`);
    });
}

main().catch(err => {
    logger.error(`[startup] fatal: ${err.message}`);
    process.exit(1);
});
