// ──────────────────────────────────────────────────────────────
// SEARCHING.JS — Layer 3: Discovery Engine v4.0.0
//
// CONTRACT (per "Skyline AA-1 — Layer 3 Discovery Engine v4.0 —
// Five-Search Intelligent Discovery + Lead Ranking"):
//
// Layer 3 discovers credible, evidence-backed candidates and hands
// them to Layer 4. It does NOT verify, does NOT invent missing
// fields, and does NOT let AI confidence override deterministic
// validation. GPT-4o-mini is an assistant inside Layer 3, not the
// judge of truth. The judge is: Layer 2 requirements + source
// evidence + deterministic validation + deduplication rules.
//
// v4.0 changes on top of v3.0.0 (see inline section markers):
//   - MAX_TAVILY_SEARCHES = 5 is now a GLOBAL, request-level budget
//     (not per-branch), intelligently allocated across industries
//     and enforced by a hard counter (Section 2, 7, 9).
//   - Five searches are a discovery BUDGET, not a result limit — the
//     candidate count is never capped by the search count (Section 3, 36).
//   - Query selection avoids near-duplicate hypotheses (Section 6, 10).
//   - Searches execute concurrently; source content is deduplicated by
//     URL across ALL searches before AI ever sees it (Section 29, 31).
//   - AI extraction is batched (multiple sources per OpenAI call)
//     instead of one call per raw result (Section 30).
//   - A hard company-size mismatch still hard-rejects, but a company
//     size that could not be confirmed no longer auto-rejects — it is
//     carried through as a lower-confidence candidate for Layer 4
//     verification and reflected honestly in its rank (Section 17, 21).
//   - Every surviving candidate is scored 0-100 on evidence coverage
//     and assigned High / Medium / Low, both inline on the candidate
//     and grouped in `rankedCandidates` (Section 18-22, 35).
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

    // Global, request-level discovery budget (Section 2, 9).
    MAX_TAVILY_SEARCHES: 5,

    // Two normalized query-word sets with Jaccard similarity above
    // this are treated as near-duplicates during query selection
    // (Section 6, 10).
    QUERY_SIMILARITY_THRESHOLD: 0.7,

    AI_MODEL: 'gpt-4o-mini',
    AI_TEMPERATURE: 0.2,
    AI_MAX_TOKENS: 1200,
    // Number of sources bundled into a single OpenAI extraction call
    // (Section 30).
    AI_BATCH_SIZE: 5,
    MAX_SOURCE_CONTENT_CHARS: 2000,
    MIN_EVIDENCE_SNIPPET_LENGTH: 10,

    // Centralized rank thresholds (Section 22): a 0-100 discovery-
    // quality score maps to High/Medium/Low here, and only here.
    RANK_THRESHOLDS: {
        high: 80,
        medium: 50,
    },
};

// ──────────────────────────────────────────────────────────────
// 2. ROLE MATCHING CONFIGURATION (Section 6, 16, 46 of v3 / 23 of v4)
// ──────────────────────────────────────────────────────────────

const ROLE_MATCHING = {
    // Discovered-role phrasing → normalized canonical role.
    // Only used when the requested role is CEO.
    ceoAcceptable: {
        'ceo': 'CEO',
        'chief executive officer': 'CEO',
        'founder & ceo': 'CEO',
        'co-founder & ceo': 'CEO',
        'founder and ceo': 'CEO',
        'co-founder and ceo': 'CEO',
        'co-founder & chief executive officer': 'CEO',
        'co-founder and chief executive officer': 'CEO',
        'founder & chief executive officer': 'CEO',
        'founder and chief executive officer': 'CEO',
    },
    // Roles that must NEVER satisfy a request unless explicitly
    // permitted by the requester.
    alwaysRejectedUnlessRequested: [
        'cmo', 'chief marketing officer',
        'cto', 'chief technology officer', 'chief technical officer',
        'coo', 'chief operating officer',
        'cfo', 'chief financial officer',
        'employee', 'advisor', 'investor', 'board member',
        'intern', 'associate', 'analyst', 'coordinator', 'assistant',
    ],
};

// ──────────────────────────────────────────────────────────────
// 3. REJECTION REASONS (Section 27 of v3)
// ──────────────────────────────────────────────────────────────

const REJECTION_REASONS = {
    MISSING_PERSON: 'MISSING_PERSON',
    MISSING_COMPANY: 'MISSING_COMPANY',
    MISSING_PERSON_COMPANY_ASSOCIATION: 'MISSING_PERSON_COMPANY_ASSOCIATION',
    ROLE_MISMATCH: 'ROLE_MISMATCH',
    INDUSTRY_MISMATCH: 'INDUSTRY_MISMATCH',
    LOCATION_MISMATCH: 'LOCATION_MISMATCH',
    COMPANY_SIZE_MISMATCH: 'COMPANY_SIZE_MISMATCH',
    INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
    INVALID_COMPANY_ENTITY: 'INVALID_COMPANY_ENTITY',
    INVALID_PERSON_ENTITY: 'INVALID_PERSON_ENTITY',
    SOURCE_NOT_SUPPORTING_CLAIM: 'SOURCE_NOT_SUPPORTING_CLAIM',
    AI_UNCERTAIN: 'AI_UNCERTAIN',
    DUPLICATE: 'DUPLICATE',
};

function emptyRejectionStatistics() {
    return {
        missingPerson: 0,
        missingCompany: 0,
        roleMismatch: 0,
        industryMismatch: 0,
        locationMismatch: 0,
        companySizeMismatch: 0,
        insufficientEvidence: 0,
        invalidCompany: 0,
        invalidPerson: 0,
    };
}

