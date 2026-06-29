'use strict';

/**
 * agent2.js – Prospecting / Discovery Agent (Intelligent Search Planner)
 * 
 * The second layer in the B2B lead-generation system.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Read the Agent 1 intent object carefully.
 * 2. Plan and execute intelligent multi-round searches.
 * 3. Evaluate coverage and decide whether to continue searching.
 * 4. Extract raw prospect records with email candidates.
 * 5. Deduplicate and score results.
 * 6. Return clean structured JSON with search trace.
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
const MAX_ROUNDS = 2;
const MAX_QUERIES_PER_ROUND = 3;
const CONFIDENCE_THRESHOLD_ROUTE = 0.90;
const CONFIDENCE_THRESHOLD_CLARIFY = 0.50;
const COVERAGE_THRESHOLD_STOP = 0.75;

// ────────────────────────────────────────────────────────────────
// 2. The Agent 2 System Prompt
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
}`;

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
// 5. Extract Emails with Regex
// ────────────────────────────────────────────────────────────────

function extractEmailsWithRegex(text) {
    if (!text) return [];
    const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const matches = text.match(emailRegex) || [];
    return [...new Set(matches)];
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
            if (escapeNext) { escapeNext = false; result += char; continue; }
            if (char === '\\') { escapeNext = true; result += char; continue; }
            if (char === '"') {
                if (!inString) {
                    inString = true;
                    result += char;
                } else {
                    let nextChar = '';
                    let j = i + 1;
                    while (j < fixed.length && /\s/.test(fixed[j])) j++;
                    if (j < fixed.length) nextChar = fixed[j];
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
        if (inString) { result += '"'; console.log(`🔧 [JSON] Added closing quote`); }
        fixed = result;
        
        const openBraces = (fixed.match(/\{/g) || []).length;
        const closeBraces = (fixed.match(/\}/g) || []).length;
        const openBrackets = (fixed.match(/\[/g) || []).length;
        const closeBrackets = (fixed.match(/\]/g) || []).length;
        if (openBraces > closeBraces) fixed += '}'.repeat(openBraces - closeBraces);
        if (openBrackets > closeBrackets) fixed += ']'.repeat(openBrackets - closeBrackets);
        
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
// 7. Build Search Queries for a Round
// ────────────────────────────────────────────────────────────────

function buildSearchQueries(intent, roundNumber, previousQueries = []) {
    const industry = intent.industry || '';
    const location = intent.location || '';
    const role = intent.role || '';
    const company = intent.company || '';
    
    const queries = [];
    
    // Round 1: Broad, targeted queries
    if (roundNumber === 1) {
        // Primary query: industry + location + role
        if (industry && location && role) {
            queries.push(`"${industry}" "${location}" "${role}" company contact`);
            queries.push(`"${industry}" "${location}" "${role}" email`);
        } else if (industry && location) {
            queries.push(`"${industry}" companies "${location}" contact`);
            queries.push(`"${industry}" "${location}" email`);
        } else if (industry && role) {
            queries.push(`"${industry}" "${role}" company contact`);
            queries.push(`"${industry}" "${role}" email`);
        } else if (industry) {
            queries.push(`"${industry}" companies contact list`);
            queries.push(`"${industry}" email contact`);
        }
        
        // Add a query targeting about/team pages (more likely to have real people)
        if (industry) {
            queries.push(`"${industry}" "about us" team contact`);
        }
    }
    
    // Round 2: Refined queries based on missing signals
    if (roundNumber === 2) {
        // More specific: target official websites and about pages
        if (industry && location) {
            queries.push(`site:*.${industry.toLowerCase().replace(/\s/g, '')} "${location}" about team`);
            queries.push(`"${industry}" "${location}" "contact us" email`);
        }
        if (role) {
            queries.push(`"${role}" "${industry}" "${location}" LinkedIn`);
        }
        // Generic fallback if previous queries were too broad
        if (industry) {
            queries.push(`"${industry}" directory list`);
        }
    }
    
    // Filter out queries already used in previous rounds
    const usedQuerySet = new Set(previousQueries.map(q => q.toLowerCase().trim()));
    const uniqueQueries = queries
        .filter(q => q && q.length > 5)
        .filter(q => !usedQuerySet.has(q.toLowerCase().trim()))
        .slice(0, MAX_QUERIES_PER_ROUND);
    
    console.log(`🔍 [AGENT2] Round ${roundNumber} queries:`, uniqueQueries);
    return uniqueQueries;
}

// ────────────────────────────────────────────────────────────────
// 8. Evaluate Coverage of Search Results
// ────────────────────────────────────────────────────────────────

function evaluateCoverage(searchResults, prospects, intent) {
    if (!searchResults || searchResults.length === 0) {
        return { coverageScore: 0, needMoreSearch: true, reason: 'No search results' };
    }
    
    if (!prospects || prospects.length === 0) {
        return { coverageScore: 0.1, needMoreSearch: true, reason: 'No prospects extracted' };
    }
    
    const targetCount = intent.lead_count || 5;
    const foundCount = prospects.length;
    
    // How many have email candidates?
    const withEmails = prospects.filter(p => p.email_candidates && p.email_candidates.length > 0).length;
    const emailRatio = withEmails / foundCount;
    
    // Fit score quality
    const avgFit = prospects.reduce((sum, p) => sum + (p.fit_score || 0), 0) / foundCount;
    
    // Location match
    const hasLocation = intent.location && intent.location.trim().length > 0;
    const locationMatchRatio = hasLocation 
        ? prospects.filter(p => p.location && p.location.toLowerCase().includes(intent.location.toLowerCase())).length / foundCount
        : 1;
    
    // Domain quality (presence of domain indicates real company)
    const domainRatio = prospects.filter(p => p.domain && p.domain.length > 3).length / foundCount;
    
    // Calculate coverage score
    const countScore = Math.min(foundCount / targetCount, 1);
    const emailScore = Math.min(emailRatio * 1.5, 1);
    const fitScore = Math.min(avgFit / 0.8, 1);
    const locationScore = locationMatchRatio;
    const domainScore = domainRatio;
    
    const coverageScore = (countScore * 0.3) + (emailScore * 0.25) + (fitScore * 0.2) + (locationScore * 0.15) + (domainScore * 0.1);
    
    // Decide if more search is needed
    const needMoreSearch = coverageScore < COVERAGE_THRESHOLD_STOP || foundCount < Math.min(targetCount, 3);
    const reason = needMoreSearch 
        ? `Coverage ${coverageScore.toFixed(2)} below threshold ${COVERAGE_THRESHOLD_STOP} (found ${foundCount}/${targetCount})`
        : `Good coverage (${coverageScore.toFixed(2)})`;
    
    console.log(`📊 [AGENT2] Coverage: ${coverageScore.toFixed(2)} | Need more: ${needMoreSearch} | ${reason}`);
    console.log(`   - Count: ${countScore.toFixed(2)} | Email: ${emailScore.toFixed(2)} | Fit: ${fitScore.toFixed(2)}`);
    
    return { coverageScore, needMoreSearch, reason };
}

// ────────────────────────────────────────────────────────────────
// 9. Extract Prospects from Search Results
// ────────────────────────────────────────────────────────────────

async function extractProspectsFromResults(searchResults, intent, apiKey, roundNumber) {
    if (!searchResults || searchResults.length === 0) {
        return { prospects: [], found: 0 };
    }

    console.log(`📥 [AGENT2] Round ${roundNumber}: Extracting from ${searchResults.length} search results`);

    const allText = searchResults.map(r => `${r.title} ${r.snippet} ${r.url}`).join(' ');
    const regexEmails = extractEmailsWithRegex(allText);
    console.log(`📧 [AGENT2] Round ${roundNumber}: Regex found ${regexEmails.length} email(s)`);

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
- Round: ${roundNumber} of 2

SEARCH RESULTS:
${snippets}

EXTRACTED EMAILS FROM SEARCH TEXT (USE THESE):
${JSON.stringify(regexEmails)}

CRITICAL INSTRUCTION:
Extract REAL COMPANIES that match the user's request.
- Try to extract actual companies, not just directories.
- For each company, extract the best email candidate.

For each company, extract:
- name: Company name exactly as written
- company: Same as name
- domain: The company's domain (e.g., example.com) from URL
- source: "web_search"
- source_url: The URL where the company was found
- location: City/Country if mentioned
- role: CEO/Founder/Director if mentioned
- fit_score: 0.0 to 1.0 based on match quality
- email_candidates: Emails found for this company (max 3)
- notes: Why this company matches

Return ONLY valid JSON array of prospect objects. Max ${intent.lead_count || 5} items.
`;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            console.log(`🧠 [AGENT2] Round ${roundNumber}, GPT attempt ${attempt}/3...`);
            
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
            ), `GPT:extractProspects`);

            if (!response) {
                console.warn(`⚠️ [AGENT2] GPT extraction attempt ${attempt} returned null`);
                if (attempt === 3) return { prospects: [], found: 0 };
                continue;
            }

            const rawContent = response.data.choices[0].message.content.trim();
            const parseResult = safeJsonParse(rawContent);
            
            if (!parseResult.success) {
                console.warn(`⚠️ [AGENT2] JSON parse failed on attempt ${attempt}`);
                if (attempt === 3) return { prospects: [], found: 0 };
                continue;
            }

            const parsed = parseResult.data;

            let prospects = [];
            if (Array.isArray(parsed)) {
                prospects = parsed;
            } else if (parsed.prospects && Array.isArray(parsed.prospects)) {
                prospects = parsed.prospects;
            } else {
                for (const key of Object.keys(parsed)) {
                    if (Array.isArray(parsed[key])) {
                        prospects = parsed[key];
                        break;
                    }
                }
            }

            // Assign emails if missing
            prospects = prospects.map(p => {
                if ((!p.email_candidates || p.email_candidates.length === 0) && regexEmails.length > 0) {
                    const companyDomain = p.domain || '';
                    const matchingEmails = regexEmails.filter(email => {
                        const emailDomain = email.split('@')[1] || '';
                        if (companyDomain && emailDomain === companyDomain) return true;
                        if (companyDomain && emailDomain.includes(companyDomain.split('.')[0])) return true;
                        return false;
                    });
                    if (matchingEmails.length > 0) {
                        p.email_candidates = matchingEmails.slice(0, 3);
                    }
                }
                return p;
            });

            console.log(`✅ [AGENT2] Round ${roundNumber}: Extracted ${prospects.length} prospects`);
            return { prospects, found: prospects.length };

        } catch (error) {
            console.error(`❌ [AGENT2] GPT extraction attempt ${attempt} failed:`, error.message);
            if (attempt === 3) return { prospects: [], found: 0 };
        }
    }

    return { prospects: [], found: 0 };
}

// ────────────────────────────────────────────────────────────────
// 10. Deduplicate Prospects (Improved)
// ────────────────────────────────────────────────────────────────

function deduplicateProspects(prospects) {
    if (!prospects || prospects.length === 0) return { deduped: [], removed: 0 };

    const seen = new Set();
    const deduped = [];

    for (const p of prospects) {
        // Use domain first, then company name
        let key = '';
        if (p.domain && p.domain.length > 3) {
            key = p.domain.toLowerCase().trim();
        } else if (p.company) {
            key = p.company.toLowerCase().trim().replace(/\s+/g, '');
        } else if (p.name) {
            key = p.name.toLowerCase().trim().replace(/\s+/g, '');
        } else {
            continue;
        }
        
        // Check if we've seen this before (exact or fuzzy)
        let isDuplicate = false;
        for (const s of seen) {
            // Exact match
            if (s === key) { isDuplicate = true; break; }
            // Domain match
            if (key.includes('@')) {
                const domain = key.split('@')[1];
                if (domain && s.includes(domain)) { isDuplicate = true; break; }
            }
            // Fuzzy match on first word for companies
            const firstWord = key.split(/[.\s]/)[0];
            if (firstWord && firstWord.length > 2 && s.includes(firstWord)) {
                isDuplicate = true;
                break;
            }
        }
        
        if (!isDuplicate) {
            seen.add(key);
            deduped.push(p);
        }
    }

    const removed = prospects.length - deduped.length;
    console.log(`🔄 [AGENT2] Deduped: ${removed} removed, ${deduped.length} kept`);
    return { deduped, removed };
}

// ────────────────────────────────────────────────────────────────
// 11. Sort Prospects by Fit Score
// ────────────────────────────────────────────────────────────────

function sortProspectsByFit(prospects) {
    return prospects.sort((a, b) => (b.fit_score || 0) - (a.fit_score || 0));
}

// ────────────────────────────────────────────────────────────────
// 12. Create Fallback Prospects (IMPROVED)
// ────────────────────────────────────────────────────────────────

function createFallbackProspects(searchResults, regexEmails, intent) {
    console.log(`🔧 [AGENT2] Creating fallback prospects from ${searchResults.length} results`);
    
    const prospects = [];
    const domainRegex = /https?:\/\/(?:www\.)?([^\/]+)/;
    const seenDomains = new Set();
    const targetCount = Math.max(intent.lead_count || 5, 3);
    
    // First try to extract from results that look like actual company pages
    const realPages = searchResults.filter(r => {
        const url = r.url.toLowerCase();
        return !url.includes('youtube') && 
               !url.includes('scribd') && 
               !url.includes('getprospect') &&
               !url.includes('influencers.club') &&
               !url.includes('directory') &&
               !url.includes('list') &&
               !url.includes('blog');
    });
    
    const sourcesToUse = realPages.length > 0 ? realPages : searchResults;
    
    for (const result of sourcesToUse) {
        const domainMatch = result.url.match(domainRegex);
        let domain = domainMatch ? domainMatch[1] : null;
        if (domain) {
            const parts = domain.split('.');
            if (parts.length > 2) domain = parts.slice(-2).join('.');
        }
        
        if (!domain || seenDomains.has(domain)) continue;
        seenDomains.add(domain);
        
        const matchingEmails = regexEmails.filter(email => {
            const emailDomain = email.split('@')[1] || '';
            return emailDomain === domain || emailDomain.includes(domain.split('.')[0]);
        });
        
        // Extract location from title or snippet
        let location = intent.location || null;
        const locationMatch = result.snippet.match(/(?:in|based in|located in|from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
        if (locationMatch) location = locationMatch[1];
        
        // Extract role from title or snippet
        let role = intent.role || null;
        const roleMatch = result.snippet.match(/\b(CEO|Founder|Co-Founder|Owner|Director|VP|Head|Manager)\b/i);
        if (roleMatch) role = roleMatch[1];
        
        const title = result.title || domain;
        const companyName = title
            .replace(/\b(Ltd|LLC|Inc|Limited|PLC|Corp|Corporation)\b/gi, '')
            .replace(/\s*[|\-–].*$/, '')
            .trim();
        
        prospects.push({
            name: role ? `${role} at ${companyName}` : companyName,
            company: companyName || domain,
            domain: domain,
            source: 'web_search',
            source_url: result.url,
            location: location,
            role: role || intent.role || null,
            fit_score: matchingEmails.length > 0 ? 0.7 : 0.5,
            email_candidates: matchingEmails.slice(0, 3),
            notes: `Extracted from: ${result.title || 'web search'}`
        });
        
        if (prospects.length >= targetCount) break;
    }
    
    console.log(`🔧 [AGENT2] Fallback extracted ${prospects.length} prospects with emails`);
    return { prospects, found: prospects.length };
}

// ────────────────────────────────────────────────────────────────
// 13. Main Agent 2 Function (Intelligent Search Planner)
// ────────────────────────────────────────────────────────────────

async function discoverProspects({ intent, apiKey, tavilyKey, userId = 'anonymous', onProgress = null }) {
    console.log(`🔍 [AGENT2] Starting intelligent prospect discovery for user ${userId}...`);
    console.log(`📋 [AGENT2] Intent:`, JSON.stringify(intent, null, 2));
    onProgress?.('🔎 Planning search...');

    // ─── Validate input ───
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

    // ─── Initialize state ───
    const state = {
        target: {
            industry: intent.industry || 'general',
            location: intent.location || null,
            role: intent.role || null,
            company: intent.company || null,
            lead_count: intent.lead_count || 5
        },
        searchBudget: {
            maxRounds: MAX_ROUNDS,
            maxQueriesPerRound: MAX_QUERIES_PER_ROUND,
            maxResultsPerQuery: MAX_SEARCH_RESULTS
        },
        rounds: [],
        sources: [],
        allProspects: [],
        coverageScore: 0,
        confidence: 0,
        needMoreSearch: false,
        stopReason: null,
        queryHistory: [],
        roundNumber: 0
    };

    let allResults = [];
    let totalQueriesUsed = 0;
    let totalSourcesChecked = 0;

    // ─── ROUND 1: Initial Search ───
    console.log(`🔁 [AGENT2] === ROUND 1 ===`);
    state.roundNumber = 1;
    const round1Queries = buildSearchQueries(intent, 1, []);
    state.queryHistory = [...state.queryHistory, ...round1Queries];
    
    let round1Results = [];
    let round1Prospects = [];

    for (const query of round1Queries) {
        onProgress?.(`🔎 Round 1: "${query}"...`);
        const results = await searchTavily(query, tavilyKey, MAX_SEARCH_RESULTS);
        if (results && results.length > 0) {
            round1Results = round1Results.concat(results);
            totalQueriesUsed++;
            totalSourcesChecked += results.length;
            console.log(`✅ [AGENT2] Round 1: Found ${results.length} results for "${query}"`);
        }
    }

    if (round1Results.length > 0) {
        const extraction1 = await extractProspectsFromResults(round1Results, intent, apiKey, 1);
        round1Prospects = extraction1.prospects || [];
        allResults = allResults.concat(round1Results);
        state.allProspects = round1Prospects;
        console.log(`📊 [AGENT2] Round 1: Extracted ${round1Prospects.length} prospects`);
    }

    // ─── Evaluate Round 1 ───
    const eval1 = evaluateCoverage(allResults, state.allProspects, intent);
    state.coverageScore = eval1.coverageScore;
    state.needMoreSearch = eval1.needMoreSearch;

    // ─── ROUND 2: Refined Search (if needed) ───
    if (state.needMoreSearch && state.roundNumber < MAX_ROUNDS) {
        console.log(`🔁 [AGENT2] === ROUND 2 (Refining) ===`);
        state.roundNumber = 2;
        
        const round2Queries = buildSearchQueries(intent, 2, state.queryHistory);
        state.queryHistory = [...state.queryHistory, ...round2Queries];
        
        let round2Results = [];
        let round2Prospects = [];

        for (const query of round2Queries) {
            onProgress?.(`🔎 Round 2: "${query}"...`);
            const results = await searchTavily(query, tavilyKey, MAX_SEARCH_RESULTS);
            if (results && results.length > 0) {
                round2Results = round2Results.concat(results);
                totalQueriesUsed++;
                totalSourcesChecked += results.length;
                console.log(`✅ [AGENT2] Round 2: Found ${results.length} results for "${query}"`);
            }
        }

        if (round2Results.length > 0) {
            const extraction2 = await extractProspectsFromResults(round2Results, intent, apiKey, 2);
            round2Prospects = extraction2.prospects || [];
            allResults = allResults.concat(round2Results);
            
            // Merge prospects (avoid duplicates)
            const mergedProspects = [...state.allProspects, ...round2Prospects];
            const dedupResult = deduplicateProspects(mergedProspects);
            state.allProspects = dedupResult.deduped;
            console.log(`📊 [AGENT2] Round 2: Added ${round2Prospects.length} prospects, now ${state.allProspects.length} total`);
        }

        // Re-evaluate
        const eval2 = evaluateCoverage(allResults, state.allProspects, intent);
        state.coverageScore = eval2.coverageScore;
        state.needMoreSearch = eval2.needMoreSearch;
    }

    // ─── If still no results or very low coverage, try improved fallback ───
    if (state.allProspects.length < 2 && allResults.length > 0) {
        console.log(`🔄 [AGENT2] Low coverage - trying improved fallback extraction...`);
        const allText = allResults.map(r => `${r.title} ${r.snippet} ${r.url}`).join(' ');
        const fallbackEmails = extractEmailsWithRegex(allText);
        const fallbackResult = createFallbackProspects(allResults, fallbackEmails, intent);
        if (fallbackResult.prospects && fallbackResult.prospects.length > state.allProspects.length) {
            state.allProspects = fallbackResult.prospects;
            console.log(`📊 [AGENT2] Fallback: Now ${state.allProspects.length} prospects`);
        }
    }

    // ─── FORCE: Ensure we have at least 2 prospects ───
    if (state.allProspects.length < 2 && allResults.length > 0) {
        console.log(`🔄 [AGENT2] Forcing at least 2 prospects from search results...`);
        const forcedProspects = [];
        const seenNames = new Set();
        
        for (const result of allResults) {
            const domainMatch = result.url.match(/https?:\/\/(?:www\.)?([^\/]+)/);
            let domain = domainMatch ? domainMatch[1] : null;
            if (domain) {
                const parts = domain.split('.');
                if (parts.length > 2) domain = parts.slice(-2).join('.');
            }
            if (!domain || seenNames.has(domain)) continue;
            seenNames.add(domain);
            
            const title = result.title || domain;
            const companyName = title.replace(/\s*[|\-–].*$/, '').trim();
            
            forcedProspects.push({
                name: companyName || domain,
                company: companyName || domain,
                domain: domain,
                source: 'web_search',
                source_url: result.url,
                location: intent.location || null,
                role: intent.role || null,
                fit_score: 0.5,
                email_candidates: [],
                notes: `Forced fallback from: ${result.title}`
            });
            
            if (forcedProspects.length >= 2) break;
        }
        
        if (forcedProspects.length > state.allProspects.length) {
            state.allProspects = forcedProspects;
            console.log(`📊 [AGENT2] Forced: Now ${state.allProspects.length} prospects`);
        }
    }

    // ─── Final deduplication and sorting ───
    const finalDedup = deduplicateProspects(state.allProspects);
    const sorted = sortProspectsByFit(finalDedup.deduped);

    const targetCount = Math.max(intent.lead_count || 5, 3);
    let returnedProspects = sorted.slice(0, targetCount);
    
    // ─── FORCE: Ensure we return at least 2 prospects ───
    if (returnedProspects.length < 2 && sorted.length >= 2) {
        returnedProspects = sorted.slice(0, 2);
        console.log(`📊 [AGENT2] Forced return of ${returnedProspects.length} prospects`);
    }

    // ─── Calculate final confidence ───
    const withEmails = returnedProspects.filter(p => p.email_candidates && p.email_candidates.length > 0).length;
    const avgFit = returnedProspects.reduce((sum, p) => sum + (p.fit_score || 0), 0) / (returnedProspects.length || 1);
    const coverage = returnedProspects.length >= Math.min(targetCount, 3) ? 1 : returnedProspects.length / Math.min(targetCount, 3);
    
    let confidence = 0.5 + (coverage * 0.3) + (withEmails / (returnedProspects.length || 1) * 0.1) + (avgFit * 0.1);
    confidence = Math.min(confidence, 0.98);
    
    const needsClarification = confidence < CONFIDENCE_THRESHOLD_CLARIFY;

    console.log(`✅ [AGENT2] Discovery complete: ${returnedProspects.length} prospects returned`);
    console.log(`📊 [AGENT2] Confidence: ${(confidence * 100).toFixed(1)}% | Coverage: ${state.coverageScore.toFixed(2)}`);
    console.log(`📧 [AGENT2] ${withEmails}/${returnedProspects.length} have emails`);

    return {
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
        risk_level: returnedProspects.length < 2 ? 'medium' : 'low',
        policy_flags: returnedProspects.length === 0 ? ['no_prospects'] : [],
        reason: `Found ${returnedProspects.length} candidate prospects. Rounds: ${state.roundNumber}. Coverage: ${(state.coverageScore * 100).toFixed(0)}%`,
        search_plan: {
            rounds_used: state.roundNumber,
            queries_used: state.queryHistory.slice(0, totalQueriesUsed),
            sources_checked: totalSourcesChecked,
            coverage_score: state.coverageScore,
            need_more_search: state.needMoreSearch
        },
        prospects: returnedProspects.map(p => ({
            name: p.name || p.company || null,
            company: p.company || p.name || null,
            domain: p.domain || null,
            source: p.source || 'web_search',
            source_url: p.source_url || null,
            location: p.location || intent.location || null,
            role: p.role || intent.role || null,
            fit_score: p.fit_score || 0.5,
            email_candidates: p.email_candidates || [],
            notes: p.notes || null,
        })),
        stats: {
            searched: totalQueriesUsed,
            found: state.allProspects.length,
            returned: returnedProspects.length,
            deduped: state.allProspects.length - returnedProspects.length
        }
    };
}

// ────────────────────────────────────────────────────────────────
// 14. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
    discoverProspects,
    buildSearchQueries,
    searchTavily,
    extractProspectsFromResults,
    deduplicateProspects,
    sortProspectsByFit,
    evaluateCoverage,
    safeJsonParse,
    extractEmailsWithRegex,
    createFallbackProspects,
    CONFIDENCE_THRESHOLD_ROUTE,
    CONFIDENCE_THRESHOLD_CLARIFY,
};
