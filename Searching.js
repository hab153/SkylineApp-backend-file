// ──────────────────────────────────────────────────────────────
// SEARCHING.JS — Layer 3: Discovery Engine v2.0
// 
// RESPONSIBILITIES:
// - Execute Layer 2 search plan using Tavily
// - Use GPT-4o-mini to extract legitimate candidates
// - Reject garbage (article titles, lists, fragments)
// - Preserve discovery evidence and source provenance
// - Remove obvious duplicates
// - Return structured discovery pool to Layer 4
// - NEVER verify, score, rank, or enrich leads
// - NEVER invent missing information
// ──────────────────────────────────────────────────────────────

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');

// ──────────────────────────────────────────────────────────────
// 1. CONFIGURATION
// ──────────────────────────────────────────────────────────────

const CONFIG = {
    TAVILY_API_URL: 'https://api.tavily.com/search',
    MAX_RESULTS_PER_QUERY: 20,
    SEARCH_TIMEOUT_MS: 15000,
    AI_MODEL: 'gpt-4o-mini',
    AI_TEMPERATURE: 0.2,
    AI_MAX_TOKENS: 800,
};

// ──────────────────────────────────────────────────────────────
// 2. TAVILY CLIENT
// ──────────────────────────────────────────────────────────────

class TavilyClient {
    constructor() {
        this.apiKey = process.env.TAVILY_API_KEY;
        this.apiUrl = CONFIG.TAVILY_API_URL;
        this.timeout = CONFIG.SEARCH_TIMEOUT_MS;
    }

    isConfigured() {
        return !!this.apiKey && this.apiKey.length > 0;
    }

    async search(query, options = {}) {
        if (!this.isConfigured()) {
            throw new Error('TAVILY_API_KEY_MISSING');
        }

        const maxResults = options.maxResults || CONFIG.MAX_RESULTS_PER_QUERY;

        try {
            console.log(`[TAVILY] Searching: "${query}"`);
            
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

            console.log(`[TAVILY] Found ${response.data.results?.length || 0} results for "${query}"`);
            return response.data;

        } catch (error) {
            if (error.response) {
                console.error(`[TAVILY] API Error ${error.response.status}:`, error.response.data);
                if (error.response.status === 401) {
                    throw new Error('TAVILY_API_KEY_INVALID');
                }
                if (error.response.status === 429) {
                    throw new Error('TAVILY_RATE_LIMITED');
                }
                throw new Error('TAVILY_SEARCH_FAILED');
            }
            if (error.code === 'ECONNABORTED') {
                throw new Error('TAVILY_TIMEOUT');
            }
            throw error;
        }
    }
}

// ──────────────────────────────────────────────────────────────
// 3. AI EXTRACTOR — GPT-4o-mini Integration
// ──────────────────────────────────────────────────────────────

