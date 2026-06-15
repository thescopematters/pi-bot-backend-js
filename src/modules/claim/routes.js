/**
 * Claim module routes.
 * Mirrors Go's internal/modules/claim/routes.go.
 *
 * POST /claim/execute  — schedule a claimable balance execution
 */

import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { execute } from './handler.js';

const router = Router();

router.post('/execute', authMiddleware, execute);

export default router;
