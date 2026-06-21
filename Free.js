'use strict';

const axios = require('axios');
const dns   = require('dns').promises;
const net   = require('net');

const Company     = require('./Company');
const SearchCache = require('./SearchCache');
const { generateQueryHash, getCachedSearchResults, saveSearchCache, saveCompanyFromLead } = require('./companyMemoryService');

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONFIG & CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_LEADS_RETURNED         = 5;
const TAVILY_LIMIT               = 1000;
const CONCURRENCY_LIMIT          = 2;
const CACHE_TTL_MS               = 60 * 60 * 1000;
const MEMORY_TTL_DAYS            = 30;
const CONTACT_REVERIFY_DAYS      = 30;
const CURRENT_YEAR               = new Date().getFullYear();
const MAX_MESSAGE_LENGTH         = 800;
const EMAIL_CONFIDENCE_THRESHOLD = 28;

const QUANTITY_RULE_HARD_MIN     = 2;
const QUANTITY_RULE_ABSOLUTE_MIN = 1;
const QUANTITY_RULE_DEFAULT_MAX  = MAX_LEADS_RETURNED;
const MIN_POOL_SIZE              = 3;

const INTENT = {
    LEAD_GEN:    'lead_gen',
    CHAT:        'chat',
    EMAIL_DRAFT: 'email_draft',
    BUSINESS_QA: 'business_qa',
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
// SECTION 2 — MEMORY DATABASES (Five Pillars)
// ═══════════════════════════════════════════════════════════════════════════════

const companyMemoryDB  = new Map();   // Pillar 1: Company Memory
const contactDB        = new Map();   // Pillar 2: Contact Intelligence
const researchDB       = new Map();   // Pillar 3: Research Intelligence
const analyticsDB      = new Map();   // Pillar 5: Outcome Analytics
const searchHistoryDB  = new Map();

function getCompanyMemory(domain) {
    const rec = companyMemoryDB.get(domain);
    if (!rec) return null;
    const ageDays = (Date.now() - new Date(rec.lastUpdated).getTime()) / 86400000;
    if (ageDays > MEMORY_TTL_DAYS) { console.log(`🗓️ [MEMORY] ${domain} stale — refreshing`); return null; }
    console.log(`🏢 [COMPANY MEMORY HIT] ${domain} — age: ${Math.floor(ageDays)}d`);
    return rec;
}

function setCompanyMemory(domain, data) {
    const existing = companyMemoryDB.get(domain) || {};
    companyMemoryDB.set(domain, {
        ...existing, domain,
        companyName:  data.companyName  || existing.companyName  || null,
        industry:     data.industry     || existing.industry     || null,
        hq:           data.hq           || existing.hq           || null,
        size:         data.size         || existing.size         || null,
        model:        data.model        || existing.model        || null,
        techStack:    data.techStack    || existing.techStack    || [],
        triggers:     data.triggers     || existing.triggers     || [],
        research:     data.research     || existing.research     || {},
        leadScore:    data.leadScore    || existing.leadScore    || 0,
        lastUpdated:  new Date().toISOString(),
    });
    console.log(`💾 [COMPANY MEMORY SAVE] ${domain}`);
}

function getCompanyMemoryStats() {
    return {
        totalCompanies: companyMemoryDB.size,
        totalContacts:  contactDB.size,
        totalResearch:  researchDB.size,
        totalAnalytics: analyticsDB.size,
    };
}

function getContactMemory(email) {
    const rec = contactDB.get(email?.toLowerCase());
    if (!rec) return null;
    const ageDays = (Date.now() - new Date(rec.lastVerified).getTime()) / 86400000;
    if (ageDays > CONTACT_REVERIFY_DAYS) { rec._needsReverification = true; }
    console.log(`👤 [CONTACT MEMORY HIT] ${email} | grade:${rec.verificationGrade}`);
    return rec;
}

function setContactMemory(email, data) {
    const key = email?.toLowerCase();
    if (!key) return;
    const existing = contactDB.get(key) || {};
    const grade = _computeVerificationGrade(data.confidenceScore, data.smtpResult, data.mxValid);
    contactDB.set(key, {
        ...existing,
        name:              data.name              || existing.name              || null,
        role:              data.role              || existing.role              || null,
        companyDomain:     data.companyDomain     || existing.companyDomain    || null,
        email:             key,
        confidence:        data.confidenceScore   || existing.confidence       || 0,
        smtpResult:        data.smtpResult        || existing.smtpResult       || 'unknown',
        mxValid:           data.mxValid           ?? existing.mxValid          ?? false,
        verificationGrade: grade,
        lastVerified:      new Date().toISOString(),
        _needsReverification: false,
    });
    console.log(`💾 [CONTACT MEMORY SAVE] ${key} | grade:${grade}`);
}

function _computeVerificationGrade(confidenceScore, smtpResult, mxValid) {
    if (smtpResult === 'valid' && confidenceScore >= 90) return 'A+';
    if (smtpResult === 'valid' && confidenceScore >= 70) return 'A';
    if (mxValid && confidenceScore >= 60)                return 'B';
    if (mxValid && confidenceScore >= 40)                return 'C';
    return 'D';
}

function getResearchMemory(domain) {
    const rec = researchDB.get(domain);
    if (!rec) return null;
    const ageDays = (Date.now() - new Date(rec.lastUpdated).getTime()) / 86400000;
    if (ageDays > MEMORY_TTL_DAYS) return null;
    console.log(`🔬 [RESEARCH MEMORY HIT] ${domain} — age: ${Math.floor(ageDays)}d`);
    return rec;
}

function setResearchMemory(domain, data) {
    const existing = researchDB.get(domain) || {};
    researchDB.set(domain, {
        ...existing, domain,
        painPoints:       data.painPoints       || existing.painPoints       || [],
        recentNews:       data.recentNews       || existing.recentNews       || null,
        mission:          data.mission          || existing.mission          || null,
        industryInsights: data.industryInsights || existing.industryInsights || [],
        techStack:        data.techStack        || existing.techStack        || [],
        triggers:         data.triggers         || existing.triggers         || [],
        events:           [...(existing.events || []), ...(data.events || [])].slice(-10),
        lastUpdated:      new Date().toISOString(),
    });
    console.log(`💾 [RESEARCH MEMORY SAVE] ${domain}`);
}

function recordOutcome(leadData, outcome) {
    const key = `${Date.now()}_${leadData.domain || 'unknown'}`;
    analyticsDB.set(key, {
        industry:    leadData.industry    || 'unknown',
        role:        leadData.role        || 'unknown',
        companySize: leadData.companySize || 'unknown',
        emailStyle:  leadData.emailStyle  || 'standard',
        domain:      leadData.domain      || null,
        leadScore:   leadData.leadScore   || 0,
        outcome,
        timestamp:   new Date().toISOString(),
    });
    console.log(`📈 [ANALYTICS] ${outcome} → ${leadData.domain || 'unknown'}`);
}

function getAnalyticsSummary() {
    const records = [...analyticsDB.values()];
    const summary = {};
    for (const r of records) {
        if (!summary[r.industry]) summary[r.industry] = { viewed: 0, sent: 0, replied: 0, booked: 0, won: 0 };
        if (r.outcome === 'viewed')         summary[r.industry].viewed++;
        if (r.outcome === 'email_sent')     summary[r.industry].sent++;
        if (r.outcome === 'replied')        summary[r.industry].replied++;
        if (r.outcome === 'meeting_booked') summary[r.industry].booked++;
        if (r.outcome === 'deal_won')       summary[r.industry].won++;
    }
    return summary;
}

function recordSearchHistory(userId, query, results) {
    const key  = userId || 'anonymous';
    const hist = searchHistoryDB.get(key) || [];
    hist.push({ query, resultCount: results.length, timestamp: new Date().toISOString() });
    searchHistoryDB.set(key, hist.slice(-50));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — CONTENT QUALITY SIGNALS
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
// SECTION 4 — COPY CONTROLS & ANTI-HALLUCINATION
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
"30% increase", "3x growth", "50% faster", "double your revenue", "10x results".
If you have no real stat, describe the MECHANISM instead.
BAD:  "We increased leads by 30% for agencies like yours."
GOOD: "We cut the time agencies spend on prospecting by replacing manual research with an automated pipeline."
`;

function buildBannedWordsInstruction() {
    return [
        `BANNED ADJECTIVES — NEVER use: ${BANNED_ADJECTIVES.join(', ')}. Replace with specific facts.`,
        `BANNED PHRASES — NEVER use: ${BANNED_PHRASES.join(' | ')}.`,
        BANNED_STATS_INSTRUCTION,
    ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — QUOTA & COST TRACKERS
// ═══════════════════════════════════════════════════════════════════════════════

const tavilyQuota   = { used: 0, limit: TAVILY_LIMIT, lastReset: Date.now() };
const openAiTracker = { totalCallsThisSession: 0, totalInputTokensThisSession: 0, totalOutputTokensThisSession: 0 };
const costTracker   = { estimatedUSDThisSession: 0 };

function checkTavilyReset() {
    if (Date.now() - tavilyQuota.lastReset >= 30 * 24 * 60 * 60 * 1000) {
        tavilyQuota.used = 0; tavilyQuota.lastReset = Date.now();
    }
}
function getTavilyRemaining() { checkTavilyReset(); return tavilyQuota.limit - tavilyQuota.used; }
function recordTavilyUsage()  { tavilyQuota.used += 1; }

function recordOpenAiUsage(inputTokens = 0, outputTokens = 0, model = 'gpt-4o-mini') {
    openAiTracker.totalCallsThisSession++;
    openAiTracker.totalInputTokensThisSession  += inputTokens;
    openAiTracker.totalOutputTokensThisSession += outputTokens;
    const PRICING = { 'gpt-4o-mini': { input: 0.15, output: 0.60 }, 'gpt-4o': { input: 2.50, output: 10.00 } };
    const rates = PRICING[model] ?? PRICING['gpt-4o-mini'];
    costTracker.estimatedUSDThisSession += (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — SESSION STATE
// ═══════════════════════════════════════════════════════════════════════════════

const globalSeenDomains      = new Set();
const globalSeenCompanyNames = new Set();
const researchCache          = new Map();

function resetSessionCache() {
    globalSeenCompanyNames.clear();
    researchCache.clear();
}

function getCachedResearch(domain) {
    const memHit = getResearchMemory(domain);
    if (memHit) return memHit;
    const hit = researchCache.get(domain);
    if (!hit) return null;
    if (Date.now() - hit.timestamp > CACHE_TTL_MS) { researchCache.delete(domain); return null; }
    console.log(`💾 [SESSION CACHE HIT] ${domain}`);
    return hit.data;
}

function setCachedResearch(domain, data) {
    researchCache.set(domain, { data, timestamp: Date.now() });
    setResearchMemory(domain, {
        mission:    data.mission,
        recentNews: data.recentNews,
        painPoints: data.painPoints || [],
        techStack:  data.techStack  || [],
        triggers:   data.triggers   || [],
        events:     data.events     || [],
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

async function withRetry(fn, label, retries = 2, delayMs = 800) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try { return await fn(); } catch (err) {
            const isLast = attempt === retries;
            if (err.response?.status && err.response.status < 500 && err.response.status !== 429) {
                console.warn(`⛔ [${label}] Non-retryable (${err.response.status}): ${err.message}`);
                return null;
            }
            console.warn(`⚠️ [${label}] attempt ${attempt + 1} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying'}`);
            if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
    }
    return null;
}

