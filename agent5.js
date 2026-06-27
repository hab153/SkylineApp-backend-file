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
const MAX_OUTPUT_TOKENS = 800;
const MAX_SEARCH_RESULTS = 3;
const MAX_QUERIES = 2;
const CONFIDENCE_THRESHOLD_ROUTE = 0.90;
const CONFIDENCE_THRESHOLD_CLARIFY = 0.50;

// ────────────────────────────────────────────────────────────────
// 2. The Agent 5 System Prompt
// ────────────────────────────────────────────────────────────────

const AGENT5_SYSTEM_PROMPT = `You are Agent 5, the final Lead Output and Outreach Drafting layer in a B2B lead-generation system.

Your job is to take ONE qualified prospect and return a single lead object ready for the user interface.

OUTPUT RULES
- Return only a JSON object (not an array) for a single lead.
- If a field is unknown, set it to null or an empty array.
- Keep messages SHORT (under 80 words each).
- CRITICAL: The email field MUST be populated. DO NOT return null for email if provided in the prospect data.

SCHEMA (use these exact field names):
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
      "type": "initial",
      "subject": string,
      "body": string
    },
    {
      "type": "followup",
      "subject": string,
      "body": string
    },
    {
      "type": "breakup",
      "subject": string,
      "body": string
    }
  ]
}

MESSAGE RULES
- initial: first outreach message (3-4 sentences max).
- followup: short polite bump (2-3 sentences).
- breakup: close the loop politely (2-3 sentences).
- Keep each body SHORT and direct.
- One clear CTA max.`;

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

function buildFinalQueries(prospect) {
    const queries = [];
    
    if (prospect && !prospect.recentNews && prospect.company) {
        queries.push(`"${prospect.company}" news recent`);
    }

    if (prospect && !prospect.website && prospect.company) {
        queries.push(`"${prospect.company}" official website`);
    }

    return queries.slice(0, MAX_QUERIES);
}

// ────────────────────────────────────────────────────────────────
// 6. Safe JSON Parsing with Auto-Fix
// ────────────────────────────────────────────────────────────────

function safeJsonParse(jsonString) {
    try {
        return { success: true, data: JSON.parse(jsonString) };
    } catch (error) {
        console.warn(`⚠️ [JSON] Parse error: ${error.message}`);
        console.warn(`⚠️ [JSON] Attempting to auto-fix...`);
        
        let fixed = jsonString;
        
        fixed = fixed.replace(/(\d+)\.\s*([,\}\]])/g, '$1.0$2');
        fixed = fixed.replace(/(\d+)\.\s*$/g, '$1.0');
        fixed = fixed.replace(/(\d+)\.\s*\n/g, '$1.0\n');
        fixed = fixed.replace(/,\s*}/g, '}');
        fixed = fixed.replace(/,\s*\]/g, ']');
        fixed = fixed.replace(/}\s*{/g, '},{');
        fixed = fixed.replace(/\]\s*{/g, '],{');
        fixed = fixed.replace(/}\s*"/g, '},"');
        fixed = fixed.replace(/\]\s*"/g, '],"');
        fixed = fixed.replace(/"\s*"/g, '","');
        fixed = fixed.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
        
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
        
        const lastBrace = fixed.lastIndexOf('}');
        const lastBracket = fixed.lastIndexOf(']');
        const lastEnd = Math.max(lastBrace, lastBracket);
        if (lastEnd > 0 && lastEnd < fixed.length - 1) {
            const trailing = fixed.substring(lastEnd + 1).trim();
            if (trailing && !trailing.startsWith(',') && !trailing.startsWith(']') && !trailing.startsWith('}')) {
                fixed = fixed.substring(0, lastEnd + 1);
            }
        }
        
        fixed = fixed.replace(/\}\}\}/g, '}}');
        fixed = fixed.replace(/^\uFEFF/, '');
        
        try {
            const data = JSON.parse(fixed);
            console.log(`✅ [JSON] Auto-fix successful`);
            return { success: true, data };
        } catch (retryError) {
            console.error(`❌ [JSON] Auto-fix failed: ${retryError.message}`);
            return { success: false, error: retryError };
        }
    }
}

// ────────────────────────────────────────────────────────────────
// 7. Format a Single Lead (WITH LOGGING)
// ────────────────────────────────────────────────────────────────

