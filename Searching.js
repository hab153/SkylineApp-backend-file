// ──────────────────────────────────────────────────────────────
// SEARCHING.JS — Layer 3: Discovery Engine v5.0.0
//
// RESPONSIBILITIES:
// - Execute up to 5 Tavily searches intelligently allocated
// - Extract ALL useful candidates from each search result
// - Preserve evidence for every extracted candidate
// - Remove obvious duplicates only
// - NEVER reject candidates due to missing information
// - Pass raw candidates to Layer 4 for verification
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
    MAX_TAVILY_SEARCHES: 5,
    QUERY_SIMILARITY_THRESHOLD: 0.7,
    MAX_SOURCE_CONTENT_CHARS: 2000,
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
            throw new Error('TAVILY_NOT_CONFIGURED');
        }

        const maxResults = options.maxResults || CONFIG.MAX_RESULTS_PER_QUERY;

        try {
            const response = await axios.post(
                this.apiUrl,
                {
                    query,
                    search_depth: 'advanced',
                    max_results: maxResults,
                    include_answer: false,
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
// 3. QUERY SELECTOR — Maximum 5 diverse searches
// ──────────────────────────────────────────────────────────────

class QuerySelector {
    constructor(maxSearches = CONFIG.MAX_TAVILY_SEARCHES) {
        this.maxSearches = maxSearches;
        this.stopwords = new Set(['the', 'a', 'an', 'in', 'of', 'and', 'or', 'for', 'with', 'to', 'on', 'at', 'by', 'is', 'are']);
    }

    select(searchBranches) {
        const branches = (Array.isArray(searchBranches) ? searchBranches : [])
            .map((b, i) => ({
                industry: b.industry || `branch-${i}`,
                hypotheses: Array.isArray(b.hypotheses) ? [...b.hypotheses] : [],
                priority: typeof b.priority === 'number' ? b.priority : i + 1,
                _cursor: 0,
            }))
            .filter((b) => b.hypotheses.length > 0)
            .sort((a, b) => a.priority - b.priority);

        if (branches.length === 0) return [];

        const selected = [];
        const selectedWordSets = [];

        let madeProgressThisPass = true;
        while (selected.length < this.maxSearches && madeProgressThisPass) {
            madeProgressThisPass = false;

            for (const branch of branches) {
                if (selected.length >= this.maxSearches) break;

                const picked = this.pickNextNonDuplicate(branch, selectedWordSets);
                if (picked) {
                    selected.push({ query: picked.query, branchIndustry: branch.industry });
                    selectedWordSets.push(picked.wordSet);
                    madeProgressThisPass = true;
                }
            }
        }

        return selected;
    }

    pickNextNonDuplicate(branch, selectedWordSets) {
        while (branch._cursor < branch.hypotheses.length) {
            const query = branch.hypotheses[branch._cursor++];
            const wordSet = this.normalize(query);
            const isDuplicate = selectedWordSets.some(
                (existing) => this.jaccard(existing, wordSet) > CONFIG.QUERY_SIMILARITY_THRESHOLD
            );
            if (!isDuplicate) {
                return { query, wordSet };
            }
        }
        return null;
    }

    normalize(query) {
        const words = (query || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter((w) => w && !this.stopwords.has(w));
        return new Set(words);
    }

    jaccard(setA, setB) {
        if (setA.size === 0 && setB.size === 0) return 1;
        let intersection = 0;
        for (const w of setA) {
            if (setB.has(w)) intersection++;
        }
        const union = new Set([...setA, ...setB]).size;
        return union === 0 ? 0 : intersection / union;
    }
}

// ──────────────────────────────────────────────────────────────
// 4. CANDIDATE EXTRACTOR — High recall, no rejection
// ──────────────────────────────────────────────────────────────

class CandidateExtractor {
    extractFromResults(rawResults, query, branch) {
        const candidates = [];

        for (const item of rawResults) {
            const content = item.content || '';
            const title = item.title || '';
            const url = item.url || '';

            if (!content && !title) continue;

            // Extract companies
            const companies = this.extractCompanies(content, title);
            // Extract persons
            const persons = this.extractPersons(content, title);
            // Extract roles
            const roles = this.extractRoles(content);
            // Extract location
            const location = this.extractLocation(content);
            // Extract industry
            const industry = this.extractIndustry(content);
            // Extract emails
            const emails = this.extractEmails(content);
            // Extract LinkedIn URLs
            const linkedinUrls = this.extractLinkedIn(content);

            // If we have companies but no persons, create company-only candidates
            if (companies.length > 0 && persons.length === 0) {
                for (const company of companies) {
                    candidates.push(this.buildCandidate({
                        companyName: company,
                        personName: null,
                        personRole: null,
                        companyLocation: location,
                        companyIndustry: industry,
                        email: null,
                        linkedinUrl: null,
                        evidenceSnippet: content.substring(0, 300),
                        sourceUrl: url,
                        sourceTitle: title,
                        query: query,
                        branch: branch.industry || 'unknown',
                    }));
                }
                continue;
            }

            // If we have persons, create person-company candidates
            for (const person of persons) {
                const associatedCompany = this.findAssociatedCompany(content, person, companies);
                
                candidates.push(this.buildCandidate({
                    companyName: associatedCompany || companies[0] || null,
                    personName: person.name || null,
                    personRole: person.role || null,
                    companyLocation: location,
                    companyIndustry: industry,
                    email: emails.length > 0 ? emails[0] : null,
                    linkedinUrl: linkedinUrls.length > 0 ? linkedinUrls[0] : null,
                    evidenceSnippet: content.substring(0, 300),
                    sourceUrl: url,
                    sourceTitle: title,
                    query: query,
                    branch: branch.industry || 'unknown',
                }));
            }
        }

        return candidates;
    }

    buildCandidate(data) {
        return {
            candidateId: `candidate-${uuidv4().substring(0, 8)}`,
            company: {
                name: data.companyName || null,
                domain: null,
                industry: data.companyIndustry || null,
                location: this.parseLocation(data.companyLocation),
                employeeCount: null,
                revenue: null,
                funding: null,
            },
            contact: {
                name: data.personName || null,
                role: data.personRole || null,
                email: data.email || null,
                phone: null,
                linkedinUrl: data.linkedinUrl || null,
            },
            discovery: {
                branch: data.branch || 'unknown',
                query: data.query || null,
                sourceUrl: data.sourceUrl || null,
                sourceTitle: data.sourceTitle || null,
                sourceSnippet: data.evidenceSnippet || null,
                discoveredAt: new Date().toISOString(),
            },
            evidence: this.buildEvidence(data),
            discoveryConfidence: 0.5,
        };
    }

    buildEvidence(data) {
        const evidence = [];
        if (data.companyName) {
            evidence.push({
                type: 'company_identity',
                sourceUrl: data.sourceUrl || null,
                sourceTitle: data.sourceTitle || null,
                snippet: data.evidenceSnippet || '',
            });
        }
        if (data.personName) {
            evidence.push({
                type: 'person_identity',
                sourceUrl: data.sourceUrl || null,
                sourceTitle: data.sourceTitle || null,
                snippet: data.evidenceSnippet || '',
            });
        }
        if (data.personRole) {
            evidence.push({
                type: 'role',
                sourceUrl: data.sourceUrl || null,
                sourceTitle: data.sourceTitle || null,
                snippet: data.personRole,
            });
        }
        if (data.companyIndustry) {
            evidence.push({
                type: 'industry',
                sourceUrl: data.sourceUrl || null,
                sourceTitle: data.sourceTitle || null,
                snippet: data.companyIndustry,
            });
        }
        if (data.companyLocation) {
            evidence.push({
                type: 'location',
                sourceUrl: data.sourceUrl || null,
                sourceTitle: data.sourceTitle || null,
                snippet: data.companyLocation,
            });
        }
        if (data.email) {
            evidence.push({
                type: 'email',
                sourceUrl: data.sourceUrl || null,
                sourceTitle: data.sourceTitle || null,
                snippet: data.email,
            });
        }
        return evidence;
    }

    parseLocation(locationStr) {
        if (!locationStr) return { city: null, region: null, country: null, countryCode: null };

        const lower = locationStr.toLowerCase();
        const location = { city: null, region: null, country: null, countryCode: null };

        const cities = ['london', 'berlin', 'paris', 'madrid', 'rome', 'amsterdam', 'lagos', 'abuja', 'new york', 'san francisco'];
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
                location.city = city.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
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

    // ─── Extraction helpers ───

    extractCompanies(content, title) {
        const combined = `${title || ''} ${content || ''}`;
        const companies = [];
        const seen = new Set();

        const patterns = [
            /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\s+(?:is|was|are|has|provides|offers|-|—)/gi,
            /(?:about|at|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/gi,
            /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\s+(?:company|inc|ltd|limited|corp|corporation)/gi,
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(combined)) !== null) {
                const name = match[1].trim();
                if (name.length > 2 && name.length < 50 && !this.isGarbage(name) && !seen.has(name)) {
                    seen.add(name);
                    companies.push(name);
                }
            }
        }

        return companies.slice(0, 10);
    }

    extractPersons(content, title) {
        const combined = `${title || ''} ${content || ''}`;
        const persons = [];
        const seen = new Set();

        const patterns = [
            /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s+(?:is|was|said|founded|leads|directs|manages)/gi,
            /(?:founder|ceo|cto|cfo|cmo|coo|director|manager|president|vp)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/gi,
            /by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/gi,
            /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:founder|ceo|cto|cfo|cmo|coo|director|manager|president|vp)/gi,
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(combined)) !== null) {
                const name = match[1].trim();
                if (name.length > 2 && name.length < 40 && !this.isGarbagePerson(name) && !seen.has(name)) {
                    seen.add(name);
                    const role = this.extractRoleForPerson(combined, name);
                    persons.push({ name, role });
                }
            }
        }

        return persons.slice(0, 10);
    }

    extractRoleForPerson(content, personName) {
        const lower = content.toLowerCase();
        const nameLower = personName.toLowerCase();
        
        const roles = ['founder', 'ceo', 'chief executive officer', 'cto', 'chief technology officer', 'cfo', 'chief financial officer', 'cmo', 'chief marketing officer', 'coo', 'chief operating officer', 'director', 'vp', 'vice president', 'manager', 'president', 'owner'];

        for (const role of roles) {
            if (lower.includes(role)) {
                const nameIndex = lower.indexOf(nameLower);
                const roleIndex = lower.indexOf(role);
                if (nameIndex >= 0 && roleIndex >= 0 && Math.abs(nameIndex - roleIndex) < 100) {
                    return role.charAt(0).toUpperCase() + role.slice(1);
                }
            }
        }

        return null;
    }

    extractRoles(content) {
        const roles = [];
        const lower = content.toLowerCase();
        const roleMap = {
            'founder': 'Founder',
            'ceo': 'CEO',
            'chief executive officer': 'CEO',
            'cto': 'CTO',
            'chief technology officer': 'CTO',
            'cfo': 'CFO',
            'chief financial officer': 'CFO',
            'cmo': 'CMO',
            'chief marketing officer': 'CMO',
            'coo': 'COO',
            'chief operating officer': 'COO',
            'director': 'Director',
            'vp': 'VP',
            'vice president': 'VP',
            'manager': 'Manager',
            'president': 'President',
            'owner': 'Owner',
        };

        for (const [key, value] of Object.entries(roleMap)) {
            if (lower.includes(key)) {
                roles.push(value);
            }
        }

        return roles;
    }

    extractLocation(content) {
        const lower = content.toLowerCase();
        const locations = ['london', 'berlin', 'paris', 'madrid', 'rome', 'amsterdam', 'lagos', 'abuja', 'new york', 'san francisco', 'los angeles', 'chicago', 'toronto', 'vancouver', 'sydney', 'melbourne', 'nigeria', 'germany', 'uk', 'united kingdom', 'usa', 'united states', 'canada', 'france', 'spain', 'italy', 'netherlands', 'sweden', 'norway', 'denmark', 'finland', 'ireland', 'south africa', 'brazil', 'australia', 'india', 'singapore'];

        for (const loc of locations) {
            if (lower.includes(loc)) {
                return loc.charAt(0).toUpperCase() + loc.slice(1);
            }
        }

        return null;
    }

    extractIndustry(content) {
        const lower = content.toLowerCase();
        const industries = ['saas', 'fintech', 'cybersecurity', 'healthcare', 'ai', 'blockchain', 'real estate', 'edtech', 'insurtech', 'legaltech', 'adtech', 'cleantech', 'agritech', 'manufacturing', 'retail', 'e-commerce', 'logistics', 'energy', 'education', 'hr', 'marketing', 'insurance', 'legal'];

        for (const industry of industries) {
            if (lower.includes(industry)) {
                return industry.charAt(0).toUpperCase() + industry.slice(1);
            }
        }

        return null;
    }

    extractEmails(content) {
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const matches = content.match(emailRegex);
        return matches || [];
    }

    extractLinkedIn(content) {
        const linkedinRegex = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9-]+/g;
        const matches = content.match(linkedinRegex);
        return matches || [];
    }

    findAssociatedCompany(content, person, companies) {
        if (!person || !companies || companies.length === 0) return null;
        
        const lower = content.toLowerCase();
        const personLower = person.name.toLowerCase();

        let bestCompany = null;
        let bestDistance = Infinity;

        for (const company of companies) {
            const companyLower = company.toLowerCase();
            const personIndex = lower.indexOf(personLower);
            const companyIndex = lower.indexOf(companyLower);
            
            if (personIndex >= 0 && companyIndex >= 0) {
                const distance = Math.abs(personIndex - companyIndex);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestCompany = company;
                }
            }
        }

        return bestCompany || companies[0];
    }

    isGarbage(text) {
        const garbage = ['top', 'best', 'list', 'rank', 'guide', 'how to', 'what is', 'the best', 'companies', 'industry', 'sector', 'market', 'trend', 'analysis', 'report', 'article', 'blog', 'news', 'update', 'directory', 'category', 'page', 'search', 'result', 'and is', 'consulting', 'services', 'the', 'and', 'is', 'by', 'for', 'with', 'from', 'at', 'garage', 'started', 'which', 'that', 'this', 'those', 'these'];
        const lower = text.toLowerCase().trim();
        if (lower.length < 2) return true;
        for (const word of garbage) {
            if (lower === word || (lower.includes(word) && lower.length < 12)) return true;
        }
        return false;
    }

    isGarbagePerson(text) {
        const garbage = ['the', 'and', 'is', 'by', 'for', 'with', 'from', 'at', 'this', 'that', 'those', 'these', 'which', 'consulting', 'services', 'companies', 'community', 'score', 'local', 'london', 'team', 'in', 'of', 'on', 'to', 'saastock', 'stock', 'seedtable', 'index', 'awards', 'summit', 'conference', 'meetup', 'network', 'jobs', 'directory', 'guide', 'list', 'top', 'best'];
        const lower = text.toLowerCase().trim();
        if (lower.length < 2) return true;
        const words = lower.split(/\s+/);
        if (words.length > 6) return true;
        if (words.some((w) => garbage.includes(w))) return true;
        if (/[.:;]/.test(text)) return true;
        return false;
    }
}

