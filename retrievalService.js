'use strict';

// ──────────────────────────────────────────────────────────────
// retrievalService.js
// Layer 5: Retrieval and Search Execution
//
// Version: v3
// Schema: retrieval.v1
//
// PURPOSE:
//   Receive the validated output of Layer 4 (Understanding.js),
//   convert it into a deterministic search plan, execute that plan
//   against registered adapters, normalize, deduplicate, rank, and
//   return candidate records.
//
// v3 CHANGES:
//   - Added REAL Tavily web search adapter
//   - Now searches BOTH internal DB + external web
//   - Tavily results parsed into candidates
//   - Works with TAVILY_API_KEY env var
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
// 1. CONFIGURATION
// ──────────────────────────────────────────────────────────────

const CONFIG = {
    SCHEMA_VERSION: 'retrieval.v1',
    PLAN_VERSION: 'retrieval-plan.v1',

    MAX_LIMIT: 500,
    DEFAULT_LIMIT: 100,

    SUPPORTED_INTENTS: [
        'PERSON_SEARCH',
        'COMPANY_SEARCH',
        'ICP_SEARCH',
        'EMAIL_FILTER',
        'ATTACHMENT_SEARCH'
    ],

    INTENT_TARGET_MAP: {
        PERSON_SEARCH: 'people',
        COMPANY_SEARCH: 'companies',
        ICP_SEARCH: 'companies',
        EMAIL_FILTER: 'emails',
        ATTACHMENT_SEARCH: 'attachments'
    },

    FIELD_OWNERSHIP: {
        job_title: 'person',
        person_name: 'person',
        location: 'person',
        industry: 'company',
        company_name: 'company',
        employee_count_min: 'company',
        employee_count_max: 'company',
        email_type: 'email',
        date_range: 'email'
    },

    APPROVED_OPERATORS: [
        'equals',
        'normalized_equals',
        'contains',
        'in',
        'range',
        'greater_than_or_equal',
        'less_than_or_equal',
        'location_equals',
        'location_within',
        'date_after',
        'date_before',
        'exists'
    ],

    SCORING: {
        EXACT_TITLE_MATCH: 3,
        NORMALIZED_TITLE_MATCH: 2,
        EXACT_INDUSTRY_MATCH: 2,
        EXACT_LOCATION_MATCH: 2,
        BROADER_LOCATION_MATCH: 1,
        COMPLETE_COMPANY_DATA: 1,
        COMPLETE_PERSON_DATA: 1,
        RECENT_UPDATE: 1
    },

    ERROR_CODES: {
        INVALID_REQUEST: 'INVALID_REQUEST',
        CLARIFICATION_REQUIRED: 'CLARIFICATION_REQUIRED',
        UNSUPPORTED_QUERY: 'UNSUPPORTED_QUERY',
        INVALID_FILTER: 'INVALID_FILTER',
        INVALID_EMPLOYEE_RANGE: 'INVALID_EMPLOYEE_RANGE',
        PERMISSION_DENIED: 'PERMISSION_DENIED',
        SOURCE_TIMEOUT: 'SOURCE_TIMEOUT',
        SOURCE_RATE_LIMITED: 'SOURCE_RATE_LIMITED',
        SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
        SOURCE_NOT_CONFIGURED: 'SOURCE_NOT_CONFIGURED',
        INTERNAL_ERROR: 'INTERNAL_ERROR'
    },

    EMPTY_RESULT_REASONS: {
        NO_MATCHING_RECORDS: 'NO_MATCHING_RECORDS',
        FILTER_TOO_RESTRICTIVE: 'FILTER_TOO_RESTRICTIVE',
        SOURCE_HAS_NO_DATA: 'SOURCE_HAS_NO_DATA',
        SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
        SOURCE_NOT_CONFIGURED: 'SOURCE_NOT_CONFIGURED',
        SEARCH_BLOCKED_BY_PERMISSION: 'SEARCH_BLOCKED_BY_PERMISSION',
        AMBIGUITY_NOT_RESOLVED: 'AMBIGUITY_NOT_RESOLVED'
    },

    // Tavily settings
    TAVILY: {
        MAX_RESULTS: 20,
        SEARCH_DEPTH: 'advanced',
        INCLUDE_DOMAINS: [],
        EXCLUDE_DOMAINS: []
    }
};

// ──────────────────────────────────────────────────────────────
// 2. ID GENERATION
// ──────────────────────────────────────────────────────────────

const crypto = require('crypto');

function generateId(prefix) {
    const rand = crypto.randomBytes(6).toString('hex');
    return `${prefix}_${rand}`;
}

function hashId(value) {
    if (!value || typeof value !== 'string') return 'unknown';
    return crypto.createHash('sha256').update(value).digest('hex').substring(0, 16);
}

// ──────────────────────────────────────────────────────────────
// 3. ADAPTER REGISTRY
// ──────────────────────────────────────────────────────────────

const adapterRegistry = new Map();

function registerAdapter(name, adapter) {
    if (!name || typeof name !== 'string') {
        throw new Error('registerAdapter: name must be a non-empty string');
    }
    if (!adapter || typeof adapter !== 'object') {
        throw new Error('registerAdapter: adapter must be an object');
    }
    if (typeof adapter.search !== 'function') {
        throw new Error(`registerAdapter: adapter "${name}" must implement search()`);
    }
    if (typeof adapter.normalize !== 'function') {
        throw new Error(`registerAdapter: adapter "${name}" must implement normalize()`);
    }
    adapterRegistry.set(name, { name, ...adapter });
    return true;
}

