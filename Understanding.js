// ──────────────────────────────────────────────────────────────
// UNDERSTANDING.JS — Layer 1: Query Understanding Service
// Version: v1.0.0
// 
// PURPOSE: Transform natural language query → validated JSON
// 
// RESPONSIBILITIES:
// - Intent classification (enum)
// - Entity extraction (typed, nullable)
// - Ambiguity detection (including location ambiguity)
// - Query normalization
// - Schema enforcement (strict)
// - Retry on validation failure (max 3 attempts)
// - Fallback behavior (no crashes)
// - No side effects (no external calls)
// - Structured logging (sanitized)
// - Rate limiting (distributed-ready)
// - Schema versioning
// - HTTP 429 for rate limits (not fallback)
// - Transport retries separated from schema retries
// ──────────────────────────────────────────────────────────────

const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ──────────────────────────────────────────────────────────────
// 1. CONFIGURATION
// ──────────────────────────────────────────────────────────────

const CONFIG = {
    // ── LLM ──
    MODEL: 'gpt-4o-mini',
    TEMPERATURE: 0.1,
    MAX_TOKENS: 800,

    // ── Schema retries (for invalid JSON/schema violations) ──
    MAX_SCHEMA_RETRIES: 3,
    SCHEMA_RETRY_BACKOFF_MS: 500,

    // ── Transport retries (for network/timeout/provider errors) ──
    MAX_TRANSPORT_RETRIES: 2,
    TRANSPORT_RETRY_BACKOFF_MS: 1000,
    TRANSPORT_RETRY_MULTIPLIER: 2,

    // ── Input limits ──
    MAX_QUERY_LENGTH: 2000,

    // ── Rate limiting ──
    RATE_LIMIT_WINDOW_MS: 60000,
    MAX_REQUESTS_PER_TENANT: 100,
    MAX_REQUESTS_PER_USER: 50,

    // ── Schema ──
    SCHEMA_VERSION: 'v1',
    SCHEMA_FILE: 'understanding.v1.json',

    // ── Logging ──
    LOG_RAW_OUTPUT: false,
    LOG_PII: false,
};

// ──────────────────────────────────────────────────────────────
// 2. DISTRIBUTED RATE LIMITER (Redis-compatible interface)
// ──────────────────────────────────────────────────────────────

class RateLimiter {
    constructor(store = null) {
        this.store = store || new Map();
        this.windowMs = CONFIG.RATE_LIMIT_WINDOW_MS;
        this.tenantLimit = CONFIG.MAX_REQUESTS_PER_TENANT;
        this.userLimit = CONFIG.MAX_REQUESTS_PER_USER;
        this.isDistributed = store !== null;
    }

    async check(tenantId, userId) {
        const now = Date.now();
        const windowMs = this.windowMs;

        const tenantKey = `rate:tenant:${this.hashId(tenantId)}`;
        const tenantCount = await this.getCount(tenantKey, now, windowMs);
        if (tenantCount >= this.tenantLimit) {
            return {
                allowed: false,
                reason: 'Tenant rate limit exceeded',
                limit: this.tenantLimit,
                windowMs: windowMs,
                resetAt: new Date(now + windowMs).toISOString()
            };
        }
        await this.increment(tenantKey, now, windowMs);

        const userKey = `rate:user:${this.hashId(userId)}`;
        const userCount = await this.getCount(userKey, now, windowMs);
        if (userCount >= this.userLimit) {
            return {
                allowed: false,
                reason: 'User rate limit exceeded',
                limit: this.userLimit,
                windowMs: windowMs,
                resetAt: new Date(now + windowMs).toISOString()
            };
        }
        await this.increment(userKey, now, windowMs);

        return { allowed: true };
    }

    async getCount(key, now, windowMs) {
        if (this.isDistributed && this.store.get) {
            const data = await this.store.get(key);
            if (!data) return 0;
            const parsed = JSON.parse(data);
            const cutoff = now - windowMs;
            const valid = parsed.filter(t => t > cutoff);
            return valid.length;
        } else {
            if (!this.store.has(key)) return 0;
            const data = this.store.get(key);
            const cutoff = now - windowMs;
            const valid = data.filter(t => t > cutoff);
            this.store.set(key, valid);
            return valid.length;
        }
    }

    async increment(key, now, windowMs) {
        if (this.isDistributed && this.store.set) {
            const data = await this.store.get(key);
            let parsed = data ? JSON.parse(data) : [];
            parsed.push(now);
            const cutoff = now - windowMs;
            parsed = parsed.filter(t => t > cutoff);
            await this.store.set(key, JSON.stringify(parsed), windowMs / 1000);
        } else {
            if (!this.store.has(key)) {
                this.store.set(key, []);
            }
            const data = this.store.get(key);
            data.push(now);
            const cutoff = now - windowMs;
            this.store.set(key, data.filter(t => t > cutoff));
        }
    }

