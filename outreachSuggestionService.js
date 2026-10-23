// outreachSuggestionService.js
const OpenAI = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

async function generateOutreachSuggestion(lead) {
    try {
        const prompt = `Generate a personalized cold outreach email for ${lead.companyName}, a company in the ${lead.industry || 'general'} industry. The recipient's email is ${lead.email}.

Rules:
- Return ONLY valid JSON with exactly two keys: "subject" and "body"
- Subject must be under 50 characters, intriguing but professional
- Body must be under 150 words, specific to their industry/company
- Include a clear, low-friction call to action
- Sound human, not salesy
- Do NOT include signatures or placeholders

Example output format:
{
  "subject": "Quick question about [Company] outreach",
  "body": "Hi Maya,\n\nI noticed Brightline Media has been expanding its digital presence..."
}`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "You are an expert B2B sales copywriter. Always respond with valid JSON only." },
                { role: "user", content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 350,
            response_format: { type: "json_object" } // ✅ Forces JSON output
        });

        const rawContent = completion.choices[0].message.content.trim();
        const parsed = JSON.parse(rawContent);

        if (!parsed.subject || !parsed.body) {
            throw new Error('AI response missing required fields');
        }

        return {
            subject: parsed.subject.trim(),
            body: parsed.body.trim()
        };

    } catch (error) {
        console.error('OpenAI Outreach Suggestion Error:', error.message);
        throw new Error(`Failed to generate outreach suggestion for ${lead.companyName}: ${error.message}`);
    }
}

module.exports = { generateOutreachSuggestion };
