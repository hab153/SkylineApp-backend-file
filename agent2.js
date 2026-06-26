'use strict';

/**
 * agent2.js – Prospecting / Discovery Agent
 * 
 * The second layer in the B2B lead-generation system.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Read the Agent 1 intent object carefully.
 * 2. Search defined sources (Tavily) for matching prospects.
 * 3. Extract raw prospect records: name, company, domain, source, location, role, fit signals.
 * 4. Deduplicate results.
 * 5. Assign a preliminary fit score and confidence.
 * 6. Preserve all user constraints exactly.
 * 7. Return clean structured JSON only.
 * 
 * YOU MUST NOT:
 * - Write outreach.
 * - Send emails.
 * - Finalize sales decisions.
 * - Pretend emails are verified.
 * - Return a paragraph.
 * - Invent facts not supported by sources.
 */

const axios = require('axios');

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const MODEL = 'gpt-4o-mini';
const MAX_OUTPUT_TOKENS = 500;
const MAX_SEARCH_RESULTS = 5;
const MAX_QUERIES = 3;
const CONFIDENCE_THRESHOLD_ROUTE = 0.90;
const CONFIDENCE_THRESHOLD_CLARIFY = 0.50;

// ────────────────────────────────────────────────────────────────
// 2. The Agent 2 System Prompt (locked, production-grade)
// ────────────────────────────────────────────────────────────────

const AGENT2_SYSTEM_PROMPT = `You are Agent 2, the Prospecting / Discovery layer in a B2B lead-generation system.

Your job is to take the structured routing output from Agent 1 and find candidate companies or people that match the request. You may search the web or defined data sources to discover prospects, but you must not send outreach, make final business decisions, or verify deliverability as your main task.

PRIMARY RESPONSIBILITIES
1. Read the Agent 1 intent object carefully.
2. Search only relevant, defined sources for matching prospects.
3. Extract raw prospect records: name, company, domain, source, location, role, and any public fit signals.
4. Deduplicate results.
5. Assign a preliminary fit score and confidence.
6. Preserve all user constraints exactly.
7. Return clean structured JSON only.

YOU MUST NOT
- Write outreach.
- Send emails.
- Finalize sales decisions.
- Pretend emails are verified.
- Return a paragraph.
- Invent facts not supported by sources.

SEARCH RULES
- Use targeted queries.
- Prefer fresh, source-backed public information.
- Search only as much as needed to satisfy the request.
- If the request is unclear, request clarification instead of guessing.

OUTPUT FORMAT
Return valid JSON only using this schema:
{
  "intent": string,
  "confidence": number,
  "needs_clarification": boolean,
  "clarification_question": string|null,
  "next_pipeline": string|null,
  "entities": {
    "industry": string|null,
    "location": string|null,
    "role": string|null,
    "company": string|null,
    "lead_count": number|null,
    "email": string|null,
    "domain": string|null,
    "source_type": string|null
  },
  "risk_level": "low" | "medium" | "high",
  "policy_flags": string[],
  "reason": string,
  "prospects": [
    {
      "name": string|null,
      "company": string|null,
      "domain": string|null,
      "source": string|null,
      "source_url": string|null,
      "location": string|null,
      "role": string|null,
      "fit_score": number|null,
      "email_candidates": string[],
      "notes": string|null
    }
  ],
  "stats": {
    "searched": number,
    "found": number,
    "returned": number,
    "deduped": number
  }
}

CONFIDENCE GUIDELINES
- 0.90 to 1.00 = very clear, strong match.
- 0.70 to 0.89 = mostly clear.
- 0.50 to 0.69 = ambiguous, ask for clarification.
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
// 5. Build Search Queries from Intent
// ────────────────────────────────────────────────────────────────

function buildSearchQueries(intent) {
    const queries = [];
    const industry = intent.industry || '';
    const location = intent.location || '';
    const role = intent.role || '';
    const company = intent.company || '';

    // Primary query: industry + location + role
    if (industry && location && role) {
        queries.push(`"${industry}" "${location}" "${role}" company contact`);
    } else if (industry && location) {
        queries.push(`"${industry}" companies in "${location}"`);
    } else if (industry && role) {
        queries.push(`"${industry}" "${role}" company`);
    } else if (industry) {
        queries.push(`"${industry}" companies list contact email`);
    } else if (company) {
        queries.push(`"${company}" company contact email`);
    }

    // Fallback query
    if (queries.length === 0) {
        queries.push('business contact email directory');
    }

    // Ensure we don't exceed MAX_QUERIES
    return queries.slice(0, MAX_QUERIES);
}

// ────────────────────────────────────────────────────────────────
// 6. Extract Prospects from Search Results (using GPT)
// ────────────────────────────────────────────────────────────────

async function extractProspectsFromResults(searchResults, intent, apiKey) {
    if (!searchResults || searchResults.length === 0) {
        return { prospects: [], found: 0 };
    }

    // Build a compact text from search results
    const snippets = searchResults.map((r, i) => 
        `[${i + 1}] TITLE: ${r.title}\nURL: ${r.url}\nSNIPPET: ${r.snippet}`
    ).join('\n\n---\n\n');

    const extractionPrompt = `