    hashId(id) {
        return crypto.createHash('sha256').update(id).digest('hex').substring(0, 16);
    }

    cleanup() {
        if (this.isDistributed) return;
        const now = Date.now();
        const windowMs = this.windowMs;
        for (const [key, timestamps] of this.store) {
            const filtered = timestamps.filter(t => now - t < windowMs);
            if (filtered.length === 0) {
                this.store.delete(key);
            } else {
                this.store.set(key, filtered);
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────
// 3. JSON SCHEMA — understanding.v1 (strict)
// ──────────────────────────────────────────────────────────────

function loadSchema() {
    try {
        const schemaPath = path.join(__dirname, 'understanding.v1.json');
        if (fs.existsSync(schemaPath)) {
            return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
        }
    } catch (error) {
        console.warn('[UNDERSTANDING] Could not load schema file, using embedded schema');
    }

    return {
        $schema: 'http://json-schema.org/draft-07/schema#',
        $id: 'https://skyline.ai/schemas/understanding.v1.json',
        title: 'Understanding Schema v1',
        description: 'Structured understanding of a natural language query',
        version: '1.0.0',
        type: 'object',
        required: ['intent', 'confidence', 'entities', 'ambiguities', 'normalized_query'],
        additionalProperties: false,
        properties: {
            intent: {
                type: 'string',
                enum: [
                    'ICP_SEARCH',
                    'PERSON_SEARCH',
                    'COMPANY_SEARCH',
                    'EMAIL_FILTER',
                    'THREAD_SUMMARY',
                    'ATTACHMENT_SEARCH',
                    'ACTION_REQUIRED',
                    'UNKNOWN'
                ]
            },
            confidence: {
                type: 'number',
                minimum: 0,
                maximum: 1
            },
            entities: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    job_title: { type: ['string', 'null'] },
                    industry: { type: ['string', 'null'] },
                    location: { type: ['string', 'null'] },
                    employee_count_min: { type: ['integer', 'null'], minimum: 0 },
                    employee_count_max: { type: ['integer', 'null'], minimum: 0 },
                    person_name: { type: ['string', 'null'] },
                    company_name: { type: ['string', 'null'] },
                    email_type: { type: ['string', 'null'] },
                    date_range: {
                        type: ['object', 'null'],
                        additionalProperties: false,
                        properties: {
                            from: { type: 'string', format: 'date' },
                            to: { type: 'string', format: 'date' }
                        }
                    }
                }
            },
            ambiguities: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['field', 'issue', 'candidates'],
                    additionalProperties: false,
                    properties: {
                        field: { type: 'string' },
                        issue: { type: 'string' },
                        candidates: {
                            type: 'array',
                            items: { type: 'string' }
                        }
                    }
                }
            },
            normalized_query: {
                type: 'string'
            }
        }
    };
}

const UNDERSTANDING_SCHEMA = loadSchema();

// ──────────────────────────────────────────────────────────────
// 4. STRICT DATE VALIDATOR
// ──────────────────────────────────────────────────────────────

function isValidDateString(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return false;
    const dateRegex = /^(\d{4})-(\d{2})-(\d{2})$/;
    const match = dateStr.match(dateRegex);
    if (!match) return false;

    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);

    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;

    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day;
}

// ──────────────────────────────────────────────────────────────
// 5. LOGGER (Sanitized)
// ──────────────────────────────────────────────────────────────

class Logger {
    constructor(correlationId) {
        this.correlationId = correlationId || `und-${uuidv4().substring(0, 8)}`;
        this.logs = [];
    }

    log(level, message, data = {}) {
        const sanitized = this.sanitize(data);

        const entry = {
            timestamp: new Date().toISOString(),
            level: level,
            correlationId: this.correlationId,
            message: message,
            ...sanitized
        };

        this.logs.push(entry);
        console.log(JSON.stringify(entry));
        return entry;
    }

