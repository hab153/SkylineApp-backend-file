const { generateAssistantResponse } = require('./assist');
const ChatMessage = require('./ChatMessage');
const User = require('./User');

/**
 * Handle POST /api/assistant requests
 * Receives user message, generates AI response, returns JSON
 */
async function assistantChat(req, res) {
    try {
        // 1. Get user ID from JWT (set by authMiddleware)
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized. Please log in again.' });
        }

        // 2. Get message from request body
        const { message } = req.body;

        // 3. Validate message
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: 'Message is required and cannot be empty.' });
        }

        // 4. Get user and remaining count from middleware
        const user = req.userDoc;
        const remaining = req.assistantRemaining || 0;

        if (!user) {
            return res.status(401).json({ error: 'User not found. Please log in again.' });
        }

        // 5. Generate AI response
        const response = await generateAssistantResponse(userId, message);

        // 6. Save to chat history (ChatMessage with sessionId = 'assistant')
        await ChatMessage.create({
            userId: userId,
            sessionId: 'assistant',  // Special session ID for assistant
            role: 'user',
            content: message,
            createdAt: new Date()
        });
        await ChatMessage.create({
            userId: userId,
            sessionId: 'assistant',
            role: 'assistant',
            content: response,
            createdAt: new Date()
        });

        // 7. Increment assistant usage counter
        await User.findByIdAndUpdate(userId, {
            $inc: { 'usage.assistantCount': 1 }
        });

        // 8. Return response with remaining count
        return res.json({
            response: response,
            remaining: remaining - 1  // Subtract the one we just used
        });

    } catch (error) {
        console.error('[assistantController] Error:', error);
        return res.status(500).json({
            error: 'Assistant is temporarily unavailable. Please try again in a moment.'
        });
    }
}

module.exports = { assistantChat };
