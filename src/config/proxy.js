/**
 * Outbound proxy configuration for Horizon/Stellar RPC requests.
 *
 * Injects an HTTP(S) or SOCKS5 proxy agent into the Stellar SDK's shared
 * AxiosClient so every outgoing request (loadAccount, submitTransaction,
 * transaction lookups) exits through the proxy — hiding the server's real IP
 * from Horizon node operators and on-chain observers.
 *
 * Supports:
 *   - HTTP/HTTPS proxies:  PROXY_URL=http://user:pass@proxy.example.com:8080
 *   - SOCKS5 proxies:      PROXY_URL=socks5://user:pass@proxy.example.com:1080
 *
 * Set PROXY_URL in .env to enable. Leave unset to bypass.
 */

import pkg from '@stellar/stellar-sdk';
const { Horizon } = pkg;
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import logger from '../common/logger.js';

/**
 * Configure the Stellar SDK's shared Horizon AxiosClient to route all
 * requests through the proxy specified by PROXY_URL.
 *
 * Must be called BEFORE any Horizon.Server instances are used (i.e. before
 * clientPool.load()).
 */
export function configureProxy() {
    const proxyUrl = process.env.PROXY_URL;

    if (!proxyUrl) {
        logger.info('[proxy] PROXY_URL not set — all Horizon requests will use the server\'s direct IP');
        return;
    }

    let agent;
    const lower = proxyUrl.toLowerCase();

    if (lower.startsWith('socks5://') || lower.startsWith('socks4://') || lower.startsWith('socks://')) {
        agent = new SocksProxyAgent(proxyUrl);
        logger.info(`[proxy] SOCKS proxy configured — all Horizon requests will route through ${maskCredentials(proxyUrl)}`);
    } else {
        // HTTP / HTTPS proxy
        agent = new HttpsProxyAgent(proxyUrl);
        logger.info(`[proxy] HTTP(S) proxy configured — all Horizon requests will route through ${maskCredentials(proxyUrl)}`);
    }

    // The Stellar SDK v13's Horizon module uses a single shared axios instance
    // (Horizon.AxiosClient) for every HTTP call — loadAccount, submitTransaction,
    // transactions().call(), etc. Hooking its request interceptor injects the
    // proxy agent into every outgoing request without touching business logic.
    Horizon.AxiosClient.interceptors.request.use((config) => {
        config.httpAgent = agent;
        config.httpsAgent = agent;
        return config;
    });

    logger.info('[proxy] Stellar SDK AxiosClient interceptor installed — all Horizon traffic is now proxied');
}

/**
 * Mask credentials in a proxy URL for safe logging.
 * e.g. "http://user:secret@host:8080" → "http://***:***@host:8080"
 */
function maskCredentials(urlStr) {
    try {
        const u = new URL(urlStr);
        if (u.username || u.password) {
            u.username = '***';
            u.password = '***';
        }
        return u.toString();
    } catch {
        return '<invalid-url>';
    }
}
