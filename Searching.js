// ──────────────────────────────────────────────────────────────
// SEARCHING.JS — Stage 2: People Discovery
// Skyline AA-1 Lead Generation System
//
// RESPONSIBILITIES:
// - Accept clean Stage 1 contract
// - Build targeted search queries
// - Execute Tavily searches (with fallback tiers, capped)
// - Extract people from search results with GPT (Luna, cascading to Terra)
// - De-duplicate candidates
// - Return validated people list
// - NEVER fail the whole stage if one query fails
// ──────────────────────────────────────────────────────────────

const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');
const axios = require('axios');

// ──────────────────────────────────────────────────────────────
// 1. CONFIGURATION
// ──────────────────────────────────────────────────────────────

const CONFIG = {
    // Tavily settings
    TAVILY_API_URL: 'https://api.tavily.com/search',
    TAVILY_MAX_RESULTS_PER_QUERY: 20,
    TAVILY_SEARCH_TIMEOUT_MS: 15000,
    MAX_TAVILY_SEARCHES_PER_TIER: 3,
    MAX_TAVILY_SEARCHES_TOTAL: 9, // 3 tiers × 3 searches each — hard ceiling, enforced below

    // AI extraction settings
    // Primary model per system plan: GPT-5.6 Luna (cheap, sufficient for structured extraction).
    // Escalates to Terra only when Luna's output is empty/invalid — see PeopleExtractor.extractBatch.
    AI_MODEL: 'gpt-5.6-luna',
    AI_MODEL_FALLBACK: 'gpt-5.6-terra',
    AI_TEMPERATURE: 0.2,
    AI_MAX_TOKENS: 1000,
    AI_BATCH_SIZE: 5,

    // Fallback tiers
    MIN_POOL_SIZE_MULTIPLIER: 1.5, // Requested × 1.5 = min pool size

    // Confidence levels
    CONFIDENCE: {
        HIGH: 'high',
        MEDIUM: 'medium',
        LOW: 'low',
    },

    // Discovery tiers
    DISCOVERY_TIERS: {
        TIER_1: 'tier1',
        TIER_2: 'tier2',
        TIER_3: 'tier3',
    },
};

// ──────────────────────────────────────────────────────────────
// 2. OUTPUT CONTRACT — People Candidate
// ──────────────────────────────────────────────────────────────

/**
 * Each candidate represents a real person discovered.
 * Stage 3 (Pattern Memory) consumes this directly.
 */
const CANDIDATE_SCHEMA = {
    name: 'string (required)',
    title: 'string (required)',
    companyName: 'string (required)',
    domain: 'string (required)',
    sourceUrl: 'string (required)',
    confidence: 'high | medium | low (required)',
    discoveredVia: 'tier1 | tier2 | tier3 (required)',
};

// ──────────────────────────────────────────────────────────────
// 3. QUERY BUILDER
// ──────────────────────────────────────────────────────────────

function buildSearchQueries(params) {
    const { companyName, domain, role, seniority, location, industry } = params;
    const queries = [];

    // ── Tier 1: Most specific ──
    // Full role + seniority + location + company
    if (role && seniority) {
        queries.push(`${seniority} ${role} ${companyName}`);
        queries.push(`${companyName} ${role} ${location}`);
        queries.push(`${companyName} team ${role}`);
    } else if (role) {
        queries.push(`${companyName} ${role}`);
        queries.push(`${role} at ${companyName}`);
        queries.push(`${companyName} team ${role}`);
    }

    // ── Company "About/Team" pages ──
    queries.push(`${companyName} team`);
    queries.push(`${companyName} about us`);
    queries.push(`${companyName} leadership`);

    // ── Location-specific ──
    if (location) {
        queries.push(`${companyName} ${location} team`);
        queries.push(`${companyName} employees ${location}`);
    }

    // ── Industry-specific ──
    if (industry) {
        queries.push(`${companyName} ${industry} team`);
    }

    // ── Remove duplicates ──
    const unique = [...new Set(queries)];
    return unique.slice(0, CONFIG.MAX_TAVILY_SEARCHES_PER_TIER * 2);
}

