// ──────────────────────────────────────────────────────────────
// SEARCHING.JS — Layer 3: Discovery & Search Execution Engine
// 
// RESPONSIBILITIES:
// - Execute Layer 2 search plan using Tavily
// - Collect raw candidates (possible companies/people)
// - Preserve discovery evidence and source provenance
// - Perform basic URL-level deduplication only
// - Return raw discovery pool to Layer 4
// - NEVER verify, score, rank, or enrich leads
// - NEVER invent missing information
// ──────────────────────────────────────────────────────────────

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// ──────────────────────────────────────────────────────────────
// 1. CONFIGURATION
// ──────────────────────────────────────────────────────────────

const CONFIG = {
    TAVILY_API_URL: 'https://api.tavily.com/search',
    MAX_RESULTS_PER_QUERY: 20,
    SEARCH_TIMEOUT_MS: 15000,
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
// 3. CANDIDATE EXTRACTOR — Simplified, "Possible" Only
// ──────────────────────────────────────────────────────────────

class CandidateExtractor {
    /**
     * Extract raw candidates from Tavily search results
     * All fields are "possible" — NOT verified
     */
    extractFromTavilyResults(results, query, branch) {
        const candidates = [];
        const rawResults = results.results || [];

        for (const item of rawResults) {
            const candidate = this.extractCandidate(item, query, branch);
            if (candidate) {
                candidates.push(candidate);
            }
        }

        return candidates;
    }

    /**
     * Extract a single raw candidate from a Tavily result
     * Everything is marked as "possible" — NOT verified
     */
    extractCandidate(item, query, branch) {
        // Skip if no useful content
        if (!item.content && !item.title) {
            return null;
        }

        const content = item.content || '';
        const title = item.title || '';
        const url = item.url || '';

        // ── Extract possible signals (not verified) ──
        const possibleCompany = this.extractPossibleCompany(title, content);
        const possiblePerson = this.extractPossiblePerson(title, content);
        const possibleRole = this.extractPossibleRole(title, content);
        const possibleIndustry = this.extractPossibleIndustry(title, content);
        const possibleLocation = this.extractPossibleLocation(title, content);

        // ── Build raw candidate ──
        return {
            candidateId: `candidate-${uuidv4().substring(0, 8)}`,
            
            // ── Possible fields (unverified) ──
            possibleCompany: possibleCompany || null,
            possiblePerson: possiblePerson || null,
            possibleRole: possibleRole || null,
            possibleIndustry: possibleIndustry || null,
            possibleLocation: possibleLocation || null,
            
            // ── Discovery provenance ──
            branch: branch.industry || 'unknown',
            query: query,
            source: {
                url: url,
                title: title,
                snippet: content.substring(0, 500),
            },
            
            // ── Raw evidence ──
            evidence: [
                {
                    type: 'discovery_source',
                    sourceUrl: url,
                    sourceTitle: title,
                    snippet: content.substring(0, 300),
                }
            ],
            
            // ── Metadata ──
            discoveredAt: new Date().toISOString(),
            rawData: item, // Preserve full raw data for later layers
        };
    }

    // ─── Simple extraction helpers (all "possible") ───

    extractPossibleCompany(title, content) {
        const combined = `${title || ''} ${content || ''}`;
        
        // Try title first
        if (title) {
            let cleaned = title
                .replace(/\s*[-|]\s*.*$/, '')
                .replace(/\s*(About|Home|Contact|Blog|Careers|Team|Company|Homepage)$/i, '')
                .trim();
            if (cleaned.length > 2 && cleaned.length < 60) {
                return cleaned;
            }
        }

        // Try content patterns
        const patterns = [
            /company\s+(?:name\s+is\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/i,
            /about\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})(?:\s+company)/i,
            /welcome to\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/i,
        ];

        for (const pattern of patterns) {
            const match = combined.match(pattern);
            if (match && match[1]) {
                return match[1].trim();
            }
        }

        return null;
    }

    extractPossiblePerson(title, content) {
        const combined = `${title || ''} ${content || ''}`;
        
        const patterns = [
            /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s+(?:is|was|said|-)/i,
            /(?:founder|ceo|cto|director|manager|president)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i,
            /by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i,
            /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:founder|ceo|cto)/i,
        ];

        for (const pattern of patterns) {
            const match = combined.match(pattern);
            if (match && match[1]) {
                const name = match[1].trim();
                if (name.length > 2 && name.length < 40) {
                    return name;
                }
            }
        }

        return null;
    }

    extractPossibleRole(title, content) {
        const combined = `${title || ''} ${content || ''}`.toLowerCase();
        const roles = ['founder', 'ceo', 'co-founder', 'cto', 'cfo', 'cmo', 'coo', 'director', 'vp', 'manager', 'president', 'executive', 'owner'];

        for (const role of roles) {
            if (combined.includes(role)) {
                return role.charAt(0).toUpperCase() + role.slice(1);
            }
        }

        return null;
    }

    extractPossibleIndustry(title, content) {
        const combined = `${title || ''} ${content || ''}`.toLowerCase();
        const industries = {
            'saas': 'SaaS',
            'fintech': 'Fintech',
            'healthcare': 'Healthcare',
            'cybersecurity': 'Cybersecurity',
            'ai': 'AI',
            'blockchain': 'Blockchain',
            'real estate': 'Real Estate',
            'edtech': 'EdTech',
            'insurtech': 'InsurTech',
            'legaltech': 'LegalTech',
            'adtech': 'AdTech',
            'cleantech': 'CleanTech',
            'agritech': 'AgriTech',
            'manufacturing': 'Manufacturing',
            'retail': 'Retail',
            'e-commerce': 'E-commerce',
        };

        for (const [key, value] of Object.entries(industries)) {
            if (combined.includes(key)) {
                return value;
            }
        }

        return null;
    }

    extractPossibleLocation(title, content) {
        const combined = `${title || ''} ${content || ''}`.toLowerCase();
        const locations = {
            'london': 'London',
            'uk': 'United Kingdom',
            'united kingdom': 'United Kingdom',
            'nigeria': 'Nigeria',
            'germany': 'Germany',
            'usa': 'United States',
            'united states': 'United States',
            'canada': 'Canada',
            'france': 'France',
            'spain': 'Spain',
            'italy': 'Italy',
            'netherlands': 'Netherlands',
            'sweden': 'Sweden',
            'norway': 'Norway',
            'denmark': 'Denmark',
            'finland': 'Finland',
            'ireland': 'Ireland',
            'south africa': 'South Africa',
            'brazil': 'Brazil',
            'australia': 'Australia',
            'india': 'India',
            'singapore': 'Singapore',
        };

        for (const [key, value] of Object.entries(locations)) {
            if (combined.includes(key)) {
                return value;
            }
        }

        return null;
    }
}

