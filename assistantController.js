// assistantController.js
const User = require('./User');
const ChatMessage = require('./ChatMessage');
const Session = require('./Session');
const { generateSuggestion } = require('./aiSuggestion');
const { sanitizeString, isValidObjectId } = require('./sanitize');
const crypto = require('crypto');

/**
 * POST /api/assistant
 * Handles assistant chat messages with context
 */
const assistantChat = async (req, res) => {
    try {
        const userId = req.userId;
        const { message, sessionId } = req.body;

        console.log('🤖 [ASSISTANT] Chat request received');
        console.log(' [ASSISTANT] User ID:', userId);
        console.log('🤖 [ASSISTANT] Message length:', message?.length || 0);
        console.log('🤖 [ASSISTANT] Session ID present:', !!sessionId);

        if (!message || typeof message !== 'string' || message.trim() === '') {
            return res.status(400).json({ 
                success: false,
                error: 'Message is required',
                response: 'Please enter a message.'
            });
        }

        // ✅ Validate message length to prevent abuse
        if (message.length > 5000) {
            return res.status(400).json({
                success: false,
                error: 'Message too long',
                response: 'Message must be under 5000 characters.'
            });
        }

        const cleanMessage = sanitizeString(message.trim());

        // ✅ FIX #1: Use crypto.randomBytes instead of Math.random() for session ID
        let currentSessionId;
        if (sessionId && typeof sessionId === 'string') {
            // Validate provided sessionId format
            if (/^[a-zA-Z0-9_-]{10,100}$/.test(sessionId)) {
                currentSessionId = sessionId;
            } else {
                // Generate secure session ID if provided one is invalid
                currentSessionId = `assistant_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`;
            }
        } else {
            currentSessionId = `assistant_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`;
        }

        // ✅ Validate userId is valid ObjectId
        if (!isValidObjectId(userId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid user ID',
                response: 'Invalid session.'
            });
        }

        // Get user info for context
        const user = await User.findById(userId).select('fullName subscriptionTier country skillLevel primaryGoal interests');
        if (!user) {
            console.error('❌ [ASSISTANT] User not found:', userId);
            return res.status(404).json({ 
                success: false,
                error: 'User not found',
                response: 'User not found.'
            });
        }

        // ✅ FIX #8: Ensure query parameters are properly typed strings, not objects/arrays
        const safeUserId = String(userId);
        const safeSessionId = String(currentSessionId);

        // Check if session exists, create if not
        let session = await Session.findOne({ 
            userId: safeUserId, 
            sessionId: safeSessionId,
            type: 'assistant'
        });

        if (!session) {
            // ✅ FIX #9: Sanitize session name before saving
            const sessionName = cleanMessage.substring(0, 50) || 'Assistant Chat';
            
            session = await Session.create({
                userId: safeUserId,
                sessionId: safeSessionId,
                type: 'assistant',
                name: sessionName,
                updatedAt: new Date()
            });
            console.log('✅ [ASSISTANT] New session created');
        } else {
            // ✅ FIX #9: Verify session belongs to this user before updating
            if (String(session.userId) !== safeUserId) {
                return res.status(403).json({
                    success: false,
                    error: 'Access denied',
                    response: 'You do not have access to this session.'
                });
            }
            
            // Update session timestamp
            await Session.findOneAndUpdate(
                { userId: safeUserId, sessionId: safeSessionId },
                { updatedAt: new Date() }
            );
            console.log('✅ [ASSISTANT] Existing session updated');
        }

        // Save user message
        // ✅ FIX #10: Ensure all values passed to create are properly typed
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

        // Generate AI response using the suggestion function
        let aiResponse;
        try {
            // Use the existing suggestion generator with context
            const suggestion = await generateSuggestion(contextMessages.slice(-3));
            aiResponse = suggestion || "I'm here to help! What would you like to know?";
            console.log('✅ [ASSISTANT] AI response generated');
        } catch (aiError) {
            console.error('❌ [ASSISTANT] AI generation error:', aiError.message);
            // Fallback response
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
