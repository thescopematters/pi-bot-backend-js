/**
 * JWT authentication middleware.
 * Mirrors Go's internal/modules/user/middleware.go.
 *
 * Reads Authorization: Bearer <token>, verifies with JWT_SECRET,
 * and sets req.user = { id, email } (mirrors c.Set("userID", ...)).
 */

import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { errorResponse } from '../common/response.js';

export function authMiddleware(req, res, next) {
    const authHeader = req.headers['authorization'] ?? '';
    if (!authHeader.startsWith('Bearer ')) {
        return errorResponse(res, 401, 'unauthorized');
    }
    const token = authHeader.slice(7);

    try {
        const claims = jwt.verify(token, env.jwt.secret, {
            issuer: env.jwt.issuer,
        });
        // Go stores userID in the context as "id" claim
        req.user = { id: claims.id, email: claims.email };
        next();
    } catch {
        return errorResponse(res, 401, 'unauthorized');
    }
}
