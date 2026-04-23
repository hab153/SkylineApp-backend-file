// Free.js
// Handles AI responses for FREE tier users.
// Model: GPT-3.5-Turbo | Limit: Short Answers, Low Memory

const axios = require('axios');

async function generateFreeResponse(message, history, userProfile) {
    try {
        console.log("🟢 [FREE TIER] Processing request via GPT-3.5...");

        // 1. LIMIT CONTEXT: Only use the last 2 messages to save cost/memory
        const limitedHistory = history.slice(-2);

        // 2. SYSTEM PROMPT: Enforce brevity and limit capabilities
        const systemPrompt = `You are Skyline AA-1 Assistant (Free Tier). 
        Your goal is to provide quick, direct, and concise answers. 
        STRICT LIMITS: 
        - Keep responses under 100 words. 
        - Do NOT generate full business plans, code, or complex strategies. 
        - If a user asks for a detailed plan, politely suggest they upgrade to GO or PRO for full access.
        - Tone: Professional but brief.`;

        const messages = [
            { role: 'system', content: systemPrompt },
            ...limitedHistory,
            { role: 'user', content: message }
        ];

        // 3. CALL AI MODEL (GPT-3.5-Turbo)
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-3.5-turbo",
            messages: messages,
            max_tokens: 150, // Strict output limit
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const aiReply = response.data.choices[0].message.content;

        // 4. UPDATE HISTORY: Keep only last 4 messages in memory for free users
        const newHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: aiReply }];
        const limitedNewHistory = newHistory.slice(-4);

        return {
            reply: aiReply,
            updatedHistory: limitedNewHistory
        };

    } catch (error) {
        console.error("❌ [FREE TIER] Error:", error.message);
        throw new Error("Free AI service temporarily unavailable.");
    }
}

module.exports = {
    generateFreeResponse
};
