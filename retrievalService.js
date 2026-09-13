'use strict';

// ──────────────────────────────────────────────────────────────
// retrievalService.js
// Layer 5: Retrieval and Search Execution
//
// Version: v1
// Schema: retrieval.v1
//
// PURPOSE:
//   Receive the validated output of Layer 4 (Understanding.js),
//   convert it into a deterministic search plan, execute that plan
//   against registered adapters, normalize, deduplicate, rank, and
//   return candidate records.
//
// ARCHITECTURE RULES (from Layer 5 design document):
//   - No LLM. Fully deterministic.
//   - No enrichment, verification, scoring, or formatting.
//   - Never guess; never silently drop a filter.
//   - Empty results are SUCCESS, not errors.
//   - Partial source failures must be visible.
//   - Provider details live behind adapters.
//   - Never throws — always returns a structured response.
//
// EXPORTS:
//   retrieve(understanding, context)
//   registerAdapter(name, adapter)
//   getAdapter(name)
//   listAdapters()
//   preSearchGate(understanding, context)
//   buildSearchPlan(understanding, context)
//   debug()
//   CONFIG
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

    // Field ownership resolution (§9.5)
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

    // Approved operators only (§10.3)
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

    // Retrieval scoring weights (§16.2)
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
    }
};

// ──────────────────────────────────────────────────────────────
// 2. ID GENERATION (no external deps)
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
// 3. ADAPTER REGISTRY (§11)
// ──────────────────────────────────────────────────────────────

const adapterRegistry = new Map();

/**
 * Register a search adapter.
 * Adapter contract:
 *   {
 *     name: string,
 *     supports(searchPlan): boolean,
 *     search(searchPlan, context): Promise<{ records: any[] }>,
 *     normalize(records): Array<CanonicalCandidate>
 *   }
 */
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
// 4. STUB ADAPTER (default, no external deps)
//
// Purpose: allow the full Layer 5 pipeline to run end-to-end
// without a real data source. Real adapters can be registered
// later without touching Free.js.
// ──────────────────────────────────────────────────────────────

const stubAdapter = {
    name: 'internal_people_index',
    supports(searchPlan) {
        return searchPlan && typeof searchPlan.target === 'string';
    },
    async search(/* searchPlan, context */) {
        return {
            records: [],
            empty_result_reason: CONFIG.EMPTY_RESULT_REASONS.SOURCE_NOT_CONFIGURED
        };
    },
    normalize(records) {
        return Array.isArray(records) ? records : [];
    }
};

registerAdapter('internal_people_index', stubAdapter);

// ──────────────────────────────────────────────────────────────
// 5. REQUEST VALIDATION (§9.2, §7.3)
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

    // Numeric range validation
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
// 6. PRE-SEARCH GATE (§9.3, §9.4)
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

    // Ambiguities must be resolved before retrieval (§9.3)
    if (Array.isArray(understanding.ambiguities) && understanding.ambiguities.length > 0) {
        result.error_code = CONFIG.ERROR_CODES.CLARIFICATION_REQUIRED;
        result.reason = 'Unresolved ambiguities present.';
        return result;
    }
    result.ambiguities_resolved = true;

    // Tenant context — must be provided by trusted backend, not by the LLM (§20.1)
    if (!context || typeof context.tenantId !== 'string' || context.tenantId.trim().length === 0) {
        result.error_code = CONFIG.ERROR_CODES.PERMISSION_DENIED;
        result.reason = 'Missing authenticated tenant context.';
        return result;
    }
    result.authorization_valid = true;

    // Required fields — target must be derivable
    if (!CONFIG.INTENT_TARGET_MAP[understanding.intent]) {
        result.error_code = CONFIG.ERROR_CODES.UNSUPPORTED_QUERY;
        result.reason = 'No target mapping for intent.';
        return result;
    }
    result.required_fields_present = true;

    // Employee range
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
// 7. INTENT → TARGET (§9.4)
// ──────────────────────────────────────────────────────────────

function mapIntentToTarget(intent) {
    return CONFIG.INTENT_TARGET_MAP[intent] || null;
}

// ──────────────────────────────────────────────────────────────
// 8. FIELD OWNERSHIP RESOLUTION (§9.5)
// ──────────────────────────────────────────────────────────────

function resolveFieldOwner(field) {
    return CONFIG.FIELD_OWNERSHIP[field] || null;
}

// ──────────────────────────────────────────────────────────────
// 9. SEARCH PLAN COMPILER (§9.6, §10)
// ──────────────────────────────────────────────────────────────

