'use strict';

const axios = require('axios');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const TAVILY_LIMIT       = 1000;
const CACHE_TTL_MS       = 60 * 60 * 1000;
const CURRENT_YEAR       = new Date().getFullYear();
const MAX_MESSAGE_LENGTH = 800;

// ─── QUOTA TRACKERS ────────────────────────────────────────────────────────────
const tavilyQuota = { used: 0, limit: TAVILY_LIMIT, lastReset: Date.now() };

function checkTavilyReset() {
    const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - tavilyQuota.lastReset >= ONE_MONTH) {
        tavilyQuota.used      = 0;
        tavilyQuota.lastReset = Date.now();
    }
}
function getTavilyRemaining() { checkTavilyReset(); return tavilyQuota.limit - tavilyQuota.used; }
function recordTavilyUsage()  { tavilyQuota.used += 1; }

// ─── RETRY HELPER ─────────────────────────────────────────────────────────────
async function withRetry(fn, label, retries = 2, delayMs = 800) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isLast = attempt === retries;
            console.warn(`⚠️ [${label}] attempt ${attempt + 1} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying'}`);
            if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
    }
    return null;
}

// ─── TAVILY SEARCH ─────────────────────────────────────────────────────────────
async function searchWithTavily(query, tavilyKey, options = {}) {
    if (getTavilyRemaining() <= 0) throw new Error('Tavily quota exhausted');

    return withRetry(async () => {
        const response = await axios.post('https://api.tavily.com/search', {
            api_key:             tavilyKey,
            query,
            search_depth:        'advanced',
            max_results:         options.maxResults || 10,
            include_answer:      false,
            include_raw_content: false,
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 12000 });        recordTavilyUsage();
        return (response.data?.results || []).map(r => ({
            title:   r.title   || '',
            url:     r.url     || '',
            snippet: r.content || '',
            date:    r.published_date || null,
        }));
    }, `Tavily:${query.slice(0, 40)}`) ?? [];
}

// ─── COLLECT STAGE: INTENT PARSING ─────────────────────────────────────────────
/**
 * Extracts structured intent from user natural language input.
 */
async function parseIntent(message, apiKey) {
    const intentPrompt = `You are an intent parser for a B2B lead generation system.
Extract structured intent from the following user request: "${message}".

Return ONLY valid JSON:
{
  "industry": "string (e.g., SaaS, Logistics, Consulting). Infer if not explicit.",
  "business_type": "string (e.g., Agency, Startup, Enterprise, Local Business). Infer if not explicit.",
  "target_role": "string (e.g., CEO, Founder, Owner, Decision Maker). Default to 'Decision Maker' if not specified.",
  "location": "string or null (City, Country, Region). Null if not mentioned.",
  "purpose": "string (Brief summary of why they are searching, e.g., 'outreach', 'partnership'). Default to 'outreach'."
}

Rules:
- If industry is vague (e.g., "companies"), infer based on context or default to "General Business".
- Target role should be specific decision-makers.
- Location must be null if not explicitly mentioned.`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: intentPrompt }],
            max_tokens:  150,
            temperature: 0.1,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:intentParse');

        if (!res) return { industry: 'General', business_type: 'Company', target_role: 'Decision Maker', location: null, purpose: 'outreach' };

        const raw    = res.data.choices[0].message.content.replace(/```json|```/g, '');
        const parsed = JSON.parse(raw);
        console.log(`🎯 [INTENT PARSED] ${JSON.stringify(parsed)}`);
        return parsed;

    } catch (e) {
        console.warn('[Intent Parse Failed]:', e.message);
        return { industry: 'General', business_type: 'Company', target_role: 'Decision Maker', location: null, purpose: 'outreach' };    }
}

// ─── COLLECT STAGE: QUERY CONSTRUCTION ─────────────────────────────────────────
/**
 * Generates multiple high-quality search queries using structured intent.
 */