// ──────────────────────────────────────────────────────────────
// 4. TAVILY CLIENT
// ──────────────────────────────────────────────────────────────

class TavilyClient {
    constructor() {
        this.apiKey = process.env.TAVILY_API_KEY;
        this.apiUrl = CONFIG.TAVILY_API_URL;
        this.timeout = CONFIG.TAVILY_SEARCH_TIMEOUT_MS;
    }

    isConfigured() {
        return !!this.apiKey && this.apiKey.length > 0;
    }

    async search(query, options = {}) {
        if (!this.isConfigured()) {
            throw new Error('TAVILY_NOT_CONFIGURED');
        }

        const maxResults = options.maxResults || CONFIG.TAVILY_MAX_RESULTS_PER_QUERY;

        try {
            const response = await axios.post(
                this.apiUrl,
                {
                    query: query,
                    search_depth: 'advanced',
                    max_results: maxResults,
                    include_answer: false,
                    include_domains: options.includeDomains || [],
                    exclude_domains: options.excludeDomains || [],
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: this.timeout,
                }
            );

            return response.data;
        } catch (error) {
            if (error.response) {
                if (error.response.status === 401) throw new Error('TAVILY_API_KEY_INVALID');
                if (error.response.status === 429) throw new Error('TAVILY_RATE_LIMITED');
                throw new Error('TAVILY_SEARCH_FAILED');
            }
            if (error.code === 'ECONNABORTED') throw new Error('TAVILY_TIMEOUT');
            throw error;
        }
    }
}

// ──────────────────────────────────────────────────────────────
// 5. AI EXTRACTOR — Extracts people from search results
// ──────────────────────────────────────────────────────────────

class PeopleExtractor {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
        this.model = CONFIG.AI_MODEL;
        this.fallbackModel = CONFIG.AI_MODEL_FALLBACK;
        this.temperature = CONFIG.AI_TEMPERATURE;
        this.maxTokens = CONFIG.AI_MAX_TOKENS;
    }

    isConfigured() {
        return !!process.env.OPENAI_API_KEY;
    }

    async extractPeople(searchResults, query, domain) {
        if (!this.isConfigured()) {
            console.warn('[EXTRACTOR] OpenAI not configured');
            return [];
        }

        const results = searchResults.results || [];
        if (results.length === 0) return [];

        // Batch results
        const batches = [];
        for (let i = 0; i < results.length; i += CONFIG.AI_BATCH_SIZE) {
            batches.push(results.slice(i, i + CONFIG.AI_BATCH_SIZE));
        }

        const allCandidates = [];
        for (const batch of batches) {
            const candidates = await this.extractBatch(batch, query, domain);
            allCandidates.push(...candidates);
        }

        return allCandidates;
    }

    /**
     * Extracts people from one batch of search results using the primary
     * model (Luna). If Luna returns nothing usable — empty result or a
     * parse/API failure — retries once with the fallback model (Terra)
     * before giving up on this batch, per the cascade rule in the spec.
     */
    async extractBatch(results, query, domain) {
        const primaryAttempt = await this.callModel(this.model, results, query, domain);

        if (primaryAttempt.ok && primaryAttempt.people.length > 0) {
            return primaryAttempt.people;
        }

        // Escalate to Terra only when Luna produced nothing usable.
        console.warn(`[EXTRACTOR] Luna returned no usable result for query "${query}" — escalating to ${this.fallbackModel}`);
        const fallbackAttempt = await this.callModel(this.fallbackModel, results, query, domain);

        return fallbackAttempt.ok ? fallbackAttempt.people : [];
    }

    /**
     * Single model call. Returns { ok, people } — ok is false on API error
     * or invalid JSON, so the caller can decide whether to escalate.
     */
    async callModel(model, results, query, domain) {
        const prompt = this.buildExtractionPrompt(results, query, domain);

        try {
            const response = await this.openai.chat.completions.create({
                model: model,
                temperature: this.temperature,
                max_tokens: this.maxTokens,
                response_format: { type: 'json_object' },
                messages: [
                    {
                        role: 'system',
                        content: `You are Skyline AA-1 People Discovery Assistant.

Your job is to extract real people from search results.

RULES:
1. ONLY extract people who are clearly identified with a name and title.
2. The title must be a real job title.
3. If a person's name or title is unclear, skip them.
4. Extract the sourceUrl where this person was found.
5. Return JSON only.

Output format:
{
  "people": [
    {
      "name": "Jane Doe",
      "title": "Marketing Director",
      "sourceUrl": "https://example.com/team/jane-doe"
    }
  ]
}`
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ]
            });

            const content = response.choices[0].message.content;
            const parsed = JSON.parse(content || '{"people": []}');
            return { ok: true, people: parsed.people || [] };

        } catch (error) {
            console.error(`[EXTRACTOR] ${model} batch error:`, error.message);
            return { ok: false, people: [] };
        }
    }

    buildExtractionPrompt(results, query, domain) {
        const resultsText = results.map((r, i) => {
            const content = (r.content || '').substring(0, 1000);
            return `
--- Result ${i + 1} ---
Title: ${r.title || 'No title'}
URL: ${r.url || 'No URL'}
Content:
${content}`;
        }).join('\n');

        return `Extract people from these search results.

Search query: "${query}"
Target domain: ${domain}

${resultsText}

Extract every real person mentioned with a name and title.
Return only people who can be clearly identified.
Include the sourceUrl where each person was found.`;
    }
}

