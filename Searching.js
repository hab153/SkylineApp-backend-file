// ──────────────────────────────────────────────────────────────
// SEARCHING.JS — Layer 3: Discovery & Search Execution Engine
// 
// RESPONSIBILITIES:
// - Execute search plan using Tavily
// - Extract candidates from search results
// - Preserve evidence for each discovery
// - Remove obvious duplicates
// - Return structured discovery results
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
    DEDUPLICATION_KEYS: ['normalized_domain', 'company_name'],
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
// 3. CANDIDATE EXTRACTOR
// ──────────────────────────────────────────────────────────────

class CandidateExtractor {
    /**
     * Extract candidates from Tavily search results
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
     * Extract a single candidate from a Tavily result
     */
    extractCandidate(item, query, branch) {
        // Skip if no useful content
        if (!item.content && !item.title) {
            return null;
        }

        const content = item.content || '';
        const title = item.title || '';
        const url = item.url || '';
        const domain = this.extractDomain(url);

        // ── Extract company name ──
        let companyName = this.extractCompanyName(title, content, domain);
        if (!companyName) {
            companyName = domain || 'Unknown Company';
        }

        // ── Extract person name ──
        const personName = this.extractPersonName(title, content);

        // ── Extract role ──
        const role = this.extractRole(title, content);

        // ── Extract industry ──
        const industry = this.extractIndustry(title, content);

        // ── Extract location ──
        const location = this.extractLocation(title, content);

        // ── Extract email ──
        const email = this.extractEmail(content);

        // ── Extract LinkedIn URL ──
        const linkedinUrl = this.extractLinkedIn(content);

        // ── Build candidate ──
        return {
            candidateId: `candidate-${uuidv4().substring(0, 8)}`,
            company: {
                name: companyName,
                domain: domain,
                industry: industry || null,
                location: {
                    city: location?.city || null,
                    region: location?.region || null,
                    country: location?.country || null,
                    countryCode: location?.countryCode || null,
                },
                employeeCount: null,
                revenue: null,
                funding: null,
            },
            contact: {
                name: personName || null,
                role: role || null,
                email: email || null,
                phone: null,
                linkedinUrl: linkedinUrl || null,
            },
            discovery: {
                branch: branch.industry || 'unknown',
                query: query,
                sourceUrl: url,
                sourceTitle: title,
                sourceSnippet: content.substring(0, 500),
                discoveredAt: new Date().toISOString(),
            },
            evidence: [
                {
                    type: 'company_identity',
                    sourceUrl: url,
                    sourceTitle: title,
                    snippet: content.substring(0, 300),
                }
            ],
            rawData: item,
            confidence: 0.5, // Base confidence, will be updated by Layer 4
        };
    }

    // ─── Helper extraction methods ───

    extractDomain(url) {
        if (!url) return null;
        try {
            const parsed = new URL(url);
            let domain = parsed.hostname;
            if (domain.startsWith('www.')) {
                domain = domain.substring(4);
            }
            return domain;
        } catch {
            return null;
        }
    }

    extractCompanyName(title, content, domain) {
        // Try to find company name in title
        if (title) {
            // Remove common suffixes
            let cleaned = title
                .replace(/\s*[-|]\s*.*$/, '') // Remove after separator
                .replace(/\s*(About|Home|Contact|Blog|Careers|Team|Company|Homepage)$/i, '')
                .trim();
            
            if (cleaned.length > 2 && cleaned.length < 60) {
                return cleaned;
            }
        }

        // Try to find in content
        if (content) {
            // Look for "Company Name is" or "About Company Name"
            const patterns = [
                /company\s+(?:name\s+is\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/i,
                /about\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})(?:\s+company)/i,
                /welcome to\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/i,
                /(?:^|\s)([A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,3})(?:\s+is\s+a\s+)/i,
            ];

            for (const pattern of patterns) {
                const match = content.match(pattern);
                if (match && match[1]) {
                    return match[1].trim();
                }
            }
        }

        // Fallback to domain
        if (domain) {
            return domain
                .split('.')[0]
                .replace(/^www\./, '')
                .replace(/[-_]/g, ' ')
                .split(' ')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ');
        }