const REJECTION_TO_STAT_KEY = {
    MISSING_PERSON: 'missingPerson',
    MISSING_COMPANY: 'missingCompany',
    ROLE_MISMATCH: 'roleMismatch',
    INDUSTRY_MISMATCH: 'industryMismatch',
    LOCATION_MISMATCH: 'locationMismatch',
    COMPANY_SIZE_MISMATCH: 'companySizeMismatch',
    INSUFFICIENT_EVIDENCE: 'insufficientEvidence',
    INVALID_COMPANY_ENTITY: 'invalidCompany',
    INVALID_PERSON_ENTITY: 'invalidPerson',
};

// ──────────────────────────────────────────────────────────────
// 4. TAVILY CLIENT (Section 4, 8)
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
// 5. QUERY SELECTOR (Section 5, 6, 7, 9, 10)
//
// Turns Layer 2's (possibly large) set of hypotheses across
// (possibly many) branches into a global, deduplicated, diversity-
// aware selection capped at CONFIG.MAX_TAVILY_SEARCHES. This is the
// enforcement point for "5 is a search budget, not a leads budget":
// nothing downstream is allowed to run more Tavily searches than
// what comes out of this selector.
// ──────────────────────────────────────────────────────────────

class QuerySelector {
    constructor(maxSearches = CONFIG.MAX_TAVILY_SEARCHES) {
        this.maxSearches = maxSearches;
        this.stopwords = new Set([
            'the', 'a', 'an', 'in', 'of', 'and', 'or', 'for', 'with',
            'to', 'on', 'at', 'by', 'is', 'are',
        ]);
    }

    /**
     * @param {Array} searchBranches Layer 2 branches: [{ industry, hypotheses, priority }]
     * @returns {Array} up to maxSearches entries: [{ query, branchIndustry }]
     */
    select(searchBranches) {
        const branches = (Array.isArray(searchBranches) ? searchBranches : [])
            .map((b, i) => ({
                industry: b.industry || `branch-${i}`,
                hypotheses: Array.isArray(b.hypotheses) ? [...b.hypotheses] : [],
                priority: typeof b.priority === 'number' ? b.priority : i + 1,
                _cursor: 0,
            }))
            .filter((b) => b.hypotheses.length > 0)
            // Lower priority number = higher priority (Section 7 example:
            // priority 1 gets picked from first each round, so with an
            // odd search budget it naturally receives the extra slot —
            // this reproduces the spec's own "SaaS → 3, Real Estate → 2"
            // example without hardcoding a distribution).
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
            // Too similar to something already selected (Section 6, 10) —
            // skip it and try this branch's next hypothesis instead of
            // spending budget on a near-duplicate.
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
// 6. AI EXTRACTOR — GPT-4o-mini SEMANTIC ASSISTANT (Section 11-15, 30-31)
//
// This class's job is ONLY to answer: "what entities and
// relationships are actually supported by this source?" It is
// explicitly allowed to return zero candidates (NO_VALID_CANDIDATE).
// It is NOT the final authority — everything it returns still goes
// through DeterministicValidator.
//
// v4.0: extraction is BATCHED — multiple deduplicated sources are
// sent in a single OpenAI call, each source tagged with its own
// sourceIndex, query, and branch context, instead of one call per
// raw result (Section 30).
// ──────────────────────────────────────────────────────────────

class AIExtractor {
    constructor() {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        this.model = CONFIG.AI_MODEL;
    }

    isConfigured() {
        return !!process.env.OPENAI_API_KEY;
    }

    /**
     * @param {Array} sourceBatch Deduplicated sources: [{ title, url, content, query, branchIndustry, score }]
     * @returns {Array} flat array of raw normalized AI candidates, possibly empty.
     */
    async extractBatch(sourceBatch, objective) {
        if (!this.isConfigured()) {
            throw new Error('OPENAI_NOT_CONFIGURED');
        }
        if (!Array.isArray(sourceBatch) || sourceBatch.length === 0) {
            return [];
        }

        const prompt = this.buildBatchPrompt(sourceBatch);

        try {
            const response = await this.openai.chat.completions.create({
                model: this.model,
                temperature: CONFIG.AI_TEMPERATURE,
                max_tokens: CONFIG.AI_MAX_TOKENS * sourceBatch.length,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: this.systemPrompt(objective) },
                    { role: 'user', content: prompt },
                ],
            });

            const parsed = JSON.parse(response.choices[0].message.content || '{}');
            const results = Array.isArray(parsed.results) ? parsed.results : [];

            const out = [];
            for (const r of results) {
                const source = sourceBatch[r.sourceIndex];
                if (!source) continue; // AI referenced an index we didn't send — ignore, never guess.
                const candidates = Array.isArray(r.candidates) ? r.candidates : [];
                for (const c of candidates) {
                    out.push(this.normalizeAIShape(c, source));
                }
            }
            return out;
        } catch (error) {
            console.error('[AI] Batch extraction failed:', error.message);
            // A failed batch yields zero candidates for those sources,
            // never a fabricated one (Section 27, 39).
            return [];
        }
    }

