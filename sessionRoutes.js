const express = require('express');
const router = express.Router();
const { verifyToken } = require('./authMiddleware');
const {
    getSessions,
    createSession,
    renameSession,
    pinSession,
    deleteSession
} = require('./sessionController');

// Get all sessions for the authenticated user
router.get('/sessions', verifyToken, getSessions);

// Create a new session
router.post('/sessions', verifyToken, createSession);

// Rename a session
router.put('/sessions/:sessionId/rename', verifyToken, renameSession);

// Pin/unpin a session
router.put('/sessions/:sessionId/pin', verifyToken, pinSession);

// Delete a session
router.delete('/sessions/:sessionId', verifyToken, deleteSession);

module.exports = router;
