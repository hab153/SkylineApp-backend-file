// historyRoutes.js
const express = require('express');
const router = express.Router();
const { verifyToken } = require('./authMiddleware');
const HistoryController = require('./HistoryController');

// ── Get all sessions for the authenticated user ──
// GET /api/history/sessions
router.get('/sessions', verifyToken, HistoryController.getSessions);

// ── Get messages for a specific session ──
// GET /api/history/messages/:sessionId
router.get('/messages/:sessionId', verifyToken, HistoryController.getSessionMessages);

// ── Rename a session ──
// PUT /api/history/rename/:sessionId
router.put('/rename/:sessionId', verifyToken, HistoryController.renameSession);

// ── Toggle pin status ──
// PUT /api/history/pin/:sessionId
router.put('/pin/:sessionId', verifyToken, HistoryController.togglePin);

// ── Delete a session and all its messages ──
// DELETE /api/history/delete/:sessionId
router.delete('/delete/:sessionId', verifyToken, HistoryController.deleteSession);

module.exports = router;
