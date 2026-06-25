'use strict';

const axios = require('axios');
const dns   = require('dns').promises;
const net   = require('net');

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONFIG & CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_LEADS_RETURNED        = 5;
const TAVILY_LIMIT              = 1000;
const CONCURRENCY_LIMIT         = 2;
const CACHE_TTL_MS              = 60 * 60 * 1000;
const CURRENT_YEAR              = new Date().getFullYear();
const MAX_MESSAGE_LENGTH        = 800;
const EMAIL_CONFIDENCE_THRESHOLD = 28;

// Thresholds for Policy Engine & HITL
const POLICY_CONFIDENCE_MIN     = 75; // Actions only execute if score > 75
const POLICY_HITL_FLOOR         = 50; // Ask for approval if 50 < score < 75

const QUANTITY_RULE_HARD_MIN     = 2;
const QUANTITY_RULE_ABSOLUTE_MIN = 1;
const QUANTITY_RULE_DEFAULT_MAX  = MAX_LEADS_RETURNED;

const MIN_POOL_SIZE = 3;

// Expanded Intent Taxonomy
const INTENT = {
    LEAD_GEN:          'lead_gen',
    CHAT:              'chat',
    EMAIL_DRAFT:       'email_draft',
    BUSINESS_QA:       'business_qa',
    BULK_SEARCH:       'bulk_search',
    SINGLE_ENRICHMENT: 'single_enrichment',
    CLARIFICATION:     'clarification_needed'
};

const ROLE_PRIORITY = {
    'ceo':            1,
    'founder':        2,
    'co-founder':     2,
    'co founder':     2,
    'owner':          3,
    'director':       4,
    'vp':             5,
    'vice president': 5,
    'head of':        6,
    'manager':        7,
    'marketing':      8,
    'sales':          9,
};

const REPUTATION_BLOCKED_DOMAINS = new Set([]);

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — AUDIT & LOGGING LAYER (NEW)
// ═══════════════════════════════════════════════════════════════════════════════

class AuditLogger {
    constructor() {
        this.logs = [];
    }

    log(module, action, details, status = 'success') {
        const entry = {
            timestamp: new Date().toISOString(),
            module,
            action,
            status,
            details
        };
        this.logs.push(entry);
        console.log(`[AUDIT][${module}] ${action} - ${status}`);
    }

    getTrail() {
        return this.logs;
    }
}

const audit = new AuditLogger();

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — POLICY ENGINE (NEW)
// ═══════════════════════════════════════════════════════════════════════════════

