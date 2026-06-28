const { generateAssistantResponse } = require('./assist');
const ChatMessage = require('./ChatMessage');
const User = require('./User');
const Session = require('./Session'); // <-- NEW

/**
 * Handle POST /api/assistant requests
 */
async function assistantChat(req, res) {
    try {
        console.log('[Assistant] Request received from user:', req.userId);

        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized. Please log in again.' });
        }

        const { message } = req.body;
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: 'Message is required and cannot be empty.' });
        }

        const user = req.userDoc;
        const remaining = req.assistantRemaining || 0;

        if (!user) {
            return res.status(401).json({ error: 'User not found. Please log in again.' });
        }

        console.log('[Assistant] Generating response for user:', userId);

        const response = await generateAssistantResponse(userId, message);

        console.log('[Assistant] Response generated, saving to history...');

        // --- NEW: Ensure Assistant Session exists ---
        const existingSession = await Session.findOne({ userId, sessionId: 'assistant' });
        if (!existingSession) {
            await Session.create({
                userId,
                sessionId: 'assistant',
                type: 'assistant',
                name: 'Assistant Chat',
                updatedAt: new Date()
            });
        } else {
            await Session.findOneAndUpdate(
                { userId, sessionId: 'assistant' },
                { updatedAt: new Date() }
            );
        }

        // Save to chat history
        await ChatMessage.create({
            userId: userId,
            sessionId: 'assistant',
            role: 'user',
            content: message,
            createdAt: new Date()
        });
        await ChatMessage.create({
            userId: userId,
            sessionId: 'assistant',
            role: 'ai',
            content: response,
            createdAt: new Date()
        });

        // Increment assistant usage counter
        await User.findByIdAndUpdate(userId, {
            $inc: { 'usage.assistantCount': 1 }
        });

        console.log('[Assistant] Success, returning response');

        return res.json({
            response: response,
            remaining: remaining - 1
        });

    } catch (error) {
        console.error('[assistantController] FULL ERROR:', error);
        console.error('[assistantController] Error stack:', error.stack);
        return res.status(500).json({
            error: 'Assistant is temporarily unavailable. Please try again in a moment.'
        });
    }
}

module.exports = { assistantChat };
