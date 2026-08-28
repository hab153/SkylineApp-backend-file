// ──────────────────────────────────────────────────────────────
// SEARCHING.JS — Layer 3: Discovery Engine v3.0.0
//
// CONTRACT (per "Skyline AA-1 — Layer 3: Discovery Engine v3.0"):
//
// Layer 3 discovers credible, evidence-backed candidates and hands
// them to Layer 4. It does NOT verify, does NOT invent missing
// fields, and does NOT let AI confidence override deterministic
// validation. GPT-4o-mini is an assistant inside Layer 3, not the
// judge of truth. The judge is: Layer 2 requirements + source
// evidence + deterministic validation + deduplication rules.
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
    AI_MAX_TOKENS: 1200,
    AI_BATCH_SIZE: 5,
    MIN_EVIDENCE_SNIPPET_LENGTH: 10,
};

// ──────────────────────────────────────────────────────────────
// 2. ROLE MATCHING CONFIGURATION (Section 6, 16, 46)
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
// 3. REJECTION REASONS (Section 27)
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
    INSUFFICIENT_EVIDENCE: 'insufficientEvidence',
    INVALID_COMPANY_ENTITY: 'invalidCompany',
    INVALID_PERSON_ENTITY: 'invalidPerson',
};

// ──────────────────────────────────────────────────────────────
// 4. TAVILY CLIENT (Section 4, 7)
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
// 5. AI EXTRACTOR — GPT-4o-mini SEMANTIC ASSISTANT (Section 8-10, 25)
//
// This class's job is ONLY to answer: "what entities and
// relationships are actually supported by this source?" It is
// explicitly allowed to return zero candidates (NO_VALID_CANDIDATE).
// It is NOT the final authority — everything it returns still goes
// through DeterministicValidator.
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
     * @returns {Array} raw AI candidates (schema per Section 9),
     *                  possibly empty (NO_VALID_CANDIDATE).
     */
    async extractCandidates(rawResult, query, branch, objective) {
        if (!this.isConfigured()) {
            throw new Error('OPENAI_NOT_CONFIGURED');
        }

        const prompt = this.buildExtractionPrompt(rawResult, query, branch, objective);

        try {
            const response = await this.openai.chat.completions.create({
                model: this.model,
                temperature: CONFIG.AI_TEMPERATURE,
                max_tokens: CONFIG.AI_MAX_TOKENS,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: this.systemPrompt(objective) },
                    { role: 'user', content: prompt },
                ],
            });

            const parsed = JSON.parse(response.choices[0].message.content || '{}');
            const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];

            return candidates.map((c) => this.normalizeAIShape(c, rawResult));
        } catch (error) {
            console.error(`[AI] Extraction failed for "${query}":`, error.message);
            // A failed AI call yields zero candidates for this result,
            // not a fabricated one.
            return [];
        }
    }

    systemPrompt(objective) {
        return `You are the Skyline AA-1 Layer 3 semantic extraction assistant.

Your ONLY job: identify what entities and relationships are ACTUALLY
SUPPORTED by the provided source text. You are not the final authority —
a separate deterministic validator will reject anything you cannot
support with evidence, so you must be conservative.

ABSOLUTE RULES:
1. NEVER invent information. If the source does not say it, return null.
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
7. It is correct and expected to return an empty "candidates" array when
   no source-supported candidate exists (NO_VALID_CANDIDATE). Do not
   force an extraction.
8. One source may yield zero, one, or multiple candidates. Extract every
   distinct company/person the source actually supports.
9. Preserve the exact requested role (${objective.role || 'any'}) — do
   not substitute a different role.

Requested context:
- targetType: ${objective.targetType || 'contact'}
- role: ${objective.role || 'any'}
- industries: ${(objective.industries || []).join(', ') || 'any'}
- location: ${objective.locationLabel || 'any'}
- companySize: ${objective.companySizeLabel || 'not specified'}

Return JSON only, in this exact shape:
{
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
}`;
    }

    buildExtractionPrompt(rawResult, query, branch, objective) {
        return `Search query: "${query}"
Search branch industry: ${branch.industry || 'unknown'}

Source:
Title: ${rawResult.title || 'No title'}
URL: ${rawResult.url || 'No URL'}
Content:
${(rawResult.content || '').substring(0, 2000)}

Extract only candidates this source text actually supports. Return
{"candidates": []} if nothing qualifies.`;
    }

    normalizeAIShape(c, rawResult) {
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
            sourceUrl: rawResult.url || null,
            sourceTitle: rawResult.title || null,
            // Raw data preservation for debugging (Section 37): lets us
            // later determine whether Tavily, GPT extraction,
            // deterministic validation, or deduplication was the point
            // of failure for any given candidate.
            rawData: {
                url: rawResult.url || null,
                title: rawResult.title || null,
                content: (rawResult.content || '').substring(0, 2000),
                score: typeof rawResult.score === 'number' ? rawResult.score : null,
            },
        };
    }
}

