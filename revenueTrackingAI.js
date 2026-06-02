const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Helper to clean markdown code fences from AI response
function cleanAIResponse(responseText) {
    let cleaned = responseText.trim();
    const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/;
    const match = cleaned.match(jsonBlockRegex);
    if (match) {
        cleaned = match[1].trim();
    }
    return cleaned;
}

/**
 * Categorises a list of leads into five buckets.
 * Sends last 3 messages for context, and includes a robust fallback.
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

    // Prepare rich data for AI: include last 3 messages
    const leadsForAI = leads.map(lead => {
        const messages = (lead.replies || []).slice(-3).map(msg => ({
            from: msg.from,
            content: msg.content.substring(0, 200),
            date: msg.date
        }));
        return {
            id: lead._id,
            name: lead.name,
            company: lead.company,
            status: lead.status,
            messageCount: lead.replies ? lead.replies.length : 0,
            lastMessages: messages,
            sentiment: lead.sentiment || 'Unknown'
        };
    });

    const prompt = `
You are an expert sales analyst. Analyse the following leads and categorise each one into exactly one of these categories:

1. "contacted" – the user has sent at least one message, but the lead has NOT replied yet.
2. "replied" – the lead has replied at least once, but no clear interest or progression.
3. "interested" – the lead has shown interest (e.g., asked for pricing, demo, features, or responded positively).
4. "ongoing" – the conversation is active, close to a sale (e.g., negotiation, trial, contract discussion).
5. "win" – the deal is closed, the lead has converted or explicitly confirmed purchase.

IMPORTANT: Use the lead's actual messages (lastMessages) to determine if they have replied. If the lead has never replied, they belong to "contacted". If they have replied but no positive signals, they belong to "replied". Only use "interested", "ongoing", or "win" if the message content clearly indicates those stages.

Return ONLY valid JSON in the following format (no markdown, no extra text):
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
                max_tokens: 2000
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                }
            }
        );
        let content = response.data.choices[0].message.content;
        content = cleanAIResponse(content);
        const result = JSON.parse(content);
        return {
            contacted: result.contacted || [],
            replied: result.replied || [],
            interested: result.interested || [],
            ongoing: result.ongoing || [],
            win: result.win || []
        };
    } catch (error) {
        console.error('Categorisation AI error, using fallback:', error.message);
        // FALLBACK: deterministic rule-based categorisation using replies and status
        const fallback = {
            contacted: [],
            replied: [],
            interested: [],
            ongoing: [],
            win: []
        };
        leads.forEach(lead => {
            const status = lead.status;
            const replies = lead.replies || [];
            const lastMessage = replies.length > 0 ? replies[replies.length - 1].content.toLowerCase() : '';
            const entry = { id: lead._id, name: lead.name, company: lead.company };

            // 1. Win if status is 'Closed' or 'Win' or last message contains "purchased", "bought", "signed"
            if (status === 'Closed' || status === 'Win' || 
                lastMessage.includes('purchased') || lastMessage.includes('bought') || 
                lastMessage.includes('signed') || lastMessage.includes('deal closed')) {
                fallback.win.push(entry);
            }
            // 2. Interested if status is 'Interested' or last message contains "price", "demo", "interested", "quote"
            else if (status === 'Interested' || 
                     lastMessage.includes('price') || lastMessage.includes('demo') || 
                     lastMessage.includes('interested') || lastMessage.includes('quote')) {
                fallback.interested.push(entry);
            }
            // 3. Ongoing if status is 'Ongoing' or last message contains "next steps", "contract", "trial"
            else if (status === 'Ongoing' || 
                     lastMessage.includes('next steps') || lastMessage.includes('contract') || 
                     lastMessage.includes('trial')) {
                fallback.ongoing.push(entry);
            }
            // 4. Replied if there is at least one reply from lead (any message from 'lead')
            else if (replies.some(msg => msg.from === 'lead')) {
                fallback.replied.push(entry);
            }
            // 5. Otherwise contacted
            else {
                fallback.contacted.push(entry);
            }
        });
        return fallback;
    }
}

/**
 * Generates strategic advice for each non‑empty category.
 * (unchanged from previous version)
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
Return valid JSON, no markdown, no extra text.
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
        let content = response.data.choices[0].message.content;
        content = cleanAIResponse(content);
        return JSON.parse(content);
    } catch (error) {
        console.error('Advice generation error:', error);
        return {};
    }
}

/**
 * Generates specific actions for top 20 leads (Pro only).
 * (unchanged from previous version)
 */
async function generateActions(allLeads) {
    if (!allLeads || allLeads.length === 0) return [];

    const leadsForScoring = allLeads.map(lead => ({
        id: lead._id,
        name: lead.name,
        company: lead.company,
        lastMessageDate: lead.lastContactDate,
        messageCount: lead.replies ? lead.replies.length : 0,
        status: lead.status,
        sentiment: lead.sentiment || 'Unknown',
        lastMessages: (lead.replies || []).slice(-2).map(m => ({ from: m.from, content: m.content.substring(0, 100) }))
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
No markdown, no extra text.

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
                max_tokens: 1500
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                }
            }
        );
        let content = response.data.choices[0].message.content;
        content = cleanAIResponse(content);
        const actions = JSON.parse(content);
        return Array.isArray(actions) ? actions.slice(0, 20) : [];
    } catch (error) {
        console.error('Action generation error:', error);
        return [];
    }
}

module.exports = { categorizeLeads, generateAdvice, generateActions };
