const { generateAssistantResponse } = require('./assist');
const ChatMessage = require('./ChatMessage');
const User = require('./User');

async function assistantChat(req, res) {
    try {
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

        const response = await generateAssistantResponse(userId, message);

        // SAVE TO CHAT HISTORY - FIXED: role: 'ai' (not 'assistant')
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
            role: 'ai',          // <-- FIXED HERE
            content: response,
            createdAt: new Date()
        });

        await User.findByIdAndUpdate(userId, {
            $inc: { 'usage.assistantCount': 1 }
        });

        return res.json({
            response: response,
            remaining: remaining - 1
        });

    } catch (error) {
        console.error('[assistantController] Error:', error);
        return res.status(500).json({
            error: 'Assistant is temporarily unavailable. Please try again in a moment.'
        });
    }
}

module.exports = { assistantChat };
