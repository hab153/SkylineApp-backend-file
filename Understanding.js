// ──────────────────────────────────────────────────────────────
// UNDERSTANDING.JS — Stage 1: Input & Normalization
// Skyline AA-1 Lead Generation System
//
// RESPONSIBILITIES:
// - Accept structured fields OR free-text input
// - Parse free-text with GPT (only when needed)
// - Resolve domain via DNS/Tavily (cached)
// - Normalize all fields
// - Validate and set needsClarification
// - Output clean, predictable contract for Stage 2
// - NEVER invent requirements
// - NEVER use AI/Tavily when not strictly necessary
// - NEVER silently conflate "AI parsing failed" with "user request was vague"
// ──────────────────────────────────────────────────────────────

const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');
const dns = require('dns').promises;
const axios = require('axios');

// ──────────────────────────────────────────────────────────────
// 1. CONFIGURATION
// ──────────────────────────────────────────────────────────────

const CONFIG = {
    // Model for free-text parsing only
    // Confirm exact API model string against OpenAI's current docs before deploying —
    // marketing names (e.g. "Luna") don't always match the literal API model string.
    AI_MODEL: 'gpt-5.6-luna',
    AI_MODEL_FALLBACK: 'gpt-5.6-terra',
    AI_TEMPERATURE: 0.2,
    AI_MAX_TOKENS: 500,

    // Domain resolution
    DNS_TIMEOUT: 5000,
    TAVILY_API_URL: 'https://api.tavily.com/search',
    TAVILY_MAX_RESULTS: 1,

    // Defaults
    DEFAULT_QUANTITY: 50,
    MAX_QUANTITY_FREE: 50,
    MAX_QUANTITY_GO: 200,
    MAX_QUANTITY_PRO: 500,
};

// ──────────────────────────────────────────────────────────────
// 2. OUTPUT CONTRACT — Stage 1 Output
// ──────────────────────────────────────────────────────────────

/**
 * The Stage 1 contract is the single source of truth.
 * Stage 2 (People Discovery) consumes this directly.
 *
 * resolvedVia reflects the ORIGINAL resolution method, even on a cache hit —
 * cache is a lookup shortcut, not a resolution method in its own right.
 *
 * parserFailed distinguishes a system-level AI failure from a genuinely
 * vague user request — both used to look identical (needsClarification: true,
 * everything else null). Free.js (and any caller) MUST check parserFailed
 * separately, since "the AI broke" and "please give us more detail" need
 * completely different user-facing messages.
 */
const CONTRACT_SCHEMA = {
    companyName: 'string | null',
    domain: 'string | null',
    role: 'string | null',
    seniority: 'string | null',
    industry: 'string | null',
    location: 'string | null',
    quantity: 'number | null',
    resolvedVia: 'provided' | 'dns' | 'tavily' | null,
    needsClarification: 'boolean',
    parserFailed: 'boolean',
    parserErrorDetail: 'string | null',
    originalRequest: 'string | null',
    requestId: 'string',
    processedAt: 'string',
    version: 'string',
};

// ──────────────────────────────────────────────────────────────
// 3. NORMALIZATION MAPPINGS
// ──────────────────────────────────────────────────────────────

// Country normalization
const COUNTRY_TO_CODE = {
    'germany': 'DE',
    'german': 'DE',
    'deutschland': 'DE',
    'france': 'FR',
    'french': 'FR',
    'united kingdom': 'GB',
    'uk': 'GB',
    'britain': 'GB',
    'england': 'GB',
    'nigeria': 'NG',
    'usa': 'US',
    'united states': 'US',
    'america': 'US',
    'canada': 'CA',
    'australia': 'AU',
    'india': 'IN',
    'china': 'CN',
    'japan': 'JP',
    'singapore': 'SG',
    'spain': 'ES',
    'italy': 'IT',
    'netherlands': 'NL',
    'sweden': 'SE',
    'norway': 'NO',
    'denmark': 'DK',
    'finland': 'FI',
    'ireland': 'IE',
    'south africa': 'ZA',
    'brazil': 'BR',
    'mexico': 'MX'
};

// Code → Full name
const CODE_TO_COUNTRY = {
    'DE': 'Germany',
    'FR': 'France',
    'GB': 'United Kingdom',
    'NG': 'Nigeria',
    'US': 'United States',
    'CA': 'Canada',
    'AU': 'Australia',
    'IN': 'India',
    'CN': 'China',
    'JP': 'Japan',
    'SG': 'Singapore',
    'ES': 'Spain',
    'IT': 'Italy',
    'NL': 'Netherlands',
    'SE': 'Sweden',
    'NO': 'Norway',
    'DK': 'Denmark',
    'FI': 'Finland',
    'IE': 'Ireland',
    'ZA': 'South Africa',
    'BR': 'Brazil',
    'MX': 'Mexico'
};