    sanitize(data) {
        const result = {};

        for (const [key, value] of Object.entries(data)) {
            if (['password', 'token', 'secret', 'apiKey', 'authorization'].includes(key.toLowerCase())) {
                result[key] = '[REDACTED]';
                continue;
            }

            if (!CONFIG.LOG_PII && (key === 'userId' || key === 'user_id' || key === 'tenantId' || key === 'tenant_id')) {
                result[key] = this.hashId(value);
                continue;
            }

            if (!CONFIG.LOG_RAW_OUTPUT && (key === 'rawOutput' || key === 'rawContent')) {
                result[key] = value ? `${value.substring(0, 100)}...[TRUNCATED]` : null;
                continue;
            }

            if (typeof value === 'string' && value.length > 500) {
                result[key] = value.substring(0, 500) + '...[TRUNCATED]';
                continue;
            }

            if (value && typeof value === 'object' && !Array.isArray(value)) {
                result[key] = this.sanitize(value);
                continue;
            }

            result[key] = value;
        }

        return result;
    }

    hashId(id) {
        if (!id || typeof id !== 'string') return 'unknown';
        return crypto.createHash('sha256').update(id).digest('hex').substring(0, 16);
    }

    getLogs() {
        return this.logs;
    }

    clear() {
        this.logs = [];
    }
}

// ──────────────────────────────────────────────────────────────
// 6. STRICT VALIDATOR (No crashes)
// ──────────────────────────────────────────────────────────────

function validateUnderstanding(data) {
    const errors = [];

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return {
            valid: false,
            errors: ['Data must be a non-null object']
        };
    }

    const required = ['intent', 'confidence', 'entities', 'ambiguities', 'normalized_query'];
    for (const field of required) {
        if (!(field in data) || data[field] === undefined || data[field] === null) {
            errors.push(`Missing required field: ${field}`);
        }
    }

    const validIntents = [
        'ICP_SEARCH', 'PERSON_SEARCH', 'COMPANY_SEARCH',
        'EMAIL_FILTER', 'THREAD_SUMMARY', 'ATTACHMENT_SEARCH',
        'ACTION_REQUIRED', 'UNKNOWN'
    ];
    if (data.intent && !validIntents.includes(data.intent)) {
        errors.push(`Invalid intent: ${data.intent}. Must be one of: ${validIntents.join(', ')}`);
    }

    if (data.confidence !== undefined && data.confidence !== null) {
        if (typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 1) {
            errors.push('Confidence must be a number between 0 and 1');
        }
    }

    if (data.entities) {
        if (typeof data.entities !== 'object' || Array.isArray(data.entities)) {
            errors.push('entities must be an object');
        } else {
            const entityFields = [
                'job_title', 'industry', 'location', 'person_name', 'company_name', 'email_type'
            ];
            for (const field of entityFields) {
                if (field in data.entities && data.entities[field] !== null && typeof data.entities[field] !== 'string') {
                    errors.push(`entities.${field} must be a string or null`);
                }
            }

            if ('employee_count_min' in data.entities && data.entities.employee_count_min !== null) {
                if (typeof data.entities.employee_count_min !== 'number' ||
                    !Number.isInteger(data.entities.employee_count_min) ||
                    data.entities.employee_count_min < 0) {
                    errors.push('entities.employee_count_min must be a non-negative integer or null');
                }
            }
            if ('employee_count_max' in data.entities && data.entities.employee_count_max !== null) {
                if (typeof data.entities.employee_count_max !== 'number' ||
                    !Number.isInteger(data.entities.employee_count_max) ||
                    data.entities.employee_count_max < 0) {
                    errors.push('entities.employee_count_max must be a non-negative integer or null');
                }
            }
            if (data.entities.employee_count_min !== null && data.entities.employee_count_max !== null) {
                if (data.entities.employee_count_min > data.entities.employee_count_max) {
                    errors.push('entities.employee_count_min must be <= employee_count_max');
                }
            }

            if ('date_range' in data.entities && data.entities.date_range !== null) {
                if (typeof data.entities.date_range !== 'object' || Array.isArray(data.entities.date_range)) {
                    errors.push('entities.date_range must be an object or null');
                } else {
                    if (data.entities.date_range.from !== undefined && data.entities.date_range.from !== null) {
                        if (!isValidDateString(data.entities.date_range.from)) {
                            errors.push(`entities.date_range.from must be a valid date in YYYY-MM-DD format, got: ${data.entities.date_range.from}`);
                        }
                    }
                    if (data.entities.date_range.to !== undefined && data.entities.date_range.to !== null) {
                        if (!isValidDateString(data.entities.date_range.to)) {
                            errors.push(`entities.date_range.to must be a valid date in YYYY-MM-DD format, got: ${data.entities.date_range.to}`);
                        }
                    }
                    if (data.entities.date_range.from && data.entities.date_range.to) {
                        const from = new Date(data.entities.date_range.from + 'T00:00:00Z');
                        const to = new Date(data.entities.date_range.to + 'T00:00:00Z');
                        if (!isNaN(from) && !isNaN(to) && from > to) {
                            errors.push('entities.date_range.from must be <= to');
                        }
                    }
                }
            }
        }
    }

    if (!Array.isArray(data.ambiguities)) {
        errors.push('ambiguities must be an array');
    } else {
        for (let i = 0; i < data.ambiguities.length; i++) {
            const amb = data.ambiguities[i];
            if (!amb || typeof amb !== 'object' || Array.isArray(amb)) {
                errors.push(`ambiguities[${i}] must be an object`);
                continue;
            }
            if (!amb.field || typeof amb.field !== 'string') {
                errors.push(`ambiguities[${i}].field is required and must be a string`);
            }
            if (!amb.issue || typeof amb.issue !== 'string') {
                errors.push(`ambiguities[${i}].issue is required and must be a string`);
            }
            if (!Array.isArray(amb.candidates)) {
                errors.push(`ambiguities[${i}].candidates must be an array`);
            } else {
                for (const candidate of amb.candidates) {
                    if (typeof candidate !== 'string') {
                        errors.push(`ambiguities[${i}].candidates items must be strings`);
                    }
                }
            }
        }
    }

    if (data.normalized_query !== undefined && data.normalized_query !== null && typeof data.normalized_query !== 'string') {
        errors.push('normalized_query must be a string');
    }

    const allowed = ['intent', 'confidence', 'entities', 'ambiguities', 'normalized_query'];
    for (const key of Object.keys(data)) {
        if (!allowed.includes(key)) {
            errors.push(`Additional property not allowed: ${key}`);
        }
    }

    return {
        valid: errors.length === 0,
        errors: errors
    };
}

