// Go.js
// Handles AI responses for GO tier users ($8/mo).
// Model: GPT-4o | Limit: Smart Responses, Medium Memory

const axios = require('axios');

async function generateGoResponse(message, history, userProfile) {
    try {
        console.log("🟡 [GO TIER] Processing request via GPT-4o...");

        // 1. ALLOW MORE CONTEXT: Use last 6 messages for better conversation flow
        const limitedHistory = history.slice(-6);

        // 2. SYSTEM PROMPT: Encourage helpfulness and detail
        const systemPrompt = `You are Skyline AA-1 Assistant (GO Tier). 
        You are a smart, helpful, and empathetic business consultant. 
        CAPABILITIES:
        - Provide detailed, thoughtful answers up to 300 words.
        - Remember previous context in the conversation.
        - Help outline ideas, offer strategic advice, and refine concepts.
        - Do NOT generate the final structured "Simon Squibb" business plan document (reserved for PRO).
        - Tone: Engaging, professional, and encouraging.`;

        const messages = [
            { role: 'system', content: systemPrompt },
            ...limitedHistory,
            { role: 'user', content: message }
        ];

        // 3. CALL AI MODEL (GPT-4o)
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o",
            messages: messages,
            max_tokens: 400, // Generous output limit for detailed answers
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const aiReply = response.data.choices[0].message.content;

        // 4. UPDATE HISTORY: Keep last 10 messages in memory for Go users
        const newHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: aiReply }];
        const limitedNewHistory = newHistory.slice(-10);

        return {
            reply: aiReply,
            updatedHistory: limitedNewHistory
        };

    } catch (error) {
        console.error("❌ [GO TIER] Error:", error.message);
        throw new Error("Go AI service temporarily unavailable.");
    }
}

module.exports = {
    generateGoResponse
};