// Industry normalization
const INDUSTRY_MAPPINGS = {
    'saas': 'SaaS',
    'software as a service': 'SaaS',
    'cybersecurity': 'Cybersecurity',
    'cyber security': 'Cybersecurity',
    'fintech': 'Fintech',
    'financial technology': 'Fintech',
    'healthcare': 'Healthcare',
    'health care': 'Healthcare',
    'manufacturing': 'Manufacturing',
    'e-commerce': 'E-commerce',
    'ecommerce': 'E-commerce',
    'retail': 'Retail',
    'logistics': 'Logistics',
    'ai': 'AI',
    'artificial intelligence': 'AI',
    'machine learning': 'Machine Learning',
    'ml': 'Machine Learning',
    'blockchain': 'Blockchain',
    'real estate': 'Real Estate',
    'education': 'Education',
    'edtech': 'EdTech',
    'hr': 'HR',
    'human resources': 'HR',
    'marketing': 'Marketing',
    'adtech': 'AdTech',
    'insurance': 'Insurance',
    'insurtech': 'InsurTech',
    'legal': 'Legal',
    'legaltech': 'LegalTech',
    'energy': 'Energy',
    'cleantech': 'CleanTech',
    'agriculture': 'Agriculture',
    'agritech': 'AgriTech'
};

// Role normalization
const ROLE_MAPPINGS = {
    'ceo': 'CEO',
    'chief executive officer': 'CEO',
    'chief exec': 'CEO',
    'founder': 'Founder',
    'co-founder': 'Co-Founder',
    'cofounder': 'Co-Founder',
    'cto': 'CTO',
    'chief technology officer': 'CTO',
    'cfo': 'CFO',
    'chief financial officer': 'CFO',
    'ciso': 'CISO',
    'chief information security officer': 'CISO',
    'cmo': 'CMO',
    'chief marketing officer': 'CMO',
    'coo': 'COO',
    'chief operating officer': 'COO',
    'vp': 'VP',
    'vice president': 'VP',
    'director': 'Director',
    'head': 'Head',
    'manager': 'Manager',
    'owner': 'Owner',
    'president': 'President',
    'executive': 'Executive',
    'decision maker': 'Decision Maker',
    'decision-maker': 'Decision Maker'
};

// Seniority mapping
const SENIORITY_MAPPINGS = {
    'c-level': 'C-Level',
    'clevel': 'C-Level',
    'c suite': 'C-Level',
    'executive': 'Executive',
    'vp': 'VP',
    'vice president': 'VP',
    'director': 'Director',
    'head': 'Head',
    'manager': 'Manager',
    'senior': 'Senior',
    'mid': 'Mid-Level',
    'junior': 'Junior',
    'entry': 'Entry',
};

// ──────────────────────────────────────────────────────────────
// 4. DOMAIN RESOLUTION (with caching)
// ──────────────────────────────────────────────────────────────

// In-memory cache for companyName → { domain, resolvedVia }
// TODO: Replace with a MongoDB collection for persistence — an in-memory
// Map resets on every deploy/restart, causing companies to be re-resolved
// (and potentially re-billed via Tavily) after every deploy.
const domainCache = new Map();

/**
 * Resolves a company's domain.
 * Returns { domain, resolvedVia } or null if resolution fails.
 * resolvedVia is always the ORIGINAL method that resolved it —
 * a cache hit returns whatever method resolved it the first time.
 */
