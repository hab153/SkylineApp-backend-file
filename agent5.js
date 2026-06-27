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
const MAX_OUTPUT_TOKENS = 1200;
const MAX_SEARCH_RESULTS = 3;
const MAX_QUERIES = 2;
const CONFIDENCE_THRESHOLD_ROUTE = 0.90;
const CONFIDENCE_THRESHOLD_CLARIFY = 0.50;

// ────────────────────────────────────────────────────────────────
// 2. The Agent 5 System Prompt (COMPRESSED SCHEMA)
// ────────────────────────────────────────────────────────────────

const AGENT5_SYSTEM_PROMPT = `You are Agent 5, the final Lead Output and Outreach Drafting layer in a B2B lead-generation system.

Your job is to take qualified prospects from Agent 4 and return a clean JSON array of final lead objects. Each object should be ready for the user interface, export, or outbound workflow.

PRIMARY RESPONSIBILITIES
1. Read Agent 4 output carefully.
2. Transform each qualified prospect into a final lead object.
3. Include contact, company, email, scoring, verification, and outreach fields.
4. Write concise outreach drafts: initial, followup, breakup.
5. Return JSON array only.

YOU MUST NOT
- Return plain text.
- Invent facts.
- Over-search.
- Produce commentary outside the JSON array.

OUTPUT RULES
- Return only a JSON array.
- One array item per final lead.
- If a field is unknown, set it to null or an empty array.
- Keep messages SHORT (under 80 words each).

COMPRESSED SCHEMA (use these short field names):
[
  {
    "name": string|null,
    "company": string|null,
    "domain": string|null,
    "email": string|null,
    "eConf": string|null,
    "eLabel": string|null,
    "vGrade": string|null,
    "eVal": {
      "score": number|null,
      "verdict": string|null,
      "smtp": string|null,
      "reason": string|null,
      "grade": string|null
    },
    "emails": string[],
    "role": string|null,
    "linkedin": string|null,
    "size": string|null,
    "model": string|null,
    "industry": string|null,
    "hq": string|null,
    "news": string|null,
    "leadScore": number|null,
    "pageScore": number|null,
    "mxValid": boolean|null,
    "dataScore": number|null,
    "flags": string[],
    "lang": string|null,
    "_mem": {
      "companies": number|null,
      "contacts": number|null,
      "research": number|null,
      "analytics": number|null
    },
    "messages": [
      { "type": "initial" | "followup" | "breakup", "subject": string, "body": string }
    ]
  }
]

MESSAGE RULES
- initial: first outreach message (3-4 sentences max).
- followup: short polite bump (2-3 sentences).
- breakup: close the loop politely (2-3 sentences).
- Keep each body SHORT and direct.
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
    
    const firstProspect = prospects[0];
    if (firstProspect && !firstProspect.news && firstProspect.company) {
        queries.push(`"${firstProspect.company}" news recent`);
    }

    if (firstProspect && !firstProspect.website && firstProspect.company) {
        queries.push(`"${firstProspect.company}" official website`);
    }

    return queries.slice(0, MAX_QUERIES);
}

// ────────────────────────────────────────────────────────────────
// 6. Enhanced Safe JSON Parsing with Auto-Fix
// ────────────────────────────────────────────────────────────────

function safeJsonParse(jsonString) {
    try {
        return { success: true, data: JSON.parse(jsonString) };
    } catch (error) {
        console.warn(`⚠️ [JSON] Parse error: ${error.message}`);
        console.warn(`⚠️ [JSON] Attempting to auto-fix...`);
        
        let fixed = jsonString;
        
        // Fix 1: Incomplete numbers
        fixed = fixed.replace(/(\d+)\.\s*([,\}\]])/g, '$1.0$2');
        fixed = fixed.replace(/(\d+)\.\s*$/g, '$1.0');
        fixed = fixed.replace(/(\d+)\.\s*\n/g, '$1.0\n');
        
        // Fix 2: Trailing commas
        fixed = fixed.replace(/,\s*}/g, '}');
        fixed = fixed.replace(/,\s*\]/g, ']');
        
        // Fix 3: Missing commas
        fixed = fixed.replace(/}\s*{/g, '},{');
        fixed = fixed.replace(/\]\s*{/g, '],{');
        fixed = fixed.replace(/}\s*"/g, '},"');
        fixed = fixed.replace(/\]\s*"/g, '],"');
        fixed = fixed.replace(/"\s*"/g, '","');
        
        // Fix 4: Remove control characters
        fixed = fixed.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
        
        // Fix 5: Fix unterminated strings (character by character)
        let result = '';
        let inString = false;
        let escapeNext = false;
        
        for (let i = 0; i < fixed.length; i++) {
            const char = fixed[i];
            
            if (escapeNext) {
                escapeNext = false;
                result += char;
                continue;
            }
            
            if (char === '\\') {
                escapeNext = true;
                result += char;
                continue;
            }
            
            if (char === '"') {
                if (!inString) {
                    inString = true;
                    result += char;
                } else {
                    let nextChar = '';
                    let j = i + 1;
                    while (j < fixed.length && /\s/.test(fixed[j])) j++;
                    if (j < fixed.length) {
                        nextChar = fixed[j];
                    }
                    
                    if (nextChar === ',' || nextChar === ']' || nextChar === '}' || nextChar === '' || nextChar === ' ' || nextChar === '\n') {
                        inString = false;
                        result += char;
                    } else {
                        result += char;
                    }
                }
                continue;
            }
            
            result += char;
        }
        
        if (inString) {
            result += '"';
            console.log(`🔧 [JSON] Added closing quote for unterminated string`);
        }
        
        fixed = result;
        
        // Fix 6: Missing closing brackets
        const openBraces = (fixed.match(/\{/g) || []).length;
        const closeBraces = (fixed.match(/\}/g) || []).length;
        const openBrackets = (fixed.match(/\[/g) || []).length;
        const closeBrackets = (fixed.match(/\]/g) || []).length;
        
        if (openBraces > closeBraces) {
            fixed += '}'.repeat(openBraces - closeBraces);
        }
        if (openBrackets > closeBrackets) {
            fixed += ']'.repeat(openBrackets - closeBrackets);
        }
        
        // Fix 7: Remove trailing text after last JSON structure
        const lastBrace = fixed.lastIndexOf('}');
        const lastBracket = fixed.lastIndexOf(']');
        const lastEnd = Math.max(lastBrace, lastBracket);
        if (lastEnd > 0 && lastEnd < fixed.length - 1) {
            const trailing = fixed.substring(lastEnd + 1).trim();
            if (trailing && !trailing.startsWith(',') && !trailing.startsWith(']') && !trailing.startsWith('}')) {
                fixed = fixed.substring(0, lastEnd + 1);
            }
        }
        
        // Fix 8: Clean up multiple closing braces
        fixed = fixed.replace(/\}\}\}/g, '}}');
        fixed = fixed.replace(/^\uFEFF/, '');
        
        // Fix 9: Missing commas between properties
        fixed = fixed.replace(/"\s*\n\s*"/g, '",\n"');
        fixed = fixed.replace(/}\s*\n\s*"/g, '},\n"');
        fixed = fixed.replace(/\]\s*\n\s*"/g, '],\n"');
        fixed = fixed.replace(/}\s*\n\s*{/g, '},\n{');
        fixed = fixed.replace(/\]\s*\n\s*{/g, '],\n{');
        fixed = fixed.replace(/"\s+"([^"]+?)"\s*:/g, '", "$1":');
        fixed = fixed.replace(/}\s+"([^"]+?)"\s*:/g, '}, "$1":');
        fixed = fixed.replace(/\]\s+"([^"]+?)"\s*:/g, '], "$1":');
        
        try {
            const data = JSON.parse(fixed);
            console.log(`✅ [JSON] Auto-fix successful`);
            return { success: true, data };
        } catch (retryError) {
            console.error(`❌ [JSON] Auto-fix failed: ${retryError.message}`);
            console.log(`⚠️ [JSON] Fixed snippet (last 200 chars): ...${fixed.slice(-200)}`);
            return { success: false, error: retryError };
        }
    }
}

// ────────────────────────────────────────────────────────────────
// 7. Main Agent 5 Function
// ────────────────────────────────────────────────────────────────

async function formatFinalLeads({ qualified_prospects, intent, userProfile, apiKey, tavilyKey, userId = 'anonymous', onProgress = null }) {
    console.log(`📦 [AGENT5] Formatting final leads for user ${userId}...`);
    onProgress?.('📦 Packaging final leads...');

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
You are Agent 5, the final output formatter. Convert these qualified prospects into final lead objects using the COMPRESSED SCHEMA.

SENDER: ${senderName}
VALUE: ${usp}

PROSPECTS:
${qualified_prospects.map((p, i) => `
${i+1}. ${p.name || 'Unknown'} | ${p.company || 'Unknown'} | ${p.role || 'Unknown'}
   Domain: ${p.domain || 'Unknown'}
   Location: ${p.location || 'Unknown'}
   Industry: ${p.industry || 'Unknown'}
   Fit: ${p.fit_score || 0} | Priority: ${p.priority || 'medium'}
   Angle: ${p.personalization_angle || 'growth'}
   Notes: ${p.notes || 'N/A'}
