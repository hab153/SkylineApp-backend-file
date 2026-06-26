'use strict';

/**
 * agent4.js – Qualification / Personalization Agent
 * 
 * The fourth layer in the B2B lead-generation system.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Read Agent 3 output carefully.
 * 2. Evaluate each prospect against ICP, role, location, industry, and available public signals.
 * 3. Determine qualification status: qualified, unqualified, or review.
 * 4. Assign fit score and priority.
 * 5. Choose the best outreach/personalization angle for qualified leads.
 * 6. Return clean structured JSON only.
 * 
 * YOU MUST NOT:
 * - Send outreach.
 * - Write full emails unless the output schema explicitly asks for an angle only.
 * - Invent facts that are not supported by the input or sources.
 * - Over-search when the input is already strong.
 * - Return a paragraph.
 */

const axios = require('axios');

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const MODEL = 'gpt-4o-mini';
const MAX_OUTPUT_TOKENS = 400;
const MAX_SEARCH_RESULTS = 5;
const MAX_QUERIES = 2;
const CONFIDENCE_THRESHOLD_ROUTE = 0.90;
const CONFIDENCE_THRESHOLD_CLARIFY = 0.50;

// ────────────────────────────────────────────────────────────────
// 2. The Agent 4 System Prompt (locked, production-grade)
// ────────────────────────────────────────────────────────────────

const AGENT4_SYSTEM_PROMPT = `You are Agent 4, the Qualification / Personalization layer in a B2B lead-generation system.

Your job is to take enriched prospect records from Agent 3 and decide which ones are worth pursuing now. You must score fit, prioritize leads, determine the best personalization angle, and return a structured JSON object for the next step.

PRIMARY RESPONSIBILITIES
1. Read Agent 3 output carefully.
2. Evaluate each prospect against ICP, role, location, industry, and available public signals.
3. Determine qualification status: qualified, unqualified, or review.
4. Assign fit score and priority.
5. Choose the best outreach/personalization angle for qualified leads.
6. Return clean structured JSON only.

YOU MUST NOT
- Send outreach.
- Write full emails unless the output schema explicitly asks for an angle only.
- Invent facts that are not supported by the input or sources.
- Over-search when the input is already strong.
- Return a paragraph.

QUALIFICATION RULES
- Use explicit ICP fit first.
- Favor prospects with clear public identity and business relevance.
- Penalize incomplete, conflicting, or weak records.
- If a lead is not strong enough, mark it unqualified or review.
- If a lead is qualified, set next_pipeline to outreach_drafting.

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
  "qualified_prospects": [
    {
      "name": string|null,
      "company": string|null,
      "domain": string|null,
      "website": string|null,
      "location": string|null,
      "role": string|null,
      "fit_score": number|null,
      "priority": "high" | "medium" | "low",
      "qualification_status": "qualified" | "unqualified" | "review",
      "personalization_angle": string|null,
      "notes": string|null
    }
  ],
  "stats": {
    "reviewed": number,
    "qualified": number,
    "rejected": number,
    "returned": number
  }
}

CONFIDENCE GUIDELINES
- 0.90 to 1.00 = very clear, strong fit.
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
// 5. Build Qualification Queries for a Prospect
// ────────────────────────────────────────────────────────────────

function buildQualificationQueries(prospect) {
    const queries = [];
    const company = prospect.company || prospect.name || '';
    const domain = prospect.domain || '';

    // Only search if the prospect is uncertain or missing key signals
    const needsRecentNews = !prospect.notes || prospect.notes.includes('No recent');
    const needsFundingSignal = prospect.confidence < 0.7;

    if (needsRecentNews && company) {
        queries.push(`"${company}" news funding expansion`);
    }

    if (needsFundingSignal && company) {
        queries.push(`"${company}" funding round investment`);
    }

    // If we have domain, check for recent activity
    if (domain && (needsRecentNews || needsFundingSignal)) {
        queries.push(`site:${domain} news funding`);
    }

    return queries.slice(0, MAX_QUERIES);
}

// ────────────────────────────────────────────────────────────────
// 6. Search for Additional Qualification Signals
// ────────────────────────────────────────────────────────────────

async function searchQualificationSignals(prospect, tavilyKey) {
    const queries = buildQualificationQueries(prospect);
    if (queries.length === 0) {
        return { signals: [], searched: 0 };
    }

    let allResults = [];
    for (const query of queries) {
        const results = await searchTavily(query, tavilyKey, 3);
        if (results && results.length > 0) {
            allResults = allResults.concat(results);
        }
    }

    return { signals: allResults, searched: queries.length };
}

// ────────────────────────────────────────────────────────────────
// 7. Main Agent 4 Function
// ────────────────────────────────────────────────────────────────

/**
 * Qualifies and prioritizes prospects from Agent 3.
 * 
 * @param {Object} params
 * @param {Array}  params.enriched_prospects - The enriched prospects from Agent 3.
 * @param {Object} params.intent - The original intent from Agent 1.
 * @param {string} params.apiKey - OpenAI API key.
 * @param {string} params.tavilyKey - Tavily API key.
 * @param {string} params.userId - User identifier for logging.
 * @param {Function} params.onProgress - Optional progress callback.
 * 
 * @returns {Object} Structured qualification result.
 */
async function qualifyProspects({ enriched_prospects, intent, apiKey, tavilyKey, userId = 'anonymous', onProgress = null }) {
    console.log(`🏆 [AGENT4] Starting qualification for user ${userId}...`);
    onProgress?.('🏆 Evaluating and prioritizing leads...');

    // Validate input
    if (!enriched_prospects || enriched_prospects.length === 0) {
        return {
            intent: 'lead_qualification',
            confidence: 0.0,
            needs_clarification: true,
            clarification_question: 'No prospects were provided to qualify. Please run enrichment first.',
            next_pipeline: null,
            entities: intent?.entities || {},
            risk_level: 'low',
            policy_flags: ['no_prospects'],
            reason: 'No prospects provided to Agent 4.',
            qualified_prospects: [],
            stats: { reviewed: 0, qualified: 0, rejected: 0, returned: 0 }
        };
    }

    // ─── Step 1: Gather qualification signals for each prospect ───
    const prospectsWithSignals = [];
    for (const prospect of enriched_prospects) {
        let signals = [];
        let searched = 0;

        // Only search if the prospect needs it (low confidence or missing signals)
        if (prospect.confidence < 0.7) {
            const result = await searchQualificationSignals(prospect, tavilyKey);
            signals = result.signals;
            searched = result.searched;
        }

        prospectsWithSignals.push({
            prospect,
            signals,
            searched,
        });
    }

    // ─── Step 2: Build input for GPT qualification ───
    const prospectsForGPT = prospectsWithSignals.map(({ prospect, signals }) => {
        const signalText = signals.length > 0 
            ? signals.map(s => `- ${s.title}: ${s.snippet}`).join('\n')
            : 'No additional signals found.';

        return {
            prospect: {
                name: prospect.name || 'Unknown',
                company: prospect.company || 'Unknown',
                domain: prospect.domain || 'Unknown',
                website: prospect.website || null,
                location: prospect.location || 'Unknown',
                role: prospect.role || 'Unknown',
                industry: prospect.industry || 'Unknown',
                confidence: prospect.confidence || 0.5,
                verification_status: prospect.verification_status || 'unverified',
                notes: prospect.notes || 'No notes.',
                linkedin_url: prospect.linkedin_url || null,
            },
            signals: signalText,
        };
    });

    const qualificationPrompt = `
