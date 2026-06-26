'use strict';

/**
 * agent3.js – Enrichment / Verification Agent
 * 
 * The third layer in the B2B lead-generation system.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Read Agent 2 output carefully.
 * 2. For each prospect, find missing or stale public information.
 * 3. Enrich records with website, company details, identity clues, role, location, and public signals.
 * 4. Verify whether the record looks usable and coherent.
 * 5. Deduplicate or merge conflicting sources.
 * 6. Assign confidence and verification status.
 * 7. Return clean structured JSON only.
 * 
 * YOU MUST NOT:
 * - Write outreach.
 * - Send emails.
 * - Make final sales decisions.
 * - Pretend email deliverability is guaranteed.
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
const MAX_QUERIES_PER_PROSPECT = 2;
const CONFIDENCE_THRESHOLD_ROUTE = 0.90;
const CONFIDENCE_THRESHOLD_CLARIFY = 0.50;

// ────────────────────────────────────────────────────────────────
// 2. The Agent 3 System Prompt (locked, production-grade)
// ────────────────────────────────────────────────────────────────

const AGENT3_SYSTEM_PROMPT = `You are Agent 3, the Enrichment / Verification layer in a B2B lead-generation system.

Your job is to take the prospect records from Agent 2 and enrich them with reliable public information, then assess how trustworthy and complete each record is. You may use web search tools like Tavily when live public facts are needed. You must use GPT to merge, normalize, score, and format the final structured output.

PRIMARY RESPONSIBILITIES
1. Read Agent 2 output carefully.
2. For each prospect, find missing or stale public information.
3. Enrich records with website, company details, identity clues, role, location, and public signals.
4. Verify whether the record looks usable and coherent.
5. Deduplicate or merge conflicting sources.
6. Assign confidence and verification status.
7. Return clean structured JSON only.

YOU MUST NOT
- Write outreach.
- Send emails.
- Make final sales decisions.
- Pretend email deliverability is guaranteed.
- Return a paragraph.
- Invent facts not supported by sources.

SEARCH RULES
- Use search only when needed for live public facts.
- Keep searches targeted and minimal.
- Prefer official websites and reliable public sources.
- If the record is already strong in the input, do not over-search it.

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
  "enriched_prospects": [
    {
      "name": string|null,
      "company": string|null,
      "domain": string|null,
      "website": string|null,
      "location": string|null,
      "role": string|null,
      "industry": string|null,
      "linkedin_url": string|null,
      "confidence": number|null,
      "verification_status": "verified" | "partial" | "unverified",
      "notes": string|null
    }
  ],
  "stats": {
    "checked": number,
    "enriched": number,
    "verified": number,
    "returned": number
  }
}

CONFIDENCE GUIDELINES
- 0.90 to 1.00 = very clear and well supported.
- 0.70 to 0.89 = mostly clear.
- 0.50 to 0.69 = incomplete, needs caution.
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
// 5. Build Enrichment Queries for a Prospect
// ────────────────────────────────────────────────────────────────

function buildEnrichmentQueries(prospect) {
    const queries = [];
    const company = prospect.company || prospect.name || '';
    const domain = prospect.domain || '';

    if (company && domain) {
        queries.push(`"${company}" site:${domain} about`);
        queries.push(`"${company}" "${domain}" leadership team`);
    } else if (company) {
        queries.push(`"${company}" company website official`);
        queries.push(`"${company}" CEO founder`);
    } else if (domain) {
        queries.push(`site:${domain} about team`);
        queries.push(`site:${domain} contact`);
    }

    // If we have a name, try to find LinkedIn
    if (prospect.name && company) {
        queries.push(`"${prospect.name}" "${company}" LinkedIn`);
    }

    return queries.slice(0, MAX_QUERIES_PER_PROSPECT);
}

// ────────────────────────────────────────────────────────────────
// 6. Enrich a Single Prospect Using Search Results
// ────────────────────────────────────────────────────────────────

async function enrichSingleProspect(prospect, tavilyKey, apiKey) {
    console.log(`🔍 [AGENT3] Enriching: ${prospect.company || prospect.name || 'Unknown'}`);

    // If the prospect already has high confidence, skip heavy enrichment
    if (prospect.fit_score >= 0.85 && prospect.domain && prospect.email_candidates?.length > 0) {
        console.log(`⏭️ [AGENT3] Skipping enrichment - already high confidence`);
        return {
            ...prospect,
            confidence: prospect.fit_score || 0.7,
            verification_status: 'partial',
            notes: prospect.notes || 'Already has strong signals.',
        };
    }

    // Build search queries
    const queries = buildEnrichmentQueries(prospect);
    if (queries.length === 0) {
        return {
            ...prospect,
            confidence: prospect.fit_score || 0.4,
            verification_status: 'unverified',
            notes: 'No search queries could be built.',
        };
    }

    // Execute searches
    let allResults = [];
    for (const query of queries) {
        const results = await searchTavily(query, tavilyKey, 3);
        if (results && results.length > 0) {
            allResults = allResults.concat(results);
        }
    }

    if (allResults.length === 0) {
        return {
            ...prospect,
            confidence: prospect.fit_score || 0.4,
            verification_status: 'unverified',
            notes: 'No public information found to enrich this prospect.',
        };
    }

    // Use GPT to extract enriched data
    const snippets = allResults.map((r, i) => 
        `[${i + 1}] TITLE: ${r.title}\nURL: ${r.url}\nSNIPPET: ${r.snippet}`
    ).join('\n\n---\n\n');

    const enrichmentPrompt = `
You are an enrichment specialist. Enrich this prospect with public information from the search results.

PROSPECT TO ENRICH:
- Name: ${prospect.name || 'Unknown'}
- Company: ${prospect.company || 'Unknown'}
- Domain: ${prospect.domain || 'Unknown'}
- Location: ${prospect.location || 'Unknown'}
- Role: ${prospect.role || 'Unknown'}

SEARCH RESULTS:
${snippets}

Extract and return ONLY valid JSON with these fields:
{
  "name": "Full name if found, otherwise keep original",
  "company": "Company name if found, otherwise keep original",
  "domain": "Domain if found, otherwise keep original",
  "website": "Official website URL if found, otherwise null",
  "location": "City/Country if found, otherwise keep original",
  "role": "Role/title if found, otherwise keep original",
  "industry": "Industry if found, otherwise null",
  "linkedin_url": "LinkedIn URL if found, otherwise null",
  "confidence": 0.0 to 1.0 based on how well the public sources support this record,
  "verification_status": "verified" | "partial" | "unverified",
  "notes": "Brief notes on what was found and any discrepancies"
}

Be conservative. Only update fields when you have clear evidence from the search results.
`;

    try {
        const response = await withRetry(() => axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: MODEL,
                messages: [
                    { role: 'system', content: 'You extract structured enrichment data from search results. Return only valid JSON.' },
                    { role: 'user', content: enrichmentPrompt }
                ],
                max_tokens: 300,
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
        ), 'GPT:enrichProspect');

        if (!response) {
            return {
                ...prospect,
                confidence: prospect.fit_score || 0.4,
                verification_status: 'unverified',
                notes: 'GPT enrichment failed.',
            };
        }

        const rawContent = response.data.choices[0].message.content.trim();
        const enriched = JSON.parse(rawContent);

        // Merge enriched data with original
        const merged = {
            ...prospect,
            name: enriched.name || prospect.name,
            company: enriched.company || prospect.company,
            domain: enriched.domain || prospect.domain,
            website: enriched.website || null,
            location: enriched.location || prospect.location,
            role: enriched.role || prospect.role,
            industry: enriched.industry || null,
            linkedin_url: enriched.linkedin_url || null,
            confidence: enriched.confidence || prospect.fit_score || 0.5,
            verification_status: enriched.verification_status || 'partial',
            notes: enriched.notes || 'Enriched from public sources.',
        };

        console.log(`✅ [AGENT3] Enriched: ${merged.company} → confidence: ${merged.confidence}`);
        return merged;

    } catch (error) {
        console.error(`❌ [AGENT3] Enrichment failed:`, error.message);
        return {
            ...prospect,
            confidence: prospect.fit_score || 0.4,
            verification_status: 'unverified',
            notes: 'Enrichment failed due to an error.',
        };
    }
}

// ────────────────────────────────────────────────────────────────
// 7. Main Agent 3 Function
// ────────────────────────────────────────────────────────────────

/**
 * Enriches and verifies prospects from Agent 2.
 * 
 * @param {Object} params
 * @param {Array}  params.prospects - The prospects from Agent 2.
 * @param {Object} params.intent - The original intent from Agent 1.
 * @param {string} params.apiKey - OpenAI API key.
 * @param {string} params.tavilyKey - Tavily API key.
 * @param {string} params.userId - User identifier for logging.
 * @param {Function} params.onProgress - Optional progress callback.
 * 
 * @returns {Object} Structured enrichment result.
 */