// ──────────────────────────────────────────────────────────────
// 5. DEDUPLICATION ENGINE — Simple, high-recall dedup
// ──────────────────────────────────────────────────────────────

class DeduplicationEngine {
    deduplicate(candidates) {
        const seen = new Map();
        const unique = [];
        let duplicatesRemoved = 0;

        for (const candidate of candidates) {
            const domain = candidate.company?.domain;
            const companyName = candidate.company?.name;
            const personName = candidate.contact?.name;

            let key = null;
            if (domain) {
                key = domain.toLowerCase();
            } else if (companyName && personName) {
                const compKey = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
                const persKey = personName.toLowerCase().replace(/[^a-z0-9]/g, '');
                key = `${compKey}_${persKey}`;
            } else if (companyName) {
                key = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
            }

            if (key) {
                if (seen.has(key)) {
                    const existing = seen.get(key);
                    if (candidate.evidence && candidate.evidence.length > 0) {
                        existing.evidence = [...existing.evidence, ...candidate.evidence];
                    }
                    duplicatesRemoved++;
                    continue;
                }
                seen.set(key, candidate);
            }
            unique.push(candidate);
        }

        return { uniqueCandidates: unique, duplicatesRemoved };
    }
}

// ──────────────────────────────────────────────────────────────
// 6. MAIN SEARCHING ENGINE
// ──────────────────────────────────────────────────────────────