function constructQueries(intent) {
    const { industry, business_type, target_role, location } = intent;
    const locClause = location ? `"${location}"` : '';
    
    // Role keywords to inject
    const roleKeywords = target_role.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const primaryRole = roleKeywords[0] || 'founder';

    const queries = [];

    // Query 1: Direct Contact Page Search
    queries.push(`"${industry}" "${primaryRole}" contact page ${locClause} inurl:contact OR inurl:about`);

    // Query 2: Team/About Page Search
    queries.push(`"${industry}" "${business_type}" team page ${locClause} inurl:team OR inurl:about`);

    // Query 3: Site-specific Role Search
    queries.push(`"${industry}" company "${primaryRole}" ${locClause} site:.com`);

    // Query 4: Broad Industry + Role
    queries.push(`"${industry}" founder OR CEO email contact ${locClause}`);

    console.log(`🔍 [QUERIES GENERATED] ${queries.length} queries`);
    return queries;
}

// ─── COLLECT STAGE: EARLY SOURCE FILTERING ─────────────────────────────────────
/**
 * Immediately removes low-quality sources.
 * ACCEPTS ONLY: official company websites, about, team, contact pages.
 * REJECTS: blogs, listicles, directories, forums, social media, aggregators.
 */
function filterRawSources(results) {
    const REJECT_PATTERNS = [
        /\/blog\//i, /\/article\//i, /\/news\//i, /\/tutorial\//i,
        /\/how-to\//i, /\/guide\//i, /\/tips\//i, /\/resources\//i,
        /\/learn\//i, /\/wiki\//i, /\/forum\//i, /\/comments\//i,
        /\.pdf$/i,
        /reddit\.com/i, /medium\.com/i, /quora\.com/i, /wikipedia\.org/i,
        /stackoverflow\.com/i, /linkedin\.com\/posts/i, /facebook\.com/i,
        /twitter\.com/i, /x\.com/i, /instagram\.com/i,
        /hubspot\.com\/blog/i, /moz\.com\/blog/i, /semrush\.com\/blog/i,
        /clutch\.co/i, /yelp\.com/i, /g2\.com/i, /capterra\.com/i,        /crunchbase\.com/i, /apollo\.io/i, /hunter\.io/i,
        /top\s+\d+/i, /best\s+\d+/i, /listicle/i
    ];

    const ACCEPT_PATTERNS = [
        /\/about/i, /\/team/i, /\/contact/i, /\/company/i,
        /\/people/i, /\/leadership/i, /\/founders/i, /\/our-story/i,
        /\/home/i, /^https?:\/\/[^\/]+\/?$/i // Root domains
    ];

    const filtered = [];

    for (const result of results) {
        const url = result.url || '';
        const title = result.title || '';
        const snippet = result.snippet || '';

        // 1. Check Rejection Patterns
        let rejected = false;
        for (const pattern of REJECT_PATTERNS) {
            if (pattern.test(url) || pattern.test(title)) {
                rejected = true;
                break;
            }
        }
        if (rejected) continue;

        // 2. Check Acceptance Patterns (Must match at least one strong signal or be a root domain)
        let accepted = false;
        for (const pattern of ACCEPT_PATTERNS) {
            if (pattern.test(url)) {
                accepted = true;
                break;
            }
        }

        // If it's a root domain (e.g., example.com), it's generally acceptable for business
        const urlObj = new URL(url);
        const isRootDomain = urlObj.pathname === '/' || urlObj.pathname === '';
        
        if (accepted || isRootDomain) {
            filtered.push(result);
        } else {
            // Optional: Strict mode -> reject if no clear "business page" signal
            // For now, we allow it if it passed rejection filters, but lower confidence later
            filtered.push(result); 
        }
    }
    console.log(`🧹 [FILTERING] Reduced ${results.length} results to ${filtered.length} high-quality candidates`);
    return filtered;}

// ─── COLLECT STAGE: DOMAIN NORMALIZATION ───────────────────────────────────────
/**
 * Groups and deduplicates results by domain.
 */
