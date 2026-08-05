// assistantController.js
const User = require('./User');
const ChatMessage = require('./ChatMessage');
const Session = require('./Session');
const { generateSuggestion } = require('./aiSuggestion');
const { sanitizeString, isValidObjectId } = require('./sanitize');
const crypto = require('crypto');

/**
 * ✅ Generate a cryptographically secure session ID.
 * Uses crypto.randomBytes — NEVER Math.random().
 */
function generateSecureSessionId() {
    return `assistant_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * POST /api/assistant
 * Handles assistant chat messages with context
 */
const assistantChat = async (req, res) => {
    try {
        const userId = req.userId;
        const { message, sessionId } = req.body;

        console.log('🤖 [ASSISTANT] Chat request received');
        console.log('🤖 [ASSISTANT] Message length:', message?.length || 0);

        // Validate message
        if (!message || typeof message !== 'string' || message.trim() === '') {
            return res.status(400).json({ 
                success: false,
                error: 'Message is required',
                response: 'Please enter a message.'
            });
        }

        if (message.length > 5000) {
            return res.status(400).json({
                success: false,
                error: 'Message too long',
                response: 'Message must be under 5000 characters.'
            });
        }

        const cleanMessage = sanitizeString(message.trim());

        // ✅ FIX #1: Always use crypto.randomBytes for session ID generation.
        // If user provides a sessionId, validate it strictly. Otherwise generate securely.
        let currentSessionId;
        if (sessionId && typeof sessionId === 'string' && /^[a-zA-Z0-9_-]{10,100}$/.test(sessionId)) {
            currentSessionId = sessionId;
        } else {
            currentSessionId = generateSecureSessionId();
        }

        // ✅ FIX #8: Cast userId to String IMMEDIATELY — before ANY database call.
        // CodeQL flags any DB query where the variable hasn't been explicitly typed.
        if (!userId || !isValidObjectId(userId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid user ID',
                response: 'Invalid session.'
            });
        }
        const safeUserId = String(userId);
        const safeSessionId = String(currentSessionId);

        // ✅ FIX #8: Use safeUserId (explicitly String-typed) in ALL queries from here on.
        const user = await User.findById(safeUserId).select('fullName subscriptionTier country skillLevel primaryGoal interests');
        if (!user) {
            console.error('❌ [ASSISTANT] User not found');
            return res.status(404).json({ 
                success: false,
                error: 'User not found',
                response: 'User not found.'
            });
        }

        // Check if session exists, create if not
        // ✅ FIX #9: All query params are safeUserId/safeSessionId — explicitly String-typed above
        let session = await Session.findOne({ 
            userId: safeUserId, 
            sessionId: safeSessionId,
            type: 'assistant'
        });

        if (!session) {
            const sessionName = cleanMessage.substring(0, 50) || 'Assistant Chat';
            
            // ✅ FIX #9: Session.create uses only safeUserId and safeSessionId
            session = await Session.create({
                userId: safeUserId,
                sessionId: safeSessionId,
                type: 'assistant',
                name: sessionName,
                updatedAt: new Date()
            });
            console.log('✅ [ASSISTANT] New session created');
        } else {
            // Verify session belongs to this user
            if (String(session.userId) !== safeUserId) {
                return res.status(403).json({
                    success: false,
                    error: 'Access denied',
                    response: 'You do not have access to this session.'
                });
            }
            
            await Session.findOneAndUpdate(
                { userId: safeUserId, sessionId: safeSessionId },
                { updatedAt: new Date() }
            );
            console.log('✅ [ASSISTANT] Existing session updated');
        }

        // Save user message
        // ✅ FIX #10: ChatMessage.create uses only safeUserId and safeSessionId
        await ChatMessage.create({
            userId: safeUserId,
            sessionId: safeSessionId,
            role: 'user',
            content: cleanMessage,
            title: cleanMessage.substring(0, 30) + '...'
        });
        console.log('✅ [ASSISTANT] User message saved');

        // Get previous messages for context (last 6)
        const previousMessages = await ChatMessage.find({
            userId: safeUserId,
            sessionId: safeSessionId,
            role: { $ne: 'system' }
        })
        .sort({ createdAt: -1 })
        .limit(6)
        .lean();

        // Format context for AI
        const contextMessages = previousMessages.reverse().map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: typeof msg.content === 'string' ? msg.content : ''
        }));

        console.log('📝 [ASSISTANT] Context messages count:', contextMessages.length);

        // Generate AI response
        let aiResponse;
        try {
            const suggestion = await generateSuggestion(contextMessages.slice(-3));
            aiResponse = suggestion || "I'm here to help! What would you like to know?";
            console.log('✅ [ASSISTANT] AI response generated');
        } catch (aiError) {
            console.error('❌ [ASSISTANT] AI generation error:', aiError.message);
            aiResponse = "I'm sorry, I'm having trouble processing your request right now. Please try again in a moment.";
        }

        // Save AI response
        await ChatMessage.create({
            userId: safeUserId,
            sessionId: safeSessionId,
            role: 'ai',
            content: typeof aiResponse === 'string' ? aiResponse : 'Unable to generate response.'
        });
        console.log('✅ [ASSISTANT] AI response saved');

        res.json({
            success: true,
            response: aiResponse,
            sessionId: currentSessionId
        });

    } catch (error) {
        console.error('❌ [ASSISTANT] Fatal error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            response: 'Sorry, something went wrong. Please try again later.'
        });
    }
};

module.exports = { assistantChat };