async function runWithConcurrency(tasks, limit) {
    const results = []; const executing = new Set();
    for (const task of tasks) {
        const promise = task()
            .then(result => { executing.delete(promise); return result; })
            .catch(err   => { executing.delete(promise); console.warn(`⚠️ [CONCURRENCY] Task failed: ${err?.message}`); return null; });
        results.push(promise);
        executing.add(promise);
        if (executing.size >= limit) await Promise.race(executing);
    }
    return Promise.allSettled(results);
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
    for (const pattern of injectionPatterns) safe = safe.replace(pattern, '[REDACTED]');
    return safe;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — LANGUAGE DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

function _detectLanguage(message) {
    if (!message || typeof message !== 'string') return { code: 'en', name: 'English', rtl: false };
    const unicodeText = message.replace(/[\x00-\x7F]+/g, ' ').trim();
    if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(unicodeText)) {
        if (/[\u0698\u06AF\u06CC\u06BE]/.test(unicodeText)) return { code: 'fa', name: 'Farsi',  rtl: true };
        if (/[\u06C1\u06BE\u06D2]/.test(unicodeText))        return { code: 'ur', name: 'Urdu',   rtl: true };
        return { code: 'ar', name: 'Arabic', rtl: true };
    }
    if (/[\u0590-\u05FF\uFB1D-\uFB4F]/.test(unicodeText)) return { code: 'he', name: 'Hebrew',   rtl: true  };
    if (/[\u0400-\u04FF]/.test(unicodeText))               return { code: 'ru', name: 'Russian',  rtl: false };
    if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(unicodeText)) {
        if (/[\u3040-\u309F\u30A0-\u30FF]/.test(unicodeText)) return { code: 'ja', name: 'Japanese', rtl: false };
        return { code: 'zh', name: 'Chinese', rtl: false };
    }
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(unicodeText)) return { code: 'ja', name: 'Japanese', rtl: false };
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(unicodeText)) return { code: 'ko', name: 'Korean',   rtl: false };
    if (/[\u0900-\u097F]/.test(unicodeText))               return { code: 'hi', name: 'Hindi',    rtl: false };
    if (/[\u0E00-\u0E7F]/.test(unicodeText))               return { code: 'th', name: 'Thai',     rtl: false };
    if (/[\u0370-\u03FF]/.test(unicodeText))               return { code: 'el', name: 'Greek',    rtl: false };
    const lower = message.toLowerCase();
    const langPatterns = [
        { code: 'es', name: 'Spanish',    rtl: false, pattern: /\b(gracias|hola|empresa|necesito|quiero|tenemos|nuestro|sistema|equipo)\b/ },
        { code: 'fr', name: 'French',     rtl: false, pattern: /\b(merci|bonjour|nous|vous|notre|votre|entreprise|besoin|système|équipe)\b/ },
        { code: 'de', name: 'German',     rtl: false, pattern: /\b(danke|hallo|bitte|haben|sind|kann|wir|das|die|der|unser|team|system)\b/ },
        { code: 'pt', name: 'Portuguese', rtl: false, pattern: /\b(obrigado|olá|temos|nosso|empresa|preciso|quero|sistema|equipe)\b/ },
        { code: 'it', name: 'Italian',    rtl: false, pattern: /\b(grazie|ciao|abbiamo|nostro|azienda|bisogno|voglio|sistema|squadra)\b/ },
        { code: 'nl', name: 'Dutch',      rtl: false, pattern: /\b(bedankt|hallo|wij|onze|bedrijf|nodig|wil|systeem|team)\b/ },
        { code: 'tr', name: 'Turkish',    rtl: false, pattern: /\b(teşekkür|merhaba|bizim|şirket|ihtiyaç|istiyorum|sistem|ekip)\b/ },
        { code: 'sv', name: 'Swedish',    rtl: false, pattern: /\b(tack|hej|vi|vårt|företag|behöver|vill|system|team)\b/ },
        { code: 'id', name: 'Indonesian', rtl: false, pattern: /\b(terima kasih|halo|kami|perusahaan|butuh|ingin|sistem|tim)\b/ },
    ];
    for (const lang of langPatterns) {
        if (lang.pattern.test(lower)) return { code: lang.code, name: lang.name, rtl: lang.rtl };
    }
    return { code: 'en', name: 'English', rtl: false };
}