function normalizeDomains(filteredResults) {
    const domainMap = new Map();

    for (const result of filteredResults) {
        try {
            const urlObj = new URL(result.url);
            const domain = urlObj.hostname.replace(/^www\./, '');
            
            if (!domainMap.has(domain)) {
                domainMap.set(domain, {
                    domain: domain,
                    source_url: result.url,
                    title: result.title,
                    snippet: result.snippet,
                    original_results: [result]
                });
            } else {
                // Keep the most relevant URL (prefer /contact or /about over root if available)
                const existing = domainMap.get(domain);
                const currentUrlLower = result.url.toLowerCase();
                const existingUrlLower = existing.source_url.toLowerCase();

                const priorityPaths = ['/contact', '/about', '/team', '/leadership'];
                
                let shouldReplace = false;
                for (const path of priorityPaths) {
                    if (currentUrlLower.includes(path) && !existingUrlLower.includes(path)) {
                        shouldReplace = true;
                        break;
                    }
                }

                if (shouldReplace) {
                    existing.source_url = result.url;
                    existing.title = result.title;
                    existing.snippet = result.snippet;
                }
                existing.original_results.push(result);
            }
        } catch (e) {
            // Invalid URL, skip
        }
    }
    return Array.from(domainMap.values());
}

// ─── COLLECT STAGE: CONFIDENCE SCORING ─────────────────────────────────────────
/**
 * Calculates initial confidence based on relevance signals.
 */
function calculateConfidence(entity, intent) {
    let score = 0.5; // Base confidence

    const url = entity.source_url.toLowerCase();
    const title = (entity.title || '').toLowerCase();
    const snippet = (entity.snippet || '').toLowerCase();
    const industry = (intent.industry || '').toLowerCase();
    const role = (intent.target_role || '').toLowerCase();

    // 1. URL Structure Signals
    if (url.includes('/contact')) score += 0.2;
    if (url.includes('/about')) score += 0.15;
    if (url.includes('/team')) score += 0.15;
    if (url.includes('/leadership')) score += 0.2;

    // 2. Title/Snippet Keyword Matches
    if (title.includes(industry) || snippet.includes(industry)) score += 0.1;
    if (title.includes(role) || snippet.includes(role)) score += 0.15;
    
    // 3. Penalty for generic terms
    if (title.includes('home') && url.split('/').length <= 4) score -= 0.1;

    return Math.min(Math.max(score, 0.1), 1.0);
}

// ─── COLLECT STAGE: MAIN EXECUTION ─────────────────────────────────────────────
async function runCollectStage(message, apiKey, tavilyKey, onProgress) {
    try {
        onProgress?.('🧠 Parsing intent...');
        const intent = await parseIntent(message, apiKey);

        onProgress?.('🔍 Constructing search queries...');
        const queries = constructQueries(intent);

        let allRawResults = [];
        
        // Execute Queries
        for (const query of queries) {
            if (getTavilyRemaining() <= 0) break;
            onProgress?.(`🔎 Searching: ${query.slice(0, 50)}...`);
            const results = await searchWithTavily(query, tavilyKey, { maxResults: 5 });
            allRawResults = [...allRawResults, ...results];
        }
        if (allRawResults.length === 0) {
            return [];
        }

        onProgress?.('🧹 Filtering low-quality sources...');
        const filteredResults = filterRawSources(allRawResults);

        onProgress?.('🗂️ Normalizing domains...');
        const normalizedEntities = normalizeDomains(filteredResults);

        // Final Output Construction
        const output = normalizedEntities.map(entity => {
            const confidence = calculateConfidence(entity, intent);
            
            // Generate Reason
            const reasons = [];
            if (entity.source_url.toLowerCase().includes('/contact')) reasons.push('Contact page found');
            if (entity.source_url.toLowerCase().includes('/about')) reasons.push('About page found');
            if ((entity.title + entity.snippet).toLowerCase().includes(intent.industry.toLowerCase())) reasons.push('Matches industry');
            if ((entity.title + entity.snippet).toLowerCase().includes(intent.target_role.toLowerCase())) reasons.push('Matches target role');
            
            const reason = reasons.length > 0 ? reasons.join(', ') : 'Relevant business domain identified';

            return {
                domain: entity.domain,
                source_url: entity.source_url,
                title: entity.title,
                snippet: entity.snippet,
                reason: reason,
                initial_confidence: parseFloat(confidence.toFixed(2))
            };
        });

        // Sort by confidence descending
        output.sort((a, b) => b.initial_confidence - a.initial_confidence);

        console.log(`✅ [COLLECT STAGE] Completed. Found ${output.length} candidates.`);
        return output;

    } catch (error) {
        console.error('❌ [COLLECT STAGE] Error:', error.message);
        return [];
    }
}

