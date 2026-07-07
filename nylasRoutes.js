const express = require('express');
const router = express.Router();
const { verifyToken } = require('./authMiddleware');
const { csrfProtection } = require('./csrf');
const {
    getNylasAuthUrl,
    handleNylasCallback,
    checkNylasStatus,
    disconnectNylas
} = require('./nylasAuthController');

/**
 * GET /api/auth/nylas/url
 * Get Nylas OAuth URL for connecting user's email
 * Requires: Authentication
 */
router.get('/auth/nylas/url', verifyToken, getNylasAuthUrl);

/**
 * GET /api/auth/nylas/callback
 * Nylas OAuth callback endpoint (Nylas redirects here)
 * Public - no authentication required
 */
router.get('/auth/nylas/callback', handleNylasCallback);

/**
 * GET /api/auth/nylas/status
 * Check if user's Nylas is connected
 * Requires: Authentication
 */
router.get('/auth/nylas/status', verifyToken, checkNylasStatus);

/**
 * POST /api/auth/nylas/disconnect
 * Disconnect user's Nylas
 * Requires: Authentication + CSRF protection
 */
router.post('/auth/nylas/disconnect', verifyToken, csrfProtection, disconnectNylas);

module.exports = router;