You are a prospect extraction expert. Extract companies and contacts from the search results below.

USER REQUEST:
- Industry: ${intent.industry || 'Any'}
- Location: ${intent.location || 'Any'}
- Role: ${intent.role || 'Any'}
- Company: ${intent.company || 'Any'}
- Max leads: ${intent.lead_count || 5}

SEARCH RESULTS:
${snippets}

Extract all companies that match the user's request. For each company, extract:
- name: Company name exactly as written
- company: Same as name
- domain: The company's domain (e.g., example.com) if present in URL or text, otherwise null
- source: "web_search"
- source_url: The URL where the company was found
- location: City/Country if mentioned, otherwise null
- role: CEO/Founder/Director if mentioned, otherwise null
- fit_score: 0.0 to 1.0 based on how well it matches the user's request
- email_candidates: Any emails found in the text (max 3), empty array if none
- notes: Brief note on why this company matches

Return ONLY valid JSON array of prospect objects. Max ${intent.lead_count || 5} items.
`;

    try {
        const response = await withRetry(() => axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: MODEL,
                messages: [
                    { role: 'system', content: 'You extract structured prospect data from search results. Return only valid JSON.' },
                    { role: 'user', content: extractionPrompt }
                ],
                max_tokens: MAX_OUTPUT_TOKENS,
                temperature: 0.0,
                response_format: { type: 'json_object' }
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        ), 'GPT:extractProspects');

        if (!response) {
            console.warn('⚠️ [AGENT2] GPT extraction returned null');
            return { prospects: [], found: 0 };
        }

        const rawContent = response.data.choices[0].message.content.trim();
        const parsed = JSON.parse(rawContent);

        // Handle both array and object responses
        let prospects = [];
        if (Array.isArray(parsed)) {
            prospects = parsed;
        } else if (parsed.prospects && Array.isArray(parsed.prospects)) {
            prospects = parsed.prospects;
        } else {
            // Try to find any array in the object
            for (const key of Object.keys(parsed)) {
                if (Array.isArray(parsed[key])) {
                    prospects = parsed[key];
                    break;
                }
            }
        }

        console.log(`🧠 [AGENT2] Extracted ${prospects.length} prospects from search results`);
        return { prospects, found: prospects.length };

    } catch (error) {
        console.error(`❌ [AGENT2] GPT extraction failed:`, error.message);
        return { prospects: [], found: 0 };
    }
}

// ────────────────────────────────────────────────────────────────
// 7. Deduplicate Prospects
// ────────────────────────────────────────────────────────────────

function deduplicateProspects(prospects) {
    if (!prospects || prospects.length === 0) return { deduped: [], removed: 0 };

    const seen = new Set();
    const deduped = [];

    for (const p of prospects) {
        // Create a key from company name or domain or name
        const key = (p.company || p.name || '').toLowerCase().trim();
        if (!key) continue;
        
        // Check if we've seen this company before (fuzzy match on first word)
        const firstWord = key.split(' ')[0];
        let isDuplicate = false;
        for (const s of seen) {
            if (s.includes(firstWord) || firstWord.includes(s)) {
                isDuplicate = true;
                break;
            }
        }
        
        if (!isDuplicate) {
            seen.add(firstWord);
            deduped.push(p);
        }
    }

    const removed = prospects.length - deduped.length;
    console.log(`🔄 [AGENT2] Deduped: ${removed} removed, ${deduped.length} kept`);
    return { deduped, removed };
}

// ────────────────────────────────────────────────────────────────
// 8. Sort Prospects by Fit Score
// ────────────────────────────────────────────────────────────────

function sortProspectsByFit(prospects) {
    return prospects.sort((a, b) => (b.fit_score || 0) - (a.fit_score || 0));
}

// ────────────────────────────────────────────────────────────────
// 9. Main Agent 2 Function
// ────────────────────────────────────────────────────────────────

/**
 * Discovers prospects based on the intent from Agent 1.
 * 
 * @param {Object} params
 * @param {Object} params.intent - The structured intent from Agent 1.
 * @param {string} params.apiKey - OpenAI API key.
 * @param {string} params.tavilyKey - Tavily API key.
 * @param {string} params.userId - User identifier for logging.
 * @param {Function} params.onProgress - Optional progress callback.
 * 
 * @returns {Object} Structured prospect discovery result.
 */
async function discoverProspects({ intent, apiKey, tavilyKey, userId = 'anonymous', onProgress = null }) {
    console.log(`🔍 [AGENT2] Starting prospect discovery for user ${userId}...`);
    onProgress?.('🔎 Searching for matching prospects...');

    // Validate input
    if (!intent) {
        return {
            intent: 'lead_prospecting',
            confidence: 0.0,
            needs_clarification: true,
            clarification_question: 'I need more information about what you\'re looking for. Please specify industry, location, or role.',
            next_pipeline: null,
            entities: {},
            risk_level: 'low',
            policy_flags: ['missing_intent'],
            reason: 'No intent object provided to Agent 2.',
            prospects: [],
            stats: { searched: 0, found: 0, returned: 0, deduped: 0 }
        };
    }

    // Check if we have enough information to search
    const hasIndustry = intent.industry && intent.industry !== 'general';
    const hasLocation = intent.location && intent.location.trim().length > 0;
    const hasRole = intent.role && intent.role.trim().length > 0;
    const hasCompany = intent.company && intent.company.trim().length > 0;

    if (!hasIndustry && !hasLocation && !hasRole && !hasCompany) {
        return {
            intent: 'lead_prospecting',
            confidence: 0.4,
            needs_clarification: true,
            clarification_question: 'Could you be more specific about what you\'re looking for? For example: what industry, location, or role?',
            next_pipeline: null,
            entities: intent.entities || {},
            risk_level: 'low',
            policy_flags: ['vague_request'],
            reason: 'Insufficient information to perform a search.',
            prospects: [],
            stats: { searched: 0, found: 0, returned: 0, deduped: 0 }
        };
    }

    // ─── Step 1: Build search queries ───
    const queries = buildSearchQueries(intent);
    console.log(`🔍 [AGENT2] Search queries:`, queries);

    // ─── Step 2: Execute Tavily searches ───
    let allResults = [];
    let searchCount = 0;

    for (const query of queries) {
        if (searchCount >= MAX_QUERIES) break;
        searchCount++;
        onProgress?.(`🔎 Searching: "${query}"...`);
        
        const results = await searchTavily(query, tavilyKey, MAX_SEARCH_RESULTS);
        if (results && results.length > 0) {
            allResults = allResults.concat(results);
            console.log(`✅ [AGENT2] Found ${results.length} results for query: "${query}"`);
        } else {
            console.log(`⚠️ [AGENT2] No results for query: "${query}"`);
        }
    }

    // ─── Step 3: If no results, try a broader fallback query ───
    if (allResults.length === 0 && searchCount < MAX_QUERIES) {
        const fallbackQuery = `${intent.industry || ''} companies contact`.trim();
        onProgress?.(`🔄 Trying broader search: "${fallbackQuery}"...`);
        const fallbackResults = await searchTavily(fallbackQuery, tavilyKey, MAX_SEARCH_RESULTS);
        if (fallbackResults && fallbackResults.length > 0) {
            allResults = allResults.concat(fallbackResults);
            searchCount++;
        }
    }

    // ─── Step 4: Extract prospects from search results ───
    if (allResults.length === 0) {
        return {
            intent: 'lead_prospecting',
            confidence: 0.5,
            needs_clarification: true,
            clarification_question: 'I couldn\'t find any matching prospects. Could you try a different industry, location, or be more specific?',
            next_pipeline: null,
            entities: intent.entities || {},
            risk_level: 'low',
            policy_flags: ['no_results'],
            reason: `No search results found for: ${intent.industry || ''} ${intent.location || ''}`,
            prospects: [],
            stats: { searched: searchCount, found: 0, returned: 0, deduped: 0 }
        };
    }

    // ─── Step 5: Extract prospects using GPT ───
    onProgress?.('🧠 Extracting companies and contacts...');
    const { prospects, found } = await extractProspectsFromResults(allResults, intent, apiKey);

    if (!prospects || prospects.length === 0) {
        return {
            intent: 'lead_prospecting',
            confidence: 0.5,
            needs_clarification: true,
            clarification_question: 'I found search results but couldn\'t extract any matching companies. Could you try a different industry or location?',
            next_pipeline: null,
            entities: intent.entities || {},
            risk_level: 'low',
            policy_flags: ['extraction_failed'],
            reason: 'No prospects could be extracted from search results.',
            prospects: [],
            stats: { searched: searchCount, found: 0, returned: 0, deduped: 0 }
        };
    }

    // ─── Step 6: Deduplicate prospects ───
    const { deduped, removed } = deduplicateProspects(prospects);

    // ─── Step 7: Sort by fit score ───
    const sortedProspects = sortProspectsByFit(deduped);

    // ─── Step 8: Limit to requested count ───
    const maxLeads = intent.lead_count || 5;
    const returnedProspects = sortedProspects.slice(0, maxLeads);

    // ─── Step 9: Build confidence score ───
    let confidence = 0.85;
    if (returnedProspects.length < 2) confidence = 0.70;
    if (returnedProspects.length === 0) confidence = 0.40;
    if (!intent.industry || intent.industry === 'general') confidence -= 0.10;
    if (!intent.location) confidence -= 0.10;

    const needsClarification = confidence < CONFIDENCE_THRESHOLD_CLARIFY;

    // ─── Step 10: Build and return result ───
    const result = {
        intent: 'lead_prospecting',
        confidence: Math.round(confidence * 100) / 100,
        needs_clarification: needsClarification,
        clarification_question: needsClarification 
            ? 'I found some prospects but the match isn\'t strong. Could you provide more specific details about what you\'re looking for?'
            : null,
        next_pipeline: returnedProspects.length > 0 ? 'lead_enrichment' : null,
        entities: intent.entities || {
            industry: intent.industry || null,
            location: intent.location || null,
            role: intent.role || null,
            company: intent.company || null,
            lead_count: returnedProspects.length,
            email: null,
            domain: null,
            source_type: 'web_search'
        },
        risk_level: 'low',
        policy_flags: [],
        reason: `Found ${returnedProspects.length} candidate prospects that match the requested ICP and location.`,
        prospects: returnedProspects.map(p => ({
            name: p.name || p.company || null,
            company: p.company || p.name || null,
            domain: p.domain || null,
            source: p.source || 'web_search',
            source_url: p.source_url || null,
            location: p.location || intent.location || null,
            role: p.role || intent.role || null,
            fit_score: p.fit_score || 0.7,
            email_candidates: p.email_candidates || [],
            notes: p.notes || null,
        })),
        stats: {
            searched: searchCount,
            found: found,
            returned: returnedProspects.length,
            deduped: removed,
        }
    };

    console.log(`✅ [AGENT2] Discovery complete: ${returnedProspects.length} prospects returned`);
    return result;
}

// ────────────────────────────────────────────────────────────────
// 10. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
    discoverProspects,
    buildSearchQueries,
    searchTavily,
    extractProspectsFromResults,
    deduplicateProspects,
    sortProspectsByFit,
    CONFIDENCE_THRESHOLD_ROUTE,
    CONFIDENCE_THRESHOLD_CLARIFY,
};