// ──────────────────────────────────────────────────────────────
// 7. FALLBACK RESPONSE (No _meta)
// ──────────────────────────────────────────────────────────────

function getFallbackResponse() {
    return {
        intent: 'UNKNOWN',
        confidence: 0.0,
        entities: {},
        ambiguities: [],
        normalized_query: ''
    };
}

// ──────────────────────────────────────────────────────────────
// 8. SYSTEM PROMPT — WITH LOCATION AMBIGUITY DETECTION
// ──────────────────────────────────────────────────────────────

function buildSystemPrompt(schemaVersion) {
    return `You are a query-understanding model. Your ONLY job is to convert the user's natural-language request into a strict JSON object that matches the provided JSON Schema.

Rules:
- Output ONLY valid JSON. No markdown, no explanations, no code fences.
- Use the exact field names and types from the schema.
- For unknown values, use null instead of guessing.
- If the request is ambiguous, populate the "ambiguities" array.
- Do not invent entities or fields that are not in the schema.
- Do not perform any external actions. You only analyze text.

INTENT DEFINITIONS:
- ICP_SEARCH: Ideal Customer Profile search (company criteria, industry, location, size)
- PERSON_SEARCH: Find specific people by role, company, or location
- COMPANY_SEARCH: Find companies by criteria
- EMAIL_FILTER: Filter existing emails by criteria
- THREAD_SUMMARY: Summarize a conversation thread
- ATTACHMENT_SEARCH: Find specific attachments
- ACTION_REQUIRED: Find emails needing action
- UNKNOWN: Fallback for unclear or out-of-scope requests

╔══════════════════════════════════════════════════════════════════╗
║     LOCATION AMBIGUITY DETECTION — CRITICAL RULES              ║
╚══════════════════════════════════════════════════════════════════╝

You MUST detect location ambiguity and ask clarifying questions.

1. CITY NAME WITH MULTIPLE WELL-KNOWN MATCHES:
   - "London" → Could be London, UK OR London, Ontario, Canada
   - "Paris" → Could be Paris, France OR Paris, Texas, USA
   - "Moscow" → Could be Moscow, Russia OR Moscow, Idaho, USA
   - "Birmingham" → Could be Birmingham, UK OR Birmingham, Alabama, USA
   - "Manchester" → Could be Manchester, UK OR Manchester, New Hampshire, USA
   → ASK: "Which London do you mean? London, UK or London, Canada?"

2. CITY ABBREVIATIONS / SHORT FORMS:
   - "SF" → San Francisco OR South Florida
   - "LA" → Los Angeles OR Latin America (in some contexts)
   - "DC" → Washington, DC OR District of Columbia
   - "NYC" → Usually clear (New York City) — no need to ask
   - "Vegas" → Las Vegas, NV
   → ASK: "Do you mean San Francisco or South Florida?"

3. VAGUE OR OVERLAPPING REGION NAMES:
   - "Bay Area" → San Francisco Bay Area OR other bay areas (e.g., Tampa Bay)
   - "Tri-State Area" → NY/NJ/CT OR other tri-state regions
   - "Midwest" → US Midwest (very broad — need country context)
   - "South", "North" → Extremely broad without country context
   → ASK: "Which bay area do you mean? San Francisco Bay Area or another?"

4. COUNTRY NAMES THAT ARE AMBIGUOUS OR CONFUSED:
   - "Georgia" → Country (Georgia) OR US State (Georgia)
   - "Turkey" vs "Türkiye" → Same country, different naming
   - "Congo" → Democratic Republic of the Congo OR Republic of the Congo
   - "Guinea" → Guinea, Equatorial Guinea, Guinea-Bissau
   → ASK: "Do you mean the country Georgia or the US state of Georgia?"

5. "REMOTE" / "WORLDWIDE" VS SPECIFIC LOCATION:
   - "Remote" → Anywhere in the world OR Remote but US-only OR Remote but Europe-only
   - "Worldwide" → Truly global OR Global but mainly US/EU
   → ASK: "Do you mean remote anywhere in the world, or remote within a specific region?"

6. LOCATION IMPLIED BY OFFICE NAMES OR HQ:
   - "Headquarters" → Which HQ if the company has multiple?
   - "Main office" → Same issue
   → ASK: "Which headquarters location do you mean?"

7. LOCATION TIED TO TIME ZONE INSTEAD OF PLACE:
   - "EST" → Eastern US, Eastern Canada, Eastern Australia, etc.
   - "PST" → Pacific US, Pacific Canada
   - "GMT+1" → Multiple regions share this timezone (UK, Portugal, West Africa, etc.)
   → ASK: "Which region do you mean by EST? Eastern US, Eastern Canada, or Eastern Australia?"

┌─────────────────────────────────────────────────────────────────┐
│  HOW TO RESPOND WHEN LOCATION IS AMBIGUOUS                    │
├─────────────────────────────────────────────────────────────────┤
│ 1. Set "confidence" to a lower value (0.4 - 0.6)              │
│ 2. Add an entry to "ambiguities" with:                         │
│    - field: "location"                                        │
│    - issue: "Description of the ambiguity"                    │
│    - candidates: ["Option 1", "Option 2", "Option 3"]         │
│ 3. Set "intent" to "UNKNOWN" until clarified                 │
│ 4. Keep the "location" field as null                         │
└─────────────────────────────────────────────────────────────────┘

EXAMPLES:

Example 1 — City ambiguity:
User: "Find CEOs in London"
→ "ambiguities": [{
    "field": "location",
    "issue": "London could refer to London, UK or London, Ontario, Canada.",
    "candidates": ["London, UK", "London, Canada"]
}]

Example 2 — City abbreviation:
User: "Find SaaS companies in SF"
→ "ambiguities": [{
    "field": "location",
    "issue": "SF could mean San Francisco or South Florida.",
    "candidates": ["San Francisco, CA", "South Florida"]
}]

Example 3 — Vague region:
User: "Find CTOs in the Bay Area"
→ "ambiguities": [{
    "field": "location",
    "issue": "Bay Area could mean San Francisco Bay Area or other bay areas.",
    "candidates": ["San Francisco Bay Area", "Tampa Bay Area", "Other"]
}]

Example 4 — Country vs State:
User: "Find founders in Georgia"
→ "ambiguities": [{
    "field": "location",
    "issue": "Georgia could mean the country or the US state.",
    "candidates": ["Georgia (country)", "Georgia, USA"]
}]

Example 5 — Remote ambiguity:
User: "Find remote developers"
→ "ambiguities": [{
    "field": "location",
    "issue": "Remote could mean anywhere globally, US-only, or Europe-only.",
    "candidates": ["Global (anywhere)", "US only", "Europe only"]
}]

Example 6 — Timezone ambiguity:
User: "Find companies in EST"
→ "ambiguities": [{
    "field": "location",
    "issue": "EST could refer to Eastern US, Eastern Canada, or Eastern Australia.",
    "candidates": ["Eastern US", "Eastern Canada", "Eastern Australia"]
}]

SCHEMA VERSION: ${schemaVersion}

JSON Schema:
${JSON.stringify(UNDERSTANDING_SCHEMA, null, 2)}`;
}

