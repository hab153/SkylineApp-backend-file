// HistoryController.js
const ChatMessage = require('./ChatMessage');
const Session = require('./Session');

/**
 * Format time helper
 */
function formatTime(date) {
    if (!date) return '';
    try {
        const d = new Date(date);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
}

/**
 * GET /api/history/sessions
 * Get all sessions for a user
 */
exports.getSessions = async (req, res) => {
    try {
        const userId = req.userId;

        const sessions = await Session.find({ userId })
            .sort({ pinned: -1, updatedAt: -1 })
            .select('sessionId name type pinned updatedAt createdAt')
            .lean();

        // Get message count for each session
        const sessionsWithCount = await Promise.all(
            sessions.map(async (session) => {
                const count = await ChatMessage.countDocuments({
                    userId,
                    sessionId: session.sessionId
                });
                return {
                    ...session,
                    messageCount: count,
                    lastUpdated: session.updatedAt || session.createdAt
                };
            })
        );

        console.log(`📊 [History] Retrieved ${sessionsWithCount.length} sessions for user ${userId}`);
        res.json(sessionsWithCount);
    } catch (error) {
        console.error('❌ [History] Error fetching sessions:', error);
        res.status(500).json({ error: 'Failed to fetch sessions' });
    }
};

/**
 * GET /api/history/messages/:sessionId
 * Get messages for a specific session
 */
exports.getSessionMessages = async (req, res) => {
    try {
        const userId = req.userId;
        const { sessionId } = req.params;

        if (!sessionId) {
            return res.status(400).json({ error: 'Session ID required' });
        }

        const messages = await ChatMessage.find({
            userId,
            sessionId
        })
        .sort({ createdAt: 1 })
        .select('role content createdAt')
        .lean();

        // Format messages for frontend
        const formattedMessages = messages.map(msg => ({
            role: msg.role || 'user',
            content: msg.content || '',
            createdAt: msg.createdAt || new Date(),
            time: msg.createdAt ? formatTime(msg.createdAt) : ''
        }));

        console.log(`📊 [History] Retrieved ${formattedMessages.length} messages for session ${sessionId}`);
        res.json(formattedMessages);
    } catch (error) {
        console.error('❌ [History] Error fetching messages:', error);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
};

/**
 * PUT /api/history/rename/:sessionId
 * Rename a session
 */
exports.renameSession = async (req, res) => {
    try {
        const userId = req.userId;
        const { sessionId } = req.params;
        const { name } = req.body;

        if (!name || name.trim() === '') {
            return res.status(400).json({ error: 'Name is required' });
        }

        const session = await Session.findOneAndUpdate(
            { userId, sessionId },
            { name: name.trim(), updatedAt: new Date() },
            { new: true }
        );

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        console.log(`📊 [History] Renamed session ${sessionId} to "${name}"`);
        res.json({ success: true, session });
    } catch (error) {
        console.error('❌ [History] Error renaming session:', error);
        res.status(500).json({ error: 'Failed to rename session' });
    }
};

/**
 * PUT /api/history/pin/:sessionId
 * Toggle pin status
 */
exports.togglePin = async (req, res) => {
    try {
        const userId = req.userId;
        const { sessionId } = req.params;
        const { pinned } = req.body;

        const session = await Session.findOneAndUpdate(
            { userId, sessionId },
            { pinned: !!pinned, updatedAt: new Date() },
            { new: true }
        );

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        console.log(`📊 [History] ${pinned ? 'Pinned' : 'Unpinned'} session ${sessionId}`);
        res.json({ success: true, session });
    } catch (error) {
        console.error('❌ [History] Error toggling pin:', error);
        res.status(500).json({ error: 'Failed to toggle pin' });
    }
};

/**
 * DELETE /api/history/delete/:sessionId
 * Delete a session and all its messages
 */
exports.deleteSession = async (req, res) => {
    try {
        const userId = req.userId;
        const { sessionId } = req.params;

        // Delete all messages
        const messagesDeleted = await ChatMessage.deleteMany({ userId, sessionId });
        
        // Delete the session
        const result = await Session.deleteOne({ userId, sessionId });

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Session not found' });
        }

        console.log(`📊 [History] Deleted session ${sessionId} (${messagesDeleted.deletedCount} messages)`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ [History] Error deleting session:', error);
        res.status(500).json({ error: 'Failed to delete session' });
    }
};