// ──────────────────────────────────────────────────────────────
// 4. DEDUPLICATION ENGINE — URL/Result Level Only
// ──────────────────────────────────────────────────────────────

class DeduplicationEngine {
    /**
     * Remove only obvious duplicates (same URL or same result)
     * Sophisticated identity resolution belongs to Layer 4
     */
    deduplicate(candidates) {
        const seenUrls = new Set();
        const uniqueCandidates = [];

        for (const candidate of candidates) {
            const url = candidate.source?.url;
            
            // Skip if we've seen this URL before
            if (url) {
                if (seenUrls.has(url)) {
                    continue;
                }
                seenUrls.add(url);
            }
            
            uniqueCandidates.push(candidate);
        }

        const duplicatesRemoved = candidates.length - uniqueCandidates.length;

        console.log(`[DEDUPE] Removed ${duplicatesRemoved} duplicate URLs`);

        return {
            uniqueCandidates: uniqueCandidates,
            duplicatesRemoved: duplicatesRemoved,
        };
    }
}

// ──────────────────────────────────────────────────────────────
// 5. MAIN SEARCHING ENGINE
// ──────────────────────────────────────────────────────────────

class SearchingEngine {
    constructor() {
        this.tavilyClient = new TavilyClient();
        this.candidateExtractor = new CandidateExtractor();
        this.deduplicationEngine = new DeduplicationEngine();
    }