// ──────────────────────────────────────────────────────────────
// 9. USER PROMPT BUILDER
// ──────────────────────────────────────────────────────────────

function buildUserPrompt(query, tenantId, userId, conversationId, locale, timezone) {
    const prompt = {
        query: query,
        tenant_id: tenantId,
        user_id: userId
    };

    if (conversationId) {
        prompt.conversation_id = conversationId;
    }
    if (locale) {
        prompt.locale = locale;
    }
    if (timezone) {
        prompt.timezone = timezone;
    }

    return JSON.stringify(prompt, null, 2);
}

// ──────────────────────────────────────────────────────────────
// 10. TRANSPORT RETRY (Separate from schema retry)
// ──────────────────────────────────────────────────────────────

async function callWithTransportRetry(openaiClient, messages, logger, attempt) {
    const maxRetries = CONFIG.MAX_TRANSPORT_RETRIES;
    let lastError = null;
    let delay = CONFIG.TRANSPORT_RETRY_BACKOFF_MS;

    for (let retry = 0; retry <= maxRetries; retry++) {
        try {
            const startTime = Date.now();
            const response = await openaiClient.chat.completions.create({
                model: CONFIG.MODEL,
                messages: messages,
                temperature: CONFIG.TEMPERATURE,
                max_tokens: CONFIG.MAX_TOKENS,
                response_format: { type: 'json_object' }
            });
            const llmTimeMs = Date.now() - startTime;

            logger.log('INFO', 'LLM response received', {
                attempt: attempt,
                transportRetry: retry,
                llmTimeMs: llmTimeMs,
                responseLength: response.choices[0].message.content.length
            });

            return {
                success: true,
                response: response,
                transportRetries: retry,
                llmTimeMs: llmTimeMs
            };

        } catch (error) {
            lastError = error;

            if (error.status === 401 || error.status === 403) {
                logger.log('ERROR', 'LLM auth error (non-retryable)', {
                    status: error.status,
                    message: error.message
                });
                return {
                    success: false,
                    error: error,
                    transportRetries: retry,
                    isRetryable: false
                };
            }

            const isRetryable = error.status >= 500 ||
                error.status === 429 ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ECONNRESET';

            if (!isRetryable || retry >= maxRetries) {
                logger.log('ERROR', 'LLM call failed (final)', {
                    attempt: attempt,
                    transportRetry: retry,
                    error: error.message,
                    status: error.status,
                    isRetryable: isRetryable
                });
                return {
                    success: false,
                    error: error,
                    transportRetries: retry,
                    isRetryable: isRetryable
                };
            }

            logger.log('WARN', 'LLM transport retry', {
                attempt: attempt,
                transportRetry: retry,
                delayMs: delay,
                error: error.message
            });

            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= CONFIG.TRANSPORT_RETRY_MULTIPLIER;
        }
    }

    return {
        success: false,
        error: lastError,
        transportRetries: maxRetries,
        isRetryable: false
    };
}