function getAdapter(name) {
    return adapterRegistry.get(name) || null;
}

function listAdapters() {
    return Array.from(adapterRegistry.keys());
}

// ──────────────────────────────────────────────────────────────
// 4. INTERNAL LEAD DB ADAPTER — Queries MongoDB
// ──────────────────────────────────────────────────────────────

const internalLeadAdapter = {
    name: 'internal_lead_db',

    supports(searchPlan) {
        return searchPlan && (
            searchPlan.target === 'people' ||
            searchPlan.target === 'companies'
        );
    },

    async search(searchPlan, context) {
        console.log('🔍 [INTERNAL] internal_lead_db.search() called');

        const Lead = require('./Lead');
        const mongoQuery = buildMongoQuery(searchPlan, context);

        console.log('🔍 [INTERNAL] Query:', JSON.stringify(mongoQuery));

        const limit = searchPlan.pagination?.limit || CONFIG.DEFAULT_LIMIT;
        const leads = await Lead.find(mongoQuery)
            .limit(limit)
            .lean();

        console.log('🔍 [INTERNAL] Found', leads.length, 'leads');

        if (leads.length === 0) {
            return {
                records: [],
                empty_result_reason: CONFIG.EMPTY_RESULT_REASONS.NO_MATCHING_RECORDS
            };
        }

        return {
            records: leads,
            empty_result_reason: null
        };
    },

    normalize(records) {
        if (!Array.isArray(records)) return [];
        return records.map(lead => ({
            person_id: lead._id ? String(lead._id) : null,
            company_id: null,
            name: lead.name || null,
            job_title: lead.jobTitle || lead.role || null,
            job_title_normalized: lead.jobTitle ? String(lead.jobTitle).toLowerCase() : null,
            company_name: lead.company || null,
            industry: lead.industry || null,
            location: lead.location || lead.hq || null,
            employee_count: lead.employees || lead.employeeCount || null,
            email: lead.email || null,
            company: lead.company ? {
                company_id: null,
                name: lead.company,
                industry: lead.industry || null,
                employee_count: lead.employees || null,
                location: lead.location || null
            } : null,
            contact: {
                email: lead.email || null,
                phone: lead.phone || null
            },
            source: 'internal_lead_db',
            source_record_id: lead._id ? String(lead._id) : null,
            match_type: 'normalized',
            _raw: lead
        }));
    }
};

function buildMongoQuery(searchPlan, context) {
    const query = {};

    if (context.tenantId) {
        query.userId = context.userId || context.tenantId;
    }

    const filters = searchPlan.filters || [];
    for (const filter of filters) {
        if (filter._injected) continue;
        const { field, operator, value } = filter;
        const mongoField = mapFieldToMongo(field);
        if (!mongoField) continue;

        switch (operator) {
            case 'normalized_equals':
            case 'equals':
                query[mongoField] = { $regex: `^${escapeRegex(value)}$`, $options: 'i' };
                break;
            case 'contains':
                query[mongoField] = { $regex: escapeRegex(value), $options: 'i' };
                break;
            case 'location_equals':
                query[mongoField] = { $regex: escapeRegex(value), $options: 'i' };
                break;
            case 'greater_than_or_equal':
                query[mongoField] = { ...(query[mongoField] || {}), $gte: value };
                break;
            case 'less_than_or_equal':
                query[mongoField] = { ...(query[mongoField] || {}), $lte: value };
                break;
            case 'range':
                query[mongoField] = { $gte: value.min, $lte: value.max };
                break;
            case 'in':
                query[mongoField] = { $in: value };
                break;
            case 'exists':
                query[mongoField] = { $exists: true, $ne: null };
                break;
            case 'date_after':
                query[mongoField] = { ...(query[mongoField] || {}), $gte: new Date(value) };
                break;
            case 'date_before':
                query[mongoField] = { ...(query[mongoField] || {}), $lte: new Date(value) };
                break;
        }
    }

    return query;
}

function mapFieldToMongo(canonicalField) {
    const mapping = {
        'person.name': 'name',
        'person.job_title': 'jobTitle',
        'person.location': 'location',
        'person.email': 'email',
        'person.phone': 'phone',
        'company.name': 'company',
        'company.industry': 'industry',
        'company.location': 'location',
        'company.employee_count': 'employees',
        'email.type': 'emailType',
        'email.date': 'emailDate',
        'email.address': 'email',
        'tenant_id': 'userId'
    };
    return mapping[canonicalField] || null;
}