`).join('\n')}

${searchSnippets ? `\nSIGNALS:\n${searchSnippets}` : ''}

For each prospect, create a lead object with:
1. Identity fields (name, company, domain, email)
2. Email validation (set reasonable defaults based on qualification)
3. Company details (size, model, industry, HQ)
4. Scoring fields (leadScore, etc.)
5. 3 SHORT outreach messages (initial, followup, breakup) - keep under 80 words each

Use the COMPRESSED SCHEMA field names (eConf, vGrade, eVal, emails, size, model, news, flags, lang, _mem).

Return ONLY a JSON array. No extra text. Use the compressed schema.`;

    // ─── Step 3: Try formatting with retries ───
    let lastError = null;
    
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            console.log(`📦 [AGENT5] Formatting attempt ${attempt}/3...`);
            
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
                console.warn(`⚠️ [AGENT5] Formatting attempt ${attempt} returned null`);
                if (attempt === 3) break;
                continue;
            }

            const rawContent = response.data.choices[0].message.content.trim();
            
            const parseResult = safeJsonParse(rawContent);
            
            if (!parseResult.success) {
                console.warn(`⚠️ [AGENT5] JSON parse failed on attempt ${attempt}`);
                if (attempt === 3) break;
                continue;
            }

            const parsed = parseResult.data;

            // ─── Step 4: Extract leads ───
            let leads = [];
            if (Array.isArray(parsed)) {
                leads = parsed;
            } else if (parsed.leads && Array.isArray(parsed.leads)) {
                leads = parsed.leads;
            } else if (parsed.prospects && Array.isArray(parsed.prospects)) {
                leads = parsed.prospects;
            } else {
                for (const key of Object.keys(parsed)) {
                    if (Array.isArray(parsed[key])) {
                        leads = parsed[key];
                        break;
                    }
                }
            }

            // ─── Step 5: Ensure messages exist ───
            leads = leads.map(lead => {
                if (!lead.messages || lead.messages.length === 0) {
                    const name = lead.name || lead.company || 'there';
                    const company = lead.company || 'your company';
                    
                    lead.messages = [
                        {
                            type: 'initial',
                            subject: `One thought on ${company}`,
                            body: `Hi ${name},\n\nRunning a business means most of your day goes to work that doesn't close deals. We build outreach pipelines that cut manual prospecting time.\n\nWorth 15 minutes?\n\nBest,\n${senderName}`
                        },
                        {
                            type: 'followup',
                            subject: `Re: One thought on ${company}`,
                            body: `Hi ${name},\n\nFloating this back up — most business owners say there aren't enough hours to prospect and deliver.\n\nStill worth a quick chat?\n\nBest,\n${senderName}`
                        },
                        {
                            type: 'breakup',
                            subject: `Closing my file on ${company}`,
                            body: `Hi ${name},\n\nAssuming timing isn't right — I'll stop following up. Reach out whenever it makes sense.\n\nBest,\n${senderName}`
                        }
                    ];
                }
                return lead;
            });

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

            console.log(`✅ [AGENT5] Formatting complete: ${leads.length} leads output (attempt ${attempt})`);
            return result;

        } catch (error) {
            lastError = error;
            console.error(`❌ [AGENT5] Formatting attempt ${attempt} failed:`, error.message);
            if (attempt === 3) break;
        }
    }

    console.error(`❌ [AGENT5] All formatting attempts failed. Last error: ${lastError?.message || 'Unknown error'}`);
    
    return {
        intent: 'lead_output',
        confidence: 0.0,
        needs_clarification: true,
        clarification_question: 'Failed to format leads. Please try again.',
        next_pipeline: null,
        entities: intent?.entities || {},
        risk_level: 'medium',
        policy_flags: ['formatting_failure'],
        reason: `Formatting failed after 3 attempts: ${lastError?.message || 'Unknown error'}`,
        leads: [],
        stats: { input: qualified_prospects.length, output: 0, searched }
    };
}

// ────────────────────────────────────────────────────────────────
// 8. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
    formatFinalLeads,
    buildFinalQueries,
    searchTavily,
    safeJsonParse,
    CONFIDENCE_THRESHOLD_ROUTE,
    CONFIDENCE_THRESHOLD_CLARIFY,
};