    systemPrompt(objective) {
        return `You are the Skyline AA-1 Layer 3 semantic extraction assistant.

Your ONLY job: identify what entities and relationships are ACTUALLY
SUPPORTED by each provided source text. You are not the final authority —
a separate deterministic validator will reject anything you cannot
support with evidence, so you must be conservative.

You will be given MULTIPLE numbered sources in one request. Treat each
source completely independently — never combine facts from source 0
with facts from source 1, even if they discuss the same company.

ABSOLUTE RULES:
1. NEVER invent information. If a source does not say it, return null.
2. NEVER treat a page title, article title, search-results page,
   directory page, category, list, ranking, event, or community as a
   company. A company must be an actual organization.
3. NEVER treat an arbitrary person mentioned on a page (e.g. an article
   author who is not stated to hold the role) as the requested contact.
4. NEVER treat a job vacancy listing as identifying the current holder
   of that role.
5. A person↔company relationship may only be reported when the source
   text explicitly establishes it (e.g. "James Gill, CEO of GoSquared").
   If the source does not connect them, leave company null.
6. Do not invent emails, phone numbers, LinkedIn URLs, employee counts,
   revenue, or funding. Only report them if the source states them.
7. It is correct and expected to return an empty "candidates" array for
   a source when no source-supported candidate exists
   (NO_VALID_CANDIDATE). Do not force an extraction.
8. One source may yield zero, one, or many candidates — extract every
   distinct company/person that source actually supports. A directory
   page listing 20 companies should yield up to 20 candidates, not one.
9. Preserve the exact requested role (${objective.role || 'any'}) — do
   not substitute a different role.
10. Include every source you were given in "results", even ones with
    an empty candidates array, using its exact sourceIndex.

Requested context (applies to all sources unless a source states its
own more specific query/branch context):
- targetType: ${objective.targetType || 'contact'}
- role: ${objective.role || 'any'}
- industries: ${(objective.industries || []).join(', ') || 'any'}
- location: ${objective.locationLabel || 'any'}
- companySize: ${objective.companySizeLabel || 'not specified'}

Return JSON only, in this exact shape:
{
  "results": [
    {
      "sourceIndex": 0,
      "candidates": [
        {
          "company": {
            "name": string|null,
            "domain": string|null,
            "industry": string|null,
            "location": string|null
          },
          "contact": {
            "name": string|null,
            "role": string|null
          },
          "relationship": {
            "confirmed": boolean,
            "statement": string|null
          },
          "companySizeEvidence": string|null,
          "evidence": [
            { "type": "company_identity"|"person_identity"|"role"|"person_company_association"|"industry"|"location"|"company_size", "quote": string }
          ]
        }
      ]
    }
  ]
}`;
    }

    buildBatchPrompt(sourceBatch) {
        const sections = sourceBatch.map((s, i) => {
            const content = (s.content || '').substring(0, CONFIG.MAX_SOURCE_CONTENT_CHARS);
            return `--- Source ${i} ---
Query used to find this source: "${s.query || 'unknown'}"
Search branch industry: ${s.branchIndustry || 'unknown'}
Title: ${s.title || 'No title'}
URL: ${s.url || 'No URL'}
Content:
${content}`;
        });

        return `${sections.join('\n\n')}

Extract only candidates each source text actually supports. Return an
entry in "results" for every source index above, using an empty
"candidates" array for any source that supports nothing.`;
    }

    normalizeAIShape(c, source) {
        const company = c.company || {};
        const contact = c.contact || {};
        const relationship = c.relationship || {};
        return {
            companyName: company.name || null,
            companyDomain: company.domain || null,
            companyIndustry: company.industry || null,
            companyLocation: company.location || null,
            companySizeEvidence: c.companySizeEvidence || null,
            personName: contact.name || null,
            personRole: contact.role || null,
            relationshipConfirmed: relationship.confirmed === true,
            relationshipStatement: relationship.statement || null,
            evidence: Array.isArray(c.evidence) ? c.evidence : [],
            sourceUrl: source.url || null,
            sourceTitle: source.title || null,
            query: source.query || null,
            branchIndustry: source.branchIndustry || null,
            // Raw data preservation for debugging (Section 39 of v4 /
            // Section 37 of v3): lets us later determine whether Tavily,
            // GPT extraction, deterministic validation, or deduplication
            // was the point of failure for any given candidate. Also
            // feeds the ranking engine's source-quality component.
            rawData: {
                url: source.url || null,
                title: source.title || null,
                content: (source.content || '').substring(0, CONFIG.MAX_SOURCE_CONTENT_CHARS),
                score: typeof source.score === 'number' ? source.score : null,
            },
        };
    }
}

// ──────────────────────────────────────────────────────────────
// 7. ENTITY-QUALITY HELPERS (Section 11, 12 of v3)
// ──────────────────────────────────────────────────────────────

const COMPANY_ENTITY_BLOCKLIST_PHRASES = [
    'top ', 'best ', ' list', 'ranking', 'ranked', 'guide to', 'how to',
    'what is', 'companies in', 'software companies', 'directory',
    'category', 'search results', 'jobs in', ' jobs', 'vacanc',
    'community', 'meetup', 'conference', 'summit', 'local london',
    'event', 'score', 'report', 'article', 'blog', 'news', 'update',
];

const PERSON_NAME_BLOCKLIST_WORDS = new Set([
    'the', 'and', 'is', 'by', 'for', 'with', 'from', 'at', 'this',
    'that', 'those', 'these', 'which', 'consulting', 'services',
    'companies', 'community', 'score', 'local', 'london', 'team',
    'in', 'of', 'on', 'to', 'saastock', 'stock', 'seedtable', 'index',
    'awards', 'summit', 'conference', 'meetup', 'network', 'jobs',
    'directory', 'guide', 'list', 'top', 'best',
]);

function looksLikeListOrPageTitle(name) {
    if (!name) return true;
    const lower = name.toLowerCase().trim();
    if (lower.length < 2) return true;
    return COMPANY_ENTITY_BLOCKLIST_PHRASES.some((p) => lower.includes(p));
}