// ──────────────────────────────────────────────────────────────
// 11. SCHEMA RETRY (Separate from transport retry)
// ──────────────────────────────────────────────────────────────

async function processWithSchemaRetry(userQuery, tenantId, userId, conversationId, locale, timezone, openaiClient, logger, onProgress) {
    let lastError = null;
    let lastOutput = null;
    const schemaErrors = [];

    for (let attempt = 1; attempt <= CONFIG.MAX_SCHEMA_RETRIES; attempt++) {
        logger.log('INFO', 'Schema attempt started', {
            attempt: attempt,
            maxAttempts: CONFIG.MAX_SCHEMA_RETRIES,
            queryLength: userQuery.length
        });

        const systemPrompt = buildSystemPrompt(CONFIG.SCHEMA_VERSION);
        const userPrompt = buildUserPrompt(userQuery, tenantId, userId, conversationId, locale, timezone);

        let finalSystemPrompt = systemPrompt;
        if (attempt > 1 && schemaErrors.length > 0) {
            const feedback = `\n\nPREVIOUS ATTEMPTS FAILED SCHEMA VALIDATION. ERRORS:\n${schemaErrors.join('; ')}\n\nPlease fix these issues and output valid JSON matching the schema.`;
            finalSystemPrompt += feedback;
        }

        const messages = [
            { role: 'system', content: finalSystemPrompt },
            { role: 'user', content: userPrompt }
        ];

        const transportResult = await callWithTransportRetry(openaiClient, messages, logger, attempt);

        if (!transportResult.success) {
            logger.log('WARN', 'Transport retry exhausted', {
                attempt: attempt,
                error: transportResult.error?.message
            });
            continue;
        }

        const rawContent = transportResult.response.choices[0].message.content;
        if (CONFIG.LOG_RAW_OUTPUT) {
            logger.log('DEBUG', 'Raw LLM output', {
                attempt: attempt,
                rawContent: rawContent
            });
        }

        let parsed;
        try {
            parsed = JSON.parse(rawContent);
        } catch (parseError) {
            const errorMsg = `JSON parse error: ${parseError.message}`;
            schemaErrors.push(errorMsg);
            lastError = errorMsg;
            lastOutput = rawContent;
            logger.log('WARN', 'JSON parse failed', {
                attempt: attempt,
                error: errorMsg
            });
            continue;
        }

        const validation = validateUnderstanding(parsed);
        if (validation.valid) {
            logger.log('INFO', 'Schema validation passed', {
                attempt: attempt,
                intent: parsed.intent,
                confidence: parsed.confidence
            });
            return {
                success: true,
                data: parsed,
                schemaAttempts: attempt,
                transportRetries: transportResult.transportRetries,
                rawOutput: rawContent,
                llmTimeMs: transportResult.llmTimeMs
            };
        } else {
            schemaErrors.push(...validation.errors);
            lastError = validation.errors.join('; ');
            lastOutput = rawContent;
            logger.log('WARN', 'Schema validation failed', {
                attempt: attempt,
                errors: validation.errors
            });
        }

        if (attempt < CONFIG.MAX_SCHEMA_RETRIES) {
            const delay = CONFIG.SCHEMA_RETRY_BACKOFF_MS * (attempt * attempt);
            logger.log('INFO', 'Schema retry waiting', {
                attempt: attempt,
                delayMs: delay
            });
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    logger.log('ERROR', 'All schema attempts failed', {
        maxAttempts: CONFIG.MAX_SCHEMA_RETRIES,
        schemaErrors: schemaErrors,
        lastError: lastError
    });

    return {
        success: false,
        data: getFallbackResponse(),
        schemaAttempts: CONFIG.MAX_SCHEMA_RETRIES,
        lastError: lastError,
        lastOutput: lastOutput,
        schemaErrors: schemaErrors
    };
}

// ──────────────────────────────────────────────────────────────
// 12. MAIN UNDERSTANDING FUNCTION
// ──────────────────────────────────────────────────────────────

async function understand(query, tenantId, userId, options = {}) {
    const correlationId = options.correlationId || `und-${uuidv4().substring(0, 8)}`;
    const startTime = Date.now();

    const logger = new Logger(correlationId);

    logger.log('INFO', 'Request started', {
        queryLength: query ? query.length : 0,
        hasTenantId: !!tenantId,
        hasUserId: !!userId,
        hasConversationId: !!options.conversationId,
        hasLocale: !!options.locale,
        hasTimezone: !!options.timezone
    });

    try {
        if (!query || typeof query !== 'string') {
            logger.log('WARN', 'Invalid query: not a string');
            return getFallbackResponse();
        }

        const trimmedQuery = query.trim();
        if (trimmedQuery.length === 0) {
            logger.log('WARN', 'Empty query');
            return getFallbackResponse();
        }

        if (trimmedQuery.length > CONFIG.MAX_QUERY_LENGTH) {
            logger.log('WARN', 'Query too long', {
                length: trimmedQuery.length,
                maxLength: CONFIG.MAX_QUERY_LENGTH
            });
            return getFallbackResponse();
        }

        if (!tenantId || typeof tenantId !== 'string' || tenantId.trim().length === 0) {
            logger.log('WARN', 'Missing required tenantId');
            return getFallbackResponse();
        }

        if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
            logger.log('WARN', 'Missing required userId');
            return getFallbackResponse();
        }

        const normalizedTenantId = tenantId.trim();
        const normalizedUserId = userId.trim();

        const rateLimiter = options.rateLimiter || understand.rateLimiter || new RateLimiter();
        understand.rateLimiter = rateLimiter;

        const rateCheck = await rateLimiter.check(normalizedTenantId, normalizedUserId);
        if (!rateCheck.allowed) {
            logger.log('WARN', 'Rate limit exceeded', {
                reason: rateCheck.reason,
                limit: rateCheck.limit,
                windowMs: rateCheck.windowMs,
                resetAt: rateCheck.resetAt
            });
            const error = new Error(rateCheck.reason);
            error.statusCode = 429;
            error.rateLimitInfo = rateCheck;
            throw error;
        }

        if (!process.env.OPENAI_API_KEY) {
            logger.log('ERROR', 'OPENAI_API_KEY not set');
            return getFallbackResponse();
        }

        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });

        const result = await processWithSchemaRetry(
            trimmedQuery,
            normalizedTenantId,
            normalizedUserId,
            options.conversationId || null,
            options.locale || null,
            options.timezone || null,
            openai,
            logger,
            options.onProgress
        );

        const response = {
            ...result.data
        };

        logger.log('INFO', 'Request completed', {
            intent: response.intent,
            confidence: response.confidence,
            schemaAttempts: result.schemaAttempts || 1,
            transportRetries: result.transportRetries || 0,
            success: result.success,
            processingTimeMs: Date.now() - startTime,
            hasAmbiguities: response.ambiguities.length > 0
        });

        if (Math.random() < 0.01) {
            rateLimiter.cleanup();
        }

        return response;

    } catch (error) {
        if (error.statusCode === 429) {
            throw error;
        }

        logger.log('ERROR', 'Fatal error', {
            error: error.message,
            stack: error.stack
        });
        return getFallbackResponse();
    }
}

