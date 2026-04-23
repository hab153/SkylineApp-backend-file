// Go.js
const axios = require('axios');

async function generateGoResponse(message, history, userProfile) {
    try {
        console.log("🟡 [GO TIER] Processing via GPT-4o...");

        // LONG MEMORY: Keep last 10 messages
        const limitedHistory = history.slice(-10);

        const systemPrompt = `You are Skyline AA-1 Assistant (GO Member). 
        You are a powerful, intelligent consultant. 
        Provide detailed, thoughtful answers. 
        Use advanced reasoning to help the user. 
        Tone: Professional, encouraging, and insightful.`;

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o", 
            messages: [
                { role: 'system', content: systemPrompt },
                ...limitedHistory,
                { role: 'user', content: message }
            ],
            max_tokens: 500, 
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const aiReply = response.data.choices[0].message.content;
        
        const newHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: aiReply }];
        
        return {
            reply: aiReply,
            updatedHistory: newHistory.slice(-12) 
        };

    } catch (error) {
        console.error("❌ [GO TIER] Error:", error.message);
        throw new Error("Go AI service temporarily unavailable.");
    }
}

module.exports = { generateGoResponse };