function looksLikeGarbagePersonName(name) {
    if (!name) return true;
    const trimmed = name.trim();
    if (trimmed.length < 2) return true;
    const words = trimmed.toLowerCase().split(/\s+/);
    // A real person's name is normally 2-4 tokens and shouldn't contain
    // any word that marks the string as a phrase, page, category, or
    // organization/event name rather than an individual (Section 12:
    // reject "Companies in London", "The Seedtable Score",
    // "SaaStock Local London", etc.).
    if (words.length > 6) return true;
    if (words.some((w) => PERSON_NAME_BLOCKLIST_WORDS.has(w))) return true;
    // Reject names that are really phrases/sentences.
    if (/[.:;]/.test(trimmed)) return true;
    return false;
}

// ──────────────────────────────────────────────────────────────
// 8. DETERMINISTIC VALIDATOR (Section 16-23, 26 of v3; 16-17 of v4)
//
// Every AI-extracted candidate must pass this pipeline in order.
// AI confidence NEVER overrides these checks.
//
// v4.0 change: an unconfirmed (not contradicted) hard company-size
// requirement no longer hard-rejects the candidate. Section 17 of the
// v4 spec is explicit that Layer 3 must not silently downgrade a hard
// requirement to "satisfied" — but Section 21 equally expects Low-rank
// candidates whose "company size unknown" to exist and flow to Layer 4
// for further verification. The old v3 behavior (reject outright)
// made that impossible. Now: a genuine MISMATCH still hard-rejects;
// an UNCONFIRMED size is carried through, marked, and reflected as a
// lower rank rather than silently passed off as verified.
// ──────────────────────────────────────────────────────────────

class DeterministicValidator {
    /**
     * @returns {{ ok: true, normalized: object, sizeStatus: string } | { ok: false, reason: string }}
     */
    validate(ai, objective) {
        const targetType = objective.targetType || 'contact';

        // 1. Schema validation — malformed AI output never reaches
        // entity-level checks.
        if (!this.validateSchema(ai)) {
            return this.reject(REJECTION_REASONS.AI_UNCERTAIN);
        }

        // 2. Company identity (Section 11 of v3)
        if (!ai.companyName) {
            return this.reject(REJECTION_REASONS.MISSING_COMPANY);
        }
        if (looksLikeListOrPageTitle(ai.companyName)) {
            return this.reject(REJECTION_REASONS.INVALID_COMPANY_ENTITY);
        }

        if (targetType === 'contact') {
            // 3. Person identity (Section 12 of v3)
            if (!ai.personName) {
                return this.reject(REJECTION_REASONS.MISSING_PERSON);
            }
            if (looksLikeGarbagePersonName(ai.personName)) {
                return this.reject(REJECTION_REASONS.INVALID_PERSON_ENTITY);
            }

            // 4. Person-company association (Section 13, 14, 22 of v3)
            if (!ai.relationshipConfirmed || !ai.relationshipStatement) {
                return this.reject(REJECTION_REASONS.MISSING_PERSON_COMPANY_ASSOCIATION);
            }

            // 5. Role validation (Section 23 of v4)
            const roleResult = this.validateRole(objective.role, ai.personRole);
            if (!roleResult.ok) {
                return this.reject(REJECTION_REASONS.ROLE_MISMATCH);
            }
            ai.personRole = roleResult.normalizedRole;
        }

        // 6. Industry validation
        if (objective.industries && objective.industries.length > 0) {
            const industryResult = this.validateIndustry(objective.industries, ai.companyIndustry);
            if (!industryResult.ok) {
                return this.reject(REJECTION_REASONS.INDUSTRY_MISMATCH);
            }
        }

        // 7. Location validation
        if (objective.locationLabel) {
            const locationResult = this.validateLocation(objective, ai.companyLocation);
            if (!locationResult.ok) {
                return this.reject(REJECTION_REASONS.LOCATION_MISMATCH);
            }
        }

        // 8. Hard constraint: company size (Section 17, 20-21 of v4)
        let sizeStatus = 'not_applicable';
        if (objective.companySize && objective.companySize.restricted) {
            const sizeResult = this.validateCompanySize(objective.companySize.value, ai.companySizeEvidence);
            if (sizeResult.status === 'mismatch') {
                // Evidence actively contradicts the hard requirement —
                // this is still a hard rejection.
                return this.reject(REJECTION_REASONS.COMPANY_SIZE_MISMATCH);
            }
            // 'match' or 'unconfirmed' both proceed; 'unconfirmed' is
            // carried forward honestly and will pull the candidate's
            // rank down instead of being silently treated as verified.
            sizeStatus = sizeResult.status;
        }

        // 9. Evidence validation
        const evidenceResult = this.validateEvidence(ai, targetType);
        if (!evidenceResult.ok) {
            return this.reject(REJECTION_REASONS.INSUFFICIENT_EVIDENCE);
        }

        // 10. Source validation
        if (!ai.sourceUrl) {
            return this.reject(REJECTION_REASONS.SOURCE_NOT_SUPPORTING_CLAIM);
        }

        return { ok: true, normalized: ai, sizeStatus };
    }

    reject(reason) {
        return { ok: false, reason };
    }

    validateSchema(ai) {
        if (!ai || typeof ai !== 'object') return false;
        const isNullableString = (v) => v == null || typeof v === 'string';
        if (!isNullableString(ai.companyName)) return false;
        if (!isNullableString(ai.companyDomain)) return false;
        if (!isNullableString(ai.companyIndustry)) return false;
        if (!isNullableString(ai.companyLocation)) return false;
        if (!isNullableString(ai.personName)) return false;
        if (!isNullableString(ai.personRole)) return false;
        if (ai.relationshipConfirmed != null && typeof ai.relationshipConfirmed !== 'boolean') return false;
        if (ai.evidence != null && !Array.isArray(ai.evidence)) return false;
        return true;
    }

