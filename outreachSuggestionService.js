// outreachSuggestionService.js
const OpenAI = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

/**
 * Generates a personalized outreach email suggestion using OpenAI
 * @param {Object} lead - { companyName, email, industry }
 * @returns {Promise<string>} The generated outreach message
 */
async function generateOutreachSuggestion(lead) {
    try {
        const prompt = `Write a concise, professional, and personalized cold outreach email for ${lead.companyName}, a company in the ${lead.industry || 'general'} industry. The recipient's email is ${lead.email}. 

Rules:
- Keep it under 150 words
- Be specific to their industry/company
- Include a clear, low-friction call to action
- Sound human, not salesy
- Do NOT include subject line or signature
- Return ONLY the email body text`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "You are an expert B2B sales copywriter specializing in high-converting cold outreach emails." },
                { role: "user", content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 300
        });

        return completion.choices[0].message.content.trim();

    } catch (error) {
        console.error('OpenAI Outreach Suggestion Error:', error.message);
        throw new Error(`Failed to generate outreach suggestion for ${lead.companyName}: ${error.message}`);
    }
}

module.exports = { generateOutreachSuggestion };