async function formatSingleLead(prospect, intent, userProfile, apiKey, tavilyKey) {
    const senderName = userProfile?.senderName || 'Alex';
    const usp = userProfile?.usp || 'We build outreach pipelines that cut manual prospecting time.';

    // --- LOG: What we received from Agent 4 ---
    console.log(`📥 [AGENT5] RECEIVED PROSPECT:`);
    console.log(`   - Company: ${prospect.company || 'Unknown'}`);
    console.log(`   - Name: ${prospect.name || 'Unknown'}`);
    console.log(`   - Domain: ${prospect.domain || 'Unknown'}`);
    console.log(`   - email_candidates: ${JSON.stringify(prospect.email_candidates || [])}`);
    console.log(`   - email field: ${prospect.email || 'null'}`);
    console.log(`   - fit_score: ${prospect.fit_score || 0}`);
    console.log(`   - priority: ${prospect.priority || 'medium'}`);
    console.log(`   - qualification_status: ${prospect.qualification_status || 'unknown'}`);

    // --- Extract email from prospect ---
    const email = prospect.email_candidates?.[0] || prospect.email || null;
    const emailOptions = prospect.email_candidates || [];

    console.log(`📧 [AGENT5] Extracted email: ${email || 'null'}`);
    console.log(`📧 [AGENT5] Email options: ${JSON.stringify(emailOptions)}`);

    // --- Build prompt with email included ---
    const formattingPrompt = `
You are Agent 5, the final output formatter. Convert this ONE prospect into a final lead object.

SENDER: ${senderName}
VALUE: ${usp}

PROSPECT:
- Name: ${prospect.name || 'Unknown'}
- Company: ${prospect.company || 'Unknown'}
- Domain: ${prospect.domain || 'Unknown'}
- Email: ${email || 'null'}
- Website: ${prospect.website || 'Unknown'}
- Location: ${prospect.location || 'Unknown'}
- Role: ${prospect.role || 'Unknown'}
- Industry: ${prospect.industry || 'Unknown'}
- Fit Score: ${prospect.fit_score || 0}
- Priority: ${prospect.priority || 'medium'}
- Qualification Status: ${prospect.qualification_status || 'qualified'}
- Personalization Angle: ${prospect.personalization_angle || null}
- Notes: ${prospect.notes || null}

CRITICAL INSTRUCTION:
- The email field MUST be set to "${email}" in the output. DO NOT return null for email.
- If email is "${email}", set email to "${email}".

Create a final lead object with:
1. All identity fields (name, company, domain, email) - SET THE EMAIL FIELD
2. Email validation fields (set defaults based on qualification status)
3. Company details (size, model, industry, HQ)
4. Scoring fields (leadScore, etc.)
5. 3 SHORT outreach messages: initial, followup, breakup (under 80 words each)

Use the EXACT SCHEMA from the system prompt. Return ONLY a JSON object.

IMPORTANT: 
- The email field MUST be set to "${email}" if provided.
- Keep messages SHORT and DIRECT. No fluff. One clear CTA max.`;

    try {
        console.log(`📤 [AGENT5] Sending to GPT with email: ${email || 'null'}...`);

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
                timeout: 15000
            }
        ), 'GPT:formatSingleLead');

        if (!response) {
            console.warn(`⚠️ [AGENT5] Formatting returned null for ${prospect.company}`);
            return null;
        }

        const rawContent = response.data.choices[0].message.content.trim();
        const parseResult = safeJsonParse(rawContent);
        
        if (!parseResult.success) {
            console.warn(`⚠️ [AGENT5] JSON parse failed for ${prospect.company}`);
            return null;
        }

        const lead = parseResult.data;
        
        // --- LOG: What GPT returned ---
        console.log(`📥 [AGENT5] GPT RETURNED:`);
        console.log(`   - Company: ${lead.company || 'Unknown'}`);
        console.log(`   - Name: ${lead.name || 'Unknown'}`);
        console.log(`   - Email from GPT: ${lead.email || 'null'}`);
        console.log(`   - allEmailOptions from GPT: ${JSON.stringify(lead.allEmailOptions || [])}`);
        
        // --- FORCE: Set email from prospect data if GPT didn't set it ---
        if (email) {
            if (!lead.email || lead.email === 'null' || lead.email === '') {
                lead.email = email;
                console.log(`📧 [AGENT5] FORCE SET email from prospect data: ${email}`);
            }
        }
        
        // --- FORCE: Set allEmailOptions ---
        if (emailOptions.length > 0) {
            if (!lead.allEmailOptions || lead.allEmailOptions.length === 0) {
                lead.allEmailOptions = emailOptions;
                console.log(`📧 [AGENT5] FORCE SET allEmailOptions: ${JSON.stringify(emailOptions)}`);
            }
        }
        
        // --- FORCE: Ensure email is never null if we have it ---
        if (email && (lead.email === null || lead.email === undefined)) {
            lead.email = email;
            console.log(`📧 [AGENT5] FORCE SET email (null check): ${email}`);
        }
        
        // Ensure messages exist
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

        // --- LOG: What we are returning ---
        console.log(`📤 [AGENT5] FINAL LEAD OUTPUT:`);
        console.log(`   - Company: ${lead.company || 'Unknown'}`);
        console.log(`   - Name: ${lead.name || 'Unknown'}`);
        console.log(`   - Email FINAL: ${lead.email || 'null'}`);
        console.log(`   - allEmailOptions FINAL: ${JSON.stringify(lead.allEmailOptions || [])}`);
        console.log(`   - Has messages: ${lead.messages ? lead.messages.length : 0}`);

        return lead;

    } catch (error) {
        console.error(`❌ [AGENT5] Formatting failed for ${prospect.company}:`, error.message);
        return null;
    }
}