    /**
     * Execute the search plan
     * @param {Object} plan - Layer 2 Search Plan
     * @returns {Object} Discovery Result
     */
    async execute(plan) {
        console.log('[DISCOVERY] Starting discovery execution...');

        // ── Step 1: Validate input ──
        if (!plan || plan.status === 'invalid') {
            return this.buildErrorResult('INVALID_SEARCH_PLAN', 'Invalid search plan');
        }

        if (plan.status === 'needs_clarification') {
            return this.buildErrorResult('PLAN_NEEDS_CLARIFICATION', 'Cannot execute search until plan is clarified');
        }

        // ── Step 2: Check Tavily API key ──
        if (!this.tavilyClient.isConfigured()) {
            console.error('[DISCOVERY] Tavily API key missing');
            return this.buildErrorResult('TAVILY_API_KEY_MISSING', 'Tavily API key is not configured');
        }

        // ── Step 3: Prepare search context ──
        const requestId = plan.requestId || `search-${uuidv4().substring(0, 8)}`;
        const searchBranches = plan.searchBranches || [];
        const requestedQuantity = plan.quantity?.requested || 0;

        console.log(`[DISCOVERY] Request ID: ${requestId}`);
        console.log(`[DISCOVERY] Branches: ${searchBranches.length}`);
        console.log(`[DISCOVERY] Provider: Tavily`);
        console.log(`[DISCOVERY] Requested quantity: ${requestedQuantity}`);

        // ── Step 4: Execute searches ──
        const allCandidates = [];
        const searchSummary = {
            branchesPlanned: searchBranches.length,
            branchesExecuted: 0,
            queriesExecuted: 0,
            resultsCollected: 0,
            candidatesDiscovered: 0,
        };

        const errors = [];

        for (const branch of searchBranches) {
            const branchResults = await this.executeBranch(branch, plan, errors);
            searchSummary.branchesExecuted++;
            searchSummary.queriesExecuted += branchResults.queriesExecuted || 0;
            searchSummary.resultsCollected += branchResults.resultsCollected || 0;
            
            if (branchResults.candidates) {
                allCandidates.push(...branchResults.candidates);
            }
        }

        searchSummary.candidatesDiscovered = allCandidates.length;

        console.log(`[DISCOVERY] Branches executed: ${searchSummary.branchesExecuted}`);
        console.log(`[DISCOVERY] Queries executed: ${searchSummary.queriesExecuted}`);
        console.log(`[DISCOVERY] Results collected: ${searchSummary.resultsCollected}`);
        console.log(`[DISCOVERY] Candidates discovered: ${searchSummary.candidatesDiscovered}`);

        // ── Step 5: Deduplicate at URL level only ──
        const dedupResult = this.deduplicationEngine.deduplicate(allCandidates);

        console.log(`[DISCOVERY] Deduplicated: ${dedupResult.duplicatesRemoved} removed`);
        console.log(`[DISCOVERY] ${dedupResult.uniqueCandidates.length} candidates for Layer 4`);

        // ── Step 6: Determine status ──
        let status = 'ready';
        if (dedupResult.uniqueCandidates.length === 0) {
            status = 'no_results';
        }
        if (errors.length > 0 && dedupResult.uniqueCandidates.length === 0) {
            status = 'error';
        }
        if (errors.length > 0 && dedupResult.uniqueCandidates.length > 0) {
            status = 'partial';
        }

        // ── Step 7: Build result ──
        return {
            discoveryVersion: '1.0.0',
            requestId: requestId,
            status: status,
            provider: {
                name: 'tavily',
                configured: this.tavilyClient.isConfigured(),
            },
            searchSummary: searchSummary,
            candidates: dedupResult.uniqueCandidates,
            errors: errors,
            createdBy: 'Searching.js',
            createdAt: new Date().toISOString(),
        };
    }

    /**
     * Execute a single search branch
     */
    async executeBranch(branch, plan, errors) {
        const results = {
            candidates: [],
            queriesExecuted: 0,
            resultsCollected: 0,
        };

        const hypotheses = branch.hypotheses || [];
        const industry = branch.industry || 'unknown';

        console.log(`[DISCOVERY] Executing branch: ${industry}`);

        for (const query of hypotheses) {
            try {
                console.log(`[DISCOVERY] Query: ${query}`);
                
                const tavilyResult = await this.tavilyClient.search(query);
                results.queriesExecuted++;
                results.resultsCollected += tavilyResult.results?.length || 0;

                // Extract raw candidates from this search
                const candidates = this.candidateExtractor.extractFromTavilyResults(
                    tavilyResult,
                    query,
                    branch
                );

                if (candidates && candidates.length > 0) {
                    results.candidates.push(...candidates);
                    console.log(`[DISCOVERY] Results received: ${tavilyResult.results?.length || 0}`);
                    console.log(`[DISCOVERY] Candidates discovered: ${candidates.length}`);
                }

            } catch (error) {
                console.error(`[DISCOVERY] Query "${query}" failed:`, error.message);
                errors.push({
                    query: query,
                    branch: industry,
                    error: error.message,
                });
                // Continue with other queries - don't stop on one failure
            }
        }

        return results;
    }

    /**
     * Build error result
     */
    buildErrorResult(errorCode, message) {
        return {
            discoveryVersion: '1.0.0',
            requestId: `error-${uuidv4().substring(0, 8)}`,
            status: 'error',
            provider: {
                name: 'tavily',
                configured: this.tavilyClient.isConfigured(),
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
// 6. CONVENIENCE FUNCTION
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
// 7. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    execute,
    SearchingEngine,
    TavilyClient,
    CandidateExtractor,
    DeduplicationEngine,
    CONFIG,
};