async function resolveDomain(companyName) {
    if (!companyName) return null;

    const normalizedName = companyName.toLowerCase().trim();

    // ── Check cache first ──
    if (domainCache.has(normalizedName)) {
        const cached = domainCache.get(normalizedName);
        console.log(`[DOMAIN] Cache hit for: ${companyName} (originally via ${cached.resolvedVia})`);
        return cached;
    }

    console.log(`[DOMAIN] Resolving domain for: ${companyName}`);

    // ── Step 1: DNS guess ──
    const domainGuess = companyName
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .trim() + '.com';

    try {
        await dns.resolve(domainGuess);
        console.log(`[DOMAIN] DNS resolved: ${domainGuess}`);
        const resolved = { domain: domainGuess, resolvedVia: 'dns' };
        domainCache.set(normalizedName, resolved);
        return resolved;
    } catch (dnsError) {
        console.log(`[DOMAIN] DNS failed for: ${domainGuess}`);
    }

    // ── Step 2: Tavily fallback (only if DNS fails) ──
    const tavilyApiKey = process.env.TAVILY_API_KEY;
    if (tavilyApiKey) {
        try {
            const response = await axios.post(
                CONFIG.TAVILY_API_URL,
                {
                    query: `${companyName} official website`,
                    search_depth: 'basic',
                    max_results: CONFIG.TAVILY_MAX_RESULTS,
                    include_answer: false,
                },
                {
                    headers: {
                        'Authorization': `Bearer ${tavilyApiKey}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 10000,
                }
            );

            const results = response.data.results || [];
            if (results.length > 0) {
                const url = results[0].url || '';
                const domain = extractDomainFromUrl(url);
                if (domain) {
                    console.log(`[DOMAIN] Tavily resolved: ${domain}`);
                    const resolved = { domain, resolvedVia: 'tavily' };
                    domainCache.set(normalizedName, resolved);
                    return resolved;
                }
            }
        } catch (tavilyError) {
            console.log(`[DOMAIN] Tavily fallback failed: ${tavilyError.message}`);
        }
    }

    return null;
}

function extractDomainFromUrl(url) {
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

// ──────────────────────────────────────────────────────────────
// 5. FREE-TEXT PARSING (with GPT)
// ──────────────────────────────────────────────────────────────

const PARSE_PROMPT_TEMPLATE = (text) => `
You are Skyline AA-1's Input Normalizer.
Extract structured information from the user's request.

**RULES:**
1. ONLY extract what is explicitly mentioned.
2. If a field is not mentioned, return null.
3. Normalize values (CEO → CEO, SaaS → SaaS).
4. Return JSON only.

**Output JSON:**
{
  "companyName": "string or null",
  "role": "string or null",
  "seniority": "string or null",
  "industry": "string or null",
  "location": "string or null",
  "quantity": "number or null"
}

**EXAMPLES:**

User: "Find me 39 SaaS companies in Nigeria"
Output: {
  "companyName": null,
  "role": null,
  "seniority": null,
  "industry": "SaaS",
  "location": "Nigeria",
  "quantity": 39
}

User: "Find CEOs of SaaS companies in Nigeria"
Output: {
  "companyName": null,
  "role": "CEO",
  "seniority": "C-Level",
  "industry": "SaaS",
  "location": "Nigeria",
  "quantity": null
}

User: "Get me marketing directors at Acme Corp"
Output: {
  "companyName": "Acme Corp",
  "role": "marketing director",
  "seniority": "Director",
  "industry": null,
  "location": null,
  "quantity": null
}

User: "Find me CEOs in the Real Estate industry, located in London. Company size: Any."
Output: {
  "companyName": null,
  "role": "CEO",
  "seniority": "C-Level",
  "industry": "Real Estate",
  "location": "London",
  "quantity": null
}

**User Request:**
"${text}"

**OUTPUT ONLY JSON. NO MARKDOWN.**
`;

/**
 * Calls a single model to parse free text.
 * Returns { ok, data, errorDetail }.
 * ok=false means the call itself failed or returned unparseable JSON —
 * this is a SYSTEM failure, not a comment on the user's request.
 */
async function callParseModel(model, text, openai) {
    const prompt = PARSE_PROMPT_TEMPLATE(text);

    try {
        const response = await openai.chat.completions.create({
            model: model,
            temperature: CONFIG.AI_TEMPERATURE,
            max_tokens: CONFIG.AI_MAX_TOKENS,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: 'You extract structured data from user requests. Output only JSON. Never invent missing fields.'
                },
                { role: 'user', content: prompt }
            ],
        });

        const content = response.choices[0].message.content;
        const parsed = JSON.parse(content);
        return { ok: true, data: parsed, errorDetail: null };

    } catch (error) {
        // Log full detail server-side — status code, type, message — so a
        // bad model string, auth failure, and rate limit are distinguishable
        // in logs even though the caller only sees a generic errorDetail.
        console.error(`[PARSER] ${model} failed:`, {
            message: error.message,
            status: error.status || error.response?.status,
            type: error.type || error.code,
        });
        return {
            ok: false,
            data: null,
            errorDetail: `${model}: ${error.message}`,
        };
    }
}

/**
 * Parses free text into structured fields.
 * Tries the primary model (Luna) first; if that call fails or returns
 * invalid JSON, retries once with the fallback model (Terra) — same
 * cascade pattern used in Stage 2's extractor.
 *
 * Returns { ok, data, errorDetail }. Callers MUST check `ok` — a false
 * value means the AI layer broke, and must NOT be silently treated as
 * "the user gave us nothing."
 */
async function parseFreeText(text, openai) {
    console.log('[PARSER] Parsing free-text:', text);

    const primary = await callParseModel(CONFIG.AI_MODEL, text, openai);
    if (primary.ok) return primary;

    console.warn(`[PARSER] Primary model failed, escalating to ${CONFIG.AI_MODEL_FALLBACK}`);
    const fallback = await callParseModel(CONFIG.AI_MODEL_FALLBACK, text, openai);
    if (fallback.ok) return fallback;

    // Both attempts failed — this is a real system failure, report it as such.
    return {
        ok: false,
        data: null,
        errorDetail: `Both models failed. Primary: ${primary.errorDetail} | Fallback: ${fallback.errorDetail}`,
    };
}

// ──────────────────────────────────────────────────────────────
// 6. MAIN UNDERSTANDING ENGINE
// ──────────────────────────────────────────────────────────────

class UnderstandingEngine {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }

    /**
     * Process input (structured or free-text) → normalized contract
     */
    async processRequest(input, userPlan = 'free') {
        console.log('[UNDERSTANDING] Processing input:', JSON.stringify(input, null, 2));

        const requestId = `req-${uuidv4().substring(0, 8)}`;
        const result = {
            companyName: null,
            domain: null,
            role: null,
            seniority: null,
            industry: null,
            location: null,
            quantity: null,
            resolvedVia: null,
            needsClarification: false,
            parserFailed: false,
            parserErrorDetail: null,
            originalRequest: null,
            requestId: requestId,
            processedAt: new Date().toISOString(),
            version: '1.1.0',
        };

        try {
            // ── Step 1: Detect input type ──
            const isStructured = input.companyName || input.domain || input.role || input.industry || input.location;
            const isFreeText = input.text && typeof input.text === 'string' && input.text.trim().length > 0;

            // ── Step 2: Parse free-text (if needed) ──
            let parsed = {};
            let providedDomain = null;

            if (isFreeText && !isStructured) {
                console.log('[UNDERSTANDING] Free-text input detected');
                result.originalRequest = input.text;

                const parseResult = await parseFreeText(input.text, this.openai);

                if (!parseResult.ok) {
                    // System-level failure — NOT the same as a vague request.
                    // needsClarification stays true because we genuinely have
                    // no structured data to proceed with, but parserFailed
                    // tells the caller (Free.js) this needs a "try again /
                    // something went wrong" message, not "please be more specific."
                    result.needsClarification = true;
                    result.parserFailed = true;
                    result.parserErrorDetail = parseResult.errorDetail;
                    console.log('[UNDERSTANDING] Result (parser failure):', JSON.stringify(result, null, 2));
                    return result;
                }

                parsed = parseResult.data;
            } else {
                console.log('[UNDERSTANDING] Structured input detected');
                // Use structured fields directly
                parsed = {
                    companyName: input.companyName || null,
                    role: input.role || null,
                    seniority: input.seniority || null,
                    industry: input.industry || null,
                    location: input.location || null,
                    quantity: input.quantity || null,
                };
                providedDomain = input.domain || null;
                result.originalRequest = input.text || JSON.stringify(input);
            }

            // ── Step 3: Normalize values ──
            const normalized = this.normalize(parsed);

            // ── Step 4: Resolve domain ──
            // Case A: domain was given directly by the user — use it as-is, no DNS/Tavily needed.
            if (providedDomain) {
                result.domain = providedDomain.toLowerCase().trim();
                result.resolvedVia = 'provided';
            }
            // Case B: only companyName given — attempt resolution via cache/DNS/Tavily.
            else if (normalized.companyName) {
                const resolved = await resolveDomain(normalized.companyName);
                if (resolved) {
                    result.domain = resolved.domain;
                    result.resolvedVia = resolved.resolvedVia;
                } else {
                    // Domain resolution failed — needs clarification
                    result.needsClarification = true;
                }
            }

            // ── Step 5: Apply defaults ──
            const planLimits = {
                free: CONFIG.MAX_QUANTITY_FREE,
                go: CONFIG.MAX_QUANTITY_GO,
                pro: CONFIG.MAX_QUANTITY_PRO,
            };
            const maxQuantity = planLimits[userPlan] || CONFIG.MAX_QUANTITY_FREE;

            if (normalized.quantity && normalized.quantity > maxQuantity) {
                result.quantity = maxQuantity;
                result.needsClarification = true;
            } else if (normalized.quantity) {
                result.quantity = normalized.quantity;
            } else {
                result.quantity = CONFIG.DEFAULT_QUANTITY;
            }

            // ── Step 6: Populate remaining fields ──
            result.companyName = normalized.companyName || null;
            result.role = normalized.role || null;
            result.seniority = normalized.seniority || null;
            result.industry = normalized.industry || null;
            result.location = normalized.location || null;

            // ── Step 7: Validate ──
            // A request is only invalid if it has NEITHER a company/domain
            // NOR any criteria (role/industry/location) to search by.
            // A companyName alone (e.g. "find contacts at Acme Corp") is a
            // perfectly valid, specific request and must NOT be flagged.
            const hasCompanyIdentity = !!(result.companyName || result.domain);
            const hasCriteria = !!(result.role || result.industry || result.location);

            if (!hasCompanyIdentity && !hasCriteria) {
                result.needsClarification = true;
            }

            console.log('[UNDERSTANDING] Result:', JSON.stringify(result, null, 2));
            return result;

        } catch (error) {
            console.error('[UNDERSTANDING] Error:', error.message);
            return this.buildErrorSpec(input, error.message, requestId);
        }
    }

    /**
     * Normalize values
     */
    normalize(parsed) {
        const result = { ...parsed };

        // Normalize country
        if (result.location) {
            const lowerInput = result.location.toLowerCase().trim();
            if (COUNTRY_TO_CODE[lowerInput]) {
                result.location = CODE_TO_COUNTRY[COUNTRY_TO_CODE[lowerInput]];
            } else if (CODE_TO_COUNTRY[lowerInput.toUpperCase()]) {
                result.location = CODE_TO_COUNTRY[lowerInput.toUpperCase()];
            }
        }

        // Normalize industry
        if (result.industry) {
            const lowerInput = result.industry.toLowerCase().trim();
            result.industry = INDUSTRY_MAPPINGS[lowerInput] || result.industry;
        }

        // Normalize role
        if (result.role) {
            const lowerInput = result.role.toLowerCase().trim();
            result.role = ROLE_MAPPINGS[lowerInput] || result.role;
        }

        // Normalize seniority
        if (result.seniority) {
            const lowerInput = result.seniority.toLowerCase().trim();
            result.seniority = SENIORITY_MAPPINGS[lowerInput] || result.seniority;
        }

        // Normalize quantity
        if (result.quantity) {
            const qty = parseInt(result.quantity);
            if (!isNaN(qty) && qty > 0) {
                result.quantity = qty;
            } else {
                result.quantity = null;
            }
        }

        return result;
    }

    /**
     * Build error specification
     */
    buildErrorSpec(input, errorMessage, requestId) {
        return {
            companyName: null,
            domain: null,
            role: null,
            seniority: null,
            industry: null,
            location: null,
            quantity: null,
            resolvedVia: null,
            needsClarification: true,
            parserFailed: true,
            parserErrorDetail: errorMessage,
            originalRequest: input.text || JSON.stringify(input),
            requestId: requestId || `req-${uuidv4().substring(0, 8)}`,
            processedAt: new Date().toISOString(),
            version: '1.1.0',
            _error: errorMessage,
        };
    }
}

// ──────────────────────────────────────────────────────────────
// 7. CONVENIENCE FUNCTION
// ──────────────────────────────────────────────────────────────

/**
 * Main entry point — process a request
 *
 * @param {string|object} input - Either a text string or structured object
 * @param {string} userPlan - 'free', 'go', or 'pro'
 * @returns {Promise<object>} Normalized Stage 1 contract
 */
async function understand(input, userPlan = 'free') {
    const engine = new UnderstandingEngine();

    // Normalize input
    let request = {};
    if (typeof input === 'string') {
        request = { text: input };
    } else if (typeof input === 'object') {
        request = { ...input };
        if (!request.text && request.originalRequest) {
            request.text = request.originalRequest;
        }
    } else {
        return engine.buildErrorSpec({}, 'Invalid input type');
    }

    return engine.processRequest(request, userPlan);
}

// ──────────────────────────────────────────────────────────────
// 8. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    understand,
    UnderstandingEngine,
    resolveDomain,
    parseFreeText,
    CONFIG,
    CONTRACT_SCHEMA,
    COUNTRY_TO_CODE,
    CODE_TO_COUNTRY,
    INDUSTRY_MAPPINGS,
    ROLE_MAPPINGS,
    SENIORITY_MAPPINGS,
    domainCache, // For testing/debugging
};