// ──────────────────────────────────────────────────────────────
// 6. MAIN DISCOVERY ENGINE
// ──────────────────────────────────────────────────────────────

class PeopleDiscoveryEngine {
    constructor() {
        this.tavilyClient = new TavilyClient();
        this.extractor = new PeopleExtractor();
    }

    /**
     * Main entry point — discover people
     * @param {Object} params - Stage 1 contract
     * @returns {Object} Discovered people candidates
     */
    async discover(params) {
        console.log('[DISCOVERY] Starting Stage 2...');
        console.log('[DISCOVERY] Input:', JSON.stringify(params, null, 2));

        // ── Validate input ──
        if (params.needsClarification) {
            return {
                status: 'needs_clarification',
                message: 'Stage 1 requires clarification before discovery',
                candidates: [],
                partialResults: false,
            };
        }

        if (!params.domain && !params.companyName) {
            return {
                status: 'failed',
                message: 'Missing companyName or domain',
                candidates: [],
                partialResults: false,
            };
        }

        // ── Check Tavily ──
        if (!this.tavilyClient.isConfigured()) {
            return {
                status: 'failed',
                message: 'Tavily not configured',
                candidates: [],
                partialResults: false,
            };
        }

        // ── Calculate min pool size ──
        const requestedQuantity = params.quantity || 50;
        const minPoolSize = Math.ceil(requestedQuantity * CONFIG.MIN_POOL_SIZE_MULTIPLIER);
        console.log(`[DISCOVERY] Min pool size: ${minPoolSize}`);

        // ── Build search queries ──
        const allQueries = buildSearchQueries(params);
        console.log(`[DISCOVERY] Built ${allQueries.length} queries`);

        // ── Execute searches with fallback tiers (capped) ──
        const result = await this.executeWithFallback(allQueries, params, minPoolSize);

        // ── De-duplicate ──
        const deduped = this.deduplicateCandidates(result.candidates);

        // ── Determine if partial results ──
        const partialResults = deduped.length < requestedQuantity;

        console.log(`[DISCOVERY] Found ${deduped.length} unique candidates (partial: ${partialResults})`);

        return {
            status: 'completed',
            candidates: deduped,
            partialResults: partialResults,
            requestedQuantity: requestedQuantity,
            foundQuantity: deduped.length,
            searchStatistics: result.statistics,
        };
    }

