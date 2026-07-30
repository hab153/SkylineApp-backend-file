// assistantRoutes.js
const express = require('express');
const router = express.Router();
const { verifyToken } = require('./authMiddleware');
const { checkAssistantLimit } = require('./dailyLimitMiddleware');

// ✅ DEFENSIVE IMPORT WITH DEBUG LOGGING
let assistantChat;
try {
    const controller = require('./assistantController');
    console.log(' [ROUTES] assistantController loaded:', Object.keys(controller));
    
    if (typeof controller.assistantChat !== 'function') {
        throw new Error(`assistantChat is ${typeof controller.assistantChat}, expected function`);
    }
    assistantChat = controller.assistantChat;
    console.log('✅ [ROUTES] assistantChat imported successfully');
} catch (err) {
    console.error('❌ [ROUTES] Failed to load assistantController:', err.message);
    console.error(' [ROUTES] Stack:', err.stack);
    // Create a fallback handler so the server doesn't crash
    assistantChat = (req, res) => {
        res.status(503).json({ 
            error: 'Assistant service unavailable due to configuration error' 
        });
    };
}

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
