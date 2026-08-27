// ──────────────────────────────────────────────────────────────
// SEARCHING.JS — Layer 3: Discovery Engine v3.0.0
// 
// RESPONSIBILITIES:
// - Execute Layer 2 search plan using Tavily
// - Use GPT-4o-mini to extract legitimate candidates
// - Reject garbage (article titles, lists, fragments)
// - Enforce role matching (CEO ≠ CMO)
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
    AI_BATCH_SIZE: 5,
};

// ──────────────────────────────────────────────────────────────
// 2. ROLE MATCHING CONFIGURATION
// ──────────────────────────────────────────────────────────────

const ROLE_MATCHING = {
    // Exact matches (accepted)
    exact: {
        'ceo': 'CEO',
        'chief executive officer': 'CEO',
        'founder & ceo': 'CEO',
        'co-founder & ceo': 'CEO',
        'founder and ceo': 'CEO',
        'co-founder and ceo': 'CEO',
    },
    // Partial matches (accepted with caution)
    partial: {
        'founder': 'Founder',
        'co-founder': 'Co-Founder',
        'owner': 'Owner',
        'president': 'President',
    },
    // Role aliases (accepted for specific requested roles)
    aliases: {
        'ceo': ['ceo', 'chief executive officer', 'founder & ceo', 'co-founder & ceo', 'founder and ceo', 'co-founder and ceo'],
        'founder': ['founder', 'co-founder', 'founder & ceo', 'co-founder & ceo'],
        'cto': ['cto', 'chief technology officer', 'chief technical officer'],
        'cfo': ['cfo', 'chief financial officer'],
        'cmo': ['cmo', 'chief marketing officer'],
        'coo': ['coo', 'chief operating officer'],
    },
    // Rejected roles (never accepted)
    rejected: ['cmo', 'cto', 'cfo', 'coo', 'employee', 'intern', 'associate', 'analyst', 'coordinator', 'assistant'],
};

// ──────────────────────────────────────────────────────────────
// 3. TAVILY CLIENT
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
// 4. ROLE MATCHING ENGINE
// ──────────────────────────────────────────────────────────────

class RoleMatcher {
    /**
     * Check if a discovered role matches the requested role
     * @param {string} requestedRole - The role requested by the user
     * @param {string} discoveredRole - The role discovered from search
     * @returns {Object} { match: boolean, confidence: number, normalizedRole: string }
     */
    matchRole(requestedRole, discoveredRole) {
        if (!requestedRole || !discoveredRole) {
            return { match: false, confidence: 0, normalizedRole: null };
        }

        const req = requestedRole.toLowerCase().trim();
        const dis = discoveredRole.toLowerCase().trim();

        // ── Check exact match ──
        if (ROLE_MATCHING.exact[dis] && ROLE_MATCHING.exact[dis].toLowerCase() === req) {
            return { match: true, confidence: 1.0, normalizedRole: ROLE_MATCHING.exact[dis] };
        }

        // ── Check if discovered role is in the requested role's aliases ──
        if (ROLE_MATCHING.aliases[req]) {
            for (const alias of ROLE_MATCHING.aliases[req]) {
                if (dis.includes(alias) || alias.includes(dis)) {
                    return { match: true, confidence: 0.9, normalizedRole: requestedRole };
                }
            }
        }

        // ── Check partial matches (founder for CEO, etc.) ──
        if (req === 'ceo' && ROLE_MATCHING.partial['founder'] && dis.includes('founder')) {
            return { match: true, confidence: 0.7, normalizedRole: 'Founder' };
        }

        // ── Check rejected roles ──
        for (const rejected of ROLE_MATCHING.rejected) {
            if (dis.includes(rejected)) {
                return { match: false, confidence: 0, normalizedRole: null };
            }
        }

        // ── No match found ──
        return { match: false, confidence: 0, normalizedRole: null };
    }

    /**
     * Normalize a role to standard format
     */
    normalizeRole(role) {
        if (!role) return null;
        const lower = role.toLowerCase().trim();
        if (ROLE_MATCHING.exact[lower]) return ROLE_MATCHING.exact[lower];
        if (ROLE_MATCHING.partial[lower]) return ROLE_MATCHING.partial[lower];
        return role;
    }
}

// ──────────────────────────────────────────────────────────────
// 5. AI EXTRACTOR
// ──────────────────────────────────────────────────────────────