function escapeRegex(str) {
    if (!str) return '';
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

registerAdapter('internal_lead_db', internalLeadAdapter);

// ──────────────────────────────────────────────────────────────
// 5. TAVILY SEARCH ADAPTER — Real web search
// ──────────────────────────────────────────────────────────────

/**
 * Tavily web search adapter.
 * Searches the web for companies/leads when internal DB has nothing.
 * 
 * Uses TAVILY_API_KEY from environment variables.
 * 
 * HOW IT WORKS:
 *   1. Build a natural-language query from the search plan
 *   2. Call Tavily API
 *   3. Parse results into company candidates
 *   4. Extract company names, domains, descriptions
 */
const tavilyAdapter = {
    name: 'tavily_search',

    supports(searchPlan) {
        // Supports people, companies searches
        return searchPlan && (
            searchPlan.target === 'people' ||
            searchPlan.target === 'companies'
        );
    },

    async search(searchPlan, context) {
        console.log('🌐 [TAVILY] tavily_search.search() called');

        // Check API key
        const apiKey = process.env.TAVILY_API_KEY;
        if (!apiKey) {
            console.warn('⚠️ [TAVILY] TAVILY_API_KEY not set');
            return {
                records: [],
                empty_result_reason: CONFIG.EMPTY_RESULT_REASONS.SOURCE_NOT_CONFIGURED
            };
        }

        // Build natural-language query from filters
        const query = buildTavilyQuery(searchPlan);
        console.log('🌐 [TAVILY] Query:', query);

        // Call Tavily API
        const results = await callTavilyAPI(query, apiKey);
        console.log('🌐 [TAVILY] Raw results:', results.length);

        if (results.length === 0) {
            return {
                records: [],
                empty_result_reason: CONFIG.EMPTY_RESULT_REASONS.NO_MATCHING_RECORDS
            };
        }

        // Parse Tavily results into candidates
        const candidates = parseTavilyResults(results, searchPlan);
        console.log('🌐 [TAVILY] Parsed candidates:', candidates.length);

        return {
            records: candidates,
            empty_result_reason: null
        };
    },

    normalize(records) {
        if (!Array.isArray(records)) return [];
        return records;
    }
};

/**
 * Build a natural-language query for Tavily from the search plan.
 * 
 * Example outputs:
 *   "SaaS companies in San Francisco with 50-200 employees"
 *   "CEO at SaaS companies in London"
 */
function buildTavilyQuery(searchPlan) {
    const parts = [];

    // Extract values from filters
    let jobTitle = null;
    let industry = null;
    let location = null;
    let employeeMin = null;
    let employeeMax = null;

    for (const filter of searchPlan.filters || []) {
        if (filter._injected) continue;
        switch (filter.field) {
            case 'person.job_title': jobTitle = filter.value; break;
            case 'company.industry': industry = filter.value; break;
            case 'person.location':
            case 'company.location': location = filter.value; break;
            case 'company.employee_count':
                if (filter.operator === 'greater_than_or_equal') employeeMin = filter.value;
                if (filter.operator === 'less_than_or_equal') employeeMax = filter.value;
                break;
        }
    }

    // Build query based on target
    if (searchPlan.target === 'people') {
        // Person search: "CEO at SaaS companies in San Francisco"
        if (jobTitle && industry) {
            parts.push(`${jobTitle} at ${industry} companies`);
        } else if (jobTitle) {
            parts.push(`${jobTitle}`);
        } else if (industry) {
            parts.push(`${industry} companies`);
        }
    } else {
        // Company search: "SaaS companies in San Francisco"
        if (industry) {
            parts.push(`${industry} companies`);
        }
    }

    if (location) {
        parts.push(`in ${location}`);
    }

    if (employeeMin || employeeMax) {
        if (employeeMin && employeeMax) {
            parts.push(`with ${employeeMin}-${employeeMax} employees`);
        } else if (employeeMin) {
            parts.push(`with ${employeeMin}+ employees`);
        } else if (employeeMax) {
            parts.push(`with up to ${employeeMax} employees`);
        }
    }

    // Fallback if no filters
    if (parts.length === 0) {
        parts.push(searchPlan.target === 'people' ? 'business contacts' : 'companies');
    }

    return parts.join(' ');
}

/**
 * Call Tavily API.
 * Uses native fetch (Node 18+) — no extra dependency.
 */
async function callTavilyAPI(query, apiKey) {
    const url = 'https://api.tavily.com/search';

    const body = {
        api_key: apiKey,
        query: query,
        search_depth: CONFIG.TAVILY.SEARCH_DEPTH,
        max_results: CONFIG.TAVILY.MAX_RESULTS,
        include_domains: CONFIG.TAVILY.INCLUDE_DOMAINS,
        exclude_domains: CONFIG.TAVILY.EXCLUDE_DOMAINS,
        include_answer: false,
        include_raw_content: false
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const text = await response.text();
            console.error('❌ [TAVILY] API error:', response.status, text);
            throw new Error(`Tavily API error: ${response.status}`);
        }

        const data = await response.json();
        return data.results || [];

    } catch (err) {
        console.error('❌ [TAVILY] Fetch failed:', err.message);
        throw err;
    }
}

/**
 * Parse Tavily results into structured candidates.
 * 
 * Tavily returns:
 *   { title, url, content, score }
 * 
 * We extract:
 *   - Company name (from title)
 *   - Domain (from url)
 *   - Description (from content)
 *   - Website URL
 */
function parseTavilyResults(results, searchPlan) {
    const candidates = [];

    for (const result of results) {
        if (!result || !result.url) continue;

        // Extract domain from URL
        let domain = null;
        try {
            const urlObj = new URL(result.url);
            domain = urlObj.hostname.replace(/^www\./, '');
        } catch (_) {
            continue;
        }

        // Extract company name from title
        // Titles usually look like: "Acme Corp - Best SaaS Platform" or "Home | Acme"
        const companyName = extractCompanyName(result.title, domain);

        if (!companyName) continue;

        // Build candidate
        candidates.push({
            person_id: null,
            company_id: null,
            name: null, // Tavily doesn't give us names
            job_title: null,
            job_title_normalized: null,
            company_name: companyName,
            industry: extractIndustryFromFilters(searchPlan),
            location: extractLocationFromFilters(searchPlan),
            employee_count: null,
            email: null,
            company: {
                company_id: null,
                name: companyName,
                domain: domain,
                website: result.url,
                industry: extractIndustryFromFilters(searchPlan),
                location: extractLocationFromFilters(searchPlan),
                employee_count: null,
                description: (result.content || '').substring(0, 300)
            },
            contact: { email: null, phone: null },
            source: 'tavily_search',
            source_record_id: domain,
            match_type: 'web_result',
            confidence: result.score || null,
            _raw: result
        });
    }

    return candidates;
}