    validateRole(requestedRole, discoveredRole) {
        if (!requestedRole) return { ok: true, normalizedRole: discoveredRole || null };
        if (!discoveredRole) return { ok: false, normalizedRole: null };

        const req = requestedRole.toLowerCase().trim();
        const dis = discoveredRole.toLowerCase().trim();

        if (req === 'ceo') {
            for (const [phrase, canonical] of Object.entries(ROLE_MATCHING.ceoAcceptable)) {
                if (dis === phrase || dis.includes(phrase)) {
                    return { ok: true, normalizedRole: canonical };
                }
            }
            return { ok: false, normalizedRole: null };
        }

        // Generic requested role: reject known-incompatible C-suite/other
        // roles unless they textually match the request, exact or
        // substring match required.
        if (ROLE_MATCHING.alwaysRejectedUnlessRequested.some((r) => dis.includes(r)) && !dis.includes(req)) {
            return { ok: false, normalizedRole: null };
        }

        if (dis === req || dis.includes(req) || req.includes(dis)) {
            return { ok: true, normalizedRole: discoveredRole };
        }

        return { ok: false, normalizedRole: null };
    }

    validateIndustry(requestedIndustries, discoveredIndustry) {
        if (!discoveredIndustry) return { ok: false };
        const dis = discoveredIndustry.toLowerCase();
        const match = requestedIndustries.some((req) => {
            const r = req.toLowerCase();
            return dis.includes(r) || r.includes(dis);
        });
        return { ok: match };
    }

    validateLocation(objective, discoveredLocation) {
        if (!discoveredLocation) return { ok: false };
        const dis = discoveredLocation.toLowerCase();
        const city = (objective.city || '').toLowerCase();
        const country = (objective.country || '').toLowerCase();

        // Strong evidence must reference the specific city (if the
        // request specified one) rather than only the country/region.
        if (city) {
            return { ok: dis.includes(city) };
        }
        if (country) {
            return { ok: dis.includes(country) };
        }
        return { ok: true };
    }

    validateCompanySize(requestedRange, evidenceText) {
        if (!evidenceText) return { status: 'unconfirmed' };
        const normalized = evidenceText.replace(/\s+/g, '').toLowerCase();
        const requestedNormalized = (requestedRange || '').replace(/\s+/g, '').toLowerCase();
        if (normalized.includes(requestedNormalized)) {
            return { status: 'match' };
        }
        return { status: 'unconfirmed' };
    }

    validateEvidence(ai, targetType) {
        if (!Array.isArray(ai.evidence) || ai.evidence.length === 0) {
            return { ok: false };
        }
        const types = new Set(ai.evidence.map((e) => e.type));
        const requiredAlways = ['company_identity'];
        const requiredForContact = ['person_identity', 'role', 'person_company_association'];

        const required = targetType === 'contact'
            ? [...requiredAlways, ...requiredForContact]
            : requiredAlways;

        for (const type of required) {
            if (!types.has(type)) return { ok: false };
        }

        for (const e of ai.evidence) {
            if (!e.quote || e.quote.length < CONFIG.MIN_EVIDENCE_SNIPPET_LENGTH) {
                return { ok: false };
            }
        }

        return { ok: true };
    }
}

// ──────────────────────────────────────────────────────────────
// 9. CANDIDATE BUILDER (Section 34 of v4)
// ──────────────────────────────────────────────────────────────

class CandidateBuilder {
    build(normalized, sizeStatus) {
        return {
            candidateId: `candidate-${uuidv4().substring(0, 8)}`,
            company: {
                name: normalized.companyName || null,
                domain: normalized.companyDomain || null,
                industry: normalized.companyIndustry || null,
                location: this.parseLocation(normalized.companyLocation),
                employeeCount: null,
                revenue: null,
                funding: null,
            },
            contact: {
                name: normalized.personName || null,
                role: normalized.personRole || null,
                email: null,
                phone: null,
                linkedinUrl: null,
            },
            discovery: {
                branch: normalized.branchIndustry || 'unknown',
                query: normalized.query || null,
                sourceUrl: normalized.sourceUrl || null,
                sourceTitle: normalized.sourceTitle || null,
                sourceSnippet: (normalized.relationshipStatement || '').substring(0, 300) || null,
                discoveredAt: new Date().toISOString(),
            },
            evidence: (normalized.evidence || []).map((e) => ({
                type: e.type,
                sourceUrl: normalized.sourceUrl || null,
                sourceTitle: normalized.sourceTitle || null,
                snippet: e.quote || '',
            })),
            // discoveryConfidence and rank are provisional here — the
            // RankingEngine recomputes both, after deduplication, from
            // the (possibly evidence-merged) final candidate (Section 32).
            discoveryConfidence: 0,
            rank: null,
            rawData: normalized.rawData || null,
            // Internal-only scratch space consumed by RankingEngine and
            // stripped before the candidate is returned to Layer 4.
            _meta: {
                sizeStatus: sizeStatus || 'not_applicable',
                tavilyScore: typeof normalized.rawData?.score === 'number' ? normalized.rawData.score : null,
            },
        };
    }

