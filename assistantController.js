const { v4: uuidv4 } = require('uuid');
const { generateAssistantResponse } = require('./assist');
const ChatMessage = require('./ChatMessage');
const User = require('./User');
const Session = require('./Session');
const { sanitizeString, isValidObjectId } = require('./sanitize');

/**
 * Handle POST /api/assistant requests
 */
async function assistantChat(req, res) {
    try {
        console.log('[Assistant] Request received from user:', req.userId);

        const userId = req.userId;
        if (!userId || !isValidObjectId(userId)) {
            return res.status(401).json({ error: 'Unauthorized. Please log in again.' });
        }

        let { message, sessionId } = req.body;
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: 'Message is required and cannot be empty.' });
        }
        message = sanitizeString(message);

        const user = req.userDoc;
        const remaining = req.assistantRemaining || 0;

        if (!user) {
            return res.status(401).json({ error: 'User not found. Please log in again.' });
        }

        // Use provided sessionId or generate a new one
        const currentSessionId = sessionId || uuidv4();

        console.log('[Assistant] Generating response for user:', userId, 'session:', currentSessionId);

        const response = await generateAssistantResponse(userId, message);

        console.log('[Assistant] Response generated, saving to history...');

        // Ensure Session record exists for this assistant conversation
        const existingSession = await Session.findOne({ userId, sessionId: currentSessionId });
        if (!existingSession) {
            const title = message.substring(0, 50) || 'Assistant Chat';
            await Session.create({
                userId,
                sessionId: currentSessionId,
                type: 'assistant',
                name: title,
                updatedAt: new Date()
            });
        } else {
            await Session.findOneAndUpdate(
                { userId, sessionId: currentSessionId },
                { updatedAt: new Date() }
            );
        }

        // Save user message and AI response with the sessionId
        await ChatMessage.create({
            userId: userId,
            sessionId: currentSessionId,
            role: 'user',
            content: message,
            createdAt: new Date()
        });
        await ChatMessage.create({
            userId: userId,
            sessionId: currentSessionId,
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
            remaining: remaining - 1,
            sessionId: currentSessionId
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