function compileSearchPlan(understanding, context = {}) {
    const target = mapIntentToTarget(understanding.intent);
    const entities = understanding.entities || {};
    const filters = [];
    const excludedFilters = [];

    // job_title
    if (entities.job_title != null) {
        filters.push({
            field: 'person.job_title',
            operator: 'normalized_equals',
            value: entities.job_title,
            importance: 'required'
        });
    }

    // industry
    if (entities.industry != null) {
        filters.push({
            field: 'company.industry',
            operator: 'normalized_equals',
            value: entities.industry,
            importance: 'required'
        });
    }

    // location — owner depends on target (§12.2)
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

    // employee_count_min
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

    // employee_count_max
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

    // company_name
    if (entities.company_name != null) {
        filters.push({
            field: 'company.name',
            operator: 'normalized_equals',
            value: entities.company_name,
            importance: 'required'
        });
    }

    // person_name
    if (entities.person_name != null) {
        filters.push({
            field: 'person.name',
            operator: 'normalized_equals',
            value: entities.person_name,
            importance: 'required'
        });
    }

    // email_type
    if (entities.email_type != null) {
        filters.push({
            field: 'email.type',
            operator: 'equals',
            value: entities.email_type,
            importance: 'required'
        });
    }

    // date_range
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

    // Security filter — injected from trusted context (§9.7, §20.1)
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
// 10. SEARCH PLAN VALIDATION (§10.3)
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
// 11. SOURCE SELECTION (§9.8)
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
// 12. CANDIDATE NORMALIZATION (§14)
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
        for (const r of resp.records) {
            const n = normalizeCandidate(r, resp.source);
            if (n) out.push(n);
        }
    }
    return out;
}

// ──────────────────────────────────────────────────────────────
// 13. DEDUPLICATION (§15)
// ──────────────────────────────────────────────────────────────

function normalizeKeyPart(v) {
    if (v == null) return '';
    return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildCandidateKey(c) {
    if (c.person_id) return `person:${c.person_id}`;
    if (c.email) return `email:${String(c.email).toLowerCase()}`;
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

        // Merge non-null fields, preserve conflicts
        const fields = ['name', 'job_title', 'company_name', 'industry', 'location', 'email'];
        for (const f of fields) {
            if (existing[f] == null && c[f] != null) {
                existing[f] = c[f];
            } else if (existing[f] != null && c[f] != null && existing[f] !== c[f]) {
                const conflict = existing.conflicts.find(x => x.field === f);
                const values = conflict ? conflict.values : [existing[f]];
                if (!values.includes(c[f])) values.push(c[f]);
                if (conflict) {
                    conflict.values = values;
                } else {
                    existing.conflicts.push({ field: f, values });
                }
            }
        }

        if (!existing.sources.includes(c.source)) {
            existing.sources.push(c.source);
        }
    }

    return Array.from(byKey.values());
}

// ──────────────────────────────────────────────────────────────
// 14. RETRIEVAL RANKING (§16)
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
            // Explicitly null — belongs to a later layer
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
// 15. SOURCE EXECUTION (§9.8, §9.9)
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
// 16. RESPONSE BUILDERS (§8)
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

    // ── Step 1: Pre-search gate ──
    const gate = preSearchGate(understanding, context);

    if (!gate.ready_for_retrieval) {
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

    // ── Step 2: Compile search plan ──
    const searchPlan = compileSearchPlan(understanding, context);

    // ── Step 3: Validate search plan ──
    const planCheck = validateSearchPlan(searchPlan);
    if (!planCheck.valid) {
        return buildErrorResponse({
            requestId,
            code: CONFIG.ERROR_CODES.INVALID_FILTER,
            message: planCheck.reason || 'Invalid search plan.',
            retryable: false
        });
    }

    // ── Step 4: Select adapters ──
    const adapters = selectAdapters(searchPlan, context);

    // If no adapters match the target, return empty success (not error) —
    // this keeps the pipeline flowing and lets the next layer decide.
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

    // ── Step 5: Execute adapters ──
    const sourceResponses = await executeAdapters(adapters, searchPlan, context);

    // ── Step 6: Normalize ──
    const normalizedCandidates = normalizeAll(sourceResponses);

    // ── Step 7: Deduplicate ──
    const uniqueCandidates = deduplicateCandidates(normalizedCandidates);

    // ── Step 8: Rank ──
    const rankedCandidates = rankCandidates(uniqueCandidates, searchPlan);

    // ── Step 9: Build response ──
    return buildSuccessResponse({
        requestId,
        searchId,
        intent: understanding.intent,
        searchPlan,
        candidates: rankedCandidates,
        sourceResponses,
        durationMs: Date.now() - startTime
    });
}

// ──────────────────────────────────────────────────────────────
// 18. DEBUG
// ──────────────────────────────────────────────────────────────

function debug() {
    return {
        version: 'v1',
        schema_version: CONFIG.SCHEMA_VERSION,
        plan_version: CONFIG.PLAN_VERSION,
        supported_intents: CONFIG.SUPPORTED_INTENTS.slice(),
        registered_adapters: listAdapters(),
        max_limit: CONFIG.MAX_LIMIT,
        default_limit: CONFIG.DEFAULT_LIMIT,
        error_codes: Object.keys(CONFIG.ERROR_CODES)
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
    debug,
    CONFIG
};