/**
 * Extract a company name from a title.
 * 
 * Examples:
 *   "Acme Corp - Best SaaS Platform" → "Acme Corp"
 *   "Home | Acme" → "Acme"
 *   "Acme | Official Site" → "Acme"
 */
function extractCompanyName(title, domain) {
    if (!title) {
        // Fall back to domain
        return domainToName(domain);
    }

    // Try split on " - "
    let name = title.split(' - ')[0].trim();

    // Try split on " | "
    if (!name) name = title.split(' | ')[0].trim();

    // Try split on " — " (em dash)
    if (!name) name = title.split(' — ')[0].trim();

    // Try split on ":"
    if (!name) name = title.split(':')[0].trim();

    // If name is too generic, fall back to domain
    if (!name || name.length < 2 || name.length > 100) {
        return domainToName(domain);
    }

    return name;
}

function domainToName(domain) {
    if (!domain) return null;
    // "acme-corp.com" → "Acme Corp"
    const base = domain.split('.')[0];
    return base
        .split(/[-_]/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

function extractIndustryFromFilters(searchPlan) {
    for (const f of searchPlan.filters || []) {
        if (f.field === 'company.industry') return f.value;
    }
    return null;
}

function extractLocationFromFilters(searchPlan) {
    for (const f of searchPlan.filters || []) {
        if (f.field === 'person.location' || f.field === 'company.location') return f.value;
    }
    return null;
}

registerAdapter('tavily_search', tavilyAdapter);

// ──────────────────────────────────────────────────────────────
// 6. REQUEST VALIDATION
// ──────────────────────────────────────────────────────────────

function validateRetrievalInput(understanding) {
    const errors = [];

    if (!understanding || typeof understanding !== 'object' || Array.isArray(understanding)) {
        return { valid: false, errors: ['understanding must be a non-null object'] };
    }

    if (!understanding.intent || typeof understanding.intent !== 'string') {
        errors.push('intent is required and must be a string');
    }

    if (!understanding.entities || typeof understanding.entities !== 'object' || Array.isArray(understanding.entities)) {
        errors.push('entities is required and must be an object');
    }

    if (!Array.isArray(understanding.ambiguities)) {
        errors.push('ambiguities must be an array');
    }

    if (understanding.entities) {
        const e = understanding.entities;

        if (e.employee_count_min != null && e.employee_count_min !== null) {
            if (typeof e.employee_count_min !== 'number' ||
                !Number.isInteger(e.employee_count_min) ||
                e.employee_count_min < 0) {
                errors.push('entities.employee_count_min must be a non-negative integer or null');
            }
        }

        if (e.employee_count_max != null && e.employee_count_max !== null) {
            if (typeof e.employee_count_max !== 'number' ||
                !Number.isInteger(e.employee_count_max) ||
                e.employee_count_max < 0) {
                errors.push('entities.employee_count_max must be a non-negative integer or null');
            }
        }

        if (typeof e.employee_count_min === 'number' &&
            typeof e.employee_count_max === 'number' &&
            e.employee_count_min > e.employee_count_max) {
            errors.push('INVALID_EMPLOYEE_RANGE');
        }
    }

    return { valid: errors.length === 0, errors };
}

// ──────────────────────────────────────────────────────────────
// 7. PRE-SEARCH GATE
// ──────────────────────────────────────────────────────────────

function preSearchGate(understanding, context = {}) {
    const result = {
        schema_valid: false,
        intent_supported: false,
        ambiguities_resolved: false,
        required_fields_present: false,
        employee_range_valid: false,
        authorization_valid: false,
        ready_for_retrieval: false,
        reason: null,
        error_code: null
    };

    const validation = validateRetrievalInput(understanding);
    if (!validation.valid) {
        if (validation.errors.includes('INVALID_EMPLOYEE_RANGE')) {
            result.error_code = CONFIG.ERROR_CODES.INVALID_EMPLOYEE_RANGE;
            result.reason = 'employee_count_min cannot be greater than employee_count_max.';
        } else {
            result.error_code = CONFIG.ERROR_CODES.INVALID_REQUEST;
            result.reason = validation.errors.join('; ');
        }
        return result;
    }
    result.schema_valid = true;

    if (!CONFIG.SUPPORTED_INTENTS.includes(understanding.intent)) {
        result.error_code = CONFIG.ERROR_CODES.UNSUPPORTED_QUERY;
        result.reason = `Intent "${understanding.intent}" is not searchable.`;
        return result;
    }
    result.intent_supported = true;

    if (Array.isArray(understanding.ambiguities) && understanding.ambiguities.length > 0) {
        result.error_code = CONFIG.ERROR_CODES.CLARIFICATION_REQUIRED;
        result.reason = 'Unresolved ambiguities present.';
        return result;
    }
    result.ambiguities_resolved = true;

    if (!context || typeof context.tenantId !== 'string' || context.tenantId.trim().length === 0) {
        result.error_code = CONFIG.ERROR_CODES.PERMISSION_DENIED;
        result.reason = 'Missing authenticated tenant context.';
        return result;
    }
    result.authorization_valid = true;

    if (!CONFIG.INTENT_TARGET_MAP[understanding.intent]) {
        result.error_code = CONFIG.ERROR_CODES.UNSUPPORTED_QUERY;
        result.reason = 'No target mapping for intent.';
        return result;
    }
    result.required_fields_present = true;

    const e = understanding.entities || {};
    const minOk = e.employee_count_min == null || (Number.isInteger(e.employee_count_min) && e.employee_count_min >= 0);
    const maxOk = e.employee_count_max == null || (Number.isInteger(e.employee_count_max) && e.employee_count_max >= 0);
    const rangeOk = !(Number.isInteger(e.employee_count_min) &&
                      Number.isInteger(e.employee_count_max) &&
                      e.employee_count_min > e.employee_count_max);
    result.employee_range_valid = minOk && maxOk && rangeOk;

    if (!result.employee_range_valid) {
        result.error_code = CONFIG.ERROR_CODES.INVALID_FILTER;
        result.reason = 'Invalid employee count range.';
        return result;
    }

    result.ready_for_retrieval = true;
    return result;
}

// ──────────────────────────────────────────────────────────────
// 8. INTENT → TARGET
// ──────────────────────────────────────────────────────────────

function mapIntentToTarget(intent) {
    return CONFIG.INTENT_TARGET_MAP[intent] || null;
}

function resolveFieldOwner(field) {
    return CONFIG.FIELD_OWNERSHIP[field] || null;
}

// ──────────────────────────────────────────────────────────────
// 9. SEARCH PLAN COMPILER
// ──────────────────────────────────────────────────────────────

function compileSearchPlan(understanding, context = {}) {
    const target = mapIntentToTarget(understanding.intent);
    const entities = understanding.entities || {};
    const filters = [];
    const excludedFilters = [];

    if (entities.job_title != null) {
        filters.push({
            field: 'person.job_title',
            operator: 'normalized_equals',
            value: entities.job_title,
            importance: 'required'
        });
    }

    if (entities.industry != null) {
        filters.push({
            field: 'company.industry',
            operator: 'normalized_equals',
            value: entities.industry,
            importance: 'required'
        });
    }

    if (entities.location != null) {
        const locationField =
            target === 'people' ? 'person.location' :
            target === 'companies' ? 'company.location' :
            'person.location';
        filters.push({
            field: locationField,
            operator: 'location_equals',
            value: entities.location,
            importance: 'required'
        });
    }

    if (entities.employee_count_min != null) {
        filters.push({
            field: 'company.employee_count',
            operator: 'greater_than_or_equal',
            value: entities.employee_count_min,
            importance: 'required'
        });
    } else {
        excludedFilters.push({
            field: 'company.employee_count_min',
            reason: 'User did not constrain minimum company size.'
        });
    }

    if (entities.employee_count_max != null) {
        filters.push({
            field: 'company.employee_count',
            operator: 'less_than_or_equal',
            value: entities.employee_count_max,
            importance: 'required'
        });
    } else {
        excludedFilters.push({
            field: 'company.employee_count_max',
            reason: 'User did not constrain maximum company size.'
        });
    }

    if (entities.company_name != null) {
        filters.push({
            field: 'company.name',
            operator: 'normalized_equals',
            value: entities.company_name,
            importance: 'required'
        });
    }

    if (entities.person_name != null) {
        filters.push({
            field: 'person.name',
            operator: 'normalized_equals',
            value: entities.person_name,
            importance: 'required'
        });
    }

    if (entities.email_type != null) {
        filters.push({
            field: 'email.type',
            operator: 'equals',
            value: entities.email_type,
            importance: 'required'
        });
    }

    if (entities.date_range != null && typeof entities.date_range === 'object') {
        if (entities.date_range.from) {
            filters.push({
                field: 'email.date',
                operator: 'date_after',
                value: entities.date_range.from,
                importance: 'required'
            });
        }
        if (entities.date_range.to) {
            filters.push({
                field: 'email.date',
                operator: 'date_before',
                value: entities.date_range.to,
                importance: 'required'
            });
        }
    }

    filters.push({
        field: 'tenant_id',
        operator: 'equals',
        value: context.tenantId,
        importance: 'required',
        _injected: true
    });

    const limit = Math.min(
        Number.isInteger(context.limit) && context.limit > 0 ? context.limit : CONFIG.DEFAULT_LIMIT,
        CONFIG.MAX_LIMIT
    );

    return {
        plan_version: CONFIG.PLAN_VERSION,
        target,
        filters,
        excluded_filters: excludedFilters,
        pagination: {
            limit,
            cursor: context.cursor || null
        },
        ranking: {
            strategy: 'deterministic_retrieval_v1'
        }
    };
}

// ──────────────────────────────────────────────────────────────
// 10. SEARCH PLAN VALIDATION
// ──────────────────────────────────────────────────────────────

function validateSearchPlan(plan) {
    if (!plan || typeof plan !== 'object') {
        return { valid: false, reason: 'Search plan must be an object.' };
    }
    if (!plan.target) {
        return { valid: false, reason: 'Search plan must have a target.' };
    }
    if (!Array.isArray(plan.filters)) {
        return { valid: false, reason: 'Search plan filters must be an array.' };
    }
    for (const f of plan.filters) {
        if (!f.field || !f.operator) {
            return { valid: false, reason: 'Each filter must have field and operator.' };
        }
        if (!CONFIG.APPROVED_OPERATORS.includes(f.operator)) {
            return { valid: false, reason: `Operator "${f.operator}" is not approved.` };
        }
    }
    return { valid: true };
}

// ──────────────────────────────────────────────────────────────
// 11. SOURCE SELECTION
// ──────────────────────────────────────────────────────────────

function selectAdapters(searchPlan /*, context */) {
    const available = Array.from(adapterRegistry.values());
    const matching = available.filter(a => {
        try {
            return typeof a.supports === 'function' ? a.supports(searchPlan) : false;
        } catch (_) {
            return false;
        }
    });
    return matching;
}

// ──────────────────────────────────────────────────────────────
// 12. CANDIDATE NORMALIZATION
// ──────────────────────────────────────────────────────────────

function normalizeCandidate(raw, sourceName) {
    if (!raw || typeof raw !== 'object') return null;

    return {
        person_id: raw.person_id || raw.id || null,
        company_id: raw.company_id || (raw.company && raw.company.company_id) || null,
        name: raw.name || raw.full_name || null,
        job_title: raw.job_title || raw.current_title || raw.jobTitle || null,
        job_title_normalized: raw.job_title_normalized || null,
        company_name: raw.company_name || raw.organization || (raw.company && raw.company.name) || null,
        industry: raw.industry || (raw.company && raw.company.industry) || null,
        location: raw.location || null,
        employee_count: raw.employee_count || (raw.company && raw.company.employee_count) || null,
        email: raw.email || (raw.contact && raw.contact.email) || null,
        company: raw.company || null,
        contact: raw.contact || { email: raw.email || null },
        source: raw.source || sourceName,
        source_record_id: raw.source_record_id || raw.id || null,
        retrieval: {
            source: raw.source || sourceName,
            source_record_id: raw.source_record_id || raw.id || null,
            match_type: raw.match_type || 'normalized',
            retrieval_score: 0,
            matched_filters: []
        }
    };
}

function normalizeAll(sourceResponses) {
    const out = [];
    for (const resp of sourceResponses) {
        if (!resp || !Array.isArray(resp.records)) continue;

        const adapter = getAdapter(resp.source);
        const records = adapter && typeof adapter.normalize === 'function'
            ? adapter.normalize(resp.records)
            : resp.records.map(r => normalizeCandidate(r, resp.source));

        for (const r of records) {
            const n = normalizeCandidate(r, resp.source);
            if (n) out.push(n);
        }
    }
    return out;
}

// ──────────────────────────────────────────────────────────────
// 13. DEDUPLICATION
// ──────────────────────────────────────────────────────────────

function normalizeKeyPart(v) {
    if (v == null) return '';
    return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildCandidateKey(c) {
    if (c.person_id) return `person:${c.person_id}`;
    if (c.email) return `email:${String(c.email).toLowerCase()}`;
    if (c.company && c.company.domain) return `domain:${c.company.domain.toLowerCase()}`;
    return [
        normalizeKeyPart(c.name),
        normalizeKeyPart(c.company_name),
        normalizeKeyPart(c.job_title)
    ].join('|');
}

function deduplicateCandidates(candidates) {
    const byKey = new Map();

    for (const c of candidates) {
        const key = buildCandidateKey(c);
        if (!byKey.has(key)) {
            byKey.set(key, {
                ...c,
                sources: [c.source],
                conflicts: []
            });
            continue;
        }
        const existing = byKey.get(key);

        const fields = ['name', 'job_title', 'company_name', 'industry', 'location', 'email'];
        for (const f of fields) {
            if (existing[f] == null && c[f] != null) {
                existing[f] = c[f];
            }
        }

        if (!existing.sources.includes(c.source)) {
            existing.sources.push(c.source);
        }
    }

    return Array.from(byKey.values());
}

// ──────────────────────────────────────────────────────────────
// 14. RETRIEVAL RANKING
// ──────────────────────────────────────────────────────────────

function scoreCandidate(candidate, plan) {
    let score = 0;
    const matched = [];

    const requiredFilters = (plan.filters || []).filter(f => f.importance === 'required' && !f._injected);

    for (const f of requiredFilters) {
        const value = f.value;
        const norm = v => v == null ? null : String(v).trim().toLowerCase();

        if (f.field === 'person.job_title') {
            if (norm(candidate.job_title) === norm(value)) {
                score += CONFIG.SCORING.EXACT_TITLE_MATCH;
                matched.push('job_title');
            } else if (candidate.job_title && norm(candidate.job_title).includes(norm(value))) {
                score += CONFIG.SCORING.NORMALIZED_TITLE_MATCH;
                matched.push('job_title');
            }
        } else if (f.field === 'company.industry') {
            if (norm(candidate.industry) === norm(value)) {
                score += CONFIG.SCORING.EXACT_INDUSTRY_MATCH;
                matched.push('industry');
            }
        } else if (f.field === 'person.location' || f.field === 'company.location') {
            if (norm(candidate.location) === norm(value)) {
                score += CONFIG.SCORING.EXACT_LOCATION_MATCH;
                matched.push('location');
            } else if (candidate.location && norm(candidate.location).includes(norm(value))) {
                score += CONFIG.SCORING.BROADER_LOCATION_MATCH;
                matched.push('location');
            }
        }
    }

    if (candidate.company_name || candidate.company) {
        score += CONFIG.SCORING.COMPLETE_COMPANY_DATA;
    }
    if (candidate.name && candidate.job_title) {
        score += CONFIG.SCORING.COMPLETE_PERSON_DATA;
    }

    return { score, matched };
}

function rankCandidates(candidates, plan) {
    const ranked = candidates.map(c => {
        const { score, matched } = scoreCandidate(c, plan);
        return {
            ...c,
            retrieval: {
                ...(c.retrieval || {}),
                retrieval_score: score,
                matched_filters: matched
            },
            lead_score: null
        };
    });

    ranked.sort((a, b) => {
        const sa = a.retrieval?.retrieval_score || 0;
        const sb = b.retrieval?.retrieval_score || 0;
        return sb - sa;
    });

    return ranked;
}

// ──────────────────────────────────────────────────────────────
// 15. SOURCE EXECUTION
// ──────────────────────────────────────────────────────────────

async function executeAdapter(adapter, searchPlan, context) {
    const start = Date.now();
    try {
        const result = await adapter.search(searchPlan, context);
        return {
            source: adapter.name,
            ok: true,
            records: Array.isArray(result && result.records) ? result.records : [],
            empty_result_reason: result && result.empty_result_reason ? result.empty_result_reason : null,
            duration_ms: Date.now() - start
        };
    } catch (err) {
        const isTimeout = err && (err.code === 'ETIMEDOUT' || err.name === 'TimeoutError');
        const isRateLimit = err && err.status === 429;
        return {
            source: adapter.name,
            ok: false,
            records: [],
            error_code: isTimeout ? CONFIG.ERROR_CODES.SOURCE_TIMEOUT :
                        isRateLimit ? CONFIG.ERROR_CODES.SOURCE_RATE_LIMITED :
                        CONFIG.ERROR_CODES.SOURCE_UNAVAILABLE,
            error_message: err && err.message ? err.message : 'Unknown adapter error',
            duration_ms: Date.now() - start
        };
    }
}

async function executeAdapters(adapters, searchPlan, context) {
    const settled = await Promise.allSettled(
        adapters.map(a => executeAdapter(a, searchPlan, context))
    );

    return settled.map((s, i) => {
        if (s.status === 'fulfilled') return s.value;
        return {
            source: adapters[i].name,
            ok: false,
            records: [],
            error_code: CONFIG.ERROR_CODES.INTERNAL_ERROR,
            error_message: s.reason && s.reason.message ? s.reason.message : 'Adapter rejected',
            duration_ms: 0
        };
    });
}

// ──────────────────────────────────────────────────────────────
// 16. RESPONSE BUILDERS
// ──────────────────────────────────────────────────────────────

function buildSuccessResponse({ requestId, searchId, intent, searchPlan, candidates, sourceResponses, durationMs }) {
    const succeeded = sourceResponses.filter(s => s.ok).map(s => s.source);
    const failed = sourceResponses.filter(s => !s.ok).map(s => ({
        source: s.source,
        error_code: s.error_code || CONFIG.ERROR_CODES.SOURCE_UNAVAILABLE,
        error_message: s.error_message || null
    }));

    let status = 'SUCCESS';
    if (failed.length > 0 && succeeded.length > 0) {
        status = 'PARTIAL_SUCCESS';
    } else if (failed.length > 0 && succeeded.length === 0) {
        status = 'ERROR';
    }

    const metadata = {
        total_candidates: candidates.length,
        returned_candidates: candidates.length,
        has_more: false,
        sources_attempted: sourceResponses.map(s => s.source),
        sources_succeeded: succeeded,
        sources_failed: failed,
        duration_ms: durationMs
    };

    if (candidates.length === 0) {
        const reasons = sourceResponses
            .map(s => s.empty_result_reason)
            .filter(Boolean);
        metadata.empty_result_reason = reasons[0] || CONFIG.EMPTY_RESULT_REASONS.NO_MATCHING_RECORDS;
    }

    if (status === 'ERROR') {
        return {
            status: 'ERROR',
            request_id: requestId,
            search_id: searchId,
            error: {
                code: failed[0].error_code,
                message: failed[0].error_message || 'All sources failed.',
                retryable: failed[0].error_code === CONFIG.ERROR_CODES.SOURCE_TIMEOUT ||
                           failed[0].error_code === CONFIG.ERROR_CODES.SOURCE_RATE_LIMITED,
                source: failed[0].source
            }
        };
    }

    return {
        status,
        request_id: requestId,
        search_id: searchId,
        schema_version: CONFIG.SCHEMA_VERSION,
        intent,
        search_plan: {
            target: searchPlan.target,
            filters_applied: buildFiltersAppliedView(searchPlan),
            filters_not_applied: searchPlan.excluded_filters.map(e => e.field),
            limit: searchPlan.pagination.limit
        },
        candidates,
        metadata
    };
}

function buildFiltersAppliedView(searchPlan) {
    const view = {};
    for (const f of searchPlan.filters) {
        if (f._injected) continue;
        view[f.field] = f.value;
    }
    return view;
}

function buildClarificationResponse({ requestId, ambiguities }) {
    return {
        status: 'CLARIFICATION_REQUIRED',
        request_id: requestId,
        reason: 'Unresolved ambiguities must be resolved before retrieval.',
        ambiguities: ambiguities || []
    };
}

function buildErrorResponse({ requestId, code, message, retryable = false, source = null }) {
    return {
        status: code === CONFIG.ERROR_CODES.UNSUPPORTED_QUERY ? 'UNSUPPORTED_QUERY' : 'INVALID_REQUEST',
        request_id: requestId,
        error: {
            code,
            message,
            ...(source ? { source } : {}),
            retryable
        }
    };
}

// ──────────────────────────────────────────────────────────────
// 17. MAIN ENTRYPOINT — retrieve()
// ──────────────────────────────────────────────────────────────

async function retrieve(understanding, context = {}) {
    const startTime = Date.now();
    const requestId = context.requestId || (understanding && understanding.requestId) || generateId('req');
    const searchId = generateId('search');

    console.log('═══════════════════════════════════════════════════════');
    console.log('🔍 [RETRIEVAL] Starting retrieval');
    console.log('🔍 [RETRIEVAL] Intent:', understanding?.intent);
    console.log('🔍 [RETRIEVAL] Tenant:', context?.tenantId);
    console.log('═══════════════════════════════════════════════════════');

    const gate = preSearchGate(understanding, context);

    if (!gate.ready_for_retrieval) {
        console.warn('⚠️ [RETRIEVAL] Pre-search gate failed:', gate.reason);
        if (gate.error_code === CONFIG.ERROR_CODES.CLARIFICATION_REQUIRED) {
            return buildClarificationResponse({
                requestId,
                ambiguities: understanding && understanding.ambiguities ? understanding.ambiguities : []
            });
        }
        return buildErrorResponse({
            requestId,
            code: gate.error_code || CONFIG.ERROR_CODES.INVALID_REQUEST,
            message: gate.reason || 'Request failed pre-search validation.',
            retryable: false
        });
    }

    const searchPlan = compileSearchPlan(understanding, context);
    console.log('🔍 [RETRIEVAL] Search plan compiled:', JSON.stringify({
        target: searchPlan.target,
        filterCount: searchPlan.filters.length
    }));

    const planCheck = validateSearchPlan(searchPlan);
    if (!planCheck.valid) {
        console.error('❌ [RETRIEVAL] Search plan invalid:', planCheck.reason);
        return buildErrorResponse({
            requestId,
            code: CONFIG.ERROR_CODES.INVALID_FILTER,
            message: planCheck.reason || 'Invalid search plan.',
            retryable: false
        });
    }

    const adapters = selectAdapters(searchPlan, context);
    console.log('🔍 [RETRIEVAL] Selected adapters:', adapters.map(a => a.name));

    if (adapters.length === 0) {
        return buildSuccessResponse({
            requestId,
            searchId,
            intent: understanding.intent,
            searchPlan,
            candidates: [],
            sourceResponses: [{
                source: 'none',
                ok: true,
                records: [],
                empty_result_reason: CONFIG.EMPTY_RESULT_REASONS.SOURCE_NOT_CONFIGURED,
                duration_ms: 0
            }],
            durationMs: Date.now() - startTime
        });
    }

    const sourceResponses = await executeAdapters(adapters, searchPlan, context);
    console.log('🔍 [RETRIEVAL] Source responses:',
        sourceResponses.map(s => `${s.source}: ${s.records.length} records`));

    const normalizedCandidates = normalizeAll(sourceResponses);
    console.log('🔍 [RETRIEVAL] Normalized:', normalizedCandidates.length, 'candidates');

    const uniqueCandidates = deduplicateCandidates(normalizedCandidates);
    console.log('🔍 [RETRIEVAL] After dedupe:', uniqueCandidates.length, 'unique candidates');

    const rankedCandidates = rankCandidates(uniqueCandidates, searchPlan);
    console.log('🔍 [RETRIEVAL] Ranked:', rankedCandidates.length, 'candidates');

    const response = buildSuccessResponse({
        requestId,
        searchId,
        intent: understanding.intent,
        searchPlan,
        candidates: rankedCandidates,
        sourceResponses,
        durationMs: Date.now() - startTime
    });

    console.log('✅ [RETRIEVAL] Complete. Status:', response.status,
        '| Candidates:', response.candidates?.length || 0,
        '| Duration:', Date.now() - startTime + 'ms');
    console.log('═══════════════════════════════════════════════════════');

    return response;
}

// ──────────────────────────────────────────────────────────────
// 18. DEBUG
// ──────────────────────────────────────────────────────────────

function debug() {
    return {
        version: 'v3',
        schema_version: CONFIG.SCHEMA_VERSION,
        plan_version: CONFIG.PLAN_VERSION,
        supported_intents: CONFIG.SUPPORTED_INTENTS.slice(),
        registered_adapters: listAdapters(),
        max_limit: CONFIG.MAX_LIMIT,
        default_limit: CONFIG.DEFAULT_LIMIT,
        error_codes: Object.keys(CONFIG.ERROR_CODES),
        tavily_configured: !!process.env.TAVILY_API_KEY
    };
}

// ──────────────────────────────────────────────────────────────
// 19. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    retrieve,
    registerAdapter,
    getAdapter,
    listAdapters,
    preSearchGate,
    buildSearchPlan: compileSearchPlan,
    validateRetrievalInput,
    validateSearchPlan,
    compileSearchPlan,
    mapIntentToTarget,
    resolveFieldOwner,
    normalizeCandidate,
    normalizeAll,
    deduplicateCandidates,
    rankCandidates,
    buildCandidateKey,
    buildMongoQuery,
    mapFieldToMongo,
    buildTavilyQuery,
    parseTavilyResults,
    debug,
    CONFIG
};