// ──────────────────────────────────────────────────────────────
// 6. ENTITY-QUALITY HELPERS (Section 11, 12, 45)
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
// 7. DETERMINISTIC VALIDATOR (Section 11-23, 26)
//
// Every AI-extracted candidate must pass this pipeline in order.
// AI confidence NEVER overrides these checks (Section 32).
// ──────────────────────────────────────────────────────────────

class DeterministicValidator {
    /**
     * @returns {{ ok: true, normalized: object } | { ok: false, reason: string }}
     */
    validate(ai, objective) {
        const targetType = objective.targetType || 'contact';

        // 1. Schema validation (Section 26, step 1) — malformed AI output
        // never reaches entity-level checks.
        if (!this.validateSchema(ai)) {
            return this.reject(REJECTION_REASONS.AI_UNCERTAIN);
        }

        // 2. Company identity (Section 11)
        if (!ai.companyName) {
            return this.reject(REJECTION_REASONS.MISSING_COMPANY);
        }
        if (looksLikeListOrPageTitle(ai.companyName)) {
            return this.reject(REJECTION_REASONS.INVALID_COMPANY_ENTITY);
        }

        if (targetType === 'contact') {
            // 3. Person identity (Section 12)
            if (!ai.personName) {
                return this.reject(REJECTION_REASONS.MISSING_PERSON);
            }
            if (looksLikeGarbagePersonName(ai.personName)) {
                return this.reject(REJECTION_REASONS.INVALID_PERSON_ENTITY);
            }

            // 4. Person-company association (Section 13, 14, 22)
            if (!ai.relationshipConfirmed || !ai.relationshipStatement) {
                return this.reject(REJECTION_REASONS.MISSING_PERSON_COMPANY_ASSOCIATION);
            }

            // 5. Role validation (Section 6, 16, 46)
            const roleResult = this.validateRole(objective.role, ai.personRole);
            if (!roleResult.ok) {
                return this.reject(REJECTION_REASONS.ROLE_MISMATCH);
            }
            ai.personRole = roleResult.normalizedRole;
        }

        // 6. Industry validation (Section 17, 47)
        if (objective.industries && objective.industries.length > 0) {
            const industryResult = this.validateIndustry(objective.industries, ai.companyIndustry);
            if (!industryResult.ok) {
                return this.reject(REJECTION_REASONS.INDUSTRY_MISMATCH);
            }
        }

        // 7. Location validation (Section 18, 19)
        if (objective.locationLabel) {
            const locationResult = this.validateLocation(objective, ai.companyLocation);
            if (!locationResult.ok) {
                return this.reject(REJECTION_REASONS.LOCATION_MISMATCH);
            }
        }

        // 8. Hard constraint: company size (Section 20)
        let sizeUnconfirmed = false;
        if (objective.companySize && objective.companySize.restricted) {
            const sizeResult = this.validateCompanySize(objective.companySize.value, ai.companySizeEvidence);
            if (sizeResult.status === 'mismatch') {
                return this.reject(REJECTION_REASONS.COMPANY_SIZE_MISMATCH);
            }
            if (sizeResult.status === 'unconfirmed') {
                // Strict pipeline: do not claim a hard constraint is
                // satisfied without evidence (Section 20). Reject rather
                // than silently pass it through as verified.
                return this.reject(REJECTION_REASONS.COMPANY_SIZE_MISMATCH);
            }
        }

        // 9. Evidence validation (Section 21, 22)
        const evidenceResult = this.validateEvidence(ai, targetType);
        if (!evidenceResult.ok) {
            return this.reject(REJECTION_REASONS.INSUFFICIENT_EVIDENCE);
        }

        // 10. Source validation (Section 23)
        if (!ai.sourceUrl) {
            return this.reject(REJECTION_REASONS.SOURCE_NOT_SUPPORTING_CLAIM);
        }

        return { ok: true, normalized: ai, sizeUnconfirmed };
    }

