const express = require('express');
const router = express.Router();
const { assistantChat } = require('./assistantController');
const { verifyToken } = require('./authMiddleware');

/**
 * POST /api/assistant
 * Requires: JWT token in Authorization header
 * Body: { message: "User's question" }
 * Response: { response: "AI answer" }
 */
router.post('/assistant', verifyToken, assistantChat);

module.exports = router;
