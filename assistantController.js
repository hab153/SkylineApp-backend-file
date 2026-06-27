const { generateAssistantResponse } = require('./assist');

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

        // 4. Optional: Check daily limit for assistant
        // You can add a limit check here if you want to restrict assistant usage
        // Example: Free=10, Go=50, Pro=200 messages per day
        // const user = await User.findById(userId);
        // if (user.usage?.assistantCount >= user.usage?.assistantLimit) {
        //     return res.status(429).json({ error: 'Daily assistant limit reached. Upgrade your plan for more.' });
        // }

        // 5. Generate AI response
        const response = await generateAssistantResponse(userId, message);

        // 6. Optional: Save to chat history
        // You can save assistant conversations to ChatMessage with sessionId = 'assistant'
        // await ChatMessage.create({
        //     userId,
        //     sessionId: 'assistant',
        //     role: 'user',
        //     content: message
        // });
        // await ChatMessage.create({
        //     userId,
        //     sessionId: 'assistant',
        //     role: 'assistant',
        //     content: response
        // });

        // 7. Optional: Increment assistant usage counter
        // await User.findByIdAndUpdate(userId, {
        //     $inc: { 'usage.assistantCount': 1 }
        // });

        // 8. Return response
        return res.json({ response });

    } catch (error) {
        console.error('[assistantController] Error:', error);
        return res.status(500).json({ 
            error: 'Assistant is temporarily unavailable. Please try again in a moment.' 
        });
    }
}

module.exports = { assistantChat };