    reject(reason) {
        return { ok: false, reason };
    }

    // Step 1 of the pipeline (Section 26): reject malformed AI output
    // before any entity-level interpretation happens.
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
        // request specified one) rather than only the country/region
        // (Section 18-19).
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
// 8. CANDIDATE BUILDER (Section 34)
// ──────────────────────────────────────────────────────────────

class CandidateBuilder {
    build(normalized, query, branch) {
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
                branch: branch.industry || 'unknown',
                query,
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
            discoveryConfidence: this.estimateConfidence(normalized),
            rawData: normalized.rawData || null,
        };
    }

    estimateConfidence(normalized) {
        // Confidence reflects evidence completeness (Section 33), it
        // never substitutes for validation which has already occurred
        // by the time this runs.
        let score = 0.5;
        if (normalized.relationshipConfirmed) score += 0.2;
        if (normalized.companyIndustry) score += 0.1;
        if (normalized.companyLocation) score += 0.1;
        if ((normalized.evidence || []).length >= 4) score += 0.1;
        return Math.min(1, Math.round(score * 100) / 100);
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
// 9. DEDUPLICATION ENGINE (Section 28-31)
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
            // different people who share a name at different companies
            // (Section 31), and do not merge two different companies
            // that happen to share a person's name.
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
        if (incoming.discoveryConfidence > existing.discoveryConfidence) {
            existing.discoveryConfidence = incoming.discoveryConfidence;
        }
    }
}

// ──────────────────────────────────────────────────────────────
// 10. MAIN SEARCHING ENGINE (Section 5, 39-42)
// ──────────────────────────────────────────────────────────────

class SearchingEngine {
    constructor() {
        this.tavilyClient = new TavilyClient();
        this.aiExtractor = new AIExtractor();
        this.validator = new DeterministicValidator();
        this.candidateBuilder = new CandidateBuilder();
        this.deduplicationEngine = new DeduplicationEngine();
    }