class SearchingEngine {
    constructor() {
        this.tavilyClient = new TavilyClient();
        this.querySelector = new QuerySelector();
        this.candidateExtractor = new CandidateExtractor();
        this.deduplicationEngine = new DeduplicationEngine();
    }

    async execute(plan) {
        // ── Startup validation ──
        if (!this.tavilyClient.isConfigured()) {
            return this.configErrorResult('TAVILY_NOT_CONFIGURED', plan);
        }
        if (!plan || plan.status === 'invalid' || plan.status === 'needs_clarification') {
            return this.configErrorResult('INVALID_PLAN', plan);
        }

        const requestId = plan.requestId || `search-${uuidv4().substring(0, 8)}`;
        const searchBranches = plan.searchBranches || [];

        console.log(`[DISCOVERY] Starting discovery for request ${requestId}`);
        console.log(`[DISCOVERY] Branches: ${searchBranches.length}`);
        console.log(`[DISCOVERY] Max searches: ${CONFIG.MAX_TAVILY_SEARCHES}`);

        // ── 1. Intelligent query selection ──
        const selectedQueries = this.querySelector.select(searchBranches);
        console.log(`[DISCOVERY] Selected ${selectedQueries.length} diverse queries`);

        // ── 2. Execute Tavily searches concurrently ──
        const allCandidates = [];
        const errors = [];
        const searchSummary = {
            maxSearchesAllowed: CONFIG.MAX_TAVILY_SEARCHES,
            searchesExecuted: 0,
            rawResultsFound: 0,
            candidatesExtracted: 0,
            duplicatesRemoved: 0,
            candidatesForNextLayer: 0,
        };

        const searchResults = await this.runSearches(selectedQueries, errors);
        searchSummary.searchesExecuted = searchResults.filter((r) => r && r.ok).length;

        // ── 3. Extract candidates from all results ──
        for (const searchResult of searchResults) {
            if (!searchResult || !searchResult.ok) continue;

            const rawResults = searchResult.results || [];
            searchSummary.rawResultsFound += rawResults.length;

            const candidates = this.candidateExtractor.extractFromResults(
                rawResults,
                searchResult.query,
                { industry: searchResult.branchIndustry }
            );

            if (candidates.length > 0) {
                allCandidates.push(...candidates);
                searchSummary.candidatesExtracted += candidates.length;
                console.log(`[DISCOVERY] Query "${searchResult.query}" → ${candidates.length} candidates`);
            }
        }

        console.log(`[DISCOVERY] Total candidates extracted: ${searchSummary.candidatesExtracted}`);

        // ── 4. Deduplicate ──
        const dedupResult = this.deduplicationEngine.deduplicate(allCandidates);
        searchSummary.duplicatesRemoved = dedupResult.duplicatesRemoved;
        searchSummary.candidatesForNextLayer = dedupResult.uniqueCandidates.length;

        console.log(`[DISCOVERY] Duplicates removed: ${dedupResult.duplicatesRemoved}`);
        console.log(`[DISCOVERY] Candidates for Layer 4: ${dedupResult.uniqueCandidates.length}`);

        // ── 5. Determine status ──
        let status = 'completed';
        if (searchSummary.searchesExecuted === 0) {
            status = 'failed';
        } else if (dedupResult.uniqueCandidates.length === 0) {
            status = 'no_results';
        }

        // ── 6. Build result ──
        return {
            discoveryVersion: '5.0.0',
            requestId: requestId,
            status: status,
            searchProvider: {
                name: 'tavily',
                configured: this.tavilyClient.isConfigured(),
            },
            searchStatistics: searchSummary,
            candidates: dedupResult.uniqueCandidates,
            errors: errors,
            createdBy: 'Searching.js',
            createdAt: new Date().toISOString(),
        };
    }

