const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * Categorises a list of leads into five buckets based on conversation history.
 * @param {Array} leads - Array of lead objects with replies and status
 * @returns {Promise<Object>} - { contacted, replied, interested, ongoing, win }
 */
async function categorizeLeads(leads) {
    if (!leads || leads.length === 0) {
        return {
            contacted: [],
            replied: [],
            interested: [],
            ongoing: [],
            win: []
        };
    }

    // Build a compact representation for each lead
    const leadsForAI = leads.map(lead => {
        const lastMessage = lead.replies && lead.replies.length > 0
            ? lead.replies[lead.replies.length - 1].content
            : '';
        return {
            id: lead._id,
            name: lead.name,
            company: lead.company,
            status: lead.status,
            lastMessage: lastMessage.substring(0, 300),
            messageCount: lead.replies ? lead.replies.length : 0,
            sentiment: lead.sentiment || 'Unknown'
        };
    });

    const prompt = `
You are an expert sales analyst. Analyse the following leads and categorise each one into exactly one of these categories:

1. "contacted" – the user has sent at least one message, but the lead has not replied yet.
2. "replied" – the lead has replied at least once, but no clear interest or progression.
3. "interested" – the lead has shown interest (e.g., asked for pricing, demo, features, or responded positively).
4. "ongoing" – the conversation is active, close to a sale (e.g., negotiation, trial, contract discussion).
5. "win" – the deal is closed, the lead has converted or explicitly confirmed purchase.

Use the lead's conversation history, status, message count, and sentiment to decide.

Return ONLY valid JSON in the following format:
{
  "contacted": [{"id": "...", "name": "...", "company": "..."}, ...],
  "replied": [...],
  "interested": [...],
  "ongoing": [...],
  "win": [...]
}

LEADS DATA:
${JSON.stringify(leadsForAI, null, 2)}
`;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.3,
                max_tokens: 1500
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                }
            }
        );
        const result = JSON.parse(response.data.choices[0].message.content);
        return {
            contacted: result.contacted || [],
            replied: result.replied || [],
            interested: result.interested || [],
            ongoing: result.ongoing || [],
            win: result.win || []
        };
    } catch (error) {
        console.error('Categorisation AI error:', error);
        // Fallback: simple heuristic based on status
        const fallback = {
            contacted: [],
            replied: [],
            interested: [],
            ongoing: [],
            win: []
        };
        leads.forEach(lead => {
            const status = lead.status;
            const hasReplies = (lead.replies && lead.replies.length > 0);
            const entry = { id: lead._id, name: lead.name, company: lead.company };
            if (status === 'Win' || status === 'Closed') fallback.win.push(entry);
            else if (status === 'Interested') fallback.interested.push(entry);
            else if (status === 'Ongoing') fallback.ongoing.push(entry);
            else if (hasReplies) fallback.replied.push(entry);
            else fallback.contacted.push(entry);
        });
        return fallback;
    }
}

/**
 * Generates strategic advice for each non‑empty category (Go & Pro plans).
 * @param {Object} categories - The output from categorizeLeads
 * @param {string} tier - 'go' or 'pro'
 * @returns {Promise<Object>} - { contactedAdvice, repliedAdvice, interestedAdvice, ongoingAdvice, winAdvice }
 */
async function generateAdvice(categories, tier) {
    const prompt = `
You are a revenue growth advisor. Based on the following lead categories, provide short, actionable advice for each category that has at least one lead. Keep advice under 80 words per category. Target a ${tier} plan user (Go or Pro).

CATEGORIES:
- Contacted (${categories.contacted.length} leads): ${categories.contacted.map(l => l.name).join(', ')}
- Replied (${categories.replied.length} leads): ${categories.replied.map(l => l.name).join(', ')}
- Interested (${categories.interested.length} leads): ${categories.interested.map(l => l.name).join(', ')}
- Ongoing (${categories.ongoing.length} leads): ${categories.ongoing.map(l => l.name).join(', ')}
- Win (${categories.win.length} leads): ${categories.win.map(l => l.name).join(', ')}

Return ONLY a JSON object with fields only for categories that have leads > 0. Use keys: contactedAdvice, repliedAdvice, interestedAdvice, ongoingAdvice, winAdvice.
Example: { "contactedAdvice": "Send a follow-up email with a case study...", "interestedAdvice": "Schedule a demo call..." }
`;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.7,
                max_tokens: 800
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                }
            }
        );
        return JSON.parse(response.data.choices[0].message.content);
    } catch (error) {
        console.error('Advice generation error:', error);
        return {};
    }
}

/**
 * Generates specific actions for top 20 leads (Pro only).
 * @param {Array} allLeads - Complete lead objects (with replies)
 * @returns {Promise<Array>} - Array of { leadName, leadId, action }
 */
async function generateActions(allLeads) {
    if (!allLeads || allLeads.length === 0) return [];

    // Prepare data for AI scoring
    const leadsForScoring = allLeads.map(lead => ({
        id: lead._id,
        name: lead.name,
        company: lead.company,
        lastMessageDate: lead.lastContactDate,
        messageCount: lead.replies ? lead.replies.length : 0,
        status: lead.status,
        sentiment: lead.sentiment || 'Unknown'
    }));

    const prompt = `
You are an AI sales assistant. From the following list of leads, identify the TOP 20 most promising leads (highest conversion potential) and suggest ONE specific, actionable next step for each.

Rank based on: recency of last message, number of replies, expressed interest, sentiment, and any positive signals.

For each lead, return an object with: "leadId", "leadName", "action" (a short, concrete action – e.g., "Send a discounted offer", "Call to schedule demo", "Share a case study").

Return ONLY a JSON array, e.g.:
[
  { "leadId": "xxx", "leadName": "John Doe", "action": "Follow up with a personalized video" },
  ...
]

LEADS DATA:
${JSON.stringify(leadsForScoring, null, 2)}
`;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.5,
                max_tokens: 1200
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                }
            }
        );
        const actions = JSON.parse(response.data.choices[0].message.content);
        return Array.isArray(actions) ? actions.slice(0, 20) : [];
    } catch (error) {
        console.error('Action generation error:', error);
        return [];
    }
}

module.exports = { categorizeLeads, generateAdvice, generateActions };