class PolicyEngine {
    static evaluate(lead) {
        const results = {
            passed: true,
            flagged: false,
            reason: '',
            needsApproval: false
        };

        // Rule 1: Never act on unverified emails
        if (lead.verdict === 'rejected') {
            results.passed = false;
            results.reason = 'Email rejected by verification pipeline.';
            return results;
        }

        // Rule 2: Confidence Score Gate
        if (lead.leadScore < POLICY_HITL_FLOOR) {
            results.passed = false;
            results.reason = `Confidence score ${lead.leadScore} is below the absolute floor.`;
        } else if (lead.leadScore < POLICY_CONFIDENCE_MIN) {
            results.flagged = true;
            results.needsApproval = true;
            results.reason = `Confidence score ${lead.leadScore} requires human approval.`;
        }

        // Rule 3: High-Risk Domain Check
        const sensitiveTlds = ['.gov', '.edu', '.org'];
        if (sensitiveTlds.some(tld => lead.domain.endsWith(tld))) {
            results.flagged = true;
            results.needsApproval = true;
            results.reason = 'Target is a sensitive domain (GOV/EDU/ORG).';
        }

        return results;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — CONTENT QUALITY SIGNALS
// ═══════════════════════════════════════════════════════════════════════════════

const LOW_VALUE_URL_PATTERNS = [
    /\/blog\//i, /\/article\//i, /\/news\//i, /\/tutorial\//i,
    /\/how-to\//i, /\/guide\//i, /\/tips\//i, /\/resources\//i,
    /\/learn\//i, /\/wiki\//i, /\/forum\//i, /\.pdf$/i,
    /reddit\.com/i, /medium\.com/i, /quora\.com/i,
    /wikipedia\.org/i, /stackoverflow\.com/i,
    /hubspot\.com\/blog/i, /moz\.com\/blog/i, /semrush\.com\/blog/i,
];

const HIGH_VALUE_URL_PATTERNS = [
    /\/about/i, /\/team/i, /\/contact/i, /\/company/i,
    /\/people/i, /\/leadership/i, /\/founders/i, /\/our-story/i,
];

const HIGH_VALUE_TITLE_SIGNALS = [
    'agency', 'studio', 'solutions', 'services', 'group', 'partners',
    'consulting', 'technologies', 'software', 'platform', 'media',
    'marketing', 'creative', 'digital', 'design', 'development',
    'co.', 'inc', 'ltd', 'llc', 'corp',
];

const LOW_VALUE_TITLE_SIGNALS = [
    'how to', 'guide', 'tutorial', 'best practices', 'tips for',
    'what is', 'introduction to', 'overview of', 'list of',
    'top 10', 'top 5', '10 ways', '5 ways', '7 ways',
    'blog post', 'article', 'free download', 'pdf',
];

const SKIP_DOMAINS = new Set([
    'linkedin.com', 'crunchbase.com', 'apollo.io', 'hunter.io',
    'yelp.com', 'clutch.co', 'g2.com', 'trustpilot.com',
    'bark.com', 'bark.london', 'upwork.com', 'fiverr.com', 'peopleperhour.com',
    'yell.com', 'thomsonlocal.com', 'checkatrade.com',
    'directory.com', 'yellowpages.com', 'manta.com',
    'hubspot.com', 'moz.com', 'semrush.com', 'ahrefs.com',
    'searchenginejournal.com', 'searchengineland.com',
    'entrepreneur.com', 'forbes.com', 'inc.com', 'businessinsider.com',
    'techcrunch.com', 'venturebeat.com', 'wired.com',
    'reddit.com', 'quora.com', 'medium.com', 'substack.com',
    'wikipedia.org', 'wikihow.com',
    'indeed.com', 'glassdoor.com', 'ziprecruiter.com',
    'capterra.com', 'getapp.com', 'softwareadvice.com',
    'producthunt.com', 'angellist.com', 'f6s.com',
    'goodfirms.co', 'designrush.com', 'expertise.com',
    'houzz.com', 'thumbtack.com', 'homeadvisor.com',
    'yelp.ca', 'yelp.co.uk', 'yelp.com.au',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — COPY CONTROLS
// ═══════════════════════════════════════════════════════════════════════════════

const REASONING_FILTER = `
⚠️ REASONING FILTER — NON-NEGOTIABLE:
1. You are a strict fact extractor. Use ONLY facts explicitly stated in SNIPPETS.
2. IGNORE all training data. If a fact is not in the snippets, return null.
3. NEVER invent names, emails, roles, or company details.
4. Current year is ${CURRENT_YEAR}.
`;

const BANNED_ADJECTIVES = [
    'transformative', 'seamless', 'mission-critical', 'synergy', 'game-changer',
    'revolutionary', 'cutting-edge', 'innovative', 'disruptive', 'next-level',
    'holistic', 'robust', 'scalable', 'leverage', 'streamline', 'optimize',
    'empower', 'unlock', 'elevate', 'enhance', 'boost', 'accelerate', 'amplify',
    'delve', 'awe-inspiring', 'exciting', 'landscape', 'unleash', 'dynamic',
    'groundbreaking', 'paradigm', 'ecosystem', 'value-add', 'best-in-class',
];

const BANNED_PHRASES = [
    'I hope this finds you well', 'I wanted to reach out', 'touch base',
    'circle back', 'quick question', 'just following up', 'as per my last email',
    'I am reaching out because', 'My name is', 'I hope you are doing well',
    'let me know your thoughts', 'feel free to', 'do not hesitate',
    'please find attached', 'as mentioned', 'at your earliest convenience',
    'in today\'s world', 'in the current landscape', 'going forward',
];

const BANNED_STATS_INSTRUCTION = `
BANNED FABRICATED STATS — NEVER use:
"30% increase", "3x growth", "50% faster", "double your revenue", "10x results",
"proven results", "guaranteed ROI", "increase by X%", "save X hours".
If you have no real stat, describe the MECHANISM instead.
`;

function buildBannedWordsInstruction() {
    return [
        `BANNED ADJECTIVES — NEVER use: ${BANNED_ADJECTIVES.join(', ')}. Replace with specific facts.`,
        `BANNED PHRASES — NEVER use: ${BANNED_PHRASES.join(' | ')}.`,
        BANNED_STATS_INSTRUCTION,
    ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — QUOTA & COST TRACKERS
// ═══════════════════════════════════════════════════════════════════════════════

const tavilyQuota = { used: 0, limit: TAVILY_LIMIT, lastReset: Date.now() };

const openAiTracker = {
    totalCallsThisSession:        0,
    totalInputTokensThisSession:  0,
    totalOutputTokensThisSession: 0,
};
const costTracker = { estimatedUSDThisSession: 0 };

function checkTavilyReset() {
    const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - tavilyQuota.lastReset >= ONE_MONTH) {
        tavilyQuota.used      = 0;
        tavilyQuota.lastReset = Date.now();
    }
}
function getTavilyRemaining() { checkTavilyReset(); return tavilyQuota.limit - tavilyQuota.used; }
function recordTavilyUsage()  { tavilyQuota.used += 1; }

function recordOpenAiUsage(inputTokens = 0, outputTokens = 0, model = 'gpt-4o-mini') {
    openAiTracker.totalCallsThisSession         += 1;
    openAiTracker.totalInputTokensThisSession   += inputTokens;
    openAiTracker.totalOutputTokensThisSession  += outputTokens;

    const PRICING = {
        'gpt-4o-mini': { input: 0.15,  output: 0.60  },
        'gpt-4o':      { input: 2.50,  output: 10.00 },
    };
    const rates = PRICING[model] ?? PRICING['gpt-4o-mini'];
    costTracker.estimatedUSDThisSession +=
        (inputTokens  / 1_000_000) * rates.input +
        (outputTokens / 1_000_000) * rates.output;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

const globalSeenDomains      = new Set();
const globalSeenCompanyNames = new Set();
const researchCache          = new Map();

function resetSessionCache() {
    globalSeenCompanyNames.clear();
    researchCache.clear();
}

async function withRetry(fn, label, retries = 2, delayMs = 800) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isLast = attempt === retries;
            if (err.response?.status && err.response.status < 500 && err.response.status !== 429) {
                audit.log('Network', label, `Non-retryable error: ${err.message}`, 'failed');
                return null;
            }
            if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
    }
    return null;
}

function cleanCompanyName(rawTitle) {
    let name = rawTitle.split(/[|\-–]/)[0].trim();
    name = name.replace(/\b(Ltd|LLC|Inc|Limited|PLC)\s*$/gi, '').trim();
    if (name.length > 50) name = name.substring(0, 50).trim();
    const REJECT = ['home', 'about', 'contact', 'services', 'welcome', 'index'];
    if (!name || REJECT.includes(name.toLowerCase())) return null;
    return name;
}

function sanitizeUserMessage(message) {
    const injectionPatterns = [
        /ignore (all |previous |prior )?(instructions?|prompts?|rules?)/gi,
        /disregard (all |previous |prior )?(instructions?|prompts?|rules?)/gi,
        /forget (all |previous |prior )?(instructions?|prompts?|rules?)/gi,
        /you are now/gi,
        /act as (a |an )?(?!assistant)/gi,
        /your new (instructions?|rules?|role) (is|are)/gi,
    ];
    let safe = message;
    for (const pattern of injectionPatterns) {
        safe = safe.replace(pattern, '[REDACTED]');
    }
    return safe;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — EMAIL VALIDATION PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

async function validateMX(domain) {
    try {
        const records = await dns.resolveMx(domain);
        return records && records.length > 0;
    } catch (e) {
        return false;
    }
}

async function smtpProbeEmail(email, domain) {
    return new Promise((resolve) => {
        const socket = net.createConnection(25, domain);
        let step = 0;
        socket.setTimeout(4000);

        socket.on('data', (data) => {
            const res = data.toString();
            if (step === 0 && res.startsWith('220')) {
                socket.write(`HELO google.com\r\n`);
                step++;
            } else if (step === 1 && res.startsWith('250')) {
                socket.write(`MAIL FROM:<test@google.com>\r\n`);
                step++;
            } else if (step === 2 && res.startsWith('250')) {
                socket.write(`RCPT TO:<${email}>\r\n`);
                step++;
            } else if (step === 3) {
                if (res.startsWith('250')) resolve('valid');
                else if (res.startsWith('550')) resolve('invalid');
                else resolve('unknown');
                socket.write('QUIT\r\n');
                socket.destroy();
            }
        });

        socket.on('error', () => { resolve('unknown'); socket.destroy(); });
        socket.on('timeout', () => { resolve('unknown'); socket.destroy(); });
    });
}

function classifyEmail(email, domain) {
    const local = email.split('@')[0].toLowerCase();
    const roles = ['info', 'contact', 'sales', 'support', 'hello', 'admin', 'office'];
    if (roles.includes(local)) return { type: 'confirmed-generic' };
    return { type: 'confirmed-personal' };
}

async function validateEmailFull(email, domain) {
    const normalisedEmail = email.toLowerCase().trim();
    const result = {
        email:           normalisedEmail,
        verdict:         'rejected',
        confidenceScore: 0,
        smtpResult:      null,
        mxValid:         false,
        reason:          '',
    };

    if (!normalisedEmail.includes('@')) { result.reason = 'Invalid syntax'; return result; }
    
    const emailDomain = normalisedEmail.split('@')[1];
    result.mxValid = await validateMX(emailDomain);
    if (!result.mxValid) { result.reason = 'No MX records'; return result; }

    const classification = classifyEmail(normalisedEmail, domain);
    const smtpResult = await smtpProbeEmail(normalisedEmail, emailDomain);
    result.smtpResult = smtpResult;

    if (smtpResult === 'valid') {
        result.confidenceScore = classification.type === 'confirmed-personal' ? 95 : 78;
        result.verdict = 'verified';
    } else {
        result.confidenceScore = 30;
        result.verdict = 'probable';
    }

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — TAVILY SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

async function searchWithTavily(query, tavilyKey, options = {}, requestState = null) {
    if (getTavilyRemaining() <= 0) return [];

    const maxPerRequest = (requestState && requestState.maxCallsPerRequest) || 4;
    if (requestState && requestState.callCount >= maxPerRequest) return [];

    if (requestState) requestState.callCount += 1;

    return withRetry(async () => {
        const payload = {
            api_key:             tavilyKey,
            query,
            search_depth:        'advanced',
            max_results:         options.maxResults || 5,
        };

        const response = await axios.post('https://api.tavily.com/search', payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 12000,
        });

        recordTavilyUsage();
        audit.log('Search', 'Tavily', `Query: ${query.slice(0, 30)}`);
        return (response.data?.results || []).map(r => ({
            title:      r.title   || '',
            url:        r.url     || '',
            snippet:    r.content || '',
        }));
    }, `Tavily:${query.slice(0, 40)}`) ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — INTENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function _classifyIntent(message, history, apiKey) {
    const classifyPrompt = `Classify this B2B request: "${message}". 
    Return exactly one: lead_gen, chat, email_draft, business_qa, bulk_search, single_enrichment, clarification_needed.
    If the request is vague, return clarification_needed.`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: classifyPrompt }],
            max_tokens:  10,
            temperature: 0.0,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:classify');

        const intent = res.data.choices[0].message.content.trim().toLowerCase();
        audit.log('Router', 'Classification', `Intent: ${intent}`);
        return intent;
    } catch (err) {
        return INTENT.CHAT;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — MAIN PIPELINE (WATERFALL FLOW)
// ═══════════════════════════════════════════════════════════════════════════════

async function _runLeadGenPipeline(safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, tavilyKey) {
    const requestState = { callCount: 0, maxCallsPerRequest: 6 };
    
    // 1. Search
    onProgress?.('🔍 Searching for prospects...');
    const query = `B2B companies in ${safeMessage} contact email`;
    const results = await searchWithTavily(query, tavilyKey, { maxResults: 10 }, requestState);

    const leads = [];
    for (const res of results) {
        const domain = new URL(res.url).hostname.replace('www.', '');
        if (SKIP_DOMAINS.has(domain)) continue;

        const companyName = cleanCompanyName(res.title);
        if (!companyName) continue;

        // 2. Enrich & Verify
        onProgress?.(`🛠️ Enriching ${companyName}...`);
        const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
        const foundEmails = res.snippet.match(emailRegex) || [];
        
        let bestEmail = null;
        if (foundEmails.length > 0) {
            const validation = await validateEmailFull(foundEmails[0], domain);
            bestEmail = {
                email: validation.email,
                verdict: validation.verdict,
                confidence: validation.confidenceScore,
                mx: validation.mxValid,
                smtp: validation.smtpResult
            };
        }

        const lead = {
            company: companyName,
            domain,
            email: bestEmail?.email || 'unknown',
            verdict: bestEmail?.verdict || 'rejected',
            leadScore: bestEmail?.confidence || 0,
            verificationStatus: bestEmail?.verdict || 'rejected',
            approvalStatus: 'pending',
            auditTrail: audit.getTrail()
        };

        // 3. Policy Check
        const policy = PolicyEngine.evaluate(lead);
        lead.policyCheck = policy.passed ? 'passed' : (policy.flagged ? 'flagged' : 'failed');
        
        if (policy.passed || policy.needsApproval) {
            if (policy.needsApproval) {
                lead.approvalStatus = 'awaiting_human_review';
                audit.log('Policy', 'HITL', `Lead ${companyName} flagged: ${policy.reason}`);
            } else {
                lead.approvalStatus = 'auto_approved';
            }
            leads.push(lead);
        }
    }

    return {
        reply: JSON.stringify(leads.slice(0, MAX_LEADS_RETURNED)),
        _meta: {
            auditTrail: audit.getTrail(),
            cost: costTracker.estimatedUSDThisSession
        }
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

async function generateFreeResponse(message, history, userProfile, onProgress) {
    const apiKey    = process.env.OPENAI_API_KEY;
    const tavilyKey = process.env.TAVILY_API_KEY;
    const safeMessage = sanitizeUserMessage(message);

    const intent = await _classifyIntent(safeMessage, history, apiKey);

    if (intent === 'clarification_needed') {
        return { reply: "Your request is a bit vague. Could you specify the industry or location you're interested in?" };
    }

    if (intent === 'lead_gen') {
        return await _runLeadGenPipeline(safeMessage, history, userProfile, onProgress, { code: 'en' }, apiKey, tavilyKey);
    }

    return { reply: "I've processed your request. How else can I help?" };
}

module.exports = { generateFreeResponse };