        return null;
    }

    extractPersonName(title, content) {
        const combined = `${title || ''} ${content || ''}`;
        
        // Look for "Name is" or "by Name" or "Name - Title"
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

    extractRole(title, content) {
        const combined = `${title || ''} ${content || ''}`.toLowerCase();
        const roles = ['founder', 'ceo', 'co-founder', 'cto', 'cfo', 'cmo', 'coo', 'director', 'vp', 'manager', 'president', 'executive', 'owner'];

        for (const role of roles) {
            if (combined.includes(role)) {
                return role.charAt(0).toUpperCase() + role.slice(1);
            }
        }

        return null;
    }

    extractIndustry(title, content) {
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

    extractLocation(title, content) {
        const combined = `${title || ''} ${content || ''}`;
        const countries = {
            'nigeria': 'Nigeria',
            'nigeria': 'Nigeria',
            'london': 'London',
            'uk': 'United Kingdom',
            'united kingdom': 'United Kingdom',
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
            'mexico': 'Mexico',
            'australia': 'Australia',
            'india': 'India',
            'china': 'China',
            'japan': 'Japan',
            'singapore': 'Singapore',
        };

        const lower = combined.toLowerCase();
        for (const [key, value] of Object.entries(countries)) {
            if (lower.includes(key)) {
                const isCity = ['london', 'berlin', 'paris', 'madrid', 'rome', 'amsterdam'].includes(key);
                return {
                    city: isCity ? value : null,
                    country: isCity ? null : value,
                };
            }
        }

        return null;
    }

    extractEmail(content) {
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
        const match = content.match(emailRegex);
        return match ? match[0] : null;
    }

    extractLinkedIn(content) {
        const linkedinRegex = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9-]+/;
        const match = content.match(linkedinRegex);
        return match ? match[0] : null;
    }
}

// ──────────────────────────────────────────────────────────────
// 4. DEDUPLICATION ENGINE
// ──────────────────────────────────────────────────────────────

class DeduplicationEngine {
    /**
     * Remove obvious duplicates from candidates
     */
    deduplicate(candidates) {
        const uniqueMap = new Map();
        const duplicates = [];

        for (const candidate of candidates) {
            const domain = candidate.company?.domain;
            const name = candidate.company?.name?.toLowerCase().trim();

            let key = null;

            // Prefer domain as primary key
            if (domain) {
                key = domain;
            } else if (name) {
                // Normalize company name
                const normalized = this.normalizeCompanyName(name);
                key = normalized;
            }

            if (!key) {
                // No key found, keep as unique
                uniqueMap.set(candidate.candidateId, candidate);
                continue;
            }

            if (uniqueMap.has(key)) {
                // Duplicate found
                duplicates.push({
                    originalId: uniqueMap.get(key).candidateId,
                    duplicateId: candidate.candidateId,
                    key: key,
                });
                // Merge evidence
                const existing = uniqueMap.get(key);
                if (candidate.evidence && candidate.evidence.length > 0) {
                    existing.evidence = [...existing.evidence, ...candidate.evidence];
                }
                // Keep the better contact info
                if (candidate.contact?.name && !existing.contact?.name) {
                    existing.contact.name = candidate.contact.name;
                }
                if (candidate.contact?.email && !existing.contact?.email) {
                    existing.contact.email = candidate.contact.email;
                }
                if (candidate.contact?.role && !existing.contact?.role) {
                    existing.contact.role = candidate.contact.role;
                }
            } else {
                uniqueMap.set(key, candidate);
            }
        }

        return {
            uniqueCandidates: Array.from(uniqueMap.values()),
            duplicates: duplicates,
            totalDuplicates: duplicates.length,
        };
    }