// ────────────────────────────────────────────────────────────────
// 8. Main Agent 5 Function
// ────────────────────────────────────────────────────────────────

async function formatFinalLeads({ qualified_prospects, intent, userProfile, apiKey, tavilyKey, userId = 'anonymous', onProgress = null }) {
    console.log(`📦 [AGENT5] Formatting final leads for user ${userId}...`);
    console.log(`📦 [AGENT5] Processing ${qualified_prospects.length} prospects one by one...`);
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

    let formattedLeads = [];
    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < qualified_prospects.length; i++) {
        const prospect = qualified_prospects[i];
        onProgress?.(`📦 Formatting ${i + 1}/${qualified_prospects.length}: ${prospect.company || prospect.name || 'Unknown'}...`);
        
        console.log(`📦 [AGENT5] Formatting prospect ${i + 1}/${qualified_prospects.length}: ${prospect.company || 'Unknown'}`);
        
        const lead = await formatSingleLead(prospect, intent, userProfile, apiKey, tavilyKey);
        
        if (lead) {
            formattedLeads.push(lead);
            successCount++;
            console.log(`✅ [AGENT5] Successfully formatted: ${lead.company || 'Unknown'} (email: ${lead.email || 'null'})`);
        } else {
            failureCount++;
            console.log(`❌ [AGENT5] Failed to format: ${prospect.company || 'Unknown'}`);
        }
    }

    console.log(`📦 [AGENT5] Formatting complete: ${successCount} succeeded, ${failureCount} failed`);
    console.log(`📧 [AGENT5] FINAL LEADS EMAIL SUMMARY:`);
    formattedLeads.forEach((lead, i) => {
        console.log(`   ${i + 1}. ${lead.company || 'Unknown'} → email: ${lead.email || 'null'}`);
    });

    const confidence = successCount > 0 ? Math.min(0.95, 0.7 + (successCount / qualified_prospects.length) * 0.25) : 0.4;
    const needsClarification = confidence < CONFIDENCE_THRESHOLD_CLARIFY;

    return {
        intent: 'lead_output',
        confidence: Math.round(confidence * 100) / 100,
        needs_clarification: needsClarification,
        clarification_question: needsClarification 
            ? 'Some leads failed to format. Please try again.'
            : null,
        next_pipeline: formattedLeads.length > 0 ? 'complete' : null,
        entities: intent?.entities || {
            industry: intent?.industry || null,
            location: intent?.location || null,
            role: intent?.role || null,
            company: intent?.company || null,
            lead_count: formattedLeads.length,
            email: null,
            domain: null,
            source_type: 'web_search'
        },
        risk_level: formattedLeads.length / qualified_prospects.length < 0.5 ? 'medium' : 'low',
        policy_flags: formattedLeads.length === 0 ? ['no_output'] : [],
        reason: `Formatted ${formattedLeads.length} final leads from ${qualified_prospects.length} qualified prospects.`,
        leads: formattedLeads,
        stats: {
            input: qualified_prospects.length,
            output: formattedLeads.length,
            searched: 0,
            failed: failureCount
        }
    };
}

// ────────────────────────────────────────────────────────────────
// 9. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
    formatFinalLeads,
    formatSingleLead,
    buildFinalQueries,
    searchTavily,
    safeJsonParse,
    CONFIDENCE_THRESHOLD_ROUTE,
    CONFIDENCE_THRESHOLD_CLARIFY,
};
