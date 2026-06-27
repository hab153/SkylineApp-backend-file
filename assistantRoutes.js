const express = require('express');
const router = express.Router();
const { assistantChat } = require('./assistantController');
const { verifyToken } = require('./authMiddleware');
const { checkAssistantLimit } = require('./dailyLimitMiddleware');

/**
 * POST /api/assistant
 * Requires: JWT token in Authorization header
 * Body: { message: "User's question" }
 * Response: { response: "AI answer", remaining: 19 }
 * 
 * Daily limits: Free=20, Go=70, Pro=200
 */
router.post('/assistant', verifyToken, checkAssistantLimit, assistantChat);

module.exports = router;