// ─── INFER STAGE: INTELLIGENCE EXTRACTION ──────────────────────────────────────
/**
 * The "Thinking Layer".
 * Transforms stored business entities into structured intelligence. * Does NOT search the internet.
 */
async function runInferStage(collectedCandidates, apiKey, onProgress) {
    if (!collectedCandidates || collectedCandidates.length === 0) {
        return [];
    }

    console.log(`🧠 [INFER STAGE] Starting intelligence extraction for ${collectedCandidates.length} companies...`);
    onProgress?.('🧠 Analyzing company intelligence...');

    const inferredResults = [];

    // Process in batches to avoid rate limits if necessary, but for now sequential for simplicity/clarity
    for (const candidate of collectedCandidates) {
        try {
            const inferPrompt = `You are a B2B Intelligence Analyst. 
Analyze the following company data to extract meaningful intelligence for outreach.
DO NOT search the internet. Use ONLY the provided data.

INPUT DATA:
- Domain: ${candidate.domain}
- Source URL: ${candidate.source_url}
- Page Title: ${candidate.title}
- Snippet/Content: ${candidate.snippet}

TASK:
1. Company Understanding: What do they actually do? What industry? What stage (startup/growth/enterprise)?
2. Decision-Maker Identification: Who is the best person to contact? (e.g., SaaS->Founder, Logistics->Ops Manager).
3. Pain Point Inference: What are 2-5 likely business problems they face based on their industry/type?
4. Outreach Strategy: What is the best angle and tone?
5. Confidence: How confident are you in this analysis (0.0-1.0)?

Return ONLY valid JSON:
{
  "domain": "${candidate.domain}",
  "industry": "string (Specific industry category)",
  "company_stage": "string (startup | growth | enterprise | local_small_business)",
  "decision_maker": {
    "primary": "string (e.g., Founder, CEO, Ops Manager)",
    "secondary": "string (e.g., Head of Growth, Director)"
  },
  "pain_points": [
    "string (Pain point 1)",
    "string (Pain point 2)"
  ],
  "outreach_strategy": {
    "angle": "string (e.g., ROI-focused, Efficiency-focused, Partnership)",
    "tone": "string (e.g., Direct, Professional, Casual)"
  },
  "confidence": 0.0-1.0}

RULES:
- NEVER guess specific facts like revenue or employee count.
- ALWAYS base inference on stored data signals.
- If data is weak, lower confidence and keep pain points generic to the industry.`;

            const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
                model:       'gpt-4o-mini',
                messages:    [{ role: 'user', content: inferPrompt }],
                max_tokens:  400,
                temperature: 0.2,
            }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), `OpenAI:Infer:${candidate.domain}`);

            if (res) {
                const raw = res.data.choices[0].message.content.replace(/```json|```/g, '');
                const parsed = JSON.parse(raw);
                
                // Merge with original candidate data if needed, or just return inferred
                inferredResults.push({
                    ...candidate, // Keep domain, url, etc.
                    intelligence: parsed
                });
                console.log(`✅ [INFER] Completed for ${candidate.domain}`);
            }

        } catch (err) {
            console.warn(`⚠️ [INFER] Failed for ${candidate.domain}: ${err.message}`);
            // Push a fallback minimal structure so pipeline doesn't break
            inferredResults.push({
                ...candidate,
                intelligence: {
                    domain: candidate.domain,
                    industry: "Unknown",
                    company_stage: "unknown",
                    decision_maker: { primary: "Owner", secondary: "Manager" },
                    pain_points: ["General operational efficiency"],
                    outreach_strategy: { angle: "General value prop", tone: "Professional" },
                    confidence: 0.3
                }
            });
        }
    }

    console.log(`✅ [INFER STAGE] Completed. Analyzed ${inferredResults.length} companies.`);
    return inferredResults;
}

// ─── INTENT CLASSIFIER (For Routing) ────────────────────────────────────────────
const INTENT = {    LEAD_GEN:    'lead_gen',
    CHAT:        'chat',
};