class AIExtractor {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
        this.model = CONFIG.AI_MODEL;
        this.temperature = CONFIG.AI_TEMPERATURE;
        this.maxTokens = CONFIG.AI_MAX_TOKENS;
    }

    isConfigured() {
        return !!process.env.OPENAI_API_KEY;
    }

    /**
     * Extract candidates from Tavily search results using GPT-4o-mini
     */
    async extractCandidates(tavilyResults, query, branch) {
        if (!this.isConfigured()) {
            console.warn('[AI] OpenAI API key missing. Using fallback extraction.');
            return this.fallbackExtraction(tavilyResults, query, branch);
        }

        try {
            const prompt = this.buildExtractionPrompt(tavilyResults, query, branch);
            
            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    {
                        role: 'system',
                        content: `You are Skyline AA-1 Layer 3 Discovery Assistant.

Your job is to extract real candidate companies and people from web search results.

RULES — NEVER BREAK:
1. NEVER invent information.
2. NEVER treat an article title as a company.
3. NEVER treat a category, industry, list, ranking, sentence fragment, or search phrase as a company or person.
4. Only extract an entity when the source provides evidence that the entity actually exists.
5. If information is missing, return null.
6. Do not perform final verification.
7. Return JSON only.

Extract these fields when present:
- companyName: The actual company name
- companyDomain: The company's domain
- companyIndustry: The company's industry
- companyLocation: City or country
- personName: The person's name
- personRole: Founder, CEO, etc.
- email: If found
- linkedinUrl: If found
- evidenceSnippet: The text that supports this extraction
- confidence: 0.0-1.0 how confident you are this is a real entity

Output format:
{
  "candidates": [
    {
      "companyName": "ExampleSoft" or null,
      "companyDomain": "examplesoft.com" or null,
      "companyIndustry": "SaaS" or null,
      "companyLocation": "London" or null,
      "personName": "John Smith" or null,
      "personRole": "Founder" or null,
      "email": null,
      "linkedinUrl": null,
      "evidenceSnippet": "ExampleSoft is a London-based SaaS company founded by John Smith.",
      "confidence": 0.92
    }
  ]
}`
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: this.temperature,
                max_tokens: this.maxTokens,
                response_format: { type: 'json_object' }
            });

            const content = response.choices[0].message.content;
            const parsed = JSON.parse(content);
            
            console.log(`[AI] Extracted ${parsed.candidates?.length || 0} candidates`);
            return parsed.candidates || [];

        } catch (error) {
            console.error('[AI] Extraction failed:', error.message);
            console.warn('[AI] Falling back to deterministic extraction');
            return this.fallbackExtraction(tavilyResults, query, branch);
        }
    }

    /**
     * Build the extraction prompt
     */
    buildExtractionPrompt(tavilyResults, query, branch) {
        const results = tavilyResults.results || [];
        const industry = branch.industry || 'unknown';

        let resultsText = '';
        for (let i = 0; i < Math.min(results.length, 15); i++) {
            const item = results[i];
            resultsText += `
Result ${i + 1}:
Title: ${item.title || 'No title'}
URL: ${item.url || 'No URL'}
Content: ${(item.content || '').substring(0, 800)}
---`;
        }

        return `
You are analyzing search results for: "${query}"
Target industry: ${industry}

Extract real candidate companies and people from these search results.

Search Results:
${resultsText}

Remember: Only extract entities with evidence. Never invent. Return JSON only.
`;
    }

    /**
     * Fallback: deterministic extraction when AI is unavailable
     */
    fallbackExtraction(tavilyResults, query, branch) {
        console.log('[AI] Using fallback deterministic extraction');
        const candidates = [];
        const results = tavilyResults.results || [];

        for (const item of results) {
            const content = item.content || '';
            const title = item.title || '';
            
            // Simple extraction patterns
            const companyMatch = content.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\s+(?:is|was|are|has|provides|offers)/i);
            const personMatch = content.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s+(?:is|was|said|founded|founded by)/i);
            const roleMatch = content.match(/(?:founder|ceo|cto|director|manager)\s+([A-Z][a-z]+)/i);

            if (companyMatch || personMatch) {
                candidates.push({
                    companyName: companyMatch ? companyMatch[1] : null,
                    companyDomain: null,
                    companyIndustry: branch.industry || null,
                    companyLocation: null,
                    personName: personMatch ? personMatch[1] : null,
                    personRole: roleMatch ? roleMatch[1] : null,
                    email: null,
                    linkedinUrl: null,
                    evidenceSnippet: content.substring(0, 200),
                    confidence: 0.5,
                });
            }
        }

        return candidates;
    }
}

// ──────────────────────────────────────────────────────────────
// 4. CANDIDATE BUILDER — Convert AI output to standard format
// ──────────────────────────────────────────────────────────────

class CandidateBuilder {
    /**
     * Convert AI-extracted candidates to standard format
     */
    buildCandidates(aiCandidates, query, branch, sourceUrl, sourceTitle, sourceSnippet) {
        const candidates = [];

        for (const ai of aiCandidates) {
            // Skip if no useful information
            if (!ai.companyName && !ai.personName) {
                continue;
            }

            // Skip garbage: company name looks like a sentence
            if (ai.companyName && this.isGarbageCompanyName(ai.companyName)) {
                continue;
            }

            const candidate = {
                candidateId: `candidate-${uuidv4().substring(0, 8)}`,
                company: {
                    name: ai.companyName || null,
                    domain: ai.companyDomain || null,
                    industry: ai.companyIndustry || null,
                    location: this.parseLocation(ai.companyLocation),
                    employeeCount: null,
                    revenue: null,
                    funding: null,
                },
                contact: {
                    name: ai.personName || null,
                    role: ai.personRole || null,
                    email: ai.email || null,
                    phone: null,
                    linkedinUrl: ai.linkedinUrl || null,
                },
                discovery: {
                    branch: branch.industry || 'unknown',
                    query: query,
                    sourceUrl: sourceUrl || null,
                    sourceTitle: sourceTitle || null,
                    sourceSnippet: ai.evidenceSnippet || (sourceSnippet || '').substring(0, 200),
                    discoveredAt: new Date().toISOString(),
                },
                evidence: [],
                discoveryConfidence: ai.confidence || 0.5,
            };

            // Build evidence
            if (ai.companyName) {
                candidate.evidence.push({
                    type: 'company_identity',
                    sourceUrl: sourceUrl || null,
                    sourceTitle: sourceTitle || null,
                    snippet: ai.evidenceSnippet || '',
                });
            }
            if (ai.personName) {
                candidate.evidence.push({
                    type: 'person_identity',
                    sourceUrl: sourceUrl || null,
                    sourceTitle: sourceTitle || null,
                    snippet: ai.evidenceSnippet || '',
                });
            }
            if (ai.companyIndustry) {
                candidate.evidence.push({
                    type: 'industry',
                    sourceUrl: sourceUrl || null,
                    sourceTitle: sourceTitle || null,
                    snippet: ai.companyIndustry,
                });
            }
            if (ai.companyLocation) {
                candidate.evidence.push({
                    type: 'location',
                    sourceUrl: sourceUrl || null,
                    sourceTitle: sourceTitle || null,
                    snippet: ai.companyLocation,
                });
            }

            candidates.push(candidate);
        }

        return candidates;
    }