async function enrichProspects({ prospects, intent, apiKey, tavilyKey, userId = 'anonymous', onProgress = null }) {
    console.log(`🔍 [AGENT3] Starting enrichment for user ${userId}...`);
    onProgress?.('🔬 Enriching and verifying prospects...');

    // Validate input
    if (!prospects || prospects.length === 0) {
        return {
            intent: 'lead_enrichment',
            confidence: 0.0,
            needs_clarification: true,
            clarification_question: 'No prospects were provided to enrich. Please run discovery first.',
            next_pipeline: null,
            entities: intent?.entities || {},
            risk_level: 'low',
            policy_flags: ['no_prospects'],
            reason: 'No prospects provided to Agent 3.',
            enriched_prospects: [],
            stats: { checked: 0, enriched: 0, verified: 0, returned: 0 }
        };
    }

    // ─── Step 1: Enrich each prospect ───
    const enriched = [];
    let enrichedCount = 0;
    let verifiedCount = 0;

    for (let i = 0; i < prospects.length; i++) {
        const prospect = prospects[i];
        onProgress?.(`🔍 Enriching ${i + 1}/${prospects.length}: ${prospect.company || prospect.name || 'Unknown'}...`);

        const enrichedProspect = await enrichSingleProspect(prospect, tavilyKey, apiKey);
        enriched.push(enrichedProspect);

        if (enrichedProspect.verification_status === 'verified') verifiedCount++;
        if (enrichedProspect.confidence >= 0.5) enrichedCount++;
    }

    // ─── Step 2: Calculate overall confidence ───
    const avgConfidence = enriched.reduce((sum, p) => sum + (p.confidence || 0), 0) / enriched.length;
    const verifiedRatio = verifiedCount / enriched.length;

    let confidence = 0.7 + (verifiedRatio * 0.2);
    if (avgConfidence > 0.7) confidence += 0.1;
    confidence = Math.min(confidence, 0.98);

    // ─── Step 3: Determine if clarification is needed ───
    const needsClarification = confidence < CONFIDENCE_THRESHOLD_CLARIFY || verifiedCount === 0;

    // ─── Step 4: Build and return result ───
    const result = {
        intent: 'lead_enrichment',
        confidence: Math.round(confidence * 100) / 100,
        needs_clarification: needsClarification,
        clarification_question: needsClarification 
            ? 'I enriched the prospects but many records are incomplete. Could you provide more specific details about your ideal customer profile?'
            : null,
        next_pipeline: enriched.length > 0 && verifiedCount > 0 ? 'lead_verification' : null,
        entities: intent?.entities || {
            industry: intent?.industry || null,
            location: intent?.location || null,
            role: intent?.role || null,
            company: intent?.company || null,
            lead_count: enriched.length,
            email: null,
            domain: null,
            source_type: 'web_search'
        },
        risk_level: verifiedCount / enriched.length < 0.5 ? 'medium' : 'low',
        policy_flags: verifiedCount / enriched.length < 0.3 ? ['low_verification_rate'] : [],
        reason: `Enriched ${enriched.length} prospects. ${verifiedCount} verified, ${enrichedCount} partially verified.`,
        enriched_prospects: enriched.map(p => ({
            name: p.name || null,
            company: p.company || null,
            domain: p.domain || null,
            website: p.website || null,
            location: p.location || null,
            role: p.role || null,
            industry: p.industry || null,
            linkedin_url: p.linkedin_url || null,
            confidence: p.confidence || 0.5,
            verification_status: p.verification_status || 'unverified',
            notes: p.notes || null,
        })),
        stats: {
            checked: prospects.length,
            enriched: enrichedCount,
            verified: verifiedCount,
            returned: enriched.length,
        }
    };

    console.log(`✅ [AGENT3] Enrichment complete: ${verifiedCount} verified, ${enrichedCount} enriched`);
    return result;
}

// ────────────────────────────────────────────────────────────────
// 8. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
    enrichProspects,
    enrichSingleProspect,
    buildEnrichmentQueries,
    searchTavily,
    CONFIDENCE_THRESHOLD_ROUTE,
    CONFIDENCE_THRESHOLD_CLARIFY,
};