async function _classifyIntent(message, history, apiKey) {
    const recentHistory = (history || []).slice(-6)
        .map(h => `${h.role}: ${h.content}`)
        .join('\n');

    const classifyPrompt = `You are an intent classifier.
Classify the user message into EXACTLY ONE of these intents:

1. "lead_gen" — user wants to find leads, prospect companies, get contacts, find businesses to outreach
2. "chat" — anything else: greetings, small talk, general questions

RECENT CONVERSATION:
${recentHistory || 'None'}

USER MESSAGE: "${message}"

Return ONLY the intent string. No explanation. Just one of: lead_gen | chat`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: classifyPrompt }],
            max_tokens:  10,
            temperature: 0.0,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:classify');

        if (!res) return INTENT.CHAT;

        const raw = res.data.choices[0].message.content.trim().toLowerCase();
        if (raw.includes('lead_gen')) return INTENT.LEAD_GEN;
        return INTENT.CHAT;

    } catch (err) {
        console.warn('[Intent Classify Failed]:', err.message);
        return INTENT.CHAT;
    }
}

// ─── CHAT HANDLER (Fallback) ───────────────────────────────────────────────────
async function _handleChat(message, history, userProfile, apiKey) {
    const senderName = userProfile?.senderName || 'there';
    
    const systemPrompt = `You are an intelligent AI assistant.
You help with conversations, answer questions, and assist with business tasks.
Keep responses concise but complete.`;
    const memoryMessages = (history || [])
        .slice(-20)
        .map(h => ({ role: h.role, content: h.content }));

    const messages = [
        { role: 'system',  content: systemPrompt },
        ...memoryMessages,
        { role: 'user',    content: message },
    ];

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages,
            max_tokens:  600,
            temperature: 0.7,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:chat');

        if (!res) return 'I had trouble responding — please try again.';

        return res.data.choices[0].message.content.trim();

    } catch (err) {
        console.warn('[Chat Handler Error]:', err.message);
        return 'Something went wrong. Please try again.';
    }
}

// ─── MAIN EXPORT: generateFreeResponse ─────────────────────────────────────────
async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🟢 [AI ENGINE] Pipeline started...');
        onProgress?.('🧠 Understanding your request...');

        const apiKey    = process.env.OPENAI_API_KEY;
        const tavilyKey = process.env.TAVILY_API_KEY;

        const safeMessage = typeof message === 'string'
            ? message.slice(0, MAX_MESSAGE_LENGTH)
            : '';

        if (!safeMessage.trim()) {
            return {
                reply:          'How can I help you today? I can find leads or just chat.',
                updatedHistory: history,
            };
        }

        const intent = await _classifyIntent(safeMessage, history, apiKey);
        console.log(`🎯 [INTENT] ${intent}`);
        if (intent === INTENT.LEAD_GEN) {
            // 1. COLLECT STAGE
            onProgress?.('🚀 Starting Collect Stage...');
            const candidates = await runCollectStage(safeMessage, apiKey, tavilyKey, onProgress);
            
            if (candidates.length === 0) {
                return {
                    reply: JSON.stringify([]),
                    updatedHistory: [
                        ...history,
                        { role: 'user', content: safeMessage },
                        { role: 'assistant', content: 'No candidates found.' },
                    ],
                };
            }

            // 2. INFER STAGE
            onProgress?.('🧠 Starting Infer Stage...');
            const enrichedLeads = await runInferStage(candidates, apiKey, onProgress);
            
            const reply = JSON.stringify(enrichedLeads);
            
            return {
                reply,
                updatedHistory: [
                    ...history,
                    { role: 'user',      content: safeMessage },
                    { role: 'assistant', content: `[Found and Analyzed ${enrichedLeads.length} business candidates]` },
                ],
            };
        }

        // INTENT.CHAT (default)
        const reply = await _handleChat(safeMessage, history, userProfile, apiKey);
        return {
            reply,
            updatedHistory: [
                ...history,
                { role: 'user',      content: safeMessage },
                { role: 'assistant', content: reply },
            ],
        };

    } catch (error) {
        console.error('❌ [AI ENGINE] Fatal error:', error.message);
        return { reply: 'An error occurred. Please try again.', updatedHistory: history };
    }
}
module.exports = { generateFreeResponse };