function _buildMultilingualEmailBlock(detectedLanguage) {
    const rtlNote = detectedLanguage.rtl ? `NOTE: ${detectedLanguage.name} is right-to-left. Format accordingly.` : '';
    return `
MULTILINGUAL ENGINE — CRITICAL:
The user's request was written in: ${detectedLanguage.name} (${detectedLanguage.code}).
${rtlNote}
ALL THREE EMAILS MUST be written entirely in ${detectedLanguage.name}.
RULES: Write every word in ${detectedLanguage.name}. No mixing languages. 100% ${detectedLanguage.name}.
`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

const FREE_EMAIL_PROVIDERS = new Set([
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
    'protonmail.com', 'aol.com', 'mail.com', 'yandex.com', 'zoho.com',
]);

const DISPOSABLE_DOMAINS = new Set([
    'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwam.com',
    'yopmail.com', 'trashmail.com', 'fakeinbox.com', 'sharklasers.com',
    'maildrop.cc', 'discard.email', '10minutemail.com', 'tempr.email',
]);

function isValidEmailFormat(email) {
    if (!email || typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}
function isFreeEmailDomain(domain)  { return FREE_EMAIL_PROVIDERS.has(domain.toLowerCase()); }
function isDisposableDomain(domain) { return DISPOSABLE_DOMAINS.has(domain.toLowerCase()); }

async function validateMX(domain) {
    try { const r = await dns.resolveMx(domain); return r && r.length > 0; } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — VERIFICATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

async function smtpProbeEmail(email, domain) {
    try {
        const mxRecords = await dns.resolveMx(domain);
        if (!mxRecords || mxRecords.length === 0) return 'unknown';
        const mxHost = mxRecords.sort((a, b) => a.priority - b.priority)[0].exchange;
        return await new Promise((resolve) => {
            const timeout = setTimeout(() => { try { socket.destroy(); } catch {} resolve('unknown'); }, 8000);
            const socket  = net.createConnection(25, mxHost);
            let buffer = '', stage = 0;
            socket.on('error', () => { clearTimeout(timeout); resolve('unknown'); });
            socket.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\r\n'); buffer = lines.pop();
                for (const line of lines) {
                    if (!line) continue;
                    const code = parseInt(line.slice(0, 3), 10);
                    if (stage === 0 && code === 220)                { socket.write(`EHLO mailcheck.local\r\n`); stage = 1; }
                    else if (stage === 1 && (code === 250 || code === 220)) { socket.write(`MAIL FROM:<probe@mailcheck.local>\r\n`); stage = 2; }
                    else if (stage === 2 && code === 250)           { socket.write(`RCPT TO:<${email}>\r\n`); stage = 3; }
                    else if (stage === 3) {
                        clearTimeout(timeout); socket.write('QUIT\r\n'); socket.destroy();
                        if      (code === 250 || code === 251)                              { console.log(`✅ [SMTP] ${email} → VALID`);   resolve('valid');   }
                        else if (code === 550 || code === 551 || code === 553 || code === 554) { console.warn(`❌ [SMTP] ${email} → INVALID`); resolve('invalid'); }
                        else                                                                { resolve('unknown'); }
                    } else if (code >= 500) { clearTimeout(timeout); socket.destroy(); resolve('unknown'); }
                }
            });
            socket.on('close', () => { clearTimeout(timeout); if (stage < 3) resolve('unknown'); });
        });
    } catch (err) { console.warn(`⚠️ [SMTP PROBE] ${email}: ${err.message}`); return 'unknown'; }
}

function classifyEmail(email, domain) {
    if (!email) return { type: 'none', label: 'Not found', trustLevel: 0 };
    const localPart   = email.split('@')[0].toLowerCase();
    const emailDomain = email.split('@')[1]?.toLowerCase();
    const domainMatches = emailDomain === domain || emailDomain?.includes(domain.split('.')[0]);
    const GENERIC_PREFIXES = ['contact', 'info', 'hello', 'sales', 'team', 'support', 'enquiries', 'admin', 'office', 'mail', 'general', 'press', 'media'];
    const isGeneric = GENERIC_PREFIXES.some(p => localPart === p || localPart.startsWith(p + '.'));
    if (!domainMatches) return { type: 'unrelated-domain',   label: 'Wrong domain',           trustLevel: 0  };
    if (isGeneric)      return { type: 'confirmed-generic',  label: '✓ Contact email (real)', trustLevel: 70 };
    if (localPart.includes('.') || /[a-z]{2,}[a-z]{2,}/.test(localPart))
                        return { type: 'confirmed-personal', label: '✓ Personal email (real)', trustLevel: 90 };
    return              { type: 'confirmed-other',   label: '✓ Email (real)',               trustLevel: 75 };
}

async function validateEmailFull(email, domain) {
    const normalisedEmail = (typeof email === 'string') ? email.toLowerCase().trim() : email;
    const memContact = getContactMemory(normalisedEmail);
    if (memContact && !memContact._needsReverification) {
        return {
            email: normalisedEmail, verdict: memContact.confidence >= 60 ? 'verified' : 'probable',
            confidenceScore: memContact.confidence, smtpResult: memContact.smtpResult,
            mxValid: memContact.mxValid, disposable: false, syntaxValid: true, domainMatch: true,
            reason: `Memory cache | grade:${memContact.verificationGrade}`,
            verificationGrade: memContact.verificationGrade, _fromMemory: true,
        };
    }
    const result = {
        email: normalisedEmail, verdict: 'rejected', confidenceScore: 0,
        smtpResult: null, mxValid: false, disposable: false,
        syntaxValid: false, domainMatch: false, reason: '', verificationGrade: 'D',
    };
    if (!isValidEmailFormat(normalisedEmail))        { result.reason = 'Invalid syntax';              return result; }
    result.syntaxValid = true;
    const emailDomain = normalisedEmail.split('@')[1]?.toLowerCase();
    if (!emailDomain)                                { result.reason = 'No domain in email';           return result; }
    if (isDisposableDomain(emailDomain))             { result.disposable = true; result.reason = 'Disposable domain'; return result; }
    if (isFreeEmailDomain(emailDomain))              { result.reason = 'Free email provider';          return result; }
    if (REPUTATION_BLOCKED_DOMAINS.has(emailDomain)){ result.reason = 'Domain on reputation blocklist'; return result; }
    const domainRoot   = domain.split('.')[0].toLowerCase();
    result.domainMatch = emailDomain === domain || emailDomain.includes(domainRoot);
    if (!result.domainMatch)                         { result.reason = `Domain mismatch: ${emailDomain} vs ${domain}`; return result; }
    result.mxValid = await validateMX(emailDomain);
    if (!result.mxValid)                             { result.reason = 'No MX records';                return result; }
    const classification = classifyEmail(normalisedEmail, domain);
    let smtpResult = 'unknown';
    try { smtpResult = await smtpProbeEmail(normalisedEmail, emailDomain); } catch (e) {}
    result.smtpResult = smtpResult;
    if (smtpResult === 'invalid')  { result.reason = 'SMTP probe: mailbox does not exist'; return result; }
    if (smtpResult === 'valid') {
        result.confidenceScore = classification.type === 'confirmed-personal' ? 95 : 78;
        result.verdict         = 'verified';
        result.reason          = classification.type === 'confirmed-personal' ? 'SMTP-confirmed personal email' : 'SMTP-confirmed role email';
    } else {
        if      (classification.type === 'confirmed-personal')                           { result.confidenceScore = 65; result.verdict = 'probable'; result.reason = 'Public source, personal format, MX valid'; }
        else if (['confirmed-generic', 'confirmed-other'].includes(classification.type)) { result.confidenceScore = 52; result.verdict = 'probable'; result.reason = 'Public source, role email, MX valid'; }
        else                                                                             { result.confidenceScore = 30; result.verdict = 'probable'; result.reason = 'Source-found, MX valid, format unclear'; }
    }
    result.verificationGrade = _computeVerificationGrade(result.confidenceScore, result.smtpResult, result.mxValid);
    setContactMemory(normalisedEmail, { confidenceScore: result.confidenceScore, smtpResult: result.smtpResult, mxValid: result.mxValid });
    return result;
}

async function rankAndFilterEmails(emails, domain) {
    if (!emails || emails.length === 0) return [];
    const unique    = [...new Set(emails.map(e => (typeof e === 'string' ? e.toLowerCase().trim() : e)))];
    console.log(`🔬 [VALIDATOR] Running pipeline on ${unique.length} email(s) for ${domain}`);
    const validated = await Promise.all(unique.map(email => validateEmailFull(email, domain)));
    const passing   = validated.filter(r => r.confidenceScore >= EMAIL_CONFIDENCE_THRESHOLD).sort((a, b) => b.confidenceScore - a.confidenceScore);
    console.log(`📊 [VALIDATOR] ${passing.length}/${unique.length} passed threshold`);
    return passing;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — EMAIL EXTRACTION & PATTERN-BASED HUNTING
// ═══════════════════════════════════════════════════════════════════════════════

function extractEmailsFromText(text, companyDomain) {
    if (!text || !companyDomain) return { companyEmails: [], allEmails: [] };
    const emailRegex    = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const allFound      = [...new Set(text.match(emailRegex) || [])];
    const domainRoot    = companyDomain.split('.')[0].toLowerCase();
    const companyEmails = allFound.filter(e => {
        const ed = e.split('@')[1]?.toLowerCase() || '';
        return ed === companyDomain || ed.includes(domainRoot);
    });
    if (companyEmails.length > 0) console.log(`📧 [REGEX] Found ${companyEmails.length} email(s) for ${companyDomain}:`, companyEmails);
    return { companyEmails, allEmails: allFound };
}

/**
 * PATTERN-BASED EMAIL GENERATION — NEW
 * Given a real person's name and company domain, generate common email patterns
 * then SMTP-verify each one. This is how Hunter.io works under the hood.
 */
async function generateAndVerifyEmailPatterns(firstName, lastName, domain) {
    if (!firstName || !lastName || !domain) return null;
    const f  = firstName.toLowerCase().trim();
    const l  = lastName.toLowerCase().trim();
    const fi = f[0];
    const li = l[0];

    const patterns = [
        `${f}.${l}@${domain}`,
        `${f}${l}@${domain}`,
        `${fi}${l}@${domain}`,
        `${f}${li}@${domain}`,
        `${f}@${domain}`,
        `${f}-${l}@${domain}`,
        `${fi}.${l}@${domain}`,
    ];

    console.log(`🔑 [PATTERN HUNT] Testing ${patterns.length} patterns for ${firstName} ${lastName} @ ${domain}`);

    for (const candidate of patterns) {
        const result = await validateEmailFull(candidate, domain);
        if (result.smtpResult === 'valid') {
            console.log(`✅ [PATTERN HIT] ${candidate} SMTP confirmed`);
            return { email: candidate, ...result };
        }
    }

    // If no SMTP-valid hit, return highest-confidence probable
    const probables = await rankAndFilterEmails(patterns, domain);
    if (probables.length > 0) {
        console.log(`🟡 [PATTERN PROBABLE] ${probables[0].email} (score:${probables[0].confidenceScore})`);
        return probables[0];
    }
    return null;
}

async function huntRealEmails(companyName, domain, tavilyKey) {
    if (getTavilyRemaining() <= 0) return { companyEmails: [], allEmails: [] };
    console.log(`🎯 [EMAIL HUNT] ${companyName} @ ${domain}`);
    const contactResults = await searchWithTavily(
        `"${companyName}" contact email "@${domain}" OR "contact us" OR "email us"`,
        tavilyKey, { maxResults: 3 }
    );
    const directoryResults = getTavilyRemaining() > 0
        ? await searchWithTavily(`${companyName} ${domain} email address contact`, tavilyKey, { maxResults: 3 })
        : [];
    const allText   = [...contactResults, ...directoryResults].map(r => `${r.title} ${r.snippet} ${r.url}`).join(' ');
    const extracted = extractEmailsFromText(allText, domain);
    if (extracted.companyEmails.length > 0) console.log(`✅ [EMAIL HUNT] Found:`, extracted.companyEmails);
    else console.log(`⚠️ [EMAIL HUNT] No emails found for ${domain}`);
    return extracted;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — TAVILY SEARCH + PAGE FETCHER
// ═══════════════════════════════════════════════════════════════════════════════

async function searchWithTavily(query, tavilyKey, options = {}) {
    if (getTavilyRemaining() <= 0) throw new Error('Tavily quota exhausted');
    return withRetry(async () => {
        const response = await axios.post('https://api.tavily.com/search', {
            api_key:             tavilyKey,
            query,
            search_depth:        'advanced',
            max_results:         options.maxResults || 5,
            include_answer:      false,
            include_raw_content: false,
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 12000 });
        recordTavilyUsage();
        return (response.data?.results || []).map(r => ({
            title:   r.title   || '',
            url:     r.url     || '',
            snippet: r.content || '',
            date:    r.published_date || null,
        }));
    }, `Tavily:${query.slice(0, 40)}`) ?? [];
}

/**
 * PAGE FETCHER — NEW (Intelligence Layer)
 * Fetches the actual /about or /contact page for a domain to extract
 * emails, names, and roles directly from full page content.
 * Uses Tavily's raw_content mode on specific URLs.
 */
async function fetchCompanyPage(domain, tavilyKey, pagePath = '/about') {
    if (getTavilyRemaining() <= 0) return null;
    const url = `https://${domain}${pagePath}`;
    console.log(`🌐 [PAGE FETCH] ${url}`);
    try {
        const results = await searchWithTavily(`site:${domain} ${pagePath.replace('/', '')}`, tavilyKey, { maxResults: 2 });
        if (!results || results.length === 0) return null;
        const pageResult = results.find(r => r.url.includes(domain)) || results[0];
        return pageResult?.snippet || null;
    } catch (err) {
        console.warn(`⚠️ [PAGE FETCH] Failed for ${url}: ${err.message}`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 13 — SEARCH QUERY BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

function _buildEntityFirstQueries(intent) {
    const loc = intent.location ? `"${intent.location}"` : '';
    const ind = intent.industry || '';
    const tgt = intent.target   || '';

    const primary = [
        `"${tgt}"`, ind, loc,
        'contact email CEO founder',
        'inurl:about OR inurl:team OR inurl:contact OR inurl:contact-us',
    ].filter(Boolean).join(' ');

    const entityFocus = [
        ind, loc,
        'official website company',
        '"about us" OR "our team" OR "meet the team"',
        '"contact us" OR "get in touch"',
    ].filter(Boolean).join(' ');

    const dmFocus = [
        `"${ind}"`, loc,
        'CEO OR founder OR owner OR director',
        '"email" OR "contact"',
        '-site:linkedin.com -site:crunchbase.com',
    ].filter(Boolean).join(' ');

    // NEW: Trigger event query (Intent Signals Layer)
    const triggerFocus = [
        `"${ind}"`, loc,
        `${CURRENT_YEAR}`,
        'funding OR hired OR launched OR expanding OR "new office" OR "series A" OR "series B"',
        '-site:linkedin.com',
    ].filter(Boolean).join(' ');

    return { primary, entityFocus, dmFocus, triggerFocus };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 14 — SCORING
// ═══════════════════════════════════════════════════════════════════════════════

function _scorePageBusinessRelevance(result) {
    const url     = (result.url     || '').toLowerCase();
    const title   = (result.title   || '').toLowerCase();
    const snippet = (result.snippet || '').toLowerCase();
    let score = 50;
    for (const pattern of LOW_VALUE_URL_PATTERNS)  { if (pattern.test(url))      { score -= 35; break; } }
    for (const pattern of HIGH_VALUE_URL_PATTERNS) { if (pattern.test(url))      { score += 20; break; } }
    for (const signal of HIGH_VALUE_TITLE_SIGNALS) { if (title.includes(signal)) { score += 15; break; } }
    for (const signal of LOW_VALUE_TITLE_SIGNALS)  { if (title.includes(signal)) { score -= 20; break; } }
    if (snippet.includes('@'))                                    score += 15;
    if (snippet.includes('contact'))                              score += 8;
    if (/ceo|founder|owner|director/.test(snippet))               score += 15;
    if (/agency|studio|solutions|services/.test(snippet))         score += 10;
    if (/about us|our team|meet the team/.test(snippet))          score += 10;
    if (/how to|what is|tutorial|step.by.step/.test(snippet))     score -= 20;
    if (/read more|subscribe|newsletter|download free/.test(snippet)) score -= 15;
    if (/top \d+|best \d+|\d+ ways/.test(snippet))                score -= 12;
    return Math.max(0, Math.min(100, score));
}

function scoreDataCompleteness(extracted) {
    if (!extracted) return 0;
    let score = 0;
    if (extracted.mission    && extracted.mission    !== 'unknown') score += 15;
    if (extracted.hq         && extracted.hq         !== 'unknown') score += 10;
    if (extracted.size       && extracted.size       !== 'unknown') score += 10;
    if (extracted.model      && extracted.model      !== 'unknown') score += 10;
    if (extracted.recentNews)                                       score += 15;
    if (extracted.contactEmails?.length > 0)                        score += 15;
    if (extracted.employees?.length > 0)                            score += 15;
    if (extracted.employees?.some(e => e.email))                    score += 10;
    return Math.min(score, 100);
}

function scoreLeadQuality({ emailConfidence, emailConfidenceScore, mxValid, smtpResult, hasRealName,
    hasRealRole, hasLinkedIn, hasNews, hasMission, dataScore, hallucinationCount, pageScore, triggerCount }) {
    let score = 0;
    if      (emailConfidence === 'confirmed-personal') score += 40;
    else if (emailConfidence === 'confirmed-generic')  score += 30;
    else if (emailConfidence === 'confirmed-other')    score += 28;
    else if (emailConfidence === 'guessed-pattern')    score += 12;
    else                                               score += 3;
    if      (emailConfidenceScore >= 90) score += 5;
    else if (emailConfidenceScore >= 70) score += 3;
    else if (emailConfidenceScore >= 50) score += 1;
    if (mxValid)                score += 12;
    if (smtpResult === 'valid') score += 8;
    if (hasRealName)  score += 10;
    if (hasRealRole)  score += 5;
    if (hasLinkedIn)  score += 5;
    if (hasNews)      score += 8;
    if (hasMission)   score += 4;
    if (dataScore > 60) score += 3;
    if (triggerCount > 0) score += Math.min(triggerCount * 8, 20); // Intent Signals bonus
    if (pageScore && pageScore >= 70)      score += 10;
    else if (pageScore && pageScore >= 50) score += 5;
    else if (pageScore && pageScore >= 40) score += 2;
    const hallucinationPenalty = Math.min((hallucinationCount || 0) * 10, 30);
    score -= hallucinationPenalty;
    const finalScore = Math.max(0, Math.min(score, 100));
    console.log(`📊 [LEAD SCORE] email:${emailConfidence} smtp:${smtpResult} triggers:${triggerCount} halluc:-${hallucinationPenalty} → FINAL:${finalScore}`);
    return finalScore;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 15 — TRIGGER EVENT DETECTION (Intent Signals Layer)
// ═══════════════════════════════════════════════════════════════════════════════

function detectTriggerEvents(text) {
    if (!text) return [];
    const combined = text.toLowerCase();
    const triggers = [];

    const triggerMap = [
        { key: 'funding_raised',   pattern: /raised|funding|series [abcde]|seed round|investment|capital raised|venture/i },
        { key: 'product_launch',   pattern: /launched|launching|new product|new feature|just released|announcing|released today/i },
        { key: 'rapid_hiring',     pattern: /hiring|we're growing|join our team|multiple openings|expanding team|10\+ jobs/i },
        { key: 'recent_award',     pattern: /award|won first|recognized|top \d+|best of|named one of|ranked/i },
        { key: 'new_partnership',  pattern: /partnership|partnered with|collaboration|strategic alliance|joined forces/i },
        { key: 'office_expansion', pattern: /new office|opened in|expanding to|new location|international expansion/i },
        { key: 'leadership_hire',  pattern: /appointed|new ceo|new cmo|new vp|welcomes|joins as|named as/i },
        { key: 'revenue_growth',   pattern: /revenue growth|record revenue|profitable|arr|mrr growth|fastest growing/i },
    ];

    for (const { key, pattern } of triggerMap) {
        if (pattern.test(combined)) {
            triggers.push(key);
            console.log(`⚡ [TRIGGER] Detected: ${key}`);
        }
    }
    return [...new Set(triggers)];
}

function _formatTriggerForEmail(triggers) {
    if (!triggers || triggers.length === 0) return null;
    const triggerMessages = {
        'funding_raised':   'I saw you recently raised funding',
        'product_launch':   'I noticed you recently launched a new product',
        'rapid_hiring':     'I can see you\'re growing fast — lots of open roles on your site',
        'recent_award':     'Congratulations on the recent recognition',
        'new_partnership':  'I saw the recent partnership announcement',
        'office_expansion': 'I noticed you\'re expanding to a new location',
        'leadership_hire':  'I saw the recent leadership announcement',
        'revenue_growth':   'Strong growth signals caught my attention',
    };
    return triggerMessages[triggers[0]] || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 16 — HALLUCINATION DETECTION & CONTACT PICKER
// ═══════════════════════════════════════════════════════════════════════════════

function detectHallucinations(companyName, extracted) {
    const flags = [];
    if (Array.isArray(extracted.employees)) {
        extracted.employees.forEach((emp, i) => {
            if (emp.name && companyName && emp.name.toLowerCase().includes(companyName.toLowerCase().split(' ')[0])) {
                flags.push(`Employee[${i}] name contains company name: "${emp.name}"`);
            }
            if (emp.email && extracted._domain) {
                const emailDomain = emp.email.split('@')[1];
                if (emailDomain && emailDomain !== extracted._domain && !emailDomain.includes(extracted._domain.split('.')[0])) {
                    flags.push(`Employee[${i}] email domain "${emailDomain}" ≠ "${extracted._domain}"`);
                }
            }
        });
    }
    if (extracted.mission) {
        const genericPhrases = ['helping businesses', 'empowering companies', 'world-class', 'innovative solutions', 'cutting-edge'];
        if (genericPhrases.some(p => extracted.mission.toLowerCase().includes(p))) {
            flags.push(`Mission may be hallucinated: "${extracted.mission}"`);
        }
    }
    if (extracted.recentNews) {
        const yearMatch = extracted.recentNews.match(/\b(20\d{2})\b/);
        if (yearMatch && parseInt(yearMatch[1]) < CURRENT_YEAR - 2) {
            flags.push(`recentNews stale (${yearMatch[1]})`);
        }
    }
    return flags;
}

function _pickBestContact(employees, preferredContact) {
    if (!employees || employees.length === 0) return null;
    const preferred = (preferredContact || '').toLowerCase().trim();
    if (preferred && preferred !== 'any') {
        const match = employees.find(e => e.role && e.role.toLowerCase().includes(preferred));
        if (match) { console.log(`👤 [DM PICKER] Preferred match: ${match.name} (${match.role})`); return match; }
    }
    const ranked = [...employees].sort((a, b) => {
        const aRole  = (a.role || '').toLowerCase();
        const bRole  = (b.role || '').toLowerCase();
        const aScore = Object.entries(ROLE_PRIORITY).find(([key]) => aRole.includes(key))?.[1] ?? 99;
        const bScore = Object.entries(ROLE_PRIORITY).find(([key]) => bRole.includes(key))?.[1] ?? 99;
        return aScore - bScore;
    });
    const best = ranked[0];
    if (best) console.log(`👤 [DM PICKER] Best by priority: ${best.name || 'Unknown'} (${best.role || 'Unknown'})`);
    return best;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 17 — QUANTITY PARSER & RULES
// ═══════════════════════════════════════════════════════════════════════════════

function _parseRequestedCount(message) {
    if (!message || typeof message !== 'string') return null;
    const lower = message.toLowerCase();
    const wordToNum = {
        'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
        'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
        'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14,
        'fifteen': 15, 'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'twenty': 20,
    };
    const digitMatch = message.match(/\b(\d{1,3})\s*(?:leads?|emails?|contacts?|companies|results?|prospects?)\b/i);
    if (digitMatch) { const n = parseInt(digitMatch[1], 10); if (n >= 1 && n <= 100) return n; }
    const giveMatch = message.match(/\b(?:give|find|get|show|fetch|pull|return|bring)\s+(?:me\s+)?(\d{1,3})\b/i);
    if (giveMatch)  { const n = parseInt(giveMatch[1], 10);  if (n >= 1 && n <= 100) return n; }
    for (const [word, num] of Object.entries(wordToNum)) {
        if (new RegExp(`\\b${word}\\s*(?:leads?|emails?|contacts?|companies|results?|prospects?)?\\b`, 'i').test(lower)) return num;
    }
    const topMatch = message.match(/\btop\s+(\d{1,3})\b/i);
    if (topMatch) { const n = parseInt(topMatch[1], 10); if (n >= 1 && n <= 100) return n; }
    return null;
}

function _applyOutputQuantityRules(leads, requestedMax) {
    if (!Array.isArray(leads)) return [];
    const cap     = Math.min(requestedMax, QUANTITY_RULE_DEFAULT_MAX);
    const sliceTo = Math.max(QUANTITY_RULE_HARD_MIN, Math.min(cap, leads.length));
    const final   = leads.slice(0, sliceTo);
    console.log(`📐 [QUANTITY] Verified:${leads.length} | Requested:${requestedMax} | Returning:${final.length}`);
    return final;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 18 — INDUSTRY PAIN POINTS (Personalization Layer)
// ═══════════════════════════════════════════════════════════════════════════════

const INDUSTRY_PAIN_POINTS = {
    'digital marketing agency':    'agencies burning hours on manual prospecting, chasing unqualified leads, and writing generic outreach that gets ignored',
    'marketing agency':            'agencies losing time on manual lead research instead of focusing on client delivery and retention',
    'creative agency':             'creative studios spending more time pitching cold prospects than doing actual creative work',
    'seo agency':                  'SEO agencies struggling to prove ROI to clients and spending too long building qualified prospect lists',
    'web design':                  'web designers who lose deals because outreach is slow and competitors respond to prospects first',
    'web development':             'dev shops wasting billable hours on prospecting when those hours should go toward building',
    'software development':        'dev agencies under constant pressure to fill the pipeline between project completions',
    'saas':                        'SaaS companies burning budget on broad ads instead of targeting companies with active buying signals',
    'recruitment':                 'recruiters drowning in manual candidate sourcing when their value is in the match, not the search',
    'real estate':                 'real estate professionals struggling to find qualified buyers and sellers before competitors do',
    'accounting':                  'accountants and bookkeepers losing clients to larger firms because their outreach is reactive not proactive',
    'law firm':                    'law firms that depend entirely on referrals and have no consistent outbound pipeline',
    'consulting':                  'consultants whose revenue is feast-or-famine because they only prospect when they\'re not busy',
    'financial services':          'financial advisors who need to reach business owners at the exact moment they\'re thinking about growth',
    'insurance':                   'insurance brokers competing on price when they should be competing on relevance and timing',
    'healthcare':                  'healthcare businesses struggling to reach the right clinic administrators and procurement decision-makers',
    'e-commerce':                  'e-commerce brands paying too much for acquisition because they can\'t identify and target their ideal buyer profile',
    'logistics':                   'logistics providers losing contracts because they reach procurement teams after competitors already have',
    'manufacturing':               'manufacturers who need to get in front of procurement managers before the annual vendor review cycle',
    'construction':                'construction firms relying on tender lists and missing early-stage project opportunities',
    'education':                   'edtech companies trying to reach school administrators who are notoriously hard to reach through standard channels',
    'hospitality':                 'hospitality businesses needing to reach corporate travel managers and event planners at the right moment',
    'media':                       'media companies losing sponsorship revenue because outreach to brand managers is slow and generic',
    'pr agency':                   'PR agencies pitching cold with no context on what journalists or clients actually need right now',
    'events':                      'event companies that only win business reactively and need a systematic way to reach planners before budget is allocated',
    'general':                     'businesses spending too much time finding leads manually and not enough time closing them',
};

function _getIndustryPainPoints(industry) {
    if (!industry) return INDUSTRY_PAIN_POINTS['general'];
    const lower = industry.toLowerCase();
    for (const [key, pain] of Object.entries(INDUSTRY_PAIN_POINTS)) {
        if (lower.includes(key) || key.includes(lower)) return pain;
    }
    return INDUSTRY_PAIN_POINTS['general'];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 19 — COMPANY RESEARCH (Intelligence Layer + Data Layer)
// ═══════════════════════════════════════════════════════════════════════════════

async function researchCompanyForLead(companyName, domain, tavilyKey, openAiKey, onProgress) {
    // 1. Check session cache
    const cached = getCachedResearch(domain);
    if (cached) return cached;

    // 2. Check MongoDB
    const mongoCompany = await Company.findOne({ domain });
    if (mongoCompany?.lastUpdated) {
        const ageDays = (Date.now() - new Date(mongoCompany.lastUpdated).getTime()) / 86400000;
        if (ageDays <= MEMORY_TTL_DAYS) {
            console.log(`🏢 [MONGODB] Using stored company data for ${domain} (age: ${Math.floor(ageDays)}d)`);
            const research = mongoCompany.research || {};
            return {
                mission: research.mission || null,
                hq: mongoCompany.hq || null,
                size: mongoCompany.size || null,
                model: mongoCompany.model || null,
                recentNews: research.recentNews || null,
                contactEmails: mongoCompany.emails || [],
                employees: research.employees || [],
                triggers: research.triggers || [],
                techStack: research.techStack || [],
                _domain: domain,
            };
        }
    }

    // 3. Check in-memory fallback
    const companyMem = getCompanyMemory(domain);
    if (companyMem?.research && Object.keys(companyMem.research).length > 0) {
        console.log(`🏢 [COMPANY MEMORY] Using stored intelligence for ${domain}`);
        return companyMem.research;
    }

    if (getTavilyRemaining() <= 1) return null;

    try {
        onProgress?.(`🔍 Researching ${companyName}...`);

        // INTELLIGENCE LAYER: Multi-source data collection
        const generalResults = await searchWithTavily(
            `"${companyName}" contact email "contact@" OR "sales@" OR "info@" OR "hello@" site:${domain} OR site:linkedin.com OR site:crunchbase.com mission about ${CURRENT_YEAR}`,
            tavilyKey, { maxResults: 5 }
        );
        const generalText     = generalResults.map(r => `${r.title} ${r.snippet} ${r.url}`).join(' ');
        const generalSnippets = generalResults.map(r => `SOURCE: ${r.url}\nTITLE: ${r.title}\n${r.snippet}`).join('\n\n---\n\n');
        const regexFromGeneral = extractEmailsFromText(generalText, domain);
        const hasEmailSignal   = regexFromGeneral.companyEmails.length > 0 || generalSnippets.toLowerCase().includes('contact');

        let employeeResults = [];
        onProgress?.(`👤 Finding decision-makers at ${companyName}...`);
        if (getTavilyRemaining() > 0) {
            employeeResults = await searchWithTavily(
                `"${companyName}" CEO OR founder OR "head of" OR "director of" OR "VP of" OR owner email LinkedIn`,
                tavilyKey, { maxResults: 4 }
            );
        }

        let contactPageResults = [];
        if (!hasEmailSignal && getTavilyRemaining() > 0) {
            contactPageResults = await searchWithTavily(`site:${domain} contact OR about OR team`, tavilyKey, { maxResults: 3 });
        }

        // PAGE FETCHER — Pull /about and /contact directly
        let aboutPageText = '';
        if (getTavilyRemaining() > 0) {
            const aboutContent = await fetchCompanyPage(domain, tavilyKey, '/about');
            if (aboutContent) { aboutPageText = aboutContent; console.log(`📄 [PAGE FETCH] Got /about for ${domain}`); }
        }

        const allResults  = [...generalResults, ...employeeResults, ...contactPageResults];
        const allText     = allResults.map(r => `${r.title} ${r.snippet} ${r.url}`).join(' ') + ' ' + aboutPageText;
        const allSnippets = allResults.map(r => `SOURCE: ${r.url}\nTITLE: ${r.title}\n${r.snippet}`).join('\n\n---\n\n')
                          + (aboutPageText ? `\n\n--- ABOUT PAGE ---\n${aboutPageText}` : '');
        const regexFromAll = extractEmailsFromText(allText, domain);

        // INTENT SIGNALS LAYER: Detect trigger events from all text
        const triggers = detectTriggerEvents(allText);

        if (allSnippets.trim().length === 0) return null;

        const extractPrompt = `${REASONING_FILTER}
Extract company intelligence for "${companyName}" (domain: ${domain}).

PRIORITY TASK — DECISION MAKERS:
Find ALL named individuals at this company. For each person:
- Extract their EXACT name as written in the source
- Extract their EXACT title/role as written
- Extract their email ONLY if literally present in the text (never construct one)
- Extract their LinkedIn URL if present
- Try to identify FIRST NAME and LAST NAME separately

Focus on: CEO, Founder, Co-Founder, Owner, Director, VP, Head of X, Manager.

Also extract:
- Tech stack / tools mentioned (e.g. Shopify, HubSpot, Salesforce, WordPress, React)
- Trigger events: funding, launches, awards, expansions, new hires
- Company size signals: employee count, team size

Return ONLY valid JSON:
{
  "mission": "one sentence company mission or null",
  "hq": "City, Country or null",
  "size": "1-10 | 11-50 | 51-200 | 200+ | unknown",
  "model": "B2B | B2C | SaaS | Services | E-commerce | Agency | unknown",
  "recentNews": "one sentence most recent news or null",
  "techStack": ["tool1", "tool2"],
  "contactEmails": ["role-based emails literally found in text. Max 3. Empty array if none."],
  "employees": [
    {
      "name": "Full Name ONLY if explicitly in snippets. null otherwise.",
      "firstName": "First name only, or null",
      "lastName": "Last name only, or null",
      "role": "Exact title: CEO | Founder | Co-Founder | Director | VP | Manager | Head of X | Owner",
      "email": "Email ONLY if literally in snippets. null otherwise. NEVER invent.",
      "linkedIn": "LinkedIn URL if found. null otherwise."
    }
  ]
}

CRITICAL: Do NOT construct emails. Do NOT invent names. Source text only.

SNIPPETS:
${allSnippets}`;

        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: extractPrompt }],
            max_tokens:  700,
            temperature: 0.0,
        }, { headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:extract');

        if (!res) return null;
        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o-mini');

        const parsed = JSON.parse(res.data.choices[0].message.content.trim().replace(/```json|```/g, ''));
        parsed._domain  = domain;
        parsed.triggers = triggers; // Always use our own trigger detection, not GPT's

        // Merge regex emails with GPT-extracted emails
        const allRealEmails = [...new Set([...regexFromAll.companyEmails, ...(parsed.contactEmails || [])])].filter(isValidEmailFormat);
        parsed.contactEmails = allRealEmails.filter(email => {
            const ed = email.split('@')[1]?.toLowerCase();
            return ed === domain || ed?.includes(domain.split('.')[0]);
        });

        // Reality check: remove any GPT-invented emails
        if (Array.isArray(parsed.employees)) {
            parsed.employees = parsed.employees.map(emp => {
                if (emp.email && !allText.toLowerCase().includes(emp.email.toLowerCase())) {
                    console.warn(`🗑️ [REALITY CHECK] GPT invented email: ${emp.email} — removing`);
                    emp.email = null;
                }
                emp.emailConfidence = emp.email ? 'confirmed-personal' : 'none';
                return emp;
            });
        }

        const hallucinations = detectHallucinations(companyName, parsed);
        if (hallucinations.length > 0) {
            console.warn(`⚠️ [HALLUCINATION] ${companyName}:`, hallucinations);
            parsed._hallucinationFlags = hallucinations;
            if (Array.isArray(parsed.employees)) {
                parsed.employees = parsed.employees.filter(emp => {
                    const isSuspect = hallucinations.some(f => emp.name && f.includes(emp.name));
                    if (isSuspect) console.warn(`🗑️ Removed suspect employee: ${emp.name}`);
                    return !isSuspect;
                });
            }
        }

        parsed._regexEmails = regexFromAll.companyEmails;

        // Persist to all memory layers
        setCompanyMemory(domain, { companyName, hq: parsed.hq, size: parsed.size, model: parsed.model, techStack: parsed.techStack, triggers, research: parsed });
        setCachedResearch(domain, parsed);

        // Pillar 2: Save employees with emails
        if (Array.isArray(parsed.employees)) {
            for (const emp of parsed.employees) {
                if (emp.email && isValidEmailFormat(emp.email)) {
                    setContactMemory(emp.email, { name: emp.name, role: emp.role, companyDomain: domain, confidenceScore: 65, smtpResult: 'unknown', mxValid: true });
                }
            }
        }

        return parsed;

    } catch (err) {
        console.warn(`[Research Error] ${err.message}`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 20 — EMAIL SEQUENCE GENERATOR (Personalization Layer — FULLY IMPLEMENTED)
// ═══════════════════════════════════════════════════════════════════════════════

async function generateEmailsForLead(companyData, contactPerson, domain, userProfile, openAiKey, detectedLanguage) {
    const senderName    = userProfile?.senderName    || userProfile?.name  || 'Alex';
    const senderCompany = userProfile?.senderCompany || userProfile?.company || 'our company';
    const senderOffer   = userProfile?.offer         || 'B2B lead generation and sales automation';
    const senderWebsite = userProfile?.website       || '';

    const contactName   = contactPerson?.name || null;
    const contactRole   = contactPerson?.role || 'Decision Maker';
    const salutation    = contactName ? contactName.split(' ')[0] : 'there';

    const painPoint     = _getIndustryPainPoints(companyData?.industry || '');
    const triggerLine   = _formatTriggerForEmail(companyData?.triggers || []);
    const companyName   = companyData?.name || domain;
    const recentNews    = companyData?.recentNews || null;
    const mission       = companyData?.mission    || null;
    const techStack     = companyData?.techStack?.join(', ') || null;

    // Build rich context string for AI
    const contextBlock = [
        triggerLine    ? `TRIGGER EVENT: ${triggerLine}` : null,
        recentNews     ? `RECENT NEWS: ${recentNews}` : null,
        mission        ? `COMPANY MISSION: ${mission}` : null,
        techStack      ? `TECH STACK: ${techStack}` : null,
        `INDUSTRY PAIN: ${painPoint}`,
        `CONTACT ROLE: ${contactRole}`,
    ].filter(Boolean).join('\n');

    const emailPrompt = `${REASONING_FILTER}
${buildBannedWordsInstruction()}
${_buildMultilingualEmailBlock(detectedLanguage)}

You are writing cold outreach emails on behalf of ${senderName} from ${senderCompany}.
They offer: ${senderOffer}${senderWebsite ? `. Website: ${senderWebsite}` : ''}.

TARGET COMPANY: ${companyName} (${domain})
CONTACT: ${salutation} — ${contactRole}

CONTEXT (USE THIS TO PERSONALISE — do not fabricate beyond this):
${contextBlock}

GOAL: Write 3 emails in a sequence — Initial, Follow-up, Break-up.

EMAIL RULES:
1. Subject lines: under 8 words, no clickbait, no question marks in initial
2. Opening line: reference the TRIGGER EVENT or RECENT NEWS if available. If not, reference what the company does specifically.
3. Body: 3-5 sentences max. One clear mechanism. No fluff.
4. CTA: one specific ask — a 15-minute call, a reply, a question. Never "let me know your thoughts."
5. NEVER use banned adjectives or phrases listed above.
6. NEVER fabricate statistics.
7. Follow-up (sent Day 5): shorter, adds one new angle or asset.
8. Break-up (sent Day 12): 2 sentences max. Give them an easy out.

Return ONLY valid JSON — no preamble, no markdown:
{
  "initial": {
    "subject": "...",
    "body": "Hi ${salutation},\\n\\n[body here]\\n\\n[CTA]\\n\\n${senderName}\\n${senderCompany}"
  },
  "followup": {
    "subject": "Re: [short hook]",
    "body": "Hi ${salutation},\\n\\n[2-3 sentences adding new angle]\\n\\n[CTA]\\n\\n${senderName}"
  },
  "breakup": {
    "subject": "Closing the loop",
    "body": "Hi ${salutation},\\n\\n[1-2 sentences. Give easy out. No guilt.]\\n\\n${senderName}"
  }
}`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: emailPrompt }],
            max_tokens:  900,
            temperature: 0.4,
        }, { headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:emails');

        if (!res) return _fallbackEmailSequence(salutation, companyName, senderName, senderCompany, senderOffer, triggerLine, painPoint);
        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o-mini');

        const raw    = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        const parsed = JSON.parse(raw);
        console.log(`✉️ [EMAIL GEN] Generated 3-email sequence for ${companyName}`);
        return parsed;

    } catch (err) {
        console.warn(`[Email Gen Error] ${err.message} — using fallback`);
        return _fallbackEmailSequence(salutation, companyName, senderName, senderCompany, senderOffer, triggerLine, painPoint);
    }
}

/**
 * FALLBACK EMAIL SEQUENCE — Used when OpenAI fails.
 * Produces a real, usable sequence without AI.
 */
function _fallbackEmailSequence(salutation, companyName, senderName, senderCompany, senderOffer, triggerLine, painPoint) {
    const opener = triggerLine ? `${triggerLine} — congrats.` : `I came across ${companyName} and wanted to reach out directly.`;
    return {
        initial: {
            subject: `${companyName} — worth a quick look?`,
            body: `Hi ${salutation},\n\n${opener}\n\nWe help ${painPoint} — through ${senderOffer}.\n\nWould a 15-minute call this week make sense?\n\n${senderName}\n${senderCompany}`,
        },
        followup: {
            subject: `Re: ${companyName}`,
            body: `Hi ${salutation},\n\nWanted to follow up on my last note. A lot of teams we work with had the same challenge before finding a system that worked.\n\nHappy to share how — worth a quick call?\n\n${senderName}`,
        },
        breakup: {
            subject: 'Closing the loop',
            body: `Hi ${salutation},\n\nI'll stop following up after this. If timing ever changes, you know where to find me.\n\n${senderName}`,
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 21 — SINGLE COMPANY PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

async function processOneCompany(result, intent, tavilyKey, apiKey, userProfile, onProgress, detectedLanguage) {
    try {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
        if (!domain || isFreeEmailDomain(domain)) return null;

        const pageScore = _scorePageBusinessRelevance(result);
        if (pageScore < 30) { console.log(`🔴 [PAGE GATE] Rejected (score:${pageScore}): ${result.url}`); return null; }

        const companyName = cleanCompanyName(result.title);
        if (!companyName) return null;

        const companyKey = companyName.toLowerCase().replace(/\s+/g, '');
        if (globalSeenCompanyNames.has(companyKey)) { console.log(`⏭️ [DEDUP] Skipping: ${companyName}`); return null; }
        globalSeenCompanyNames.add(companyKey);

        onProgress?.(`📋 Researching ${companyName}...`);

        const [companyData, mxValid] = await Promise.all([
            researchCompanyForLead(companyName, domain, tavilyKey, apiKey, onProgress),
            validateMX(domain),
        ]);

        if (!mxValid) { console.warn(`🗑️ [REJECTED] ${companyName} — no MX records`); return null; }

        const dataScore = scoreDataCompleteness(companyData);
        if (dataScore < 10) { console.warn(`🗑️ Skipping ${companyName} — data score ${dataScore}/100`); return null; }

        const employees   = companyData?.employees || [];
        const bestContact = _pickBestContact(employees, intent.preferredContact);

        let candidateEmails = [
            ...(companyData?._regexEmails  || []),
            ...(companyData?.contactEmails || []),
            ...employees.filter(e => e.email && isValidEmailFormat(e.email)).map(e => e.email),
        ].filter(isValidEmailFormat);

        // PATTERN-BASED EMAIL GENERATION — NEW
        // If we have a real name but no email, try to find their email via patterns
        if (candidateEmails.length === 0 && bestContact?.firstName && bestContact?.lastName) {
            onProgress?.(`🔑 Pattern-hunting email for ${bestContact.firstName} ${bestContact.lastName}...`);
            const patternResult = await generateAndVerifyEmailPatterns(bestContact.firstName, bestContact.lastName, domain);
            if (patternResult?.email) {
                candidateEmails.push(patternResult.email);
                console.log(`✅ [PATTERN EMAIL] ${patternResult.email} (score:${patternResult.confidenceScore})`);
            }
        }

        // Fallback: Tavily email hunt
        if (candidateEmails.length === 0 && getTavilyRemaining() > 0) {
            onProgress?.(`🎯 Hunting email for ${companyName}...`);
            const huntResult = await huntRealEmails(companyName, domain, tavilyKey);
            if (huntResult.companyEmails.length > 0) candidateEmails.push(...huntResult.companyEmails.filter(isValidEmailFormat));
        }

        if (candidateEmails.length === 0) { console.warn(`🗑️ [REJECTED] ${companyName} — no emails found`); return null; }

        onProgress?.(`🔬 Validating emails for ${companyName}...`);
        const validatedEmails = await rankAndFilterEmails(candidateEmails, domain);

        if (validatedEmails.length === 0) { console.warn(`🗑️ [REJECTED] ${companyName} — no emails passed validation`); return null; }

        const topEmail       = validatedEmails[0];
        const resolvedEmail  = topEmail.email;
        const classification = classifyEmail(resolvedEmail, domain);

        console.log(`✅ ${companyName} → ${resolvedEmail} [${classification.type}] confidence:${topEmail.confidenceScore} smtp:${topEmail.smtpResult}`);

        setContactMemory(resolvedEmail, {
            name: bestContact?.name, role: bestContact?.role, companyDomain: domain,
            confidenceScore: topEmail.confidenceScore, smtpResult: topEmail.smtpResult, mxValid,
        });

        onProgress?.(`✍️ Writing personalised emails for ${companyName}...`);
        const emailSequence = await generateEmailsForLead(
            {
                name: companyName, mission: companyData?.mission, recentNews: companyData?.recentNews,
                industry: intent.industry, model: companyData?.model,
                triggers: companyData?.triggers || [], techStack: companyData?.techStack || [],
            },
            bestContact, domain, userProfile, apiKey, detectedLanguage
        );

        const hallucinationCount = (companyData?._hallucinationFlags || []).length;
        const triggers           = companyData?.triggers || [];
        const leadScore = scoreLeadQuality({
            emailConfidence:      classification.type,
            emailConfidenceScore: topEmail.confidenceScore,
            mxValid,
            smtpResult:           topEmail.smtpResult,
            hasRealName:          !!bestContact?.name,
            hasRealRole:          !!(bestContact?.role && bestContact.role !== 'unknown'),
            hasLinkedIn:          !!bestContact?.linkedIn,
            hasNews:              !!companyData?.recentNews,
            hasMission:           !!companyData?.mission,
            dataScore,
            hallucinationCount,
            pageScore,
            triggerCount:         triggers.length,
        });

        if (leadScore < 15) { console.warn(`🗑️ [SCORE GATE] ${companyName} rejected (${leadScore}/100)`); return null; }

        const savedCompany = await saveCompanyFromLead({
            company: companyName, domain, industry: intent.industry,
            country: companyData?.hq, companySize: companyData?.size,
            emails: [resolvedEmail], research: companyData, leadScore,
        });

        setCompanyMemory(domain, {
            companyName, hq: companyData?.hq, size: companyData?.size,
            model: companyData?.model, industry: intent.industry,
            triggers, techStack: companyData?.techStack || [], leadScore, research: companyData,
        });

        recordOutcome({ domain, industry: intent.industry, role: bestContact?.role, companySize: companyData?.size, leadScore }, 'viewed');

        return {
            name:            bestContact?.name || companyName,
            company:         companyName,
            domain,
            email:           resolvedEmail,
            emailConfidence: classification.type,
            emailLabel:      classification.label,
            verificationGrade: topEmail.verificationGrade || _computeVerificationGrade(topEmail.confidenceScore, topEmail.smtpResult, mxValid),
            emailValidation: {
                confidenceScore: topEmail.confidenceScore,
                verdict:         topEmail.verdict,
                smtpResult:      topEmail.smtpResult,
                reason:          topEmail.reason,
                grade:           topEmail.verificationGrade,
            },
            allEmailOptions: validatedEmails.map(v => v.email),
            role:            bestContact?.role || (companyData?.model === 'B2B' ? 'Decision Maker' : 'Owner'),
            linkedIn:        bestContact?.linkedIn  || null,
            companySize:     companyData?.size      || 'unknown',
            companyModel:    companyData?.model     || 'unknown',
            industry:        intent.industry        || 'unknown',
            hq:              companyData?.hq        || null,
            recentNews:      companyData?.recentNews || null,
            techStack:       companyData?.techStack  || [],
            triggers,
            leadScore,
            pageScore,
            mxValid,
            dataScore,
            hallucinationFlags: companyData?._hallucinationFlags || [],
            emailLanguage:      detectedLanguage.code,
            _memoryStats:       getCompanyMemoryStats(),
            messages: [
                { type: 'initial',  subject: emailSequence.initial?.subject  || '',  body: emailSequence.initial?.body  || '' },
                { type: 'followup', subject: emailSequence.followup?.subject || '', body: emailSequence.followup?.body || '' },
                { type: 'breakup',  subject: emailSequence.breakup?.subject  || '',  body: emailSequence.breakup?.body  || '' },
            ],
        };

    } catch (err) {
        console.warn(`[processOneCompany Error] ${err.message}`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 22 — INTENT CLASSIFICATION (FULLY IMPLEMENTED)
// ═══════════════════════════════════════════════════════════════════════════════

async function _classifyIntent(message, history, apiKey) {
    // Fast regex pre-check to avoid an API call for obvious cases
    const lower = message.toLowerCase();
    const leadKeywords   = /\b(find|get|generate|show|fetch|pull|give|need|want|looking for)\b.{0,40}\b(leads?|emails?|contacts?|companies|prospects?|clients?|businesses)\b/i;
    const emailKeywords  = /\b(write|draft|create|compose|help me write)\b.{0,40}\b(email|message|outreach|pitch|cold email)\b/i;
    const businessKeywords = /\b(how (do|should|can) i|what('s| is) the best|advice|strategy|tips? for|how to)\b/i;

    if (leadKeywords.test(lower))    return INTENT.LEAD_GEN;
    if (emailKeywords.test(lower))   return INTENT.EMAIL_DRAFT;
    if (businessKeywords.test(lower)) return INTENT.BUSINESS_QA;

    // GPT fallback for ambiguous messages
    try {
        const recentHistory = (history || []).slice(-4).map(h => `${h.role}: ${h.content}`).join('\n');
        const classifyPrompt = `Classify this sales AI assistant message into exactly one intent.

Recent conversation:
${recentHistory || 'None'}

User message: "${message}"

Options:
- lead_gen: User wants to find companies, leads, contacts, emails, prospects
- email_draft: User wants to write, improve, or create an outreach email
- business_qa: User wants sales advice, strategy, best practices, or business tips
- chat: Greetings, off-topic, unclear, or general conversation

Return ONLY the intent label. One word. No explanation.`;

        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:    'gpt-4o-mini',
            messages: [{ role: 'user', content: classifyPrompt }],
            max_tokens:  10,
            temperature: 0.0,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:classify');

        if (res) {
            recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o-mini');
            const detected = res.data.choices[0].message.content.trim().toLowerCase();
            if (Object.values(INTENT).includes(detected)) {
                console.log(`🎯 [INTENT GPT] ${detected}`);
                return detected;
            }
        }
    } catch (err) { console.warn(`[Intent classify error] ${err.message}`); }

    return INTENT.CHAT;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 23 — CHAT HANDLER (FULLY IMPLEMENTED)
// ═══════════════════════════════════════════════════════════════════════════════

async function _handleChat(message, history, userProfile, apiKey) {
    const systemPrompt = `You are Skyline, an AI-powered B2B sales assistant. You help sales teams find leads, write cold outreach, and close more deals.

Your personality: direct, sharp, knowledgeable about B2B sales. You don't waffle. When asked something off-topic, you bring it back to sales.

You can help with:
- Finding leads and prospect companies
- Writing cold outreach emails
- Sales strategy and advice
- Understanding industries and buyer personas

Keep responses concise — 2-4 sentences unless the user needs a detailed breakdown.
Never say "I hope this email finds you well" or use corporate filler phrases.`;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...(history || []).slice(-8),
        { role: 'user', content: message },
    ];

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages,
            max_tokens:  300,
            temperature: 0.7,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:chat');

        if (!res) return 'I can help you find leads, write emails, or answer sales questions. What are you working on?';
        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o-mini');
        return res.data.choices[0].message.content.trim();
    } catch (err) {
        console.warn(`[Chat error] ${err.message}`);
        return 'Something went wrong on my end. Try asking me to find leads or help with a cold email.';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 24 — EMAIL DRAFT HANDLER (FULLY IMPLEMENTED)
// ═══════════════════════════════════════════════════════════════════════════════

async function _handleEmailDraft(message, history, userProfile, apiKey) {
    const senderName    = userProfile?.senderName    || 'Alex';
    const senderCompany = userProfile?.senderCompany || 'my company';
    const senderOffer   = userProfile?.offer         || 'B2B services';

    const systemPrompt = `You are an expert cold email copywriter for B2B sales. You write short, direct, personalised outreach that gets replies.

RULES:
${buildBannedWordsInstruction()}
- Subject lines: under 8 words
- Body: 3-5 sentences max
- One clear CTA per email
- Never start with "I hope this email finds you well" or "My name is"
- Reference specifics from what the user tells you about the target
- If writing a sequence, write Initial + Follow-up + Break-up

Sender context:
- Name: ${senderName}
- Company: ${senderCompany}  
- Offer: ${senderOffer}`;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...(history || []).slice(-6),
        { role: 'user', content: message },
    ];

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages,
            max_tokens:  800,
            temperature: 0.5,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:emailDraft');

        if (!res) return 'I had trouble generating that email. Try giving me more context about who you\'re emailing and what you offer.';
        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o-mini');
        return res.data.choices[0].message.content.trim();
    } catch (err) {
        console.warn(`[Email draft error] ${err.message}`);
        return 'Something went wrong. Please describe who you\'re emailing and I\'ll draft something for you.';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 25 — BUSINESS QA HANDLER (FULLY IMPLEMENTED)
// ═══════════════════════════════════════════════════════════════════════════════

async function _handleBusinessQA(message, history, userProfile, apiKey) {
    const systemPrompt = `You are a senior B2B sales strategist with 15 years of experience in outbound sales, cold email, LinkedIn outreach, and pipeline building.

You give specific, tactical advice. Not theory — real tactics that work.

Rules:
- Be direct. Skip preamble.
- Give specific examples when possible
- If someone asks about cold email, reference real frameworks (PAS, AIDA, Before/After/Bridge)
- If someone asks about a specific industry, give industry-specific insight
- Keep answers under 200 words unless the question genuinely needs depth
- Never recommend spamming or unethical practices
- If you're not sure, say so — don't make things up`;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...(history || []).slice(-6),
        { role: 'user', content: message },
    ];

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages,
            max_tokens:  500,
            temperature: 0.6,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:businessQA');

        if (!res) return 'I couldn\'t pull that answer right now. Try asking about cold email tactics, lead generation strategy, or how to approach a specific industry.';
        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o-mini');
        return res.data.choices[0].message.content.trim();
    } catch (err) {
        console.warn(`[Business QA error] ${err.message}`);
        return 'Something went wrong. Ask me about sales strategy, cold outreach, or how to approach a specific market.';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 26 — LEAD GEN PIPELINE ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════

async function _runLeadGenPipeline(safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, tavilyKey, userId) {
    resetSessionCache();

    const requestedCount = _parseRequestedCount(safeMessage) ?? QUANTITY_RULE_DEFAULT_MAX;
    console.log(`🔢 [QUANTITY] User requested: ${requestedCount} leads`);

    const intentPrompt = `Extract lead generation parameters from: "${safeMessage}".
Return ONLY valid JSON:
{
  "target": "description of ideal customer or company type",
  "industry": "specific industry or niche — be precise e.g. 'plumbing', 'fashion retail', 'SaaS', 'digital marketing agency'",
  "location": "city, country, region — null if not mentioned",
  "preferredContact": "CEO | Founder | Marketing | Sales | Owner | Any"
}
Never return null for target or industry. Infer from context.`;

    let intent = { target: 'small businesses', industry: 'general', location: null, preferredContact: 'Any' };
    try {
        const intentRes = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: intentPrompt }],
            max_tokens:  150,
            temperature: 0.1,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:intent');

        if (intentRes) {
            recordOpenAiUsage(intentRes.data?.usage?.prompt_tokens || 0, intentRes.data?.usage?.completion_tokens || 0, 'gpt-4o-mini');
            intent = { ...intent, ...JSON.parse(intentRes.data.choices[0].message.content.replace(/```json|```/g, '')) };
            console.log(`🎯 Intent: ${JSON.stringify(intent)}`);
        }
    } catch (e) { console.warn('[Intent Parse Failed]:', e.message); }

    // Check MongoDB search cache
    const queryParams = { industry: intent.industry, location: intent.location, target: intent.target, preferredContact: intent.preferredContact };
    const queryHash   = generateQueryHash(queryParams);
    const cachedLeads = await getCachedSearchResults(queryHash);

    if (cachedLeads && cachedLeads.length > 0) {
        console.log(`🎉 [CACHE HIT] Returning ${cachedLeads.length} leads from memory (no Tavily calls)`);
        const leads = cachedLeads.map(company => ({
            name: company.name || company.companyName, company: company.name || company.companyName,
            domain: company.domain, email: company.emails?.[0] || '',
            emailConfidence: 'confirmed-other', emailLabel: 'From cached company',
            verificationGrade: company.research?.verificationGrade || 'B',
            role: 'Decision Maker', linkedIn: null,
            companySize: company.size || 'unknown', companyModel: company.model || 'unknown',
            industry: intent.industry, hq: company.hq || null,
            recentNews: company.research?.recentNews || null,
            triggers: company.research?.triggers || [],
            leadScore: company.leadScore || 50,
            messages: [{
                type: 'initial',
                subject: `Following up on ${intent.industry} opportunities`,
                body: `Hi,\n\nWe previously identified ${company.name || company.companyName} as a strong fit for what we offer.\n\nWould it make sense to connect this week?\n\n${userProfile?.senderName || 'Alex'}\n${userProfile?.senderCompany || ''}`,
            }],
        }));
        const finalLeads = _applyOutputQuantityRules(leads, requestedCount);
        recordSearchHistory(userId, safeMessage, finalLeads);
        return {
            reply: JSON.stringify(finalLeads),
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: `[Retrieved ${finalLeads.length} leads from cache]` }],
            _meta: { fromCache: true, cacheHit: true, memoryStats: getCompanyMemoryStats() },
        };
    }

    onProgress?.(`🔍 Searching for ${intent.industry} companies${intent.location ? ' in ' + intent.location : ''}...`);

    const searchPoolSize = Math.min(Math.max(requestedCount + 5, MAX_LEADS_RETURNED + 3), 15);
    const queries        = _buildEntityFirstQueries(intent);

    const [primaryResults, entityResults] = await Promise.all([
        searchWithTavily(queries.primary,     tavilyKey, { maxResults: searchPoolSize }),
        getTavilyRemaining() > 0
            ? searchWithTavily(queries.entityFocus, tavilyKey, { maxResults: Math.ceil(searchPoolSize / 2) })
            : Promise.resolve([]),
    ]);

    const seenUrls = new Set(primaryResults.map(r => r.url));
    let mergedRaw  = [...primaryResults, ...entityResults.filter(r => !seenUrls.has(r.url))];

    if (mergedRaw.length < MIN_POOL_SIZE && getTavilyRemaining() > 0) {
        console.log(`⚡ [DM FALLBACK] Pool thin (${mergedRaw.length}) — running DM query`);
        try {
            const dmResults = await searchWithTavily(queries.dmFocus, tavilyKey, { maxResults: searchPoolSize });
            const dmUrls    = new Set(mergedRaw.map(r => r.url));
            mergedRaw = [...mergedRaw, ...dmResults.filter(r => !dmUrls.has(r.url))];
        } catch (fbErr) { console.warn(`⚠️ [DM FALLBACK] Failed: ${fbErr.message}`); }
    }

    if (mergedRaw.length === 0) {
        return {
            reply: 'No companies found. Try narrowing the industry or adding a location.',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'No leads found.' }],
        };
    }

    const cleanResults = [];
    for (const result of mergedRaw) {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
        if (!domain) continue;
        if (globalSeenDomains.has(domain)) continue;
        if ([...SKIP_DOMAINS].some(d => domain.includes(d))) continue;
        globalSeenDomains.add(domain);
        cleanResults.push({ ...result, _domain: domain });
        if (cleanResults.length >= requestedCount + 5) break;
    }

    if (cleanResults.length === 0) {
        return {
            reply: 'Found results but all were directory or editorial sites. Try a more specific industry or location.',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'No leads after filtering.' }],
        };
    }

    onProgress?.(`⚙️ Processing ${cleanResults.length} companies...`);
    const settled = await runWithConcurrency(
        cleanResults.map(result => () => processOneCompany(result, intent, tavilyKey, apiKey, userProfile, onProgress, detectedLanguage)),
        CONCURRENCY_LIMIT
    );

    const allVerifiedLeads = settled
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value)
        .sort((a, b) => b.leadScore - a.leadScore);

    const leadsToReturn = _applyOutputQuantityRules(allVerifiedLeads, requestedCount);

    // Save to MongoDB search cache
    if (leadsToReturn.length > 0) {
        const companyIds = [];
        for (const lead of leadsToReturn) {
            let company = await Company.findOne({ domain: lead.domain });
            if (!company) {
                company = await saveCompanyFromLead({
                    company: lead.company, domain: lead.domain, industry: lead.industry,
                    country: lead.hq, companySize: lead.companySize,
                    emails: [lead.email], research: { recentNews: lead.recentNews, triggers: lead.triggers }, leadScore: lead.leadScore,
                });
            }
            if (company) companyIds.push(company._id);
        }
        await saveSearchCache(queryHash, queryParams, companyIds, 30);
    }

    recordSearchHistory(userId, safeMessage, leadsToReturn);

    const memStats = getCompanyMemoryStats();
    const _meta = {
        tavilyUsed:         tavilyQuota.used,
        tavilyRemaining:    getTavilyRemaining(),
        openAiCalls:        openAiTracker.totalCallsThisSession,
        estimatedCostUSD:   parseFloat(costTracker.estimatedUSDThisSession.toFixed(4)),
        totalVerified:      allVerifiedLeads.length,
        totalReturned:      leadsToReturn.length,
        requestedCount,
        memoryStats: {
            companiesStored:  memStats.totalCompanies,
            contactsStored:   memStats.totalContacts,
            researchRecords:  memStats.totalResearch,
            analyticsRecords: memStats.totalAnalytics,
        },
    };

    console.log(`🏁 Done. ${leadsToReturn.length} verified leads returned.`);
    console.log(`🧠 Memory: ${memStats.totalCompanies} companies | ${memStats.totalContacts} contacts`);
    console.log(`📊 GPT: ${openAiTracker.totalCallsThisSession} calls | ~$${costTracker.estimatedUSDThisSession.toFixed(4)}`);
    console.log(`🔍 Tavily: ${tavilyQuota.used}/${tavilyQuota.limit}`);

    if (leadsToReturn.length === 0) {
        return {
            reply: 'Found companies but no emails passed verification. Try a different industry or location.',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'No verified leads.' }],
            _meta,
        };
    }

    return {
        reply: JSON.stringify(leadsToReturn),
        updatedHistory: [
            ...history,
            { role: 'user',      content: safeMessage },
            { role: 'assistant', content: `[Generated ${leadsToReturn.length} verified leads]` },
        ],
        _meta,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 27 — MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🟢 [AI ENGINE] Pipeline started...');
        onProgress?.('🧠 Understanding your request...');

        const apiKey    = process.env.OPENAI_API_KEY;
        const tavilyKey = process.env.TAVILY_API_KEY;
        const userId    = userProfile?.userId || userProfile?.id || 'anonymous';

        const rawMessage  = typeof message === 'string' ? message.slice(0, MAX_MESSAGE_LENGTH) : '';
        const safeMessage = sanitizeUserMessage(rawMessage);

        if (!safeMessage.trim()) {
            return {
                reply: 'How can I help? I can find verified leads, write cold outreach, or answer B2B sales questions.',
                updatedHistory: history,
            };
        }

        const detectedLanguage = _detectLanguage(safeMessage);
        console.log(`🌐 [LANGUAGE] Detected: ${detectedLanguage.name} (${detectedLanguage.code})`);

        const intent = await _classifyIntent(safeMessage, history, apiKey);
        console.log(`🎯 [INTENT] ${intent}`);
        onProgress?.(`🧠 Mode: ${intent.replace('_', ' ')}...`);

        if (intent === INTENT.LEAD_GEN) {
            return await _runLeadGenPipeline(safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, tavilyKey, userId);
        }
        if (intent === INTENT.EMAIL_DRAFT) {
            const reply = await _handleEmailDraft(safeMessage, history, userProfile, apiKey);
            return { reply, updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: reply }] };
        }
        if (intent === INTENT.BUSINESS_QA) {
            const reply = await _handleBusinessQA(safeMessage, history, userProfile, apiKey);
            return { reply, updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: reply }] };
        }

        const reply = await _handleChat(safeMessage, history, userProfile, apiKey);
        return { reply, updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: reply }] };

    } catch (error) {
        console.error('❌ [AI ENGINE] Fatal error:', error.message);
        return { reply: 'An error occurred. Please try again.', updatedHistory: history };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 28 — PUBLIC EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
    generateFreeResponse,
    recordOutcome,
    getAnalyticsSummary,
    getCompanyMemoryStats,
    getCompanyMemory,
    setCompanyMemory,
    getContactMemory,
    setContactMemory,
    getResearchMemory,
    setResearchMemory,
    detectTriggerEvents,
    generateAndVerifyEmailPatterns,
    scoreLeadQuality,
    INTENT,
    ROLE_PRIORITY,
};
