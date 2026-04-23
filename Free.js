// Free.js
const axios = require('axios');

async function generateFreeResponse(message, history, userProfile) {
    try {
        console.log("🟢 [FREE TIER] Processing via GPT-3.5-Turbo...");

        // SHORT MEMORY: Keep only last 4 messages
        const limitedHistory = history.slice(-4);

        const systemPrompt = `You are Skyline AA-1 Assistant (Free Tier). 
        Provide concise, direct answers. 
        Limit responses to ~100 words. 
        Do not generate full business plans. 
        Tone: Helpful but brief.`;

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-3.5-turbo", 
            messages: [
                { role: 'system', content: systemPrompt },
                ...limitedHistory,
                { role: 'user', content: message }
            ],
            max_tokens: 150, 
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
            updatedHistory: newHistory.slice(-6) 
        };

    } catch (error) {
        console.error("❌ [FREE TIER] Error:", error.message);
        throw new Error("Free AI service temporarily unavailable.");
    }
}

module.exports = { generateFreeResponse };