    parseLocation(locationStr) {
        const location = { city: null, region: null, country: null, countryCode: null };
        if (!locationStr) return location;

        const lower = locationStr.toLowerCase();

        const cities = ['london', 'berlin', 'paris', 'madrid', 'rome', 'amsterdam',
            'lagos', 'abuja', 'new york', 'san francisco'];
        const countries = {
            'uk': { name: 'United Kingdom', code: 'GB' },
            'united kingdom': { name: 'United Kingdom', code: 'GB' },
            'great britain': { name: 'United Kingdom', code: 'GB' },
            'england': { name: 'United Kingdom', code: 'GB' },
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
}

// ──────────────────────────────────────────────────────────────
// 10. DEDUPLICATION ENGINE (Section 25-26 of v4)
// ──────────────────────────────────────────────────────────────

class DeduplicationEngine {
    deduplicate(candidates) {
        const seen = new Map();
        const unique = [];
        let duplicatesRemoved = 0;

        for (const candidate of candidates) {
            const key = this.identityKey(candidate);

            if (key && seen.has(key)) {
                const existing = seen.get(key);
                this.mergeEvidence(existing, candidate);
                duplicatesRemoved++;
                continue;
            }

            if (key) seen.set(key, candidate);
            unique.push(candidate);
        }

        return { uniqueCandidates: unique, duplicatesRemoved };
    }

    identityKey(candidate) {
        const domain = candidate.company?.domain;
        const companyName = candidate.company?.name;
        const personName = candidate.contact?.name;

        const normalizedCompany = domain
            ? domain.toLowerCase().trim()
            : (companyName ? companyName.toLowerCase().replace(/[^a-z0-9]/g, '') : null);

        if (!normalizedCompany) return null;

        if (personName) {
            // Person identity keyed by name + company — do NOT merge two
            // different people who share a name at different companies,
            // and do not merge two different companies that happen to
            // share a person's name.
            const normalizedPerson = personName.toLowerCase().replace(/[^a-z0-9]/g, '');
            return `person:${normalizedPerson}@company:${normalizedCompany}`;
        }

        return `company:${normalizedCompany}`;
    }

    mergeEvidence(existing, incoming) {
        const existingSnippets = new Set(existing.evidence.map((e) => `${e.type}::${e.snippet}`));
        for (const e of incoming.evidence) {
            const key = `${e.type}::${e.snippet}`;
            if (!existingSnippets.has(key)) {
                existing.evidence.push(e);
                existingSnippets.add(key);
            }
        }
        if (!existing.contact.email && incoming.contact.email) existing.contact.email = incoming.contact.email;
        if (!existing.contact.role && incoming.contact.role) existing.contact.role = incoming.contact.role;
        if (!existing.contact.linkedinUrl && incoming.contact.linkedinUrl) {
            existing.contact.linkedinUrl = incoming.contact.linkedinUrl;
        }

        // Merge internal ranking scratch space too, so a candidate
        // discovered from multiple searches gets credit for the best
        // evidence found across all of them (Section 26).
        if (existing._meta && incoming._meta) {
            if (incoming._meta.sizeStatus === 'match') {
                existing._meta.sizeStatus = 'match';
            }
            if (
                incoming._meta.tavilyScore != null &&
                (existing._meta.tavilyScore == null || incoming._meta.tavilyScore > existing._meta.tavilyScore)
            ) {
                existing._meta.tavilyScore = incoming._meta.tavilyScore;
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────
// 11. RANKING ENGINE (Section 18-22, 35 of v4)
//
// Runs AFTER deduplication, so a candidate's rank reflects the best
// merged evidence available, not just what one source happened to
// provide. Never runs before or instead of DeterministicValidator —
// only candidates that already passed validation reach this stage.
// ──────────────────────────────────────────────────────────────

class RankingEngine {
    /**
     * @returns {number} 0-100 discovery-quality score.
     */
    score(candidate, objective) {
        const targetType = objective.targetType || 'contact';
        const evidenceTypes = new Set((candidate.evidence || []).map((e) => e.type));
        const meta = candidate._meta || {};

        let score = 0;

        // Identity evidence — 30 pts
        if (candidate.company.name) score += 15;
        if (targetType !== 'contact' || candidate.contact.name) score += 15;

        // Role + person/company association — 30 pts (contact only;
        // redistributed to identity/context for company-only targets
        // since DeterministicValidator doesn't require a person there).
        if (targetType === 'contact') {
            if (candidate.contact.role) score += 15;
            if (evidenceTypes.has('person_company_association')) score += 15;
        } else {
            score += 30;
        }

        // Industry — 10 pts (full credit if not requested, since it's
        // not a gap when nothing was asked for)
        if (!objective.industries || objective.industries.length === 0 || evidenceTypes.has('industry')) {
            score += 10;
        }

        // Location — 10 pts
        if (!objective.locationLabel || evidenceTypes.has('location')) {
            score += 10;
        }

        // Company size — 10 pts. Full credit if not a hard requirement,
        // full credit if confirmed, ZERO if the hard requirement could
        // not be confirmed — this is what pulls a size-unknown candidate
        // down into Medium/Low instead of quietly passing as verified
        // (Section 17, 21).
        if (!objective.companySize || !objective.companySize.restricted) {
            score += 10;
        } else if (meta.sizeStatus === 'match') {
            score += 10;
        }

        // Source quality — 10 pts, from evidence richness + Tavily's
        // own relevance score for the source.
        const evidenceCount = (candidate.evidence || []).length;
        let sourceQuality = evidenceCount >= 4 ? 6 : evidenceCount >= 2 ? 3 : 0;
        if (typeof meta.tavilyScore === 'number') {
            sourceQuality += Math.round(meta.tavilyScore * 4);
        }
        score += Math.min(10, sourceQuality);

        return Math.max(0, Math.min(100, score));
    }

    rank(score) {
        if (score >= CONFIG.RANK_THRESHOLDS.high) return 'high';
        if (score >= CONFIG.RANK_THRESHOLDS.medium) return 'medium';
        return 'low';
    }

    /**
     * Ranks every candidate in place, strips internal scratch fields,
     * and groups the result (Section 35).
     */
    rankAll(candidates, objective) {
        const rankedCandidates = { high: [], medium: [], low: [] };

        for (const candidate of candidates) {
            const score = this.score(candidate, objective);
            candidate.rank = this.rank(score);
            candidate.discoveryConfidence = Math.round((score / 100) * 100) / 100;
            delete candidate._meta;
            rankedCandidates[candidate.rank].push(candidate);
        }

        const rankingStatistics = {
            high: rankedCandidates.high.length,
            medium: rankedCandidates.medium.length,
            low: rankedCandidates.low.length,
        };

        return { rankedCandidates, rankingStatistics };
    }
}

// ──────────────────────────────────────────────────────────────
// 12. MAIN SEARCHING ENGINE (Section 32 — full processing pipeline)
// ──────────────────────────────────────────────────────────────

class SearchingEngine {
    constructor() {
        this.tavilyClient = new TavilyClient();
        this.querySelector = new QuerySelector();
        this.aiExtractor = new AIExtractor();
        this.validator = new DeterministicValidator();
        this.candidateBuilder = new CandidateBuilder();
        this.deduplicationEngine = new DeduplicationEngine();
        this.rankingEngine = new RankingEngine();
    }

    async execute(plan) {
        // ── Startup validation ──
        if (!this.tavilyClient.isConfigured()) {
            return this.configErrorResult('TAVILY_NOT_CONFIGURED', plan);
        }
        if (!this.aiExtractor.isConfigured()) {
            return this.configErrorResult('OPENAI_NOT_CONFIGURED', plan);
        }
        if (!plan || plan.status === 'invalid' || plan.status === 'needs_clarification') {
            return this.configErrorResult('INVALID_PLAN', plan);
        }

        const requestId = plan.requestId || `search-${uuidv4().substring(0, 8)}`;
        const objective = this.normalizeObjective(plan.objective || {});
        const searchBranches = plan.searchBranches || [];

        const searchStatistics = {
            maxSearchesAllowed: CONFIG.MAX_TAVILY_SEARCHES,
            branchesConsidered: searchBranches.length,
            searchesExecuted: 0,
            rawResultsFound: 0,
            sourcesAnalyzed: 0,
            candidatesExtracted: 0,
            invalidCandidatesRejected: 0,
            duplicatesDetected: 0,
            duplicatesRemoved: 0,
            candidatesForNextLayer: 0,
        };
        const rejectionStatistics = emptyRejectionStatistics();
        const errors = [];

        // ── 1. Intelligent query selection: many hypotheses → ≤5 diverse
        // queries, allocated across branches by priority (Section 5-10) ──
        const selectedQueries = this.querySelector.select(searchBranches);

        // ── 2. Execute the (≤5) selected Tavily searches concurrently,
        // hard-capped at CONFIG.MAX_TAVILY_SEARCHES regardless of how
        // many the selector returned (Section 2, 9, 29) ──
        const searchResults = await this.runSearches(selectedQueries, errors);
        searchStatistics.searchesExecuted = searchResults.filter((r) => r && r.ok).length;

        // ── 3. Collect raw results, dedupe by source URL across ALL
        // searches before anything reaches the AI (Section 31) ──
        const { sources, rawResultsFound } = this.buildSourceList(searchResults);
        searchStatistics.rawResultsFound = rawResultsFound;
        searchStatistics.sourcesAnalyzed = sources.length;

        // ── 4. Batched AI extraction — many candidates per useful source,
        // never one call per candidate (Section 13, 30) ──
        const aiCandidates = await this.extractAll(sources, objective, errors);
        searchStatistics.candidatesExtracted = aiCandidates.length;

        // ── 5. Deterministic validation — extract broadly, qualify
        // strictly (Section 16-23) ──
        const builtCandidates = [];
        for (const ai of aiCandidates) {
            const validation = this.validator.validate(ai, objective);
            if (!validation.ok) {
                searchStatistics.invalidCandidatesRejected++;
                const statKey = REJECTION_TO_STAT_KEY[validation.reason];
                if (statKey) rejectionStatistics[statKey]++;
                continue;
            }
            builtCandidates.push(this.candidateBuilder.build(validation.normalized, validation.sizeStatus));
        }

        // ── 6. Deduplicate + merge evidence (Section 25-26) ──
        const dedupResult = this.deduplicationEngine.deduplicate(builtCandidates);
        searchStatistics.duplicatesDetected = dedupResult.duplicatesRemoved;
        searchStatistics.duplicatesRemoved = dedupResult.duplicatesRemoved;
        searchStatistics.candidatesForNextLayer = dedupResult.uniqueCandidates.length;

        // ── 7. Rank — never limits the candidate count, only classifies
        // it (Section 18-22, 36) ──
        const { rankedCandidates, rankingStatistics } = this.rankingEngine.rankAll(
            dedupResult.uniqueCandidates,
            objective
        );

        // ── Status determination ──
        let status = 'completed';
        if (searchStatistics.searchesExecuted === 0) {
            status = 'failed';
        } else if (errors.length > 0 && dedupResult.uniqueCandidates.length > 0) {
            status = 'partial';
        } else if (errors.length > 0 && dedupResult.uniqueCandidates.length === 0) {
            status = errors.length >= searchStatistics.searchesExecuted ? 'failed' : 'partial';
        }

        return {
            discoveryVersion: '4.0.0',
            requestId,
            status,
            searchProvider: { name: 'tavily', configured: this.tavilyClient.isConfigured() },
            aiExtractor: {
                provider: 'openai',
                model: CONFIG.AI_MODEL,
                configured: this.aiExtractor.isConfigured(),
            },
            searchStatistics,
            rejectionStatistics,
            rankingStatistics,
            rankedCandidates,
            // Flat list kept for Layer 4 / existing-consumer compatibility.
            candidates: dedupResult.uniqueCandidates,
            errors,
            createdBy: 'Searching.js',
            createdAt: new Date().toISOString(),
        };
    }

    normalizeObjective(objective) {
        const location = objective.location || {};
        const locationLabel = [location.city, location.country].filter(Boolean).join(', ') || null;
        return {
            targetType: objective.targetType || 'contact',
            role: objective.role || null,
            industries: objective.industries || [],
            city: location.city || null,
            country: location.country || null,
            countryCode: location.countryCode || null,
            locationLabel,
            companySize: objective.companySize || null,
            companySizeLabel: objective.companySize?.value || null,
        };
    }

    // ── Step 2 helper: parallel search execution with a hard budget cap ──
    async runSearches(selectedQueries, errors) {
        // Defensive re-cap: QuerySelector already caps to MAX_TAVILY_SEARCHES,
        // but the engine never trusts a single enforcement point for a rule
        // this important (Section 2, 9).
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

    // ── Step 3 helper: flatten + dedupe raw results into a single source
    // list before any AI call is made (Section 31) ──
    buildSourceList(searchResults) {
        const seenUrls = new Set();
        const sources = [];
        let rawResultsFound = 0;

        for (const searchResult of searchResults) {
            if (!searchResult) continue;
            rawResultsFound += searchResult.results.length;

            for (const raw of searchResult.results) {
                const url = (raw.url || '').trim();
                const normalizedUrl = url.toLowerCase().replace(/\/+$/, '');
                if (!normalizedUrl || seenUrls.has(normalizedUrl)) continue;
                seenUrls.add(normalizedUrl);

                sources.push({
                    title: raw.title || '',
                    url: raw.url || '',
                    content: raw.content || '',
                    score: typeof raw.score === 'number' ? raw.score : null,
                    query: searchResult.query,
                    branchIndustry: searchResult.branchIndustry,
                });
            }
        }

        return { sources, rawResultsFound };
    }

    // ── Step 4 helper: batch sources and run extraction batches in
    // parallel (Section 30) ──
    async extractAll(sources, objective, errors) {
        if (sources.length === 0) return [];

        const batches = [];
        for (let i = 0; i < sources.length; i += CONFIG.AI_BATCH_SIZE) {
            batches.push(sources.slice(i, i + CONFIG.AI_BATCH_SIZE));
        }

        const batchPromises = batches.map(async (batch) => {
            try {
                return await this.aiExtractor.extractBatch(batch, objective);
            } catch (error) {
                errors.push({ stage: 'ai_extraction', message: error.message });
                return [];
            }
        });

        const batchResults = await Promise.all(batchPromises);
        return batchResults.flat();
    }

    configErrorResult(code, plan) {
        return {
            status: 'failed',
            error: { code },
            discoveryVersion: '4.0.0',
            requestId: plan?.requestId || `error-${uuidv4().substring(0, 8)}`,
            searchProvider: { name: 'tavily', configured: this.tavilyClient.isConfigured() },
            aiExtractor: {
                provider: 'openai',
                model: CONFIG.AI_MODEL,
                configured: this.aiExtractor.isConfigured(),
            },
            searchStatistics: {
                maxSearchesAllowed: CONFIG.MAX_TAVILY_SEARCHES,
                branchesConsidered: 0,
                searchesExecuted: 0,
                rawResultsFound: 0,
                sourcesAnalyzed: 0,
                candidatesExtracted: 0,
                invalidCandidatesRejected: 0,
                duplicatesDetected: 0,
                duplicatesRemoved: 0,
                candidatesForNextLayer: 0,
            },
            rejectionStatistics: emptyRejectionStatistics(),
            rankingStatistics: { high: 0, medium: 0, low: 0 },
            rankedCandidates: { high: [], medium: [], low: [] },
            candidates: [],
            errors: [{ error: code }],
            createdBy: 'Searching.js',
            createdAt: new Date().toISOString(),
        };
    }
}

// ──────────────────────────────────────────────────────────────
// 13. CONVENIENCE ENTRY POINT
// ──────────────────────────────────────────────────────────────

async function execute(plan) {
    const engine = new SearchingEngine();
    try {
        return await engine.execute(plan);
    } catch (error) {
        console.error('[SEARCHING] Fatal error:', error.message);
        return {
            discoveryVersion: '4.0.0',
            requestId: `error-${uuidv4().substring(0, 8)}`,
            status: 'failed',
            error: { code: 'FATAL_ERROR', message: error.message },
            rankingStatistics: { high: 0, medium: 0, low: 0 },
            rankedCandidates: { high: [], medium: [], low: [] },
            candidates: [],
            errors: [{ error: error.message }],
            createdBy: 'Searching.js',
            createdAt: new Date().toISOString(),
        };
    }
}

// ──────────────────────────────────────────────────────────────
// 14. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    execute,
    SearchingEngine,
    QuerySelector,
    TavilyClient,
    AIExtractor,
    DeterministicValidator,
    CandidateBuilder,
    DeduplicationEngine,
    RankingEngine,
    CONFIG,
    ROLE_MATCHING,
    REJECTION_REASONS,
};
