'use strict';

/**
 * agent5.js – Final Lead Output & Outreach Drafting Agent
 * 
 * The fifth and final layer in the B2B lead-generation system.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Read Agent 4 output carefully.
 * 2. Transform each qualified prospect into a final lead object.
 * 3. Include contact, company, email, scoring, verification, and outreach fields.
 * 4. Write concise outreach drafts: initial, followup, breakup.
 * 5. Return JSON array only.
 * 6. Keep every field consistent and machine-readable.
 * 
 * YOU MUST NOT:
 * - Return plain text.
 * - Invent facts.
 * - Over-search.
 * - Lose important fields from the input.
 * - Produce commentary outside the JSON array.
 */

const axios = require('axios');

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const MODEL = 'gpt-4o-mini';
const MAX_OUTPUT_TOKENS = 500;
const MAX_SEARCH_RESULTS = 3;
const MAX_QUERIES = 2;
const CONFIDENCE_THRESHOLD_ROUTE = 0.90;
const CONFIDENCE_THRESHOLD_CLARIFY = 0.50;

// ────────────────────────────────────────────────────────────────
// 2. The Agent 5 System Prompt
// ────────────────────────────────────────────────────────────────

const AGENT5_SYSTEM_PROMPT = `You are Agent 5, the final Lead Output and Outreach Drafting layer in a B2B lead-generation system.

Your job is to take qualified prospects from Agent 4 and return a clean JSON array of final lead objects. Each object should be ready for the user interface, export, or outbound workflow. You may use live search only when a fresh public fact materially improves the final result.

PRIMARY RESPONSIBILITIES
1. Read Agent 4 output carefully.
2. Transform each qualified prospect into a final lead object.
3. Include contact, company, email, scoring, verification, and outreach fields.
4. Write concise outreach drafts: initial, followup, breakup.
5. Return JSON array only.
6. Keep every field consistent and machine-readable.

YOU MUST NOT
- Return plain text.
- Invent facts.
- Over-search.
- Lose important fields from the input.
- Produce commentary outside the JSON array.

OUTPUT RULES
- Return only a JSON array.
- One array item per final lead.
- Each item must include the full schema.
- If a field is unknown, set it to null or an empty array.
- Keep messages short, direct, and professional.

SCHEMA
[
  {
    "name": string|null,
    "company": string|null,
    "domain": string|null,
    "email": string|null,
    "emailConfidence": string|null,
    "emailLabel": string|null,
    "verificationGrade": string|null,
    "emailValidation": {
      "confidenceScore": number|null,
      "verdict": string|null,
      "smtpResult": string|null,
      "reason": string|null,
      "grade": string|null
    },
    "allEmailOptions": string[],
    "role": string|null,
    "linkedIn": string|null,
    "companySize": string|null,
    "companyModel": string|null,
    "industry": string|null,
    "hq": string|null,
    "recentNews": string|null,
    "leadScore": number|null,
    "pageScore": number|null,
    "mxValid": boolean|null,
    "dataScore": number|null,
    "hallucinationFlags": string[],
    "emailLanguage": string|null,
    "_memoryStats": {
      "totalCompanies": number|null,
      "totalContacts": number|null,
      "totalResearch": number|null,
      "totalAnalytics": number|null
    },
    "messages": [
      {
        "type": "initial" | "followup" | "breakup",
        "subject": string,
        "body": string
      }
    ]
  }
]

MESSAGE RULES
- initial: first outreach message.
- followup: short polite bump.
- breakup: close the loop politely.
- Keep each body concise and human.
- No fluff.
- One clear CTA max.

CONFIDENCE GUIDELINES
- 0.90 to 1.00 = very clear, strong final output.
- 0.70 to 0.89 = mostly clear.
- 0.50 to 0.69 = mixed, needs caution.
- below 0.50 = stop and clarify.`;

// ────────────────────────────────────────────────────────────────
// 3. Utility: Retry helper
// ────────────────────────────────────────────────────────────────

async function withRetry(fn, label, retries = 2, delayMs = 800) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isLast = attempt === retries;
            if (err.response?.status && err.response.status < 500 && err.response.status !== 429) {
                console.warn(`⛔ [${label}] Non-retryable (${err.response.status}): ${err.message}`);
                return null;
            }
            console.warn(`⚠️ [${label}] attempt ${attempt + 1} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying'}`);
            if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
    }
    return null;
}

// ────────────────────────────────────────────────────────────────
// 4. Tavily Search Helper
// ────────────────────────────────────────────────────────────────

async function searchTavily(query, tavilyKey, maxResults = MAX_SEARCH_RESULTS) {
    if (!tavilyKey) {
        console.warn('⚠️ [TAVILY] No API key provided');
        return [];
    }

    try {
        const response = await withRetry(() => axios.post(
            'https://api.tavily.com/search',
            {
                api_key: tavilyKey,
                query: query,
                search_depth: 'basic',
                max_results: maxResults,
                include_answer: false,
                include_raw_content: false,
            },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            }
        ), `Tavily:${query.slice(0, 40)}`);

        if (!response) return [];

        return (response.data?.results || []).map(r => ({
            title: r.title || '',
            url: r.url || '',
            snippet: r.content || '',
            date: r.published_date || null,
        }));

    } catch (error) {
        console.error(`❌ [TAVILY] Search failed:`, error.message);
        return [];
    }
}