You are a lead qualification specialist. Evaluate each prospect and decide if they are worth pursuing.

USER'S INTENT:
- Industry: ${intent?.industry || 'Any'}
- Location: ${intent?.location || 'Any'}
- Role: ${intent?.role || 'Any'}
- Target: ${intent?.target || 'Any'}

PROSPECTS TO EVALUATE:
${prospectsForGPT.map((p, i) => `
PROSPECT ${i + 1}:
- Name: ${p.prospect.name}
- Company: ${p.prospect.company}
- Domain: ${p.prospect.domain}
- Location: ${p.prospect.location}
- Role: ${p.prospect.role}
- Industry: ${p.prospect.industry}
- Confidence: ${p.prospect.confidence}
- Verification Status: ${p.prospect.verification_status}
- Notes: ${p.prospect.notes}
- LinkedIn: ${p.prospect.linkedin_url || 'Not found'}
- Additional Signals:
${p.signals}
`).join('\n---\n')}

QUALIFICATION RULES:
1. A prospect is QUALIFIED if:
   - Industry matches the user's intent OR is clearly related
   - Location matches OR is reasonably close
   - Role is relevant (founder, CEO, director, owner, VP, head of)
   - Verification status is "verified" OR "partial" with good signals
   - Confidence is at least 0.6

2. A prospect is UNQUALIFIED if:
   - Industry is completely wrong
   - Role is irrelevant
   - Verification status is "unverified" with no supporting signals
   - Confidence is below 0.4

3. A prospect is REVIEW if:
   - Some things match but key signals are missing
   - Confidence is between 0.4 and 0.6
   - Industry or location is ambiguous

4. Priority levels:
   - HIGH: Perfect match on all key criteria + verified + high confidence
   - MEDIUM: Good match but some gaps
   - LOW: Weak match or unclear fit

5. Personalization angle:
   - Choose ONE specific angle for outreach based on the prospect's business
   - Examples: growth, operational efficiency, customer acquisition, market expansion, innovation, etc.
   - Must be specific to their industry and role

