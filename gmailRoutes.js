const express = require('express');
const router = express.Router();
const { verifyToken } = require('./authMiddleware');
const { csrfProtection } = require('./csrf');
const {
    getGmailAuthUrl,
    handleGmailCallback,
    checkGmailStatus,
    disconnectGmail
} = require('./gmailAuthController');

/**
 * GET /api/auth/gmail/url
 * Get Gmail OAuth URL for connecting user's Gmail
 * Requires: Authentication
 */
router.get('/auth/gmail/url', verifyToken, getGmailAuthUrl);

/**
 * GET /api/auth/gmail/callback
 * Gmail OAuth callback endpoint (Google redirects here)
 * Public - no authentication required (uses state parameter)
 */
router.get('/auth/gmail/callback', handleGmailCallback);

/**
 * GET /api/auth/gmail/status
 * Check if user's Gmail is connected
 * Requires: Authentication
 */
router.get('/auth/gmail/status', verifyToken, checkGmailStatus);

/**
 * POST /api/auth/gmail/disconnect
 * Disconnect user's Gmail
 * Requires: Authentication + CSRF protection
 */
router.post('/auth/gmail/disconnect', verifyToken, csrfProtection, disconnectGmail);

module.exports = router;
