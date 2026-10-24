// outreachSuggestionService.js
// UPDATED: Batch generation — 1 OpenAI call for N leads

const OpenAI = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

/**
 * Generate N personalized outreach suggestions in ONE OpenAI call
 * @param {Array} leads - Array of {companyName, email, industry}
 * @param {number} count - Expected count (must match leads.length)
 * @returns {Promise<Array>} - Array of {leadEmail, subject, message}
 */
async function generateOutreachSuggestions(leads, count) {
    try {
        // ─── Validate ───
        if (!Array.isArray(leads) || leads.length === 0) {
            throw new Error('Leads array is required');
        }
        if (leads.length !== count) {
            throw new Error(`Count (${count}) must match leads length (${leads.length})`);
        }

        // ─── Build ONE prompt for all leads ───
        const leadsList = leads.map((lead, i) => 
            `${i + 1}. Company: "${lead.companyName || 'Unknown'}" | Industry: "${lead.industry || 'general'}" | Email: "${lead.email || 'unknown'}"`
        ).join('\n');

        const prompt = `You are an expert B2B sales copywriter. Generate ${count} personalized cold outreach emails.

For EACH company below, write:
- A compelling subject line (under 50 characters)
- A personalized message (under 150 words)
- Clear, low-friction call to action
- Sound human, not salesy
- NO signatures, NO placeholders

COMPANIES:
${leadsList}

Return ONLY valid JSON in this EXACT format:
{
  "drafts": [
    { "subject": "...", "message": "...", "leadEmail": "exact email from input" },
    { "subject": "...", "message": "...", "leadEmail": "exact email from input" }
  ]
}

Generate exactly ${count} drafts, one per company, in the same order as the input.`;

        // ─── ONE OpenAI call ───
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: "You are an expert B2B sales copywriter. Always respond with valid JSON only." 
                },
                { role: "user", content: prompt }
            ],
            temperature: 0.7,
            max_tokens: Math.min(350 * count, 4000),
            response_format: { type: "json_object" }
        });

        const rawContent = completion.choices[0].message.content.trim();
        const parsed = JSON.parse(rawContent);

        // ─── Validate response ───
        if (!parsed.drafts || !Array.isArray(parsed.drafts)) {
            throw new Error('AI response missing drafts array');
        }
        if (parsed.drafts.length !== count) {
            throw new Error(`AI returned ${parsed.drafts.length} drafts, expected ${count}`);
        }

        // ─── Ensure each draft has leadEmail (fallback by position) ───
        const result = parsed.drafts.map((draft, i) => {
            if (!draft.subject || !draft.message) {
                throw new Error(`Draft ${i+1} missing subject or message`);
            }
            return {
                leadEmail: draft.leadEmail || leads[i].email,
                subject: String(draft.subject).trim(),
                message: String(draft.message).trim()
            };
        });

        console.log(`✅ [Outreach] Generated ${result.length} drafts in 1 API call`);
        return result;

    } catch (error) {
        console.error('❌ [Outreach] Error:', error.message);
        throw error;
    }
}

// Keep old single-lead function for backwards compat (if used elsewhere)
async function generateOutreachSuggestion(lead) {
    const drafts = await generateOutreachSuggestions([lead], 1);
    return drafts[0];
}

module.exports = { 
    generateOutreachSuggestions,
    generateOutreachSuggestion  // kept for compatibility
};
