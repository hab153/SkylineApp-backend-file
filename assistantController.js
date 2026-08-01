// assistantController.js
const User = require('./User');
const ChatMessage = require('./ChatMessage');
const Session = require('./Session');
const { generateSuggestion } = require('./aiSuggestion');
const { sanitizeString } = require('./sanitize');

/**
 * POST /api/assistant
 * Handles assistant chat messages with context
 */
const assistantChat = async (req, res) => {
    try {
        const userId = req.userId;
        const { message, sessionId } = req.body;

        console.log('🤖 [ASSISTANT] Chat request received');
        console.log('🤖 [ASSISTANT] User ID:', userId);
        console.log('🤖 [ASSISTANT] Message:', message?.substring(0, 50));
        console.log('🤖 [ASSISTANT] Session ID:', sessionId);

        if (!message || message.trim() === '') {
            return res.status(400).json({ 
                success: false,
                error: 'Message is required',
                response: 'Please enter a message.'
            });
        }

        const cleanMessage = sanitizeString(message.trim());
        const currentSessionId = sessionId || `assistant_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

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

        // Check if session exists, create if not
        let session = await Session.findOne({ 
            userId: userId, 
            sessionId: currentSessionId,
            type: 'assistant'
        });

        if (!session) {
            session = await Session.create({
                userId: userId,
                sessionId: currentSessionId,
                type: 'assistant',
                name: cleanMessage.substring(0, 50) || 'Assistant Chat',
                updatedAt: new Date()
            });
            console.log('✅ [ASSISTANT] New session created:', currentSessionId);
        } else {
            // Update session timestamp
            await Session.findOneAndUpdate(
                { userId: userId, sessionId: currentSessionId },
                { updatedAt: new Date() }
            );
            console.log('✅ [ASSISTANT] Existing session updated:', currentSessionId);
        }

        // Save user message
        await ChatMessage.create({
            userId: userId,
            sessionId: currentSessionId,
            role: 'user',
            content: cleanMessage,
            title: cleanMessage.substring(0, 30) + '...'
        });
        console.log('✅ [ASSISTANT] User message saved');

        // Get previous messages for context (last 6)
        const previousMessages = await ChatMessage.find({
            userId: userId,
            sessionId: currentSessionId,
            role: { $ne: 'system' }
        })
        .sort({ createdAt: -1 })
        .limit(6)
        .lean();

        // Format context for AI
        const contextMessages = previousMessages.reverse().map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
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
            userId: userId,
            sessionId: currentSessionId,
            role: 'ai',
            content: aiResponse
        });
        console.log('✅ [ASSISTANT] AI response saved');

        res.json({
            success: true,
            response: aiResponse,
            sessionId: currentSessionId
        });

    } catch (error) {
        console.error('❌ [ASSISTANT] Fatal error:', error.message);
        console.error('❌ [ASSISTANT] Stack:', error.stack);
        res.status(500).json({
            success: false,
            error: error.message,
            response: 'Sorry, something went wrong. Please try again later.'
        });
    }
};

module.exports = { assistantChat };
