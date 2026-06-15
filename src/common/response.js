/**
 * Standard API response helpers.
 * Mirrors Go's common/response.go: SuccessResponse / ErrorResponse.
 */

/**
 * @param {import('express').Response} res
 * @param {string} message
 * @param {any} data
 */
export function successResponse(res, message, data) {
    const body = { error: false, statuscode: 200, message };
    if (data !== undefined && data !== null) body.data = data;
    res.status(200).json(body);
}

/**
 * @param {import('express').Response} res
 * @param {number} statusCode
 * @param {string} message
 */
export function errorResponse(res, statusCode, message) {
    res.status(statusCode).json({ error: true, statuscode: statusCode, message });
}