class AIExtractor {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
        this.model = CONFIG.AI_MODEL;
        this.temperature = CONFIG.AI_TEMPERATURE;
        this.maxTokens = CONFIG.AI_MAX_TOKENS;
        this.roleMatcher = new RoleMatcher();
    }

    isConfigured() {
        return !!process.env.OPENAI_API_KEY;
    }

    async extractCandidates(tavilyResults, query, branch, requestedRole) {
        if (!this.isConfigured()) {
            console.warn('[AI] OpenAI API key missing. Using fallback extraction.');
            return this.fallbackExtraction(tavilyResults, query, branch, requestedRole);
        }

        try {
            const prompt = this.buildExtractionPrompt(tavilyResults, query, branch, requestedRole);
            
            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    {
                        role: 'system',
                        content: `You are Skyline AA-1 Layer 3 Discovery Assistant.

Your job is to extract real candidate companies and people from web search results.

CRITICAL RULES — NEVER BREAK:
1. NEVER invent information.
2. NEVER treat an article title as a company.
3. NEVER treat a category, industry, list, ranking, sentence fragment, or search phrase as a company or person.
4. Only extract an entity when the source provides evidence that the entity actually exists.
5. If information is missing, return null.
6. Do not perform final verification.
7. Return JSON only.

ROLE MATCHING RULE:
- The requested role is: "${requestedRole || 'Any'}"
- Only extract candidates where the discovered role matches the requested role.
- If no role is specified, extract any relevant role.
- Return null if the role doesn't match.

Output format:
{
  "candidates": [
    {
      "companyName": "ExampleSoft" or null,
      "companyDomain": "examplesoft.com" or null,
      "companyIndustry": "SaaS" or null,
      "companyLocation": "London" or null,
      "personName": "John Smith" or null,
      "personRole": "CEO" or null,
      "email": null,
      "linkedinUrl": null,
      "evidenceSnippet": "Text that proves this extraction",
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
            
            // ── Post-process with role matching ──
            const candidates = parsed.candidates || [];
            const filtered = this.filterByRole(candidates, requestedRole);
            
            console.log(`[AI] Extracted ${candidates.length} candidates, ${filtered.length} after role filtering`);
            return filtered;

        } catch (error) {
            console.error('[AI] Extraction failed:', error.message);
            return this.fallbackExtraction(tavilyResults, query, branch, requestedRole);
        }
    }

    filterByRole(candidates, requestedRole) {
        if (!requestedRole) return candidates;
        
        const matcher = new RoleMatcher();
        const filtered = [];

        for (const candidate of candidates) {
            const role = candidate.personRole || candidate.role || null;
            if (!role) {
                // No role found, but keep if we have company and person
                if (candidate.companyName && candidate.personName) {
                    filtered.push(candidate);
                }
                continue;
            }

            const result = matcher.matchRole(requestedRole, role);
            if (result.match) {
                // Update role to normalized version
                candidate.personRole = result.normalizedRole || role;
                candidate.confidence = (candidate.confidence || 0.5) * result.confidence;
                filtered.push(candidate);
            }
        }

        return filtered;
    }

    buildExtractionPrompt(tavilyResults, query, branch, requestedRole) {
        const results = tavilyResults.results || [];
        const industry = branch.industry || 'unknown';

        let resultsText = '';
        for (let i = 0; i < Math.min(results.length, CONFIG.AI_BATCH_SIZE); i++) {
            const item = results[i];
            resultsText += `
Result ${i + 1}:
Title: ${item.title || 'No title'}
URL: ${item.url || 'No URL'}
Content: ${(item.content || '').substring(0, 600)}
---`;
        }

        return `Analyze search results for: "${query}"
Target industry: ${industry}
Requested role: ${requestedRole || 'Any'}

${resultsText}

Return JSON only. Extract real companies/people with evidence. Never invent.`;
    }

    fallbackExtraction(tavilyResults, query, branch, requestedRole) {
        console.log('[AI] Using fallback deterministic extraction');
        const candidates = [];
        const results = tavilyResults.results || [];
        const matcher = new RoleMatcher();

        for (const item of results) {
            const content = item.content || '';
            const title = item.title || '';
            
            const companyMatch = content.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\s+(?:is|was|are|has|provides|offers)/i);
            const personMatch = content.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s+(?:is|was|said|founded|founded by)/i);
            let roleMatch = content.match(/(?:founder|ceo|cto|director|manager|president)\s+([A-Z][a-z]+)/i);
            
            if (roleMatch) {
                roleMatch = roleMatch[1];
            } else {
                // Try to find role directly
                const roleRegex = /\b(founder|ceo|cto|cfo|cmo|coo|director|vp|president|owner)\b/i;
                const roleFound = content.match(roleRegex);
                if (roleFound) {
                    roleMatch = roleFound[1];
                }
            }

            if (companyMatch || personMatch) {
                const discoveredRole = roleMatch || null;
                let matched = true;
                let normalizedRole = discoveredRole;

                if (requestedRole && discoveredRole) {
                    const matchResult = matcher.matchRole(requestedRole, discoveredRole);
                    if (!matchResult.match) {
                        matched = false;
                    } else {
                        normalizedRole = matchResult.normalizedRole || discoveredRole;
                    }
                }

                if (matched) {
                    candidates.push({
                        companyName: companyMatch ? companyMatch[1] : null,
                        companyDomain: null,
                        companyIndustry: branch.industry || null,
                        companyLocation: null,
                        personName: personMatch ? personMatch[1] : null,
                        personRole: normalizedRole || null,
                        email: null,
                        linkedinUrl: null,
                        evidenceSnippet: content.substring(0, 200),
                        confidence: 0.5,
                    });
                }
            }
        }

        return candidates;
    }
}

// ──────────────────────────────────────────────────────────────
// 6. CANDIDATE BUILDER
// ──────────────────────────────────────────────────────────────

class CandidateBuilder {
    buildCandidates(aiCandidates, query, branch, sourceUrl, sourceTitle, sourceSnippet) {
        const candidates = [];

        for (const ai of aiCandidates) {
            // Must have company AND person for contact targets
            if (!ai.companyName || !ai.personName) {
                continue;
            }

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
                    sourceSnippet: ai.evidenceSnippet || (sourceSnippet || '').substring(0, 300),
                    discoveredAt: new Date().toISOString(),
                },
                evidence: this.buildEvidence(ai, sourceUrl, sourceTitle),
                discoveryConfidence: ai.confidence || 0.5,
            };

            candidates.push(candidate);
        }

        return candidates;
    }

    buildEvidence(ai, sourceUrl, sourceTitle) {
        const evidence = [];

        if (ai.companyName) {
            evidence.push({
                type: 'company_identity',
                sourceUrl: sourceUrl || null,
                sourceTitle: sourceTitle || null,
                snippet: ai.evidenceSnippet || '',
            });
        }
        if (ai.personName) {
            evidence.push({
                type: 'person_identity',
                sourceUrl: sourceUrl || null,
                sourceTitle: sourceTitle || null,
                snippet: ai.evidenceSnippet || '',
            });
        }
        if (ai.personRole) {
            evidence.push({
                type: 'role',
                sourceUrl: sourceUrl || null,
                sourceTitle: sourceTitle || null,
                snippet: ai.personRole,
            });
        }
        if (ai.companyIndustry) {
            evidence.push({
                type: 'industry',
                sourceUrl: sourceUrl || null,
                sourceTitle: sourceTitle || null,
                snippet: ai.companyIndustry,
            });
        }
        if (ai.companyLocation) {
            evidence.push({
                type: 'location',
                sourceUrl: sourceUrl || null,
                sourceTitle: sourceTitle || null,
                snippet: ai.companyLocation,
            });
        }

        return evidence;
    }

    isGarbageCompanyName(name) {
        if (!name) return true;
        const garbage = ['top', 'best', 'list', 'rank', 'guide', 'how to', 'what is', 'the best', 'companies', 'industry', 'sector', 'market', 'trend', 'analysis', 'report', 'article', 'blog', 'news', 'update', 'directory', 'category', 'page', 'search', 'result'];
        const lower = name.toLowerCase();
        for (const word of garbage) {
            if (lower.includes(word)) return true;
        }
        return false;
    }

    parseLocation(locationStr) {
        if (!locationStr) return { city: null, region: null, country: null, countryCode: null };

        const lower = locationStr.toLowerCase();
        const location = { city: null, region: null, country: null, countryCode: null };

        const cities = ['london', 'berlin', 'paris', 'madrid', 'rome', 'amsterdam', 'lagos', 'abuja', 'new york', 'san francisco', 'los angeles', 'chicago', 'toronto', 'vancouver', 'sydney', 'melbourne'];
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

        for (const city of cities) {
            if (lower.includes(city)) {
                location.city = city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                break;
            }
        }

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
// 7. DEDUPLICATION ENGINE
// ──────────────────────────────────────────────────────────────

class DeduplicationEngine {
    deduplicate(candidates) {
        const seen = new Map();
        const unique = [];

        for (const candidate of candidates) {
            const domain = candidate.company?.domain;
            const name = candidate.company?.name;
            const personName = candidate.contact?.name;

            let key = null;
            if (domain) {
                key = domain.toLowerCase();
            } else if (name && personName) {
                key = `${name.toLowerCase().replace(/[^a-zA-Z0-9]/g, '')}_${personName.toLowerCase().replace(/[^a-zA-Z0-9]/g, '')}`;
            } else if (name) {
                key = name.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');
            }

            if (key) {
                if (seen.has(key)) {
                    const existing = seen.get(key);
                    // Merge evidence
                    if (candidate.evidence && candidate.evidence.length > 0) {
                        existing.evidence = [...existing.evidence, ...candidate.evidence];
                    }
                    if (candidate.contact?.email && !existing.contact?.email) {
                        existing.contact.email = candidate.contact.email;
                    }
                    if (candidate.contact?.linkedinUrl && !existing.contact?.linkedinUrl) {
                        existing.contact.linkedinUrl = candidate.contact.linkedinUrl;
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
}

// ──────────────────────────────────────────────────────────────
// 8. MAIN SEARCHING ENGINE
// ──────────────────────────────────────────────────────────────

class SearchingEngine {
    constructor() {
        this.tavilyClient = new TavilyClient();
        this.aiExtractor = new AIExtractor();
        this.candidateBuilder = new CandidateBuilder();
        this.deduplicationEngine = new DeduplicationEngine();
    }

    async execute(plan) {
        console.log('[DISCOVERY] Starting Layer 3 discovery...');

        try {
            // ── Validate input ──
            if (!plan || plan.status === 'invalid' || plan.status === 'needs_clarification') {
                return this.buildErrorResult('INVALID_PLAN', 'Invalid or unclear search plan', plan);
            }

            // ── Check Tavily API key ──
            if (!this.tavilyClient.isConfigured()) {
                console.error('[DISCOVERY] Tavily API key missing');
                return this.buildErrorResult('TAVILY_API_KEY_MISSING', 'Tavily API key is not configured', plan);
            }

            // ── Prepare context ──
            const requestId = plan.requestId || `search-${uuidv4().substring(0, 8)}`;
            const searchBranches = plan.searchBranches || [];
            const requestedRole = plan.objective?.role || null;
            const targetType = plan.objective?.targetType || 'contact';

            console.log(`[DISCOVERY] Request: ${requestId}`);
            console.log(`[DISCOVERY] Branches: ${searchBranches.length}`);
            console.log(`[DISCOVERY] Provider: Tavily`);
            console.log(`[DISCOVERY] Requested Role: ${requestedRole || 'Any'}`);
            console.log(`[DISCOVERY] Target Type: ${targetType}`);

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
                const branchResults = await this.executeBranch(branch, requestedRole, errors, searchSummary);
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
            if (dedupResult.uniqueCandidates.length === 0 && errors.length === 0) {
                status = 'no_results';
            } else if (dedupResult.uniqueCandidates.length === 0 && errors.length > 0) {
                status = 'failed';
            } else if (dedupResult.uniqueCandidates.length > 0 && errors.length > 0) {
                status = 'partial';
            }

            // ── Build result ──
            return {
                discoveryVersion: '3.0.0',
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

        } catch (error) {
            console.error('[DISCOVERY] Fatal error:', error.message);
            return this.buildErrorResult('FATAL_ERROR', error.message, plan);
        }
    }

    async executeBranch(branch, requestedRole, errors, searchSummary) {
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

                const tavilyResult = await this.tavilyClient.search(query);
                results.queriesExecuted++;
                results.rawResultsFound += tavilyResult.results?.length || 0;

                const rawResults = tavilyResult.results || [];

                // ── Extract with AI ──
                let aiCandidates = [];
                try {
                    aiCandidates = await this.aiExtractor.extractCandidates(
                        tavilyResult,
                        query,
                        branch,
                        requestedRole
                    );
                } catch (aiError) {
                    console.error('[DISCOVERY] AI extraction error:', aiError.message);
                }

                results.aiResultsAnalyzed += rawResults.length;

                // ── Build candidates ──
                for (const item of rawResults) {
                    const builtCandidates = this.candidateBuilder.buildCandidates(
                        aiCandidates,
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

                console.log(`[DISCOVERY] Results: ${rawResults.length}, Candidates: ${results.candidates.length}`);

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

    buildErrorResult(errorCode, message, plan) {
        return {
            discoveryVersion: '3.0.0',
            requestId: plan?.requestId || `error-${uuidv4().substring(0, 8)}`,
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
// 9. CONVENIENCE FUNCTION
// ──────────────────────────────────────────────────────────────

async function execute(plan) {
    try {
        const engine = new SearchingEngine();
        return await engine.execute(plan);
    } catch (error) {
        console.error('[SEARCHING] Fatal execute error:', error.message);
        return {
            discoveryVersion: '3.0.0',
            requestId: `error-${uuidv4().substring(0, 8)}`,
            status: 'failed',
            error: { code: 'EXECUTE_ERROR', message: error.message },
            candidates: [],
            createdBy: 'Searching.js',
            createdAt: new Date().toISOString(),
        };
    }
}

// ──────────────────────────────────────────────────────────────
// 10. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    execute,
    SearchingEngine,
    TavilyClient,
    AIExtractor,
    CandidateBuilder,
    DeduplicationEngine,
    RoleMatcher,
    CONFIG,
    ROLE_MATCHING,
};