    async execute(plan) {
        // ── Startup validation (Section 3) ──
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
        const rejectionStatistics = emptyRejectionStatistics();
        const errors = [];
        const allCandidates = [];

        for (const branch of searchBranches) {
            const branchOutcome = await this.executeBranch(branch, objective, errors, searchStatistics, rejectionStatistics);
            searchStatistics.branchesExecuted++;
            allCandidates.push(...branchOutcome.candidates);
        }

        // ── Deduplication + evidence merge (Section 28-31) ──
        const dedupResult = this.deduplicationEngine.deduplicate(allCandidates);
        searchStatistics.duplicatesDetected = dedupResult.duplicatesRemoved;
        searchStatistics.duplicatesRemoved = dedupResult.duplicatesRemoved;
        searchStatistics.candidatesForNextLayer = dedupResult.uniqueCandidates.length;

        // ── Status determination (Section 40) ──
        let status = 'completed';
        if (searchStatistics.queriesExecuted === 0) {
            status = 'failed';
        } else if (errors.length > 0 && dedupResult.uniqueCandidates.length > 0) {
            status = 'partial';
        } else if (errors.length > 0 && dedupResult.uniqueCandidates.length === 0) {
            status = errors.length >= searchStatistics.queriesExecuted ? 'failed' : 'partial';
        }

        return {
            discoveryVersion: '3.0.0',
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

    async executeBranch(branch, objective, errors, searchStatistics, rejectionStatistics) {
        const candidates = [];
        const hypotheses = branch.hypotheses || [];

        for (const query of hypotheses) {
            try {
                const tavilyResult = await this.tavilyClient.search(query);
                searchStatistics.queriesExecuted++;

                const rawResults = tavilyResult.results || [];
                searchStatistics.rawResultsFound += rawResults.length;

                for (const rawResult of rawResults) {
                    const rawResultTagged = { ...rawResult, query, branch: branch.industry };

                    let aiCandidates = [];
                    try {
                        aiCandidates = await this.aiExtractor.extractCandidates(
                            rawResultTagged,
                            query,
                            branch,
                            objective
                        );
                    } catch (aiError) {
                        errors.push({ query, branch: branch.industry, error: aiError.message });
                        continue;
                    }

                    searchStatistics.aiResultsAnalyzed++;

                    // One result can yield 0, 1, or many candidates
                    // (Section 24) — never forced to exactly one.
                    for (const ai of aiCandidates) {
                        const validation = this.validator.validate(ai, objective);
                        if (!validation.ok) {
                            searchStatistics.invalidCandidatesRejected++;
                            const statKey = REJECTION_TO_STAT_KEY[validation.reason];
                            if (statKey) rejectionStatistics[statKey]++;
                            continue;
                        }

                        const built = this.candidateBuilder.build(validation.normalized, query, branch);
                        candidates.push(built);
                        searchStatistics.candidatesExtracted++;
                    }
                }
            } catch (error) {
                errors.push({ query, branch: branch.industry, error: error.message });
            }
        }

        return { candidates };
    }

    configErrorResult(code, plan) {
        return {
            status: 'failed',
            error: { code },
            discoveryVersion: '3.0.0',
            requestId: plan?.requestId || `error-${uuidv4().substring(0, 8)}`,
            searchProvider: { name: 'tavily', configured: this.tavilyClient.isConfigured() },
            aiExtractor: {
                provider: 'openai',
                model: CONFIG.AI_MODEL,
                configured: this.aiExtractor.isConfigured(),
            },
            searchStatistics: {
                branchesExecuted: 0, queriesExecuted: 0, rawResultsFound: 0,
                aiResultsAnalyzed: 0, candidatesExtracted: 0, invalidCandidatesRejected: 0,
                duplicatesDetected: 0, duplicatesRemoved: 0, candidatesForNextLayer: 0,
            },
            rejectionStatistics: emptyRejectionStatistics(),
            candidates: [],
            errors: [{ error: code }],
            createdBy: 'Searching.js',
            createdAt: new Date().toISOString(),
        };
    }
}

// ──────────────────────────────────────────────────────────────
// 11. CONVENIENCE ENTRY POINT
// ──────────────────────────────────────────────────────────────

async function execute(plan) {
    const engine = new SearchingEngine();
    try {
        return await engine.execute(plan);
    } catch (error) {
        console.error('[SEARCHING] Fatal error:', error.message);
        return {
            discoveryVersion: '3.0.0',
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
// 12. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    execute,
    SearchingEngine,
    TavilyClient,
    AIExtractor,
    DeterministicValidator,
    CandidateBuilder,
    DeduplicationEngine,
    CONFIG,
    ROLE_MATCHING,
    REJECTION_REASONS,
};