Return ONLY valid JSON with this schema:
{
  "qualified_prospects": [
    {
      "name": string|null,
      "company": string|null,
      "domain": string|null,
      "website": string|null,
      "location": string|null,
      "role": string|null,
      "fit_score": number (0-1),
      "priority": "high" | "medium" | "low",
      "qualification_status": "qualified" | "unqualified" | "review",
      "personalization_angle": string|null,
      "notes": string|null
    }
  ],
  "stats": {
    "reviewed": number,
    "qualified": number,
    "rejected": number,
    "returned": number
  },
  "reason": string,
  "confidence": number,
  "needs_clarification": boolean
}
`;

    try {
        const response = await withRetry(() => axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: MODEL,
                messages: [
                    { role: 'system', content: AGENT4_SYSTEM_PROMPT },
                    { role: 'user', content: qualificationPrompt }
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
        ), 'GPT:qualifyProspects');

        if (!response) {
            return {
                intent: 'lead_qualification',
                confidence: 0.0,
                needs_clarification: true,
                clarification_question: 'Qualification failed. Please try again.',
                next_pipeline: null,
                entities: intent?.entities || {},
                risk_level: 'medium',
                policy_flags: ['qualification_failure'],
                reason: 'GPT qualification failed.',
                qualified_prospects: [],
                stats: { reviewed: enriched_prospects.length, qualified: 0, rejected: 0, returned: 0 }
            };
        }

        const rawContent = response.data.choices[0].message.content.trim();
        const parsed = JSON.parse(rawContent);

        // ─── Step 3: Build and return result ───
        const qualifiedProspects = parsed.qualified_prospects || [];
        const stats = parsed.stats || {
            reviewed: enriched_prospects.length,
            qualified: 0,
            rejected: 0,
            returned: 0
        };

        const totalQualified = qualifiedProspects.filter(p => p.qualification_status === 'qualified').length;
        const confidence = parsed.confidence || (totalQualified / enriched_prospects.length);

        const needsClarification = parsed.needs_clarification || confidence < CONFIDENCE_THRESHOLD_CLARIFY;

        const result = {
            intent: 'lead_qualification',
            confidence: Math.round(confidence * 100) / 100,
            needs_clarification: needsClarification,
            clarification_question: needsClarification 
                ? 'I found some leads but the qualification is uncertain. Could you confirm your ICP or provide more specific criteria?'
                : null,
            next_pipeline: totalQualified > 0 ? 'outreach_drafting' : null,
            entities: intent?.entities || {
                industry: intent?.industry || null,
                location: intent?.location || null,
                role: intent?.role || null,
                company: intent?.company || null,
                lead_count: totalQualified,
                email: null,
                domain: null,
                source_type: 'web_search'
            },
            risk_level: totalQualified / enriched_prospects.length < 0.3 ? 'medium' : 'low',
            policy_flags: totalQualified === 0 ? ['no_qualified_leads'] : [],
            reason: parsed.reason || `Qualified ${totalQualified} out of ${enriched_prospects.length} prospects.`,
            qualified_prospects: qualifiedProspects.map(p => ({
                name: p.name || null,
                company: p.company || null,
                domain: p.domain || null,
                website: p.website || null,
                location: p.location || null,
                role: p.role || null,
                fit_score: p.fit_score || 0.5,
                priority: p.priority || 'medium',
                qualification_status: p.qualification_status || 'review',
                personalization_angle: p.personalization_angle || null,
                notes: p.notes || null,
            })),
            stats: {
                reviewed: stats.reviewed || enriched_prospects.length,
                qualified: stats.qualified || totalQualified,
                rejected: stats.rejected || 0,
                returned: stats.returned || qualifiedProspects.length,
            }
        };

        console.log(`✅ [AGENT4] Qualification complete: ${totalQualified} qualified, ${result.stats.rejected} rejected`);
        return result;

    } catch (error) {
        console.error(`❌ [AGENT4] Qualification failed:`, error.message);
        return {
            intent: 'lead_qualification',
            confidence: 0.0,
            needs_clarification: true,
            clarification_question: 'Qualification failed. Please try again.',
            next_pipeline: null,
            entities: intent?.entities || {},
            risk_level: 'medium',
            policy_flags: ['qualification_failure'],
            reason: `Qualification failed: ${error.message}`,
            qualified_prospects: [],
            stats: { reviewed: enriched_prospects.length, qualified: 0, rejected: 0, returned: 0 }
        };
    }
}

// ────────────────────────────────────────────────────────────────
// 8. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
    qualifyProspects,
    buildQualificationQueries,
    searchQualificationSignals,
    searchTavily,
    CONFIDENCE_THRESHOLD_ROUTE,
    CONFIDENCE_THRESHOLD_CLARIFY,
};