    async runSearches(selectedQueries, errors) {
        const cappedQueries = selectedQueries.slice(0, CONFIG.MAX_TAVILY_SEARCHES);

        const searchPromises = cappedQueries.map(async (sq) => {
            try {
                const tavilyResult = await this.tavilyClient.search(sq.query);
                return {
                    query: sq.query,
                    branchIndustry: sq.branchIndustry,
                    results: tavilyResult.results || [],
                    ok: true,
                };
            } catch (error) {
                errors.push({
                    stage: 'tavily_search',
                    query: sq.query,
                    branch: sq.branchIndustry,
                    message: error.message,
                });
                return { query: sq.query, branchIndustry: sq.branchIndustry, results: [], ok: false };
            }
        });

        return Promise.all(searchPromises);
    }

    configErrorResult(code, plan) {
        return {
            discoveryVersion: '5.0.0',
            requestId: plan?.requestId || `error-${uuidv4().substring(0, 8)}`,
            status: 'failed',
            searchProvider: {
                name: 'tavily',
                configured: this.tavilyClient.isConfigured(),
            },
            error: { code },
            candidates: [],
            errors: [{ error: code }],
            createdBy: 'Searching.js',
            createdAt: new Date().toISOString(),
        };
    }
}

// ──────────────────────────────────────────────────────────────
// 7. CONVENIENCE ENTRY POINT
// ──────────────────────────────────────────────────────────────

async function execute(plan) {
    const engine = new SearchingEngine();
    try {
        return await engine.execute(plan);
    } catch (error) {
        console.error('[SEARCHING] Fatal error:', error.message);
        return {
            discoveryVersion: '5.0.0',
            requestId: `error-${uuidv4().substring(0, 8)}`,
            status: 'failed',
            error: { code: 'FATAL_ERROR', message: error.message },
            candidates: [],
            errors: [{ error: error.message }],
            createdBy: 'Searching.js',
            createdAt: new Date().toISOString(),
        };
    }
}

// ──────────────────────────────────────────────────────────────
// 8. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    execute,
    SearchingEngine,
    QuerySelector,
    TavilyClient,
    CandidateExtractor,
    DeduplicationEngine,
    CONFIG,
};