    /**
     * Execute searches with three-tier fallback.
     * Stops as soon as minPoolSize is met, OR the total Tavily search cap
     * (CONFIG.MAX_TAVILY_SEARCHES_TOTAL) is reached — whichever comes first,
     * per spec Section 4/Step 2.5.
     */
    async executeWithFallback(allQueries, params, minPoolSize) {
        const allCandidates = [];
        const statistics = {
            tiersExecuted: 0,
            queriesExecuted: 0,
            totalSearches: 0,
            resultsProcessed: 0,
            capReached: false,
        };

        const searchBudgetRemaining = () =>
            CONFIG.MAX_TAVILY_SEARCHES_TOTAL - statistics.totalSearches;

        // ── Tier 1: Full specificity ──
        console.log('[DISCOVERY] Executing Tier 1...');
        const tier1Queries = allQueries
            .slice(0, CONFIG.MAX_TAVILY_SEARCHES_PER_TIER)
            .slice(0, Math.max(0, searchBudgetRemaining()));
        const tier1Results = await this.executeQueries(tier1Queries, params, CONFIG.DISCOVERY_TIERS.TIER_1);
        allCandidates.push(...tier1Results.candidates);
        statistics.queriesExecuted += tier1Results.queriesExecuted;
        statistics.totalSearches += tier1Results.totalSearches;
        statistics.resultsProcessed += tier1Results.resultsProcessed;
        statistics.tiersExecuted = 1;

        let uniqueCandidates = this.deduplicateCandidates(allCandidates);
        if (uniqueCandidates.length >= minPoolSize || searchBudgetRemaining() <= 0) {
            if (searchBudgetRemaining() <= 0) statistics.capReached = true;
            console.log(`[DISCOVERY] Stopping after Tier 1: pool=${uniqueCandidates.length}, capReached=${statistics.capReached}`);
            return { candidates: uniqueCandidates, statistics };
        }

        // ── Tier 2: Drop seniority ──
        console.log(`[DISCOVERY] Pool insufficient (${uniqueCandidates.length} < ${minPoolSize}). Executing Tier 2...`);
        const tier2Params = { ...params, seniority: null };
        const tier2Queries = buildSearchQueries(tier2Params)
            .slice(0, CONFIG.MAX_TAVILY_SEARCHES_PER_TIER)
            .slice(0, Math.max(0, searchBudgetRemaining()));
        const tier2Results = await this.executeQueries(tier2Queries, tier2Params, CONFIG.DISCOVERY_TIERS.TIER_2);
        allCandidates.push(...tier2Results.candidates);
        statistics.queriesExecuted += tier2Results.queriesExecuted;
        statistics.totalSearches += tier2Results.totalSearches;
        statistics.resultsProcessed += tier2Results.resultsProcessed;
        statistics.tiersExecuted = 2;

        uniqueCandidates = this.deduplicateCandidates(allCandidates);
        if (uniqueCandidates.length >= minPoolSize || searchBudgetRemaining() <= 0) {
            if (searchBudgetRemaining() <= 0) statistics.capReached = true;
            console.log(`[DISCOVERY] Stopping after Tier 2: pool=${uniqueCandidates.length}, capReached=${statistics.capReached}`);
            return { candidates: uniqueCandidates, statistics };
        }

        // ── Tier 3: Broaden location/industry ──
        console.log(`[DISCOVERY] Pool insufficient (${uniqueCandidates.length} < ${minPoolSize}). Executing Tier 3...`);
        const tier3Params = { ...params, location: null };
        const tier3Queries = buildSearchQueries(tier3Params)
            .slice(0, CONFIG.MAX_TAVILY_SEARCHES_PER_TIER)
            .slice(0, Math.max(0, searchBudgetRemaining()));
        const tier3Results = await this.executeQueries(tier3Queries, tier3Params, CONFIG.DISCOVERY_TIERS.TIER_3);
        allCandidates.push(...tier3Results.candidates);
        statistics.queriesExecuted += tier3Results.queriesExecuted;
        statistics.totalSearches += tier3Results.totalSearches;
        statistics.resultsProcessed += tier3Results.resultsProcessed;
        statistics.tiersExecuted = 3;

        uniqueCandidates = this.deduplicateCandidates(allCandidates);
        if (searchBudgetRemaining() <= 0) statistics.capReached = true;
        console.log(`[DISCOVERY] Final pool: ${uniqueCandidates.length}, capReached=${statistics.capReached}`);

        return {
            candidates: uniqueCandidates,
            statistics: statistics,
        };
    }