    /**
     * Check if company name is garbage
     */
    isGarbageCompanyName(name) {
        if (!name) return true;
        
        const garbage = [
            'top', 'best', 'list', 'rank', 'guide', 'how to',
            'what is', 'the best', 'companies', 'industry',
            'sector', 'market', 'trend', 'analysis', 'report',
            'article', 'blog', 'news', 'update', 'directory',
            'category', 'page', 'search', 'result'
        ];

        const lower = name.toLowerCase();
        for (const word of garbage) {
            if (lower.includes(word)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Parse location string
     */
    parseLocation(locationStr) {
        if (!locationStr) {
            return { city: null, region: null, country: null, countryCode: null };
        }

        const lower = locationStr.toLowerCase();
        const location = { city: null, region: null, country: null, countryCode: null };

        const cities = ['london', 'berlin', 'paris', 'madrid', 'rome', 'amsterdam', 'lagos', 'abuja'];
        const countries = {
            'uk': { name: 'United Kingdom', code: 'GB' },
            'united kingdom': { name: 'United Kingdom', code: 'GB' },
            'nigeria': { name: 'Nigeria', code: 'NG' },
            'germany': { name: 'Germany', code: 'DE' },
            'usa': { name: 'United States', code: 'US' },
            'united states': { name: 'United States', code: 'US' },
            'canada': { name: 'Canada', code: 'CA' },
            'france': { name: 'France', code: 'FR' },
            'spain': { name: 'Spain', code: 'ES' },
            'italy': { name: 'Italy', code: 'IT' },
            'netherlands': { name: 'Netherlands', code: 'NL' },
            'sweden': { name: 'Sweden', code: 'SE' },
            'norway': { name: 'Norway', code: 'NO' },
            'denmark': { name: 'Denmark', code: 'DK' },
            'finland': { name: 'Finland', code: 'FI' },
            'ireland': { name: 'Ireland', code: 'IE' },
            'south africa': { name: 'South Africa', code: 'ZA' },
            'brazil': { name: 'Brazil', code: 'BR' },
            'australia': { name: 'Australia', code: 'AU' },
            'india': { name: 'India', code: 'IN' },
            'singapore': { name: 'Singapore', code: 'SG' },
        };

        // Check cities
        for (const city of cities) {
            if (lower.includes(city)) {
                location.city = city.charAt(0).toUpperCase() + city.slice(1);
                break;
            }
        }

        // Check countries
        for (const [key, value] of Object.entries(countries)) {
            if (lower.includes(key)) {
                location.country = value.name;
                location.countryCode = value.code;
                break;
            }
        }

        return location;
    }
}

// ──────────────────────────────────────────────────────────────
// 5. DEDUPLICATION ENGINE
// ──────────────────────────────────────────────────────────────

class DeduplicationEngine {
    /**
     * Remove obvious duplicates using company name and domain
     */
    deduplicate(candidates) {
        const seen = new Map();
        const unique = [];

        for (const candidate of candidates) {
            // Build a key from company name or domain
            const name = candidate.company?.name;
            const domain = candidate.company?.domain;

            let key = null;
            if (domain) {
                key = domain.toLowerCase();
            } else if (name) {
                key = this.normalizeName(name);
            }

            if (key) {
                if (seen.has(key)) {
                    // Merge evidence from duplicates
                    const existing = seen.get(key);
                    if (candidate.evidence && candidate.evidence.length > 0) {
                        existing.evidence = [...existing.evidence, ...candidate.evidence];
                    }
                    if (candidate.contact?.name && !existing.contact?.name) {
                        existing.contact.name = candidate.contact.name;
                    }
                    if (candidate.contact?.role && !existing.contact?.role) {
                        existing.contact.role = candidate.contact.role;
                    }
                    continue;
                }
                seen.set(key, candidate);
            }

            unique.push(candidate);
        }

        const removed = candidates.length - unique.length;
        console.log(`[DEDUPE] Removed ${removed} duplicates`);

        return { uniqueCandidates: unique, duplicatesRemoved: removed };
    }

    normalizeName(name) {
        if (!name) return '';
        return name
            .toLowerCase()
            .replace(/(ltd|limited|inc|llc|corp|corporation|gmbh|plc|co|company)\s*$/i, '')
            .replace(/[^a-zA-Z0-9]/g, '')
            .trim();
    }
}

// ──────────────────────────────────────────────────────────────
// 6. MAIN SEARCHING ENGINE
// ──────────────────────────────────────────────────────────────

class SearchingEngine {
    constructor() {
        this.tavilyClient = new TavilyClient();
        this.aiExtractor = new AIExtractor();
        this.candidateBuilder = new CandidateBuilder();
        this.deduplicationEngine = new DeduplicationEngine();
    }

    /**
     * Execute the search plan
     */
    async execute(plan) {
        console.log('[DISCOVERY] Starting Layer 3 discovery...');

        // ── Validate input ──
        if (!plan || plan.status === 'invalid') {
            return this.buildErrorResult('INVALID_SEARCH_PLAN', 'Invalid search plan');
        }

        if (plan.status === 'needs_clarification') {
            return this.buildErrorResult('PLAN_NEEDS_CLARIFICATION', 'Cannot execute search until plan is clarified');
        }

        // ── Check API keys ──
        if (!this.tavilyClient.isConfigured()) {
            console.error('[DISCOVERY] Tavily API key missing');
            return this.buildErrorResult('TAVILY_API_KEY_MISSING', 'Tavily API key is not configured');
        }

        if (!this.aiExtractor.isConfigured()) {
            console.warn('[DISCOVERY] OpenAI API key missing. Using fallback extraction.');
        }

        // ── Prepare context ──
        const requestId = plan.requestId || `search-${uuidv4().substring(0, 8)}`;
        const searchBranches = plan.searchBranches || [];
        const requestedQuantity = plan.quantity?.requested || 0;

        console.log(`[DISCOVERY] Request: ${requestId}`);
        console.log(`[DISCOVERY] Branches: ${searchBranches.length}`);
        console.log(`[DISCOVERY] Provider: Tavily`);
        console.log(`[DISCOVERY] AI: ${this.aiExtractor.isConfigured() ? 'GPT-4o-mini' : 'Fallback'}`);

        // ── Execute searches ──
        const allCandidates = [];
        const searchSummary = {
            branchesExecuted: 0,
            queriesExecuted: 0,
            rawResultsFound: 0,
            aiResultsAnalyzed: 0,
            candidatesExtracted: 0,
            invalidCandidatesRejected: 0,
            duplicatesDetected: 0,
            duplicatesRemoved: 0,
            candidatesForNextLayer: 0,
        };

        const errors = [];

        for (const branch of searchBranches) {
            const branchResults = await this.executeBranch(branch, plan, errors, searchSummary);
            searchSummary.branchesExecuted++;
            searchSummary.queriesExecuted += branchResults.queriesExecuted || 0;
            searchSummary.rawResultsFound += branchResults.rawResultsFound || 0;
            searchSummary.aiResultsAnalyzed += branchResults.aiResultsAnalyzed || 0;
            searchSummary.candidatesExtracted += branchResults.candidatesExtracted || 0;
            searchSummary.invalidCandidatesRejected += branchResults.invalidCandidatesRejected || 0;

            if (branchResults.candidates) {
                allCandidates.push(...branchResults.candidates);
            }
        }

        console.log(`[DISCOVERY] Branches executed: ${searchSummary.branchesExecuted}`);
        console.log(`[DISCOVERY] Queries executed: ${searchSummary.queriesExecuted}`);
        console.log(`[DISCOVERY] Raw results found: ${searchSummary.rawResultsFound}`);
        console.log(`[DISCOVERY] AI results analyzed: ${searchSummary.aiResultsAnalyzed}`);
        console.log(`[DISCOVERY] Candidates extracted: ${searchSummary.candidatesExtracted}`);
        console.log(`[DISCOVERY] Invalid candidates rejected: ${searchSummary.invalidCandidatesRejected}`);

        // ── Deduplicate ──
        const dedupResult = this.deduplicationEngine.deduplicate(allCandidates);
        searchSummary.duplicatesDetected = dedupResult.duplicatesRemoved;
        searchSummary.duplicatesRemoved = dedupResult.duplicatesRemoved;
        searchSummary.candidatesForNextLayer = dedupResult.uniqueCandidates.length;

        console.log(`[DISCOVERY] Duplicates removed: ${dedupResult.duplicatesRemoved}`);
        console.log(`[DISCOVERY] Candidates for Layer 4: ${dedupResult.uniqueCandidates.length}`);

        // ── Determine status ──
        let status = 'completed';
        if (dedupResult.uniqueCandidates.length === 0) {
            status = 'no_results';
        }
        if (errors.length > 0 && dedupResult.uniqueCandidates.length === 0) {
            status = 'failed';
        }
        if (errors.length > 0 && dedupResult.uniqueCandidates.length > 0) {
            status = 'partial';
        }

        // ── Build result ──
        return {
            discoveryVersion: '2.0.0',
            requestId: requestId,
            status: status,
            searchProvider: {
                name: 'tavily',
                configured: this.tavilyClient.isConfigured(),
            },
            aiExtractor: {
                provider: 'openai',
                model: CONFIG.AI_MODEL,
                configured: this.aiExtractor.isConfigured(),
            },
            searchStatistics: searchSummary,
            candidates: dedupResult.uniqueCandidates,
            errors: errors,
            createdBy: 'Searching.js',
            createdAt: new Date().toISOString(),
        };
    }

    /**
     * Execute a single search branch
     */
    async executeBranch(branch, plan, errors, searchSummary) {
        const results = {
            candidates: [],
            queriesExecuted: 0,
            rawResultsFound: 0,
            aiResultsAnalyzed: 0,
            candidatesExtracted: 0,
            invalidCandidatesRejected: 0,
        };

        const hypotheses = branch.hypotheses || [];
        const industry = branch.industry || 'unknown';

        console.log(`[DISCOVERY] Executing branch: ${industry}`);

        for (const query of hypotheses) {
            try {
                console.log(`[DISCOVERY] Query: ${query}`);

                // ── Step 1: Search with Tavily ──
                const tavilyResult = await this.tavilyClient.search(query);
                results.queriesExecuted++;
                results.rawResultsFound += tavilyResult.results?.length || 0;

                const rawResults = tavilyResult.results || [];

                // ── Step 2: Extract with AI ──
                const aiCandidates = await this.aiExtractor.extractCandidates(
                    tavilyResult,
                    query,
                    branch
                );

                results.aiResultsAnalyzed += rawResults.length;

                // ── Step 3: Build standard candidates ──
                for (const item of rawResults) {
                    const builtCandidates = this.candidateBuilder.buildCandidates(
                        aiCandidates.filter(c => c.evidenceSnippet && item.content.includes(c.evidenceSnippet.substring(0, 50))),
                        query,
                        branch,
                        item.url,
                        item.title,
                        item.content
                    );

                    if (builtCandidates.length > 0) {
                        results.candidates.push(...builtCandidates);
                        results.candidatesExtracted += builtCandidates.length;
                    }
                }

                console.log(`[DISCOVERY] Results received: ${rawResults.length}`);
                console.log(`[DISCOVERY] Candidates discovered: ${results.candidates.length}`);

            } catch (error) {
                console.error(`[DISCOVERY] Query "${query}" failed:`, error.message);
                errors.push({
                    query: query,
                    branch: industry,
                    error: error.message,
                });
            }
        }

        return results;
    }

    /**
     * Build error result
     */
    buildErrorResult(errorCode, message) {
        return {
            discoveryVersion: '2.0.0',
            requestId: `error-${uuidv4().substring(0, 8)}`,
            status: 'failed',
            searchProvider: {
                name: 'tavily',
                configured: this.tavilyClient.isConfigured(),
            },
            aiExtractor: {
                provider: 'openai',
                model: CONFIG.AI_MODEL,
                configured: this.aiExtractor.isConfigured(),
            },
            error: {
                code: errorCode,
                message: message,
            },
            candidates: [],
            errors: [{ error: message }],
            createdBy: 'Searching.js',
            createdAt: new Date().toISOString(),
        };
    }
}

// ──────────────────────────────────────────────────────────────
// 7. CONVENIENCE FUNCTION
// ──────────────────────────────────────────────────────────────

/**
 * Execute a search plan
 * @param {Object} plan - Layer 2 Search Plan
 * @returns {Promise<Object>} Discovery Result
 */
async function execute(plan) {
    const engine = new SearchingEngine();
    return await engine.execute(plan);
}

// ──────────────────────────────────────────────────────────────
// 8. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    execute,
    SearchingEngine,
    TavilyClient,
    AIExtractor,
    CandidateBuilder,
    DeduplicationEngine,
    CONFIG,
};
