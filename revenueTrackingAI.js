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
 * Categorises leads into five buckets using full conversation history.
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

    // First, separate leads that never replied (contacted)
    const contacted = [];
    const repliedLeads = []; // leads that have at least one reply from 'lead'
    
    leads.forEach(lead => {
        const hasLeadReply = (lead.replies || []).some(msg => msg.from === 'lead');
        if (hasLeadReply) {
            repliedLeads.push(lead);
        } else {
            contacted.push({ id: lead._id, name: lead.name, company: lead.company });
        }
    });

    // For leads that have replied, we need to classify interest level using AI
    if (repliedLeads.length === 0) {
        return {
            contacted,
            replied: [],
            interested: [],
            ongoing: [],
            win: []
        };
    }

    // Prepare rich data: full conversation (compact string) for each lead
    const leadsForAI = repliedLeads.map(lead => {
        // Build a compact conversation log
        const conversation = (lead.replies || []).map(msg => 
            `${msg.from === 'lead' ? 'Lead' : 'You'}: ${msg.content}`
        ).join('\n');
        // Trim to avoid token explosion (last ~2000 chars)
        const trimmedConversation = conversation.length > 2000 
            ? '...(earlier messages omitted)\n' + conversation.slice(-2000)
            : conversation;
        return {
            id: lead._id,
            name: lead.name,
            company: lead.company,
            status: lead.status,
            conversation: trimmedConversation,
            totalMessages: lead.replies ? lead.replies.length : 0
        };
    });

    const prompt = `
You are an expert sales analyst. For each lead below, analyse their full conversation and decide which stage they are in:

- "interested" – the lead has shown interest (e.g., asked for pricing, demo, features, or responded positively).
- "ongoing" – the conversation is active, close to a sale (e.g., negotiation, trial, contract discussion).
- "win" – the deal is closed, the lead has converted or explicitly confirmed purchase.

Do NOT classify a lead as "contacted" or "replied" – those are already handled. Only use these three categories. If a lead has replied but shows no clear interest, you may still place them in "interested" as a default, but try to be accurate.

Return ONLY a JSON object with three arrays: "interested", "ongoing", "win". Each item must have "id", "name", "company".

Example:
{
  "interested": [{"id":"1","name":"John","company":"Acme"}],
  "ongoing": [],
  "win": []
}

LEADS DATA (full conversation included):
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
            contacted,
            replied: [], // no need – all replied leads are in interest categories
            interested: result.interested || [],
            ongoing: result.ongoing || [],
            win: result.win || []
        };
    } catch (error) {
        console.error('AI classification error, using fallback:', error.message);
        // Fallback: use keyword matching on last message and status
        const interested = [];
        const ongoing = [];
        const win = [];
        repliedLeads.forEach(lead => {
            const repliesFromLead = (lead.replies || []).filter(m => m.from === 'lead');
            const lastLeadMsg = repliesFromLead.length ? repliesFromLead[repliesFromLead.length - 1].content.toLowerCase() : '';
            const entry = { id: lead._id, name: lead.name, company: lead.company };
            if (lead.status === 'Win' || lastLeadMsg.includes('purchased') || lastLeadMsg.includes('bought') || lastLeadMsg.includes('signed')) {
                win.push(entry);
            } else if (lead.status === 'Interested' || lastLeadMsg.includes('price') || lastLeadMsg.includes('demo') || lastLeadMsg.includes('interested') || lastLeadMsg.includes('quote')) {
                interested.push(entry);
            } else if (lead.status === 'Ongoing' || lastLeadMsg.includes('next steps') || lastLeadMsg.includes('contract') || lastLeadMsg.includes('trial')) {
                ongoing.push(entry);
            } else {
                // Default to interested if they replied but no clear signal
                interested.push(entry);
            }
        });
        return {
            contacted,
            replied: [],
            interested,
            ongoing,
            win
        };
    }
}

/**
 * Generates strategic advice for each non‑empty category.
 * (unchanged – works on the final categories)
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
 * (unchanged – uses full lead data)
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
        lastMessages: (lead.replies || []).slice(-3).map(m => ({ from: m.from, content: m.content.substring(0, 100) }))
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
