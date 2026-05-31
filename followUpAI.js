// followUpAI.js
const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * Generates a short, professional follow-up email based on the last 2-3 messages.
 * @param {Array} messages - Array of message objects { from, content, date }
 * @param {string} leadName - Name of the lead
 * @param {string} companyName - Company name of the lead
 * @returns {Promise<string>} - Generated follow-up message
 */
async function generateFollowUpSuggestion(messages, leadName, companyName) {
    if (!messages || messages.length === 0) {
        throw new Error("No messages to base follow-up on.");
    }

    // Take last 2 messages for context (or 3 if available)
    const contextMessages = messages.slice(-2);
    const context = contextMessages.map(m => 
        `${m.from === 'lead' ? 'Lead' : 'You'}: ${m.content}`
    ).join('\n');

    const prompt = `
You are a professional email assistant for Skyline AA-1. 
Based on the last 2 messages, generate a SHORT follow-up email (2-3 sentences).

CONTEXT:
${context}

LEAD NAME: ${leadName}
COMPANY: ${companyName}

RULES:
- Be concise and professional
- Keep the tone warm but not pushy
- Do NOT use emojis
- Do NOT include greetings like "Hi" or "Hello" unless absolutely necessary
- Do NOT include a signature (no "Best," "Cheers," etc.)
- Provide ONLY the message text, no explanations or markdown
`;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.7,
                max_tokens: 150
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                }
            }
        );

        const suggestion = response.data.choices[0].message.content.trim();
        return suggestion;
    } catch (error) {
        console.error("Follow-up AI error:", error.response?.data || error.message);
        throw new Error("Failed to generate follow-up suggestion.");
    }
}

module.exports = { generateFollowUpSuggestion };