// ────────────────────────────────────────────────────────────────
// 5. Build Final Output Queries
// ────────────────────────────────────────────────────────────────

function buildFinalQueries(prospects) {
    const queries = [];
    
    // Only search if we need a fresh signal for the first prospect
    const firstProspect = prospects[0];
    if (firstProspect && !firstProspect.recentNews && firstProspect.company) {
        queries.push(`"${firstProspect.company}" news recent`);
    }

    // If the first prospect doesn't have a website, try to find it
    if (firstProspect && !firstProspect.website && firstProspect.company) {
        queries.push(`"${firstProspect.company}" official website`);
    }

    return queries.slice(0, MAX_QUERIES);
}

// ────────────────────────────────────────────────────────────────
// 6. Main Agent 5 Function
// ────────────────────────────────────────────────────────────────

/**
 * Converts qualified prospects into final lead objects with outreach messages.
 * 
 * @param {Object} params
 * @param {Array}  params.qualified_prospects - The qualified prospects from Agent 4.
 * @param {Object} params.intent - The original intent from Agent 1.
 * @param {string} params.userProfile - User profile for sender name and USP.
 * @param {string} params.apiKey - OpenAI API key.
 * @param {string} params.tavilyKey - Tavily API key.
 * @param {string} params.userId - User identifier for logging.
 * @param {Function} params.onProgress - Optional progress callback.
 * 
 * @returns {Object} Structured final output result.
 */
