/**
 * Express app setup.
 * Mounts the /claim router with JSON body parsing.
 */

import express from 'express';
import claimRoutes from './modules/claim/routes.js';

import pool from './config/db.js';
import { clearActiveJobs } from './modules/claim/service.js';

const app = express();

app.use(express.json());

// Mount claim routes under /claim
app.use('/claim', claimRoutes);

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/debug/clear-jobs', (_req, res) => {
    clearActiveJobs();
    res.json({ ok: true, message: 'All active jobs cleared' });
});

app.get('/health/db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ ok: true, time: result.rows[0].now });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

export default app;
