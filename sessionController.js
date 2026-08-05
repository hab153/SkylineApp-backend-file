const Session = require('./Session');
const ChatMessage = require('./ChatMessage');
const { isValidObjectId } = require('./sanitize');

/**
 * ✅ Validate and cast userId to String before any DB operation.
 * Returns null if invalid — caller must reject the request.
 */
function getSafeUserId(req) {
    const userId = req.userId;
    if (!userId || !isValidObjectId(userId)) return null;
    return String(userId);
}

/**
 * ✅ Validate sessionId from params or body.
 * Only allows alphanumeric, hyphens, underscores (1-100 chars).
 * Returns null if invalid.
 */
function validateSessionId(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return null;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) return null;
    return sessionId;
}

// Get all sessions for a user
async function getSessions(req, res) {
    try {
        // ✅ FIX #32: Cast userId to String before ANY DB query
        const safeUserId = getSafeUserId(req);
        if (!safeUserId) {
            return res.status(401).json({ error: 'Unauthorized: Invalid user ID' });
        }

        console.log(`📂 [getSessions] Fetching sessions for user: ${safeUserId}`);

        // ✅ FIX #32: Use safeUserId (explicitly String-typed) in query
        const sessions = await Session.find({ userId: safeUserId })
            .sort({ pinned: -1, updatedAt: -1 })
            .lean();

        // Get message count for each session
        const sessionsWithCounts = await Promise.all(sessions.map(async (session) => {
            // ✅ FIX #33: Use safeUserId and String(session.sessionId) in count query
            const count = await ChatMessage.countDocuments({
                userId: safeUserId,
                sessionId: String(session.sessionId)
            });
            return {
                ...session,
                messageCount: count
            };
        }));

        console.log(`📂 [getSessions] Found ${sessionsWithCounts.length} sessions`);
        res.json(sessionsWithCounts);
    } catch (error) {
        console.error('[getSessions] Error:', error.message);
        res.status(500).json({ error: 'Failed to load sessions' });
    }
}

// Create a new session
async function createSession(req, res) {
    try {
        const safeUserId = getSafeUserId(req);
        if (!safeUserId) {
            return res.status(401).json({ error: 'Unauthorized: Invalid user ID' });
        }

        const { sessionId, type, name } = req.body;

        if (!sessionId || !type) {
            return res.status(400).json({ error: 'sessionId and type are required' });
        }

        // ✅ Validate sessionId format
        const safeSessionId = validateSessionId(sessionId);
        if (!safeSessionId) {
            return res.status(400).json({ error: 'Invalid session ID format' });
        }

        // ✅ Validate type
        if (typeof type !== 'string' || !['lead', 'assistant', 'dream'].includes(type)) {
            return res.status(400).json({ error: 'Invalid session type' });
        }

        const safeName = (name && typeof name === 'string') ? name.trim().substring(0, 100) : (type === 'assistant' ? 'Assistant Chat' : 'Lead Search');

        console.log(`📂 [createSession] Creating session for user ${safeUserId}: ${safeSessionId}`);

        // ✅ FIX #32/#33: Use safeUserId and safeSessionId in query
        const session = await Session.findOneAndUpdate(
            { userId: safeUserId, sessionId: safeSessionId },
            {
                userId: safeUserId,
                sessionId: safeSessionId,
                type: String(type),
                name: safeName,
                updatedAt: new Date()
            },
            { upsert: true, new: true }
        );

        res.json(session);
    } catch (error) {
        console.error('[createSession] Error:', error.message);
        res.status(500).json({ error: 'Failed to create session' });
    }
}

// Rename a session
async function renameSession(req, res) {
    try {
        const safeUserId = getSafeUserId(req);
        if (!safeUserId) {
            return res.status(401).json({ error: 'Unauthorized: Invalid user ID' });
        }

        const { sessionId } = req.params;
        const { name } = req.body;

        const safeSessionId = validateSessionId(sessionId);
        if (!safeSessionId) {
            return res.status(400).json({ error: 'Invalid session ID format' });
        }

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const safeName = name.trim().substring(0, 100);

        console.log(`📂 [renameSession] Renaming session ${safeSessionId} for user ${safeUserId}`);

        // ✅ FIX #32/#33: Use safeUserId and safeSessionId in query
        const session = await Session.findOneAndUpdate(
            { userId: safeUserId, sessionId: safeSessionId },
            { name: safeName, updatedAt: new Date() },
            { new: true }
        );

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json(session);
    } catch (error) {
        console.error('[renameSession] Error:', error.message);
        res.status(500).json({ error: 'Failed to rename session' });
    }
}

// Pin/unpin a session
async function pinSession(req, res) {
    try {
        const safeUserId = getSafeUserId(req);
        if (!safeUserId) {
            return res.status(401).json({ error: 'Unauthorized: Invalid user ID' });
        }

        const { sessionId } = req.params;
        const { pinned } = req.body;

        const safeSessionId = validateSessionId(sessionId);
        if (!safeSessionId) {
            return res.status(400).json({ error: 'Invalid session ID format' });
        }

        console.log(`📂 [pinSession] ${pinned ? 'Pinning' : 'Unpinning'} session ${safeSessionId}`);

        // ✅ FIX #32/#33: Use safeUserId and safeSessionId in query
        const session = await Session.findOneAndUpdate(
            { userId: safeUserId, sessionId: safeSessionId },
            { pinned: pinned === true, updatedAt: new Date() },
            { new: true }
        );

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json(session);
    } catch (error) {
        console.error('[pinSession] Error:', error.message);
        res.status(500).json({ error: 'Failed to pin session' });
    }
}

// Delete a session (and all its messages)
async function deleteSession(req, res) {
    try {
        const safeUserId = getSafeUserId(req);
        if (!safeUserId) {
            return res.status(401).json({ error: 'Unauthorized: Invalid user ID' });
        }

        const { sessionId } = req.params;

        const safeSessionId = validateSessionId(sessionId);
        if (!safeSessionId) {
            return res.status(400).json({ error: 'Invalid session ID format' });
        }

        console.log(`📂 [deleteSession] Deleting session ${safeSessionId} for user ${safeUserId}`);

        // ✅ FIX #32/#33: Use safeUserId and safeSessionId in all queries
        const session = await Session.findOneAndDelete({ userId: safeUserId, sessionId: safeSessionId });
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        await ChatMessage.deleteMany({ userId: safeUserId, sessionId: safeSessionId });

        res.json({ success: true, message: 'Session deleted' });
    } catch (error) {
        console.error('[deleteSession] Error:', error.message);
        res.status(500).json({ error: 'Failed to delete session' });
    }
}

module.exports = {
    getSessions,
    createSession,
    renameSession,
    pinSession,
    deleteSession
};
