const Session = require('./Session');
const ChatMessage = require('./ChatMessage');

// Get all sessions for a user - FIXED (Proper userId filtering)
async function getSessions(req, res) {
    try {
        const userId = req.userId;
        console.log(`📂 [getSessions] Fetching sessions for user: ${userId}`);
        
        // ✅ FIX: Direct filter
        const sessions = await Session.find({ userId })
            .sort({ pinned: -1, updatedAt: -1 })
            .lean();

        // Get message count for each session
        const sessionsWithCounts = await Promise.all(sessions.map(async (session) => {
            const count = await ChatMessage.countDocuments({
                userId,
                sessionId: session.sessionId
            });
            return {
                ...session,
                messageCount: count
            };
        }));

        console.log(`📂 [getSessions] Found ${sessionsWithCounts.length} sessions for user ${userId}`);
        res.json(sessionsWithCounts);
    } catch (error) {
        console.error('[getSessions] Error:', error);
        res.status(500).json({ error: 'Failed to load sessions' });
    }
}

// Create a new session - FIXED (Proper userId filtering)
async function createSession(req, res) {
    try {
        const userId = req.userId;
        const { sessionId, type, name } = req.body;

        if (!sessionId || !type) {
            return res.status(400).json({ error: 'sessionId and type are required' });
        }

        console.log(`📂 [createSession] Creating session for user ${userId}: ${sessionId}`);

        const session = await Session.findOneAndUpdate(
            { userId, sessionId },
            {
                userId,
                sessionId,
                type,
                name: name || (type === 'assistant' ? 'Assistant Chat' : 'Lead Search'),
                updatedAt: new Date()
            },
            { upsert: true, new: true }
        );

        res.json(session);
    } catch (error) {
        console.error('[createSession] Error:', error);
        res.status(500).json({ error: 'Failed to create session' });
    }
}

// Rename a session - FIXED (Proper userId filtering)
async function renameSession(req, res) {
    try {
        const userId = req.userId;
        const { sessionId } = req.params;
        const { name } = req.body;

        if (!name || name.trim().length === 0) {
            return res.status(400).json({ error: 'Name is required' });
        }

        console.log(`📂 [renameSession] Renaming session ${sessionId} for user ${userId}`);

        const session = await Session.findOneAndUpdate(
            { userId, sessionId },
            { name: name.trim(), updatedAt: new Date() },
            { new: true }
        );

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json(session);
    } catch (error) {
        console.error('[renameSession] Error:', error);
        res.status(500).json({ error: 'Failed to rename session' });
    }
}

// Pin/unpin a session - FIXED (Proper userId filtering)
async function pinSession(req, res) {
    try {
        const userId = req.userId;
        const { sessionId } = req.params;
        const { pinned } = req.body;

        console.log(`📂 [pinSession] ${pinned ? 'Pinning' : 'Unpinning'} session ${sessionId} for user ${userId}`);

        const session = await Session.findOneAndUpdate(
            { userId, sessionId },
            { pinned: pinned === true, updatedAt: new Date() },
            { new: true }
        );

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json(session);
    } catch (error) {
        console.error('[pinSession] Error:', error);
        res.status(500).json({ error: 'Failed to pin session' });
    }
}

// Delete a session (and all its messages) - FIXED (Proper userId filtering)
async function deleteSession(req, res) {
    try {
        const userId = req.userId;
        const { sessionId } = req.params;

        console.log(`📂 [deleteSession] Deleting session ${sessionId} for user ${userId}`);

        // Delete session metadata
        const session = await Session.findOneAndDelete({ userId, sessionId });
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Delete all messages in this session
        await ChatMessage.deleteMany({ userId, sessionId });

        res.json({ success: true, message: 'Session deleted' });
    } catch (error) {
        console.error('[deleteSession] Error:', error);
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