    normalizeCompanyName(name) {
        if (!name) return '';
        return name
            .toLowerCase()
            .replace(/(ltd|limited|inc|llc|corp|corporation|gmbh|plc|co|company)\s*$/i, '')
            .replace(/[^a-zA-Z0-9]/g, '')
            .trim();
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
        console.log('[SEARCHING] Starting discovery execution...');

        // ── Step 1: Validate input ──
        if (!plan || plan.status === 'invalid') {
            return this.buildErrorResult('INVALID_SEARCH_PLAN', 'Invalid search plan');
        }

        if (plan.status === 'needs_clarification') {
            return this.buildErrorResult('PLAN_NEEDS_CLARIFICATION', 'Cannot execute search until plan is clarified');
        }

        // ── Step 2: Check Tavily API key ──
        if (!this.tavilyClient.isConfigured()) {
            console.error('[SEARCHING] Tavily API key missing');
            return this.buildErrorResult('TAVILY_API_KEY_MISSING', 'Tavily API key is not configured');
        }

        // ── Step 3: Prepare search context ──
        const requestId = plan.requestId || `search-${uuidv4().substring(0, 8)}`;
        const searchBranches = plan.searchBranches || [];
        const quantity = plan.quantity?.requested || 0;

        console.log(`[SEARCHING] Executing ${searchBranches.length} search branches for request ${requestId}`);

        // ── Step 4: Execute searches ──
        const allCandidates = [];
        const searchStats = {
            branchesExecuted: 0,
            queriesExecuted: 0,
            rawResultsFound: 0,
            candidatesExtracted: 0,
            duplicatesDetected: 0,
            duplicatesRemoved: 0,
            candidatesForVerification: 0,
        };

        for (const branch of searchBranches) {
            const branchResults = await this.executeBranch(branch, plan);
            searchStats.branchesExecuted++;
            searchStats.queriesExecuted += branchResults.queriesExecuted || 0;
            searchStats.rawResultsFound += branchResults.rawResultsFound || 0;
            
            if (branchResults.candidates) {
                allCandidates.push(...branchResults.candidates);
            }
        }

        searchStats.candidatesExtracted = allCandidates.length;

        // ── Step 5: Deduplicate ──
        const dedupResult = this.deduplicationEngine.deduplicate(allCandidates);
        searchStats.duplicatesDetected = dedupResult.totalDuplicates;
        searchStats.duplicatesRemoved = dedupResult.totalDuplicates;
        searchStats.candidatesForVerification = dedupResult.uniqueCandidates.length;

        console.log(`[SEARCHING] Deduplicated: ${dedupResult.totalDuplicates} duplicates removed`);
        console.log(`[SEARCHING] ${searchStats.candidatesForVerification} candidates for verification`);

        // ── Step 6: Build result ──
        return {
            discoveryVersion: '1.0.0',
            requestId: requestId,
            status: 'completed',
            searchProvider: {
                name: 'tavily',
                configured: this.tavilyClient.isConfigured(),
            },
            searchStatistics: searchStats,
            candidates: dedupResult.uniqueCandidates,
            createdBy: 'Searching.js',
            createdAt: new Date().toISOString(),
        };
    }

    /**
     * Execute a single search branch
     */
    async executeBranch(branch, plan) {
        const results = {
            candidates: [],
            queriesExecuted: 0,
            rawResultsFound: 0,
        };

        const hypotheses = branch.hypotheses || [];
        const industry = branch.industry || 'unknown';

        console.log(`[SEARCHING] Executing branch: ${industry} (${hypotheses.length} hypotheses)`);

        for (const query of hypotheses) {
            try {
                const tavilyResult = await this.tavilyClient.search(query);
                results.queriesExecuted++;
                results.rawResultsFound += tavilyResult.results?.length || 0;

                // Extract candidates from this search
                const candidates = this.candidateExtractor.extractFromTavilyResults(
                    tavilyResult,
                    query,
                    branch
                );

                if (candidates && candidates.length > 0) {
                    results.candidates.push(...candidates);
                }

                console.log(`[SEARCHING] Query "${query}" → ${candidates?.length || 0} candidates`);

            } catch (error) {
                console.error(`[SEARCHING] Query "${query}" failed:`, error.message);
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
            status: 'failed',
            error: {
                code: errorCode,
                message: message,
            },
            searchProvider: {
                name: 'tavily',
                configured: this.tavilyClient.isConfigured(),
            },
            candidates: [],
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