async function formatFinalLeads({ qualified_prospects, intent, userProfile, apiKey, tavilyKey, userId = 'anonymous', onProgress = null }) {
    console.log(`📦 [AGENT5] Formatting final leads for user ${userId}...`);
    onProgress?.('📦 Packaging final leads...');

    // Validate input
    if (!qualified_prospects || qualified_prospects.length === 0) {
        return {
            intent: 'lead_output',
            confidence: 0.0,
            needs_clarification: true,
            clarification_question: 'No qualified prospects were provided to format.',
            next_pipeline: null,
            entities: intent?.entities || {},
            risk_level: 'low',
            policy_flags: ['no_prospects'],
            reason: 'No qualified prospects provided to Agent 5.',
            leads: [],
            stats: { input: 0, output: 0, searched: 0 }
        };
    }

    // ─── Step 1: Optional search for fresh signals ───
    let searchResults = [];
    let searched = 0;
    
    if (tavilyKey) {
        const queries = buildFinalQueries(qualified_prospects);
        if (queries.length > 0) {
            onProgress?.('🔍 Checking for fresh signals...');
            for (const query of queries) {
                const results = await searchTavily(query, tavilyKey, 3);
                if (results && results.length > 0) {
                    searchResults = searchResults.concat(results);
                    searched++;
                }
            }
        }
    }

    // ─── Step 2: Build input for GPT formatting ───
    const senderName = userProfile?.senderName || 'Alex';
    const usp = userProfile?.usp || 'We build outreach pipelines that cut manual prospecting time.';

    const searchSnippets = searchResults.length > 0
        ? searchResults.map(r => `- ${r.title}: ${r.snippet}`).join('\n')
        : 'No additional signals found.';

    const formattingPrompt = `
You are Agent 5, the final output formatter. Convert these qualified prospects into final lead objects.

SENDER NAME: ${senderName}
VALUE PROP: ${usp}

QUALIFIED PROSPECTS:
${qualified_prospects.map((p, i) => `
PROSPECT ${i + 1}:
- Name: ${p.name || 'Unknown'}
- Company: ${p.company || 'Unknown'}
- Domain: ${p.domain || 'Unknown'}
- Website: ${p.website || 'Unknown'}
- Location: ${p.location || 'Unknown'}
- Role: ${p.role || 'Unknown'}
- Industry: ${p.industry || 'Unknown'}
- Fit Score: ${p.fit_score || 0}
- Priority: ${p.priority || 'medium'}
- Qualification Status: ${p.qualification_status || 'qualified'}
- Personalization Angle: ${p.personalization_angle || null}
- Notes: ${p.notes || null}
`).join('\n---\n')}

FRESH SEARCH SIGNALS:
${searchSnippets}

For each prospect, create a final lead object with:
1. All identity fields (name, company, domain, email)
2. Email validation fields (set reasonable defaults based on qualification status)
3. Company details (size, model, industry, HQ)
4. Scoring fields (leadScore, etc.)
5. 3 outreach messages: initial, followup, breakup

OUTREACH MESSAGE GUIDELINES:
- Use the personalization_angle if provided
- Keep each message under 120 words
- No fluff, no corporate speak
- One clear CTA per message
- Sign off with: Best,\n${senderName}

Return ONLY a JSON array of lead objects following the exact schema provided in the system prompt.`;

    try {
        const response = await withRetry(() => axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: MODEL,
                messages: [
                    { role: 'system', content: AGENT5_SYSTEM_PROMPT },
                    { role: 'user', content: formattingPrompt }
                ],
                max_tokens: MAX_OUTPUT_TOKENS,
                temperature: 0.3,
                response_format: { type: 'json_object' }
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 20000
            }
        ), 'GPT:formatLeads');

        if (!response) {
            return {
                intent: 'lead_output',
                confidence: 0.0,
                needs_clarification: true,
                clarification_question: 'Failed to format leads. Please try again.',
                next_pipeline: null,
                entities: intent?.entities || {},
                risk_level: 'medium',
                policy_flags: ['formatting_failure'],
                reason: 'GPT formatting failed.',
                leads: [],
                stats: { input: qualified_prospects.length, output: 0, searched }
            };
        }

        const rawContent = response.data.choices[0].message.content.trim();
        const parsed = JSON.parse(rawContent);

        // ─── Step 3: Extract leads from response ───
        let leads = [];
        if (Array.isArray(parsed)) {
            leads = parsed;
        } else if (parsed.leads && Array.isArray(parsed.leads)) {
            leads = parsed.leads;
        } else if (parsed.qualified_prospects && Array.isArray(parsed.qualified_prospects)) {
            leads = parsed.qualified_prospects;
        } else {
            // Try to find any array in the object
            for (const key of Object.keys(parsed)) {
                if (Array.isArray(parsed[key])) {
                    leads = parsed[key];
                    break;
                }
            }
        }

        // ─── Step 4: Ensure each lead has messages ───
        leads = leads.map(lead => {
            // Ensure messages exist
            if (!lead.messages || lead.messages.length === 0) {
                const name = lead.name || lead.company || 'there';
                const company = lead.company || 'your company';
                const angle = lead.personalization_angle || 'growth and efficiency';
                
                lead.messages = [
                    {
                        type: 'initial',
                        subject: `One thought on ${company}`,
                        body: `Hi ${name},\n\nRunning a ${lead.industry || 'business'} means most of your day goes to work that doesn't directly close deals.\n\n${usp}\n\nWorth 15 minutes this week?\n\nBest,\n${senderName}`
                    },
                    {
                        type: 'followup',
                        subject: `Re: One thought on ${company}`,
                        body: `Hi ${name},\n\nFloating this back up — most ${lead.industry || 'business'} operators I speak to say the same thing: there aren't enough hours to prospect and deliver at the same time.\n\nStill worth a quick chat?\n\nBest,\n${senderName}`
                    },
                    {
                        type: 'breakup',
                        subject: `Closing my file on ${company}`,
                        body: `Hi ${name},\n\nAssuming timing isn't right for ${company} right now — I'll stop following up. Reach out whenever it makes sense.\n\nBest,\n${senderName}`
                    }
                ];
            }
            return lead;
        });

        // ─── Step 5: Calculate confidence ───
        const confidence = leads.length > 0 ? Math.min(0.95, 0.7 + (leads.length / qualified_prospects.length) * 0.25) : 0.4;
        const needsClarification = confidence < CONFIDENCE_THRESHOLD_CLARIFY;

        const result = {
            intent: 'lead_output',
            confidence: Math.round(confidence * 100) / 100,
            needs_clarification: needsClarification,
            clarification_question: needsClarification 
                ? 'I formatted the leads but some fields are missing. Please check the output.'
                : null,
            next_pipeline: 'complete',
            entities: intent?.entities || {
                industry: intent?.industry || null,
                location: intent?.location || null,
                role: intent?.role || null,
                company: intent?.company || null,
                lead_count: leads.length,
                email: null,
                domain: null,
                source_type: 'web_search'
            },
            risk_level: leads.length / qualified_prospects.length < 0.5 ? 'medium' : 'low',
            policy_flags: leads.length === 0 ? ['no_output'] : [],
            reason: `Formatted ${leads.length} final leads from ${qualified_prospects.length} qualified prospects.`,
            leads: leads,
            stats: {
                input: qualified_prospects.length,
                output: leads.length,
                searched: searched
            }
        };

        console.log(`✅ [AGENT5] Formatting complete: ${leads.length} leads output`);
        return result;

    } catch (error) {
        console.error(`❌ [AGENT5] Formatting failed:`, error.message);
        return {
            intent: 'lead_output',
            confidence: 0.0,
            needs_clarification: true,
            clarification_question: 'Failed to format leads. Please try again.',
            next_pipeline: null,
            entities: intent?.entities || {},
            risk_level: 'medium',
            policy_flags: ['formatting_failure'],
            reason: `Formatting failed: ${error.message}`,
            leads: [],
            stats: { input: qualified_prospects.length, output: 0, searched }
        };
    }
}

// ────────────────────────────────────────────────────────────────
// 7. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
    formatFinalLeads,
    buildFinalQueries,
    searchTavily,
    CONFIDENCE_THRESHOLD_ROUTE,
    CONFIDENCE_THRESHOLD_CLARIFY,
};