    /**
     * Execute a list of queries and extract people
     */
    async executeQueries(queries, params, tier) {
        const allCandidates = [];
        let queriesExecuted = 0;
        let totalSearches = 0;
        let resultsProcessed = 0;

        for (const query of queries) {
            try {
                console.log(`[DISCOVERY] [${tier}] Searching: "${query}"`);
                const result = await this.tavilyClient.search(query);
                queriesExecuted++;
                totalSearches++;

                const rawResults = result.results || [];
                resultsProcessed += rawResults.length;

                // Extract people from these results
                const people = await this.extractor.extractPeople(
                    result,
                    query,
                    params.domain
                );

                // Tag each candidate
                for (const person of people) {
                    allCandidates.push({
                        name: person.name,
                        title: person.title,
                        companyName: params.companyName,
                        domain: params.domain,
                        sourceUrl: person.sourceUrl || '',
                        confidence: this.calculateConfidence(person, tier, query),
                        discoveredVia: tier,
                    });
                }

                console.log(`[DISCOVERY] Found ${people.length} people from query`);

            } catch (error) {
                console.error(`[DISCOVERY] Query failed: "${query}"`, error.message);
                // Continue with next query — don't fail the whole stage
            }
        }

        return {
            candidates: allCandidates,
            queriesExecuted: queriesExecuted,
            totalSearches: totalSearches,
            resultsProcessed: resultsProcessed,
        };
    }

    /**
     * Calculate confidence based on source and tier
     */
    calculateConfidence(person, tier, query) {
        let confidence = CONFIG.CONFIDENCE.MEDIUM;

        // ── Higher confidence for Tier 1 ──
        if (tier === CONFIG.DISCOVERY_TIERS.TIER_1) {
            confidence = CONFIG.CONFIDENCE.HIGH;
        }

        // ── Lower confidence for Tier 3 ──
        if (tier === CONFIG.DISCOVERY_TIERS.TIER_3) {
            confidence = CONFIG.CONFIDENCE.LOW;
        }

        // ── Check if sourceUrl is the company domain ──
        if (person.sourceUrl && person.sourceUrl.includes(person.domain || '')) {
            confidence = CONFIG.CONFIDENCE.HIGH;
        }

        return confidence;
    }

    /**
     * De-duplicate candidates (same name + company)
     */
    deduplicateCandidates(candidates) {
        const seen = new Map();
        const unique = [];

        for (const candidate of candidates) {
            const key = `${candidate.name}_${candidate.domain}`;

            if (seen.has(key)) {
                const existing = seen.get(key);
                // Keep the one with highest confidence
                const confidenceOrder = { high: 3, medium: 2, low: 1 };
                if (confidenceOrder[candidate.confidence] > confidenceOrder[existing.confidence]) {
                    seen.set(key, candidate);
                }
                continue;
            }

            seen.set(key, candidate);
        }

        // Convert Map values to array
        for (const [key, candidate] of seen) {
            unique.push(candidate);
        }

        return unique;
    }
}

// ──────────────────────────────────────────────────────────────
// 7. CONVENIENCE FUNCTION
// ──────────────────────────────────────────────────────────────

/**
 * Main entry point — discover people from Stage 1 contract
 *
 * @param {Object} params - Stage 1 contract
 * @returns {Promise<Object>} Discovered people candidates
 */
async function discover(params) {
    const engine = new PeopleDiscoveryEngine();
    return engine.discover(params);
}

// ──────────────────────────────────────────────────────────────
// 8. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    discover,
    PeopleDiscoveryEngine,
    TavilyClient,
    PeopleExtractor,
    buildSearchQueries,
    CONFIG,
    CANDIDATE_SCHEMA,
};