// ──────────────────────────────────────────────────────────────
// 13. HTTP HANDLER
// ──────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
    const startTime = Date.now();
    const correlationId = req.headers['x-correlation-id'] || `und-${uuidv4().substring(0, 8)}`;
    const logger = new Logger(correlationId);

    try {
        const { query, tenant_id, user_id, conversation_id, locale, timezone } = req.body;

        logger.log('INFO', 'HTTP request received', {
            method: req.method,
            path: req.path,
            ip: req.ip ? logger.hashId(req.ip) : 'unknown',
            hasQuery: !!query,
            hasTenantId: !!tenant_id,
            hasUserId: !!user_id
        });

        if (!query || typeof query !== 'string') {
            return res.status(400).json({
                error: {
                    code: 'INVALID_INPUT',
                    message: 'query is required and must be a non-empty string.',
                    details: {}
                }
            });
        }

        const trimmedQuery = query.trim();
        if (trimmedQuery.length === 0) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_INPUT',
                    message: 'query must not be empty.',
                    details: {}
                }
            });
        }

        if (trimmedQuery.length > CONFIG.MAX_QUERY_LENGTH) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_INPUT',
                    message: `query exceeds maximum length of ${CONFIG.MAX_QUERY_LENGTH} characters.`,
                    details: { length: trimmedQuery.length }
                }
            });
        }

        if (!tenant_id || typeof tenant_id !== 'string' || tenant_id.trim().length === 0) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_INPUT',
                    message: 'tenant_id is required and must be a non-empty string.',
                    details: {}
                }
            });
        }

        if (!user_id || typeof user_id !== 'string' || user_id.trim().length === 0) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_INPUT',
                    message: 'user_id is required and must be a non-empty string.',
                    details: {}
                }
            });
        }

        const result = await understand(trimmedQuery, tenant_id.trim(), user_id.trim(), {
            correlationId,
            conversationId: conversation_id,
            locale: locale,
            timezone: timezone,
            onProgress: (msg) => {
                logger.log('INFO', 'Progress update', { message: msg });
            }
        });

        res.status(200).json(result);

    } catch (error) {
        if (error.statusCode === 429) {
            logger.log('WARN', 'Rate limit hit', {
                reason: error.message,
                rateLimitInfo: error.rateLimitInfo
            });
            return res.status(429).json({
                error: {
                    code: 'RATE_LIMIT_EXCEEDED',
                    message: error.message,
                    details: error.rateLimitInfo || {}
                }
            });
        }

        logger.log('ERROR', 'Handler error', {
            error: error.message,
            stack: error.stack
        });
        res.status(500).json({
            error: {
                code: 'INTERNAL_ERROR',
                message: 'An unexpected error occurred.',
                details: {}
            }
        });
    }
}

// ──────────────────────────────────────────────────────────────
// 14. ROUTE REGISTRATION
// ──────────────────────────────────────────────────────────────

function registerRoutes(app) {
    app.post('/v1/understand/query', handleRequest);

    app.get('/v1/understand/schema', (req, res) => {
        res.status(200).json({
            schema: UNDERSTANDING_SCHEMA,
            version: CONFIG.SCHEMA_VERSION,
            description: 'Understanding Schema v1'
        });
    });

    app.get('/v1/understand/health', (req, res) => {
        res.status(200).json({
            status: 'healthy',
            version: CONFIG.SCHEMA_VERSION,
            timestamp: new Date().toISOString()
        });
    });

    console.log('[UNDERSTANDING] Routes registered:');
    console.log('  POST /v1/understand/query');
    console.log('  GET  /v1/understand/schema');
    console.log('  GET  /v1/understand/health');
}

// ──────────────────────────────────────────────────────────────
// 15. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    understand,
    handleRequest,
    registerRoutes,
    CONFIG,
    UNDERSTANDING_SCHEMA,
    loadSchema,
    RateLimiter,
    Logger,
    validateUnderstanding,
    isValidDateString,
    getFallbackResponse,
    buildSystemPrompt,
    buildUserPrompt
};
