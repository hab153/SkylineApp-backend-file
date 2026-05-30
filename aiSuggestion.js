/**
 * aiSuggestion.js
 * Backend service for generating AI-powered reply suggestions based on conversation context.
 */

const axios = require('axios');

// Use your existing OpenAI API key from environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; 

/**
 * Detects the primary language of the recent conversation.
 * @param {Array} messages - Array of message objects { content: string, from: string }
 * @returns {string} - Detected language code (e.g., 'en', 'es', 'fr') or 'en' as default.
 */
function detectLanguage(messages) {
    // Simple heuristic: Check the last non-empty message from the lead
    const lastLeadMsg = [...messages].reverse().find(m => m.from === 'lead' && m.content.trim().length > 0);
    
    if (!lastLeadMsg) return 'en';

    // In a production environment, you might use a library like 'franc' or an API call.
    // For now, we assume English unless specific characters are detected, 
    // but the prompt below will instruct the AI to match the language regardless.
    return 'auto'; 
}

/**
 * Generates a short, portable reply suggestion based on the last 3 messages.
 * @param {Array} messages - The last 3 messages from the conversation.
 * @returns {Promise<string>} - The suggested reply text.
 */
async function generateSuggestion(messages) {
    if (!messages || messages.length === 0) {
        throw new Error("No messages provided for suggestion.");
    }

    const language = detectLanguage(messages);
    
    // Format messages for the prompt
    const context = messages.map(m => `${m.from === 'lead' ? 'Lead' : 'You'}: ${m.content}`).join('\n');

    const systemPrompt = `
    You are an expert communication assistant for Skyline AA-1. 
    Your goal is to suggest a SHORT, PORTABLE, and HIGHLY RELEVANT reply to the last message from the Lead.
    
    RULES:
    1. Analyze the last 3 messages provided in the context.
    2. Match the LANGUAGE of the Lead's last message exactly.
    3. Keep the suggestion under 2 sentences.
    4. Maintain a professional yet conversational tone.
    5. Do NOT include greetings like "Hi" or "Hello" unless necessary for context.
    6. Do NOT use emojis.
    7. Provide ONLY the suggested text. No explanations.

    CONTEXT:
    ${context}
    `;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4o-mini", // Cost-effective and fast for suggestions
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: "Suggest a reply." }
                ],
                temperature: 0.7,
                max_tokens: 60
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
        console.error("Error generating AI suggestion:", error.response ? error.response.data : error.message);
        throw new Error("Failed to generate suggestion from AI.");
    }
}

module.exports = { generateSuggestion };
