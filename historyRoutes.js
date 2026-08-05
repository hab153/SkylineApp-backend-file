// historyRoutes.js
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { verifyToken } = require('./authMiddleware');
const HistoryController = require('./HistoryController');

// ─── ✅ FIX #46-#55: Rate limiters for all history routes ───

// Read operations: 60 requests per 15 minutes per user
const historyReadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 60,
    keyGenerator: (req) => req.userId || req.ip,
    message: { success: false, message: 'Too many history requests. Please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Write operations (rename, pin, delete): 20 requests per 15 minutes per user
const historyWriteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    keyGenerator: (req) => req.userId || req.ip,
    message: { success: false, message: 'Too many history modification requests. Please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// ── Get all sessions for the authenticated user ──
// GET /api/history/sessions
router.get('/sessions', historyReadLimiter, verifyToken, HistoryController.getSessions);

// ── Get messages for a specific session ──
// GET /api/history/messages/:sessionId
router.get('/messages/:sessionId', historyReadLimiter, verifyToken, HistoryController.getSessionMessages);

// ── Rename a session ──
// PUT /api/history/rename/:sessionId
router.put('/rename/:sessionId', historyWriteLimiter, verifyToken, HistoryController.renameSession);

// ── Toggle pin status ──
// PUT /api/history/pin/:sessionId
router.put('/pin/:sessionId', historyWriteLimiter, verifyToken, HistoryController.togglePin);

// ── Delete a session and all its messages ──
// DELETE /api/history/delete/:sessionId
router.delete('/delete/:sessionId', historyWriteLimiter, verifyToken, HistoryController.deleteSession);

module.exports = router;
