'use strict';

const axios = require('axios');
const dns   = require('dns').promises;
const net   = require('net');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const MAX_LEADS_RETURNED = 5;
const TAVILY_LIMIT       = 1000;
const CONCURRENCY_LIMIT  = 2;
const CACHE_TTL_MS       = 60 * 60 * 1000;
const CURRENT_YEAR       = new Date().getFullYear();
const MAX_MESSAGE_LENGTH = 800;

// NEW: Strict Skyline AI Email Confidence Threshold
// ONLY ACCEPT EMAILS WITH SCORE ≥ 70
const EMAIL_CONFIDENCE_THRESHOLD = 70;

// ─── OUTPUT QUANTITY CONTROL CONSTANTS ───────────────────────────────────────
const QUANTITY_RULE_HARD_MIN     = 2;
const QUANTITY_RULE_ABSOLUTE_MIN = 1;
const QUANTITY_RULE_DEFAULT_MAX  = MAX_LEADS_RETURNED;

// ─── ROLE PRIORITY MAP ───────────────────────────────────────────────────────
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

// ─── DOMAIN REPUTATION BLOCKLIST ─────────────────────────────────────────────
const REPUTATION_BLOCKED_DOMAINS = new Set([
    // Extend with known bad actors as needed
]);

// ─── SEARCH DIVERSIFICATION ───────────────────────────────────────────────────
const MIN_POOL_SIZE = 3;

// ─── INTENT TYPES ─────────────────────────────────────────────────────────────
const INTENT = {
    LEAD_GEN:    'lead_gen',
    CHAT:        'chat',
    EMAIL_DRAFT: 'email_draft',
    BUSINESS_QA: 'business_qa',
};

// ─── REASONING FILTER ──────────────────────────────────────────────────────────
const REASONING_FILTER = `
⚠️ REASONING FILTER — NON-NEGOTIABLE:
1. You are a strict fact extractor. Use ONLY facts explicitly stated in SNIPPETS.
2. IGNORE all training data. If a fact is not in the snippets, return null.
3. NEVER invent names, emails, roles, or company details.
4. Current year is ${CURRENT_YEAR}.
`;

// ─── SKYLINE AI PERSONALIZATION ENGINE RULES ─────────────────────────────────
const PERSONALIZATION_RULES = `
You are the Skyline AI Personalization Engine.

Your ONLY responsibility is to generate HIGHLY PERSONALIZED, CONTEXT-AWARE outreach messages based on real business data.

You are NOT responsible for:
- finding leads
- verifying emails
- scoring companies
- searching the web
- generic copywriting
- templated marketing messages

Your ONLY job is:

Turn structured company + decision-maker data into a message that feels like it was written specifically for THAT business.

━━━━━━━━━━━━━━━━━━━
PRIMARY GOAL
━━━━━━━━━━━━━━━━━━━

Make every message feel:
- specific
- researched
- human-written
- relevant to the exact company
- impossible to copy-paste

━━━━━━━━━━━━━━━━━━━
CORE PRINCIPLE
━━━━━━━━━━━━━━━━━━━

Generic messages = NO VALUE

If a message could be sent to 100 companies without changes:
REJECT IT.

━━━━━━━━━━━━━━━━━━━
PERSONALIZATION REQUIREMENTS
━━━━━━━━━━━━━━━━━━━

Every message MUST include:

1. Company-specific reference
- mention their business type or product

2. Role-specific angle
- founder vs CEO vs marketing head messaging differs

3. Pain-point alignment
- connect to likely business challenge:
  - customer acquisition
  - lead generation
  - scaling sales
  - automation
  - efficiency

4. Contextual relevance
- must clearly match the user's intent

━━━━━━━━━━━━━━━━━━━
NO-GENERIC LANGUAGE RULE
━━━━━━━━━━━━━━━━━━━

Reject messages containing:
- "I hope this email finds you well"
- "I am reaching out to introduce myself"
- "We help businesses grow"
- "cutting-edge solution"
- "innovative platform"

These are BANNED.

━━━━━━━━━━━━━━━━━━━
DEEP PERSONALIZATION RULE
━━━━━━━━━━━━━━━━━━━

You must behave like:

"You actually studied this company before writing."

Even if minimal data is available, you must:
- infer intelligently (but not invent facts)
- stay grounded in realistic business logic
- avoid hallucinated specifics

━━━━━━━━━━━━━━━━━━━
TONE REQUIREMENT
━━━━━━━━━━━━━━━━━━━

Tone must be:
- direct
- confident
- simple
- human
- non-salesy

No hype. No fluff.

━━━━━━━━━━━━━━━━━━━
MESSAGE STRUCTURE (STRICT)
━━━━━━━━━━━━━━━━━━━

Each message must follow:

1. Hook (specific to company)
2. Relevance statement (why you're reaching out)
3. Value alignment (what you help with)
4. Soft call-to-action

━━━━━━━━━━━━━━━━━━━
ANTI-HALLUCINATION RULE
━━━━━━━━━━━━━━━━━━━

Do NOT invent:
- product features
- company achievements
- internal company details
- fake news about the business

Only use:
- provided data
- safe general industry logic

━━━━━━━━━━━━━━━━━━━
PERSONALIZATION DEPTH SCORE
━━━━━━━━━━━━━━━━━━━

Score every message 0–100:

90–100:
Feels uniquely written for that exact company

75–89:
Strong personalization, minor generic elements

50–74:
Weak personalization, partially generic

0–49:
Generic, reusable, unacceptable

━━━━━━━━━━━━━━━━━━━
STRICT ACCEPTANCE RULE
━━━━━━━━━━━━━━━━━━━

ONLY ACCEPT messages scoring ≥ 80.

Reject anything below.

━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━

Return JSON only:

{
  "message": "...",
  "personalization_score": 92,
  "signals_used": [
    "company_context",
    "role_based_angle",
    "pain_point_alignment"
  ],
  "risk_level": "low | medium | high"
}
`;

// ─── BANNED WORDS (PERSONALIZATION LAYER ENFORCEMENT) ────────────────────────
const BANNED_ADJECTIVES = [
    'transformative','seamless','mission-critical','synergy','game-changer',
    'revolutionary','cutting-edge','innovative','disruptive','next-level',
    'holistic','robust','scalable','leverage','streamline','optimize',
    'empower','unlock','elevate','enhance','boost','accelerate','amplify',
    'delve','awe-inspiring','exciting','landscape','unleash','dynamic',
    'groundbreaking','paradigm','ecosystem','value-add','best-in-class',
];

const BANNED_PHRASES = [
    'I hope this finds you well','I wanted to reach out','touch base',
    'circle back','quick question','just following up','as per my last email',
    'I am reaching out because','My name is','I hope you are doing well',
    'let me know your thoughts','feel free to','do not hesitate',
    'please find attached','as mentioned','at your earliest convenience',
    'in today\'s world','in the current landscape','going forward',
];

// ─── QUOTA TRACKERS ────────────────────────────────────────────────────────────
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

// ─── PERSISTENT DOMAIN DEDUP ──────────────────────────────────────────────────
const globalSeenDomains = new Set();

// ─── PERSISTENT COMPANY NAME DEDUP ───────────────────────────────────────────
const globalSeenCompanyNames = new Set();

// ─── IN-MEMORY RESEARCH CACHE ─────────────────────────────────────────────────
const researchCache = new Map();
function getCachedResearch(domain) {
    const hit = researchCache.get(domain);
    if (!hit) return null;
    if (Date.now() - hit.timestamp > CACHE_TTL_MS) { researchCache.delete(domain); return null; }
    console.log(`💾 [CACHE HIT] ${domain}`);
    return hit.data;
}
function setCachedResearch(domain, data) {
    researchCache.set(domain, { data, timestamp: Date.now() });
}

// ─── RETRY HELPER ─────────────────────────────────────────────────────────────
async function withRetry(fn, label, retries = 2, delayMs = 800) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isLast = attempt === retries;
            console.warn(`⚠️ [${label}] attempt ${attempt + 1} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying'}`);
            if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
    }
    return null;
}

// ─── SKYLINE AI SOURCE SELECTION ENGINE ──────────────────────────────────────
async function _evaluateSourceQuality(url, title, snippet) {
    const urlLower     = url.toLowerCase();
    const titleLower   = (title || '').toLowerCase();
    const snippetLower = (snippet || '').toLowerCase();
    const domain       = (() => { try { return new URL(url).hostname.replace('www.', ''); } catch { return ''; } })();

    const REJECT_URL_PATTERNS = [
        '/blog', '/blogs', '/article', '/articles', '/guide', '/guides',
        '/resources', '/directory', '/directories', '/email-list', '/leads',
        '/tag', '/category', '/forum', '/community', '/thread', '/threads',
        '/list', '/top-', '/best-', '/compare', '/review'
    ];

    for (const pattern of REJECT_URL_PATTERNS) {
        if (urlLower.includes(pattern)) {
            return {
                accepted: false,
                score: 0,
                reason: `Rejected URL pattern: ${pattern}`,
                signals: ['url_pattern_reject']
            };
        }
    }

    const REJECT_DOMAINS = [
        'bookyourdata.com', 'apollo.io', 'hunter.io', 'rocketreach.co',
        'signalhire.com', 'contactout.com', 'zoominfo.com', 'lusha.io',
        'crunchbase.com', 'linkedin.com', 'yelp.com', 'yellowpages.com',
        'manta.com', 'bbb.org', 'trustpilot.com', 'g2.com', 'capterra.com',
        'softwareadvice.com', 'getapp.com', 'clutch.co', 'goodfirms.co',
        'designrush.com', 'expertise.com', 'upwork.com', 'fiverr.com',
        'freelancer.com', 'peopleperhour.com', 'reddit.com', 'quora.com',
        'medium.com', 'wikipedia.org', 'facebook.com', 'twitter.com',
        'instagram.com', 'tiktok.com', 'youtube.com'
    ];

    for (const badDomain of REJECT_DOMAINS) {
        if (domain.includes(badDomain)) {
            return {
                accepted: false,
                score: 0,
                reason: `Rejected domain type: ${badDomain} (aggregator/marketplace/social)`,
                signals: ['domain_reject']
            };
        }
    }

    const SEO_SIGNALS = [
        'top 10', 'best companies', 'list of', 'directory of', 'find emails',
        'database of', 'scraped', 'lead list', 'buy leads', 'email list',
        'how to find', 'guide to', 'tips for', 'what is', 'vs', 'review'
    ];
    
    let seoScore = 0;
    for (const signal of SEO_SIGNALS) {
        if (titleLower.includes(signal) || snippetLower.includes(signal)) {
            seoScore++;
        }
    }

    if (seoScore >= 2) {
        return {
            accepted: false,
            score: 20,
            reason: 'High probability of SEO spam or listicle content',
            signals: ['seo_spam', 'listicle']
        };
    }

    let score = 50;
    const signals = [];

    const STRONG_URL_PATHS = ['/about', '/team', '/company', '/leadership', '/contact', '/contact-us', '/founder', '/executives', '/our-story', '/people'];
    for (const path of STRONG_URL_PATHS) {
        if (urlLower.endsWith(path) || urlLower.includes(path + '/')) {
            score += 30;
            signals.push('strong_url_path');
            break;
        }
    }

    const BUSINESS_IDENTITY_SIGNALS = [
        'about us', 'our team', 'meet the team', 'leadership', 'executive team',
        'contact us', 'get in touch', 'our story', 'mission', 'values',
        'inc', 'ltd', 'llc', 'corp', 'limited', 'agency', 'studio', 'solutions'
    ];

    let identityMatches = 0;
    for (const signal of BUSINESS_IDENTITY_SIGNALS) {
        if (titleLower.includes(signal) || snippetLower.includes(signal)) {
            identityMatches++;
        }
    }

    if (identityMatches > 0) {
        score += (identityMatches * 10);
        signals.push('business_identity');
    }

    if (!snippet || snippet.length < 20) {
        score -= 30;
        signals.push('low_content');
    }

    score = Math.min(100, Math.max(0, score));

    const accepted = score >= 70;
    
    let reason = '';
    if (accepted) {
        reason = `Official business source (Score: ${score}). Strong identity signals found.`;
    } else {
        reason = `Weak source (Score: ${score}). Insufficient business authority or potential aggregator.`;
    }

    return {
        accepted,
        score,
        reason,
        signals
    };
}

// ─── SKYLINE AI EMAIL CONFIDENCE & VERIFICATION ENGINE ───────────────────────
function _evaluateEmailConfidence(email, domain, smtpResult, mxValid, sourceContext = '') {
    if (!email || !domain) {
        return { accepted: false, score: 0, type: 'invalid', reason: 'Missing email or domain', signals: [] };
    }

    const localPart   = email.split('@')[0].toLowerCase();
    const emailDomain = email.split('@')[1]?.toLowerCase();
    const domainRoot  = domain.split('.')[0].toLowerCase();
    
    const domainMatches = emailDomain === domain || emailDomain.includes(domainRoot);
    if (!domainMatches) {
        return {
            accepted: false,
            score: 0,
            type: 'domain_mismatch',
            reason: `Email domain ${emailDomain} does not match company domain ${domain}`,
            signals: ['domain_mismatch']
        };
    }

    const GENERIC_PREFIXES = [
        'info', 'support', 'contact', 'help', 'admin', 'hello', 'office',
        'noreply', 'no-reply', 'mail', 'general', 'sales', 'marketing',
        'team', 'enquiries', 'enquiry', 'press', 'media'
    ];
    const isGeneric = GENERIC_PREFIXES.some(p => localPart === p || localPart.startsWith(p + '.'));

    let score = 50;
    const signals = ['domain_match'];
    let type = 'unknown';

    if (smtpResult === 'invalid') {
        return { accepted: false, score: 0, type: 'smtp_invalid', reason: 'SMTP probe rejected mailbox', signals: ['smtp_invalid'] };
    }
    if (smtpResult === 'valid') {
        score += 30;
        signals.push('smtp_valid');
    } else if (smtpResult === 'unknown' || smtpResult === 'timeout') {
        signals.push('smtp_neutral');
    }
    
    if (mxValid) {
        score += 10;
        signals.push('mx_valid');
    }

    if (isGeneric) {
        type = 'generic';
        score -= 15;
        signals.push('generic_alias');
        if (smtpResult === 'valid') score = 65; 
        else score = Math.min(score, 60);
    } else if (localPart.includes('.') || /^[a-z]+\.[a-z]+$/.test(localPart)) {
        type = 'decision_maker';
        score += 25;
        signals.push('personal_pattern');
    } else if (/^[a-z]+$/.test(localPart) && localPart.length > 3) {
        type = 'decision_maker';
        score += 20;
        signals.push('firstname_pattern');
    } else {
        type = 'unclear';
        score -= 10;
        signals.push('unclear_pattern');
    }

    if (sourceContext.includes('founder') || sourceContext.includes('leadership') || sourceContext.includes('team')) {
        score += 15;
        signals.push('official_page_source');
    }

    if (smtpResult === 'valid' && isGeneric) {
        signals.push('possible_catchall');
        if (type === 'generic') score = Math.min(score, 65);
    }

    score = Math.min(100, Math.max(0, score));
    const accepted = score >= EMAIL_CONFIDENCE_THRESHOLD;
    
    let reason = '';
    if (accepted) {
        reason = `High confidence ${type} email (Score: ${score}).`;
    } else {
        reason = `Low confidence ${type} email (Score: ${score}). Below threshold ${EMAIL_CONFIDENCE_THRESHOLD}.`;
    }

    return {
        accepted,
        email,
        score,
        type,
        reason,
        signals
    };
}

// ─── SKYLINE AI INTENT UNDERSTANDING & TARGET RESOLUTION ENGINE ──────────────
async function _resolveTargetIntent(message, apiKey) {
    const intentPrompt = `You are the Skyline AI Intent Understanding & Target Resolution Engine.
Your ONLY responsibility is understanding EXACTLY what kind of businesses, people, and decision-makers the user wants.

User Message: "${message}"

Extract these dimensions whenever possible:
1. Company Type (e.g., SaaS, marketing agency, ecommerce brand, AI startup)
2. Business Stage (e.g., startup, early-stage, Series A, enterprise, SMB)
3. Decision-Maker Type (e.g., founder, CEO, owner, head of growth, marketing director)
4. Geography (e.g., United States, UK, Europe, remote-first)
5. Business Intent Signals (e.g., hiring, scaling, fundraising)

STRICT RULES:
- Never confuse content about companies WITH actual companies.
- Actively exclude: directories, educational content, media sites, blogs, marketplaces, forums, unrelated service providers, aggregators.
- If relevance is weak or intent is too broad, set target_detected to false.
- Assign a confidence score 0-100. ONLY ACCEPT TARGETS WITH SCORE ≥ 75.

Return ONLY valid JSON:
{
  "target_detected": true/false,
  "company_type": "string or null",
  "business_stage": "string or null",
  "geography": "string or null",
  "decision_maker": "string or null",
  "excluded_targets": ["directories", "blogs", "support vendors", "aggregators"],
  "search_strategy": ["official SaaS startup websites", "founder pages", "team pages"],
  "confidence": number
}`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: intentPrompt }],
            max_tokens:  300,
            temperature: 0.1,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:intent_resolution');

        if (!res) {
            console.warn('[Intent Resolution] Failed to get response from OpenAI');
            return { target_detected: false, confidence: 0, reason: 'API Error' };
        }

        recordOpenAiUsage(
            res.data?.usage?.prompt_tokens     || 0,
            res.data?.usage?.completion_tokens || 0,
            'gpt-4o-mini'
        );

        const raw    = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        const parsed = JSON.parse(raw);

        if (!parsed.target_detected || parsed.confidence < 75) {
            console.warn(`[Intent Resolution] Low confidence (${parsed.confidence}) or target not detected. Reason: ${parsed.reason || 'Insufficient definition'}`);
            return { ...parsed, target_detected: false };
        }

        console.log(`🎯 [INTENT RESOLVED] Type: ${parsed.company_type}, DM: ${parsed.decision_maker}, Geo: ${parsed.geography}, Confidence: ${parsed.confidence}`);
        return parsed;

    } catch (err) {
        console.warn('[Intent Resolution Failed]:', err.message);
        return { target_detected: false, confidence: 0, reason: 'Parsing Error' };
    }
}

function _leadMatchesIntent(lead, intent) {
    if (!intent || !lead) return true;

    const industryLower = (intent.company_type || '').toLowerCase();
    const targetLower   = (intent.target   || '').toLowerCase();

    const GENERIC_TERMS = ['general', 'any', 'all', 'business', 'company', 'businesses'];
    const isVagueIntent = GENERIC_TERMS.some(t =>
        industryLower.includes(t) || targetLower.includes(t)
    );
    if (isVagueIntent) return true;

    const leadIndustry = (lead.industry || '').toLowerCase();
    const leadCompany  = (lead.company  || '').toLowerCase();
    const leadDomain   = (lead.domain   || '').toLowerCase();

    if (leadIndustry && leadIndustry !== 'unknown') {
        const intentKeywords = industryLower.split(/\s+/).filter(w => w.length > 3);
        const anyMatch = intentKeywords.some(kw =>
            leadIndustry.includes(kw) || leadCompany.includes(kw) || leadDomain.includes(kw)
        );
        if (!anyMatch && intentKeywords.length > 1) {
            console.log(`⚠️ [INTENT FILTER] Weak industry match for "${lead.company}" — industry: "${leadIndustry}" vs intent: "${industryLower}"`);
        }
    }

    const preferredContact = (intent.decision_maker || 'any').toLowerCase();
    if (preferredContact && preferredContact !== 'any') {
        const leadRole = (lead.role || '').toLowerCase();
        if (leadRole && !leadRole.includes(preferredContact.split(' ')[0])) {
            console.log(`⚠️ [INTENT FILTER] Role mismatch: "${leadRole}" vs requested "${preferredContact}" for ${lead.company}`);
        }
    }

    return true;
}

// ─── TAVILY SEARCH ─────────────────────────────────────────────────────────────
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

function _buildFallbackQuery(intent) {
    const locationClause = intent.geography ? `"${intent.geography}"` : '';
    return [
        intent.company_type,
        intent.target,
        locationClause,
        'company website official',
        'inurl:about OR inurl:team',
    ].filter(Boolean).join(' ');
}

function _buildEntityFirstQueries(intent, poolSize) {
    const loc   = intent.geography ? `"${intent.geography}"` : '';
    const ind   = intent.company_type || '';
    const dm    = intent.decision_maker || '';
    const stage = intent.business_stage || '';

    const primary = [
        `"${ind}"`, stage, loc,
        dm ? `"${dm}"` : 'CEO founder',
        'contact email',
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
        dm ? `"${dm}"` : 'CEO OR founder OR owner OR director',
        '"email" OR "contact"',
        '-site:linkedin.com -site:crunchbase.com',
    ].filter(Boolean).join(' ');

    return { primary, entityFocus, dmFocus };
}

function extractEmailsFromText(text, companyDomain) {
    if (!text || !companyDomain) return { companyEmails: [], allEmails: [] };
    const emailRegex    = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const allFound      = [...new Set(text.match(emailRegex) || [])];
    const domainRoot    = companyDomain.split('.')[0].toLowerCase();
    const companyEmails = allFound.filter(e => {
        const ed = e.split('@')[1]?.toLowerCase() || '';
        return ed === companyDomain || ed.includes(domainRoot);
    });
    if (companyEmails.length > 0) {
        console.log(`📧 [REGEX] Found ${companyEmails.length} real email(s) for ${companyDomain}:`, companyEmails);
    }
    return { companyEmails, allEmails: allFound };
}

async function huntRealEmails(companyName, domain, tavilyKey) {
    if (getTavilyRemaining() <= 0) return { companyEmails: [], allEmails: [] };
    console.log(`🎯 [EMAIL HUNT] ${companyName} @ ${domain}`);

    const contactResults = await searchWithTavily(
        `"${companyName}" "@${domain}" OR "contact" OR "email us" site:${domain}`,
        tavilyKey, { maxResults: 3 }
    );
    const directoryResults = getTavilyRemaining() > 0
        ? await searchWithTavily(
            `"${companyName}" email "@${domain}" contact site:hunter.io OR site:rocketreach.co OR site:signalhire.com OR site:contactout.com`,
            tavilyKey, { maxResults: 3 }
          )
        : [];

    const allText   = [...contactResults, ...directoryResults]
        .map(r => `${r.title} ${r.snippet} ${r.url}`).join(' ');
    const extracted = extractEmailsFromText(allText, domain);

    if (extracted.companyEmails.length > 0) {
        console.log(`✅ [EMAIL HUNT] Real emails found:`, extracted.companyEmails);
    } else {
        console.log(`⚠️ [EMAIL HUNT] No real emails found for ${domain}`);
    }
    return extracted;
}

function classifyEmail(email, domain) {
    if (!email) return { type: 'none', label: 'Not found', trustLevel: 0 };
    const localPart   = email.split('@')[0].toLowerCase();
    const emailDomain = email.split('@')[1]?.toLowerCase();
    const domainMatches = emailDomain === domain || emailDomain?.includes(domain.split('.')[0]);

    const GENERIC_PREFIXES = [
        'contact','info','hello','sales','team','support',
        'enquiries','enquiry','admin','office','mail','general',
        'press','media',
    ];
    const isGeneric = GENERIC_PREFIXES.some(p =>
        localPart === p || localPart.startsWith(p + '.')
    );
    if (!domainMatches) return { type: 'unrelated-domain', label: 'Wrong domain',           trustLevel: 0  };
    if (isGeneric)      return { type: 'confirmed-generic', label: '✓ Contact email (real)', trustLevel: 65 };
    if (localPart.includes('.') || /[a-z]{2,}[a-z]{2,}/.test(localPart)) {
        return          { type: 'confirmed-personal', label: '✓ Personal email (real)',      trustLevel: 90 };
    }
    return              { type: 'confirmed-other',   label: '✓ Email (real)',                trustLevel: 75 };
}

function _DEAD_guessEmailPatterns_DO_NOT_USE(fullName, domain) {
    if (!fullName || !domain) return [];
    const parts = fullName.toLowerCase().trim().split(/\s+/);
    if (parts.length < 2) return [`${parts[0]}@${domain}`];
    const [first, last] = [parts[0], parts[parts.length - 1]];
    return [
        `${first}.${last}@${domain}`,
        `${first}@${domain}`,
        `${first[0]}${last}@${domain}`,
        `${first}${last[0]}@${domain}`,
        `${first}_${last}@${domain}`,
        `${last}.${first}@${domain}`,
        `${first[0]}.${last}@${domain}`,
    ];
}

const DISPOSABLE_DOMAINS = new Set([
    'mailinator.com','guerrillamail.com','tempmail.com','throwam.com',
    'yopmail.com','trashmail.com','fakeinbox.com','sharklasers.com',
    'guerrillamailblock.com','grr.la','guerrillamail.info','spam4.me',
    'dispostable.com','maildrop.cc','discard.email','spamgourmet.com',
    'spamgourmet.net','spamgourmet.org','wegwerfmail.de','wegwerfmail.net',
    'wegwerfmail.org','10minutemail.com','10minutemail.net','10minutemail.org',
    'tempr.email','mailnull.com','spamfree24.org','spamfree24.de',
    'spamfree24.eu','spamfree24.info','spamfree24.net','spamfree.eu',
    'spamoff.de',
]);

function isDisposableDomain(domain) {
    return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}

async function smtpProbeEmail(email, domain) {
    try {
        const mxRecords = await dns.resolveMx(domain);
        if (!mxRecords || mxRecords.length === 0) return 'unknown';

        const sorted = mxRecords.sort((a, b) => a.priority - b.priority);
        const mxHost = sorted[0].exchange;

        return await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                try { socket.destroy(); } catch {}
                console.warn(`⏱️ [SMTP PROBE] Timeout for ${email}`);
                resolve('unknown');
            }, 8000);

            const socket = net.createConnection(25, mxHost);
            let   buffer = '';
            let   stage  = 0;

            socket.on('error', (err) => {
                clearTimeout(timeout);
                console.warn(`⚠️ [SMTP PROBE] Connection error for ${email}: ${err.message}`);
                resolve('unknown');
            });

            socket.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\r\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line) continue;
                    const code = parseInt(line.slice(0, 3), 10);

                    if (stage === 0 && code === 220) {
                        socket.write(`EHLO mailcheck.local\r\n`);
                        stage = 1;
                    } else if (stage === 1 && (code === 250 || code === 220)) {
                        socket.write(`MAIL FROM:<probe@mailcheck.local>\r\n`);
                        stage = 2;
                    } else if (stage === 2 && code === 250) {
                        socket.write(`RCPT TO:<${email}>\r\n`);
                        stage = 3;
                    } else if (stage === 3) {
                        clearTimeout(timeout);
                        socket.write('QUIT\r\n');
                        socket.destroy();
                        if (code === 250 || code === 251) {
                            console.log(`✅ [SMTP PROBE] ${email} → VALID (${code})`);
                            resolve('valid');
                        } else if (code === 550 || code === 551 || code === 553 || code === 554) {
                            console.warn(`❌ [SMTP PROBE] ${email} → INVALID (${code})`);
                            resolve('invalid');
                        } else {
                            console.warn(`❓ [SMTP PROBE] ${email} → UNKNOWN (${code})`);
                            resolve('unknown');
                        }
                    } else if (code >= 500) {
                        clearTimeout(timeout);
                        socket.destroy();
                        resolve('unknown');
                    }
                }
            });

            socket.on('close', () => {
                clearTimeout(timeout);
                if (stage < 3) resolve('unknown');
            });
        });

    } catch (err) {
        console.warn(`⚠️ [SMTP PROBE] Failed for ${email}: ${err.message}`);
        return 'unknown';
    }
}

async function validateEmailFull(email, domain) {
    const normalisedEmail = (typeof email === 'string') ? email.toLowerCase().trim() : email;

    const result = {
        email:           normalisedEmail,
        verdict:         'rejected',
        confidenceScore: 0,
        smtpResult:      null,
        mxValid:         false,
        disposable:      false,
        syntaxValid:     false,
        domainMatch:     false,
        reason:          '',
    };

    if (!isValidEmailFormat(normalisedEmail)) {
        result.reason = 'Invalid syntax';
        return result;
    }
    result.syntaxValid = true;

    const emailDomain = normalisedEmail.split('@')[1]?.toLowerCase();
    if (!emailDomain) { result.reason = 'No domain in email'; return result; }

    if (isDisposableDomain(emailDomain)) {
        result.disposable = true;
        result.reason     = 'Disposable domain';
        return result;
    }

    if (isFreeEmailDomain(emailDomain)) {
        result.reason = 'Free email provider';
        return result;
    }

    if (REPUTATION_BLOCKED_DOMAINS.has(emailDomain)) {
        result.reason = 'Domain on reputation blocklist';
        return result;
    }

    const domainRoot   = domain.split('.')[0].toLowerCase();
    result.domainMatch = emailDomain === domain || emailDomain.includes(domainRoot);
    if (!result.domainMatch) {
        result.reason = `Domain mismatch: ${emailDomain} vs ${domain}`;
        return result;
    }

    result.mxValid = await validateMX(emailDomain);
    if (!result.mxValid) {
        result.reason = 'No MX records — domain cannot receive email';
        return result;
    }

    let smtpResult = 'unknown';
    try {
        smtpResult = await smtpProbeEmail(normalisedEmail, emailDomain);
    } catch (e) {
        console.warn(`[SMTP PROBE CATCH] ${e.message}`);
    }
    result.smtpResult = smtpResult;

    const evaluation = _evaluateEmailConfidence(normalisedEmail, domain, smtpResult, result.mxValid);
    
    result.confidenceScore = evaluation.score;
    result.verdict         = evaluation.accepted ? 'verified' : 'rejected';
    result.reason          = evaluation.reason;
    
    console.log(`📧 [CONFIDENCE] ${normalisedEmail} → Score: ${evaluation.score} (${evaluation.type}) - ${evaluation.accepted ? 'ACCEPTED' : 'REJECTED'}`);

    return result;
}

async function rankAndFilterEmails(emails, domain) {
    if (!emails || emails.length === 0) return [];

    const unique = [...new Set(emails.map(e => (typeof e === 'string' ? e.toLowerCase().trim() : e)))];

    console.log(`🔬 [VALIDATOR] Running full pipeline on ${unique.length} email(s) for ${domain}`);

    const validated = await Promise.all(
        unique.map(email => validateEmailFull(email, domain))
    );

    const passing = validated
        .filter(r => r.confidenceScore >= EMAIL_CONFIDENCE_THRESHOLD)
        .sort((a, b) => b.confidenceScore - a.confidenceScore);

    console.log(`📊 [VALIDATOR] ${passing.length}/${unique.length} passed threshold (≥${EMAIL_CONFIDENCE_THRESHOLD})`);
    passing.forEach(r => console.log(`   → ${r.email} | score:${r.confidenceScore} | ${r.verdict} | ${r.reason}`));

    return passing;
}

async function validateMX(domain) {
    try {
        const records = await dns.resolveMx(domain);
        return records && records.length > 0;
    } catch { return false; }
}

function isValidEmailFormat(email) {
    if (!email || typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

const FREE_EMAIL_PROVIDERS = new Set([
    'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com',
    'protonmail.com','aol.com','mail.com','yandex.com','zoho.com',
    'mailinator.com','guerrillamail.com','tempmail.com','throwam.com',
]);
function isFreeEmailDomain(domain) { return FREE_EMAIL_PROVIDERS.has(domain.toLowerCase()); }

function detectHallucinations(companyName, extracted) {
    const flags = [];
    if (Array.isArray(extracted.employees)) {
        extracted.employees.forEach((emp, i) => {
            if (emp.name && companyName &&
                emp.name.toLowerCase().includes(companyName.toLowerCase().split(' ')[0])) {
                flags.push(`Employee[${i}] name contains company name: "${emp.name}"`);
            }
            if (emp.email && extracted._domain) {
                const emailDomain = emp.email.split('@')[1];
                if (emailDomain &&
                    emailDomain !== extracted._domain &&
                    !emailDomain.includes(extracted._domain.split('.')[0])) {
                    flags.push(`Employee[${i}] email domain "${emailDomain}" ≠ company domain "${extracted._domain}"`);
                }
            }
        });
    }
    if (extracted.mission) {
        const genericPhrases = [
            'helping businesses','empowering companies','world-class',
            'innovative solutions','cutting-edge',
        ];
        if (genericPhrases.some(p => extracted.mission.toLowerCase().includes(p))) {
            flags.push(`Mission may be generic/hallucinated: "${extracted.mission}"`);
        }
    }
    if (extracted.recentNews) {
        const yearMatch = extracted.recentNews.match(/\b(20\d{2})\b/);
        if (yearMatch && parseInt(yearMatch[1]) < CURRENT_YEAR - 2) {
            flags.push(`recentNews stale (${yearMatch[1]}): "${extracted.recentNews}"`);
        }
    }
    return flags;
}

function scoreDataCompleteness(extracted) {
    if (!extracted) return 0;
    let score = 0;
    if (extracted.mission    && extracted.mission    !== 'unknown') score += 15;
    if (extracted.hq         && extracted.hq         !== 'unknown') score += 10;
    if (extracted.size       && extracted.size        !== 'unknown') score += 10;
    if (extracted.model      && extracted.model       !== 'unknown') score += 10;
    if (extracted.recentNews)                                        score += 15;
    if (extracted.contactEmails?.length > 0)                         score += 15;
    if (extracted.employees?.length > 0)                             score += 15;
    if (extracted.employees?.some(e => e.email))                     score += 10;
    return Math.min(score, 100);
}

function scoreLeadQuality({ emailConfidence, mxValid, hasRealName, hasLinkedIn, hasNews, hasMission, dataScore, hallucinationCount, pageScore }) {
    let score = 0;

    if      (emailConfidence === 'confirmed-personal') score += 40;
    else if (emailConfidence === 'confirmed-generic')  score += 30;
    else if (emailConfidence === 'confirmed-other')    score += 28;
    else if (emailConfidence === 'guessed-pattern')    score += 12;
    else                                               score +=  3;

    if (mxValid)        score += 20;
    if (hasRealName)    score += 15;
    if (hasLinkedIn)    score += 10;
    if (hasNews)        score += 10;
    if (hasMission)     score +=  5;
    if (dataScore > 60) score +=  5;

    if (pageScore && pageScore >= 70) score += 10;
    else if (pageScore && pageScore >= 50) score += 5;

    score -= (hallucinationCount || 0) * 8;

    return Math.max(0, Math.min(score, 100));
}

function _pickBestContact(employees, preferredContact) {
    if (!employees || employees.length === 0) return null;

    const preferred = (preferredContact || '').toLowerCase().trim();

    if (preferred && preferred !== 'any') {
        const match = employees.find(e =>
            e.role && e.role.toLowerCase().includes(preferred)
        );
        if (match) return match;
    }

    const ranked = [...employees].sort((a, b) => {
        const aRole = (a.role || '').toLowerCase();
        const bRole = (b.role || '').toLowerCase();

        const aScore = Object.entries(ROLE_PRIORITY).find(([key]) => aRole.includes(key))?.[1] ?? 99;
        const bScore = Object.entries(ROLE_PRIORITY).find(([key]) => bRole.includes(key))?.[1] ?? 99;

        return aScore - bScore;
    });

    return ranked[0];
}

async function runWithConcurrency(tasks, limit) {
    const results   = [];
    const executing = new Set();
    for (const task of tasks) {
        const promise = task()
            .then(result => { executing.delete(promise); return result; })
            .catch(err   => {
                executing.delete(promise);
                console.warn(`⚠️ [CONCURRENCY] Task failed: ${err?.message || err}`);
                return null;
            });
        results.push(promise);
        executing.add(promise);
        if (executing.size >= limit) await Promise.race(executing);
    }
    return Promise.allSettled(results);
}

function cleanCompanyName(rawTitle) {
    let name = rawTitle.split(/[|\-–]/)[0].trim();
    name = name.replace(
        /\b(Ltd|LLC|Inc|Limited|PLC)\s*$/gi, ''
    ).trim();
    if (name.length > 50) name = name.substring(0, 50).trim();
    const REJECT = ['home','about','contact','services','welcome','index'];
    if (!name || REJECT.includes(name.toLowerCase())) return null;
    return name;
}

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
        { code: 'es', name: 'Spanish',    rtl: false, pattern: /\b(gracias|hola|por favor|cómo|también|sí|buenas|estimado|empresa|necesito|quiero|podría|tenemos|nuestro|sistema|equipo|proceso)\b/ },
        { code: 'fr', name: 'French',     rtl: false, pattern: /\b(merci|bonjour|comment|nous|vous|les|des|une|pour|avec|très|aussi|notre|votre|pouvez|entreprise|besoin|système|équipe)\b/ },
        { code: 'de', name: 'German',     rtl: false, pattern: /\b(danke|hallo|bitte|wie|haben|sind|kann|wir|das|die|der|und|nicht|ich|sie|mit|für|eine|unser|team|system|prozess|brauchen)\b/ },
        { code: 'pt', name: 'Portuguese', rtl: false, pattern: /\b(obrigado|olá|temos|nosso|empresa|preciso|quero|poderia|sistema|equipe|processo|também|muito|para|com|por)\b/ },
        { code: 'it', name: 'Italian',    rtl: false, pattern: /\b(grazie|ciao|come|abbiamo|nostro|azienda|bisogno|voglio|potrebbe|sistema|squadra|processo|anche|molto|per|con)\b/ },
        { code: 'nl', name: 'Dutch',      rtl: false, pattern: /\b(bedankt|hallo|hoe|wij|onze|bedrijf|nodig|wil|zou|systeem|team|proces|ook|heel|voor|met)\b/ },
        { code: 'pl', name: 'Polish',     rtl: false, pattern: /\b(dziękuję|cześć|jak|mamy|nasz|firma|potrzebuję|chcę|mógłby|system|zespół|proces|też|bardzo|dla|z)\b/ },
        { code: 'tr', name: 'Turkish',    rtl: false, pattern: /\b(teşekkür|merhaba|nasıl|bizim|şirket|ihtiyaç|istiyorum|olur|sistem|ekip|süreç|ayrıca|çok|için|ile)\b/ },
        { code: 'sv', name: 'Swedish',    rtl: false, pattern: /\b(tack|hej|hur|vi|vårt|företag|behöver|vill|skulle|system|team|process|också|mycket|för|med)\b/ },
        { code: 'no', name: 'Norwegian',  rtl: false, pattern: /\b(takk|hei|hvordan|vi|vår|selskap|trenger|vil|ville|system|team|prosess|også|veldig|for|med)\b/ },
        { code: 'da', name: 'Danish',     rtl: false, pattern: /\b(tak|hej|hvordan|vi|vores|virksomhed|behøver|vil|ville|system|team|proces|også|meget|for|med)\b/ },
        { code: 'fi', name: 'Finnish',    rtl: false, pattern: /\b(kiitos|hei|miten|meillä|meidän|yritys|tarvitsen|haluan|voisi|järjestelmä|tiimi|prosessi|myös|paljon|varten)\b/ },
        { code: 'id', name: 'Indonesian', rtl: false, pattern: /\b(terima kasih|halo|bagaimana|kami|perusahaan|butuh|ingin|bisa|sistem|tim|proses|juga|sangat|untuk|dengan)\b/ },
        { code: 'ms', name: 'Malay',      rtl: false, pattern: /\b(terima kasih|hai|bagaimana|kami|syarikat|perlu|mahu|boleh|sistem|pasukan|proses|juga|sangat|untuk|dengan)\b/ },
        { code: 'vi', name: 'Vietnamese', rtl: false, pattern: /\b(cảm ơn|xin chào|chúng tôi|công ty|cần|muốn|có thể|hệ thống|đội|quy trình|cũng|rất|cho|với)\b/ },
    ];
    for (const lang of langPatterns) {
        if (lang.pattern.test(lower)) return { code: lang.code, name: lang.name, rtl: lang.rtl };
    }

    return { code: 'en', name: 'English', rtl: false };
}

function _buildMultilingualEmailBlock(detectedLanguage) {
    const rtlNote = detectedLanguage.rtl
        ? `NOTE: ${detectedLanguage.name} is a right-to-left language. Format text accordingly.`
        : '';
    return `
MULTILINGUAL ENGINE — CRITICAL:
The user's request was written in: ${detectedLanguage.name} (${detectedLanguage.code}).
${rtlNote}

ALL THREE EMAILS (initial, followup, breakup) MUST be written entirely in ${detectedLanguage.name}.
RULES — NEVER VIOLATE:
1. Write every word of every email in ${detectedLanguage.name}. No exceptions.
2. Translate the subject line, salutation, body, CTA, and sign-off into ${detectedLanguage.name}.
3. Do NOT mix languages. The emails must be 100% in ${detectedLanguage.name}.
4. Maintain all tone, rhythm, banned-word, and sales-logic rules in ${detectedLanguage.name}.
5. If ${detectedLanguage.name} is English, this rule has no additional effect — write normally.
`;
}

function _parseRequestedCount(message) {
    if (!message || typeof message !== 'string') return null;

    const lower = message.toLowerCase();

    const wordToNum = {
        'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
        'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
        'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14,
        'fifteen': 15, 'sixteen': 16, 'seventeen': 17, 'eighteen': 18,
        'nineteen': 19, 'twenty': 20,
    };

    const digitPattern = /\b(\d{1,3})\s*(?:leads?|emails?|contacts?|companies|companies'|results?|prospects?)\b/i;
    const digitMatch   = message.match(digitPattern);
    if (digitMatch) {
        const n = parseInt(digitMatch[1], 10);
        if (n >= 1 && n <= 100) {
            console.log(`🔢 [QUANTITY PARSER] Digit match: ${n} from "${digitMatch[0]}"`);
            return n;
        }
    }

    const givePattern = /\b(?:give|find|get|show|fetch|pull|return|bring)\s+(?:me\s+)?(\d{1,3})\b/i;
    const giveMatch   = message.match(givePattern);
    if (giveMatch) {
        const n = parseInt(giveMatch[1], 10);
        if (n >= 1 && n <= 100) {
            console.log(`🔢 [QUANTITY PARSER] Give-pattern match: ${n}`);
            return n;
        }
    }

    for (const [word, num] of Object.entries(wordToNum)) {
        const wordPattern = new RegExp(
            `\\b${word}\\s*(?:leads?|emails?|contacts?|companies|results?|prospects?)?\\b`, 'i'
        );
        if (wordPattern.test(lower)) {
            console.log(`🔢 [QUANTITY PARSER] Word match: "${word}" → ${num}`);
            return num;
        }
    }

    const topPattern = /\btop\s+(\d{1,3})\b/i;
    const topMatch   = message.match(topPattern);
    if (topMatch) {
        const n = parseInt(topMatch[1], 10);
        if (n >= 1 && n <= 100) {
            console.log(`🔢 [QUANTITY PARSER] Top-N match: ${n}`);
            return n;
        }
    }

    console.log(`🔢 [QUANTITY PARSER] No count specified — will use default (${QUANTITY_RULE_DEFAULT_MAX})`);
    return null;
}

function _applyOutputQuantityRules(leads, requestedMax) {
    if (!Array.isArray(leads)) return [];
    const totalVerified = leads.length;
    const cap           = Math.min(requestedMax, QUANTITY_RULE_DEFAULT_MAX);

    console.log(`📐 [QUANTITY RULES] Verified: ${totalVerified} | Requested max: ${requestedMax} | System cap: ${QUANTITY_RULE_DEFAULT_MAX} | Effective cap: ${cap}`);

    if (totalVerified === 0) {
        console.log(`📐 [QUANTITY RULES] 0 verified leads — returning empty array`);
        return [];
    }

    if (totalVerified === 1) {
        console.log(`📐 [QUANTITY RULES] Only 1 verified lead exists — returning 1 (absolute minimum)`);
        return [leads[0]];
    }

    const effectiveMin = QUANTITY_RULE_HARD_MIN;
    const sliceTo      = Math.max(effectiveMin, Math.min(cap, totalVerified));

    const final = leads.slice(0, sliceTo);
    console.log(`📐 [QUANTITY RULES] Returning ${final.length} lead(s) [min:${effectiveMin}, cap:${cap}, available:${totalVerified}]`);

    return final;
}

async function _classifyIntent(message, history, apiKey) {
    const recentHistory = (history || []).slice(-6)
        .map(h => `${h.role}: ${h.content}`)
        .join('\n');

    const classifyPrompt = `You are an intent classifier for an AI assistant.
Classify the user message into EXACTLY ONE of these intents:

1. "lead_gen"    — user wants to find leads, prospect companies, get contacts, find businesses to outreach
2. "email_draft" — user wants to write, draft, compose, or improve an email (NOT find leads)
3. "business_qa" — user wants business advice, strategy, analysis, calculations, or professional Q&A
4. "chat"        — anything else: greetings, small talk, general questions, follow-up clarifications

RECENT CONVERSATION:
${recentHistory || 'None'}

USER MESSAGE: "${message}"

Rules:
- If the message mentions finding companies, leads, prospects, outreach targets → "lead_gen"
- If the message says write/draft/compose/fix/improve an email → "email_draft"
- If the message asks for business advice, strategy, metrics, pricing, sales tips → "business_qa"
- Greetings like "hi", "hello", "thanks", "what can you do" → "chat"
- Short follow-up messages after a lead_gen result (like "give me more" or "try another industry") → "lead_gen"
Return ONLY the intent string. No explanation. No JSON. Just one of: lead_gen | email_draft | business_qa | chat`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: classifyPrompt }],
            max_tokens:  10,
            temperature: 0.0,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:classify');

        if (!res) return INTENT.CHAT;

        recordOpenAiUsage(
            res.data?.usage?.prompt_tokens     || 0,
            res.data?.usage?.completion_tokens || 0,
            'gpt-4o-mini'
        );

        const raw = res.data.choices[0].message.content.trim().toLowerCase();
        if (raw.includes('lead_gen'))    return INTENT.LEAD_GEN;
        if (raw.includes('email_draft')) return INTENT.EMAIL_DRAFT;
        if (raw.includes('business_qa')) return INTENT.BUSINESS_QA;
        return INTENT.CHAT;

    } catch (err) {
        console.warn('[Intent Classify Failed]:', err.message);
        return INTENT.CHAT;
    }
}

async function _handleChat(message, history, userProfile, apiKey) {
    const senderName = userProfile?.senderName || 'there';
    const usp        = userProfile?.usp || null;

    const systemPrompt = `You are an intelligent AI assistant and business operator.
You help with conversations, answer questions, give advice, and assist with business tasks.
You are direct, sharp, and genuinely helpful — not corporate or robotic.
${usp ? `The user's business value proposition is: "${usp}". Reference this naturally when relevant.` : ''}
You also have the ability to find leads, draft emails, and give business strategy advice.
If the user seems to want leads or emails, gently let them know you can do that.
Keep responses concise but complete. Never pad with filler.`;

    const memoryMessages = (history || [])
        .slice(-20)
        .map(h => ({ role: h.role, content: h.content }));

    const messages = [
        { role: 'system',  content: systemPrompt },
        ...memoryMessages,
        { role: 'user',    content: message },
    ];

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages,
            max_tokens:  600,
            temperature: 0.7,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:chat');

        if (!res) return 'I had trouble responding — please try again.';

        recordOpenAiUsage(
            res.data?.usage?.prompt_tokens     || 0,
            res.data?.usage?.completion_tokens || 0,
            'gpt-4o-mini'
        );

        return res.data.choices[0].message.content.trim();

    } catch (err) {
        console.warn('[Chat Handler Error]:', err.message);
        return 'Something went wrong. Please try again.';
    }
}

async function _handleEmailDraft(message, history, userProfile, apiKey) {
    const senderName = userProfile?.senderName || 'Alex';
    const usp        = userProfile?.usp || null;

    const recentContext = (history || [])
        .slice(-6)
        .map(h => `${h.role}: ${h.content}`)
        .join('\n');

    const draftPrompt = `You are a world-class B2B email copywriter.
Write the email the user is asking for based on their instructions below.

SENDER NAME: ${senderName}
${usp ? `SENDER VALUE PROP: ${usp}` : ''}

RECENT CONTEXT:
${recentContext || 'None'}

USER INSTRUCTION: "${message}"

CRITICAL RULES:
- NEVER use banned adjectives or phrases
- NEVER invent stats or percentages
- Opening line must hook immediately — no "I hope this finds you well"
- CTA must be one soft, specific ask
- Sign off with: Best, ${senderName}
- Keep total length under 150 words unless the user asks for longer

Return ONLY valid JSON:
{
  "subject": "string",
  "body": "string"
}`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o',
            messages:    [{ role: 'user', content: draftPrompt }],
            max_tokens:  600,
            temperature: 0.7,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:emaildraft');

        if (!res) throw new Error('Draft returned null');

        recordOpenAiUsage(
            res.data?.usage?.prompt_tokens     || 0,
            res.data?.usage?.completion_tokens || 0,
            'gpt-4o'
        );

        const raw    = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        const parsed = JSON.parse(raw);

        return `Here's your email:\n\n**Subject:** ${parsed.subject}\n\n${parsed.body}`;

    } catch (err) {
        console.warn('[Email Draft Error]:', err.message);
        return 'I had trouble drafting that email. Can you give me a bit more detail about who it\'s for and what you want to say?';
    }
}

async function _handleBusinessQA(message, history, userProfile, apiKey) {
    const usp = userProfile?.usp || null;

    const systemPrompt = `You are a sharp senior business strategist and operator.
You give direct, actionable business advice with zero corporate fluff.
You think like a founder, operator, and growth expert simultaneously.
${usp ? `The user runs a business with this value proposition: "${usp}". Use this as context when relevant.` : ''}
When answering:
- Be specific and concrete — no vague generalities
- Use frameworks only when they genuinely help
- Give a direct recommendation, not just options
- If you need more information to give a good answer, ask one focused question
- Never pad responses with filler sentences`;

    const memoryMessages = (history || [])
        .slice(-12)
        .map(h => ({ role: h.role, content: h.content }));

    const messages = [
        { role: 'system',  content: systemPrompt },
        ...memoryMessages,
        { role: 'user',    content: message },
    ];

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o',
            messages,
            max_tokens:  800,
            temperature: 0.5,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:businessqa');

        if (!res) return 'I had trouble with that — please try again.';

        recordOpenAiUsage(
            res.data?.usage?.prompt_tokens     || 0,
            res.data?.usage?.completion_tokens || 0,
            'gpt-4o'
        );

        return res.data.choices[0].message.content.trim();

    } catch (err) {
        console.warn('[Business QA Error]:', err.message);
        return 'Something went wrong. Please try again.';
    }
}

async function researchCompanyForLead(companyName, domain, tavilyKey, openAiKey, onProgress) {
    const cached = getCachedResearch(domain);
    if (cached) return cached;
    if (getTavilyRemaining() <= 1) return null;

    try {
        onProgress?.(`🔍 Researching ${companyName}...`);

        const generalResults = await searchWithTavily(
            `"${companyName}" contact email "contact@" OR "sales@" OR "info@" OR "hello@" site:${domain} OR site:linkedin.com OR site:crunchbase.com mission about ${CURRENT_YEAR}`,
            tavilyKey, { maxResults: 5 }
        );
        const generalText     = generalResults.map(r => `${r.title} ${r.snippet} ${r.url}`).join(' ');
        const generalSnippets = generalResults.map(r => `SOURCE: ${r.url}\nTITLE: ${r.title}\n${r.snippet}`).join('\n\n---\n\n');
        const regexFromGeneral = extractEmailsFromText(generalText, domain);

        const hasEmailSignal      = regexFromGeneral.companyEmails.length > 0 || generalSnippets.toLowerCase().includes('contact');
        const needsEmployeeSearch = generalResults.length < 3 || !hasEmailSignal;

        let employeeResults = [];
        if (needsEmployeeSearch && getTavilyRemaining() > 0) {
            onProgress?.(`👤 Finding decision-makers at ${companyName}...`);
            employeeResults = await searchWithTavily(
                `"${companyName}" CEO OR founder OR "head of" OR "director of" OR "VP of" email LinkedIn`,
                tavilyKey, { maxResults: 4 }
            );
        }

        const allText     = [...generalResults, ...employeeResults].map(r => `${r.title} ${r.snippet} ${r.url}`).join(' ');
        const allSnippets = [...generalResults, ...employeeResults]
            .map(r => `SOURCE: ${r.url}\nTITLE: ${r.title}\n${r.snippet}`).join('\n\n---\n\n');
        const regexFromAll = extractEmailsFromText(allText, domain);

        if (allSnippets.trim().length === 0) return null;

        const extractPrompt = `${REASONING_FILTER}
Extract company intelligence for "${companyName}" (domain: ${domain}).
Return ONLY valid JSON:
{
  "mission": "one sentence company mission or null",
  "hq": "City, Country or null",
  "size": "1-10 | 11-50 | 51-200 | 200+ | unknown",
  "model": "B2B | B2C | SaaS | Services | E-commerce | Agency | unknown",
  "recentNews": "one sentence most recent news or null",
  "contactEmails": ["role-based emails literally found in text. Max 3. Empty array if none."],
  "employees": [
    {
      "name": "Full Name ONLY if explicitly in snippets. null otherwise. NEVER invent.",
      "role": "Exact title: CEO | Founder | Co-Founder | Director | VP | Manager | Head of X",
      "email": "Email ONLY if literally in snippets. null otherwise. NEVER invent or construct.",
      "linkedIn": "LinkedIn URL if found. null otherwise."
    }
  ]
}
CRITICAL: Do NOT construct any email. Do NOT guess. If not in snippets: null or empty array.
SNIPPETS:${allSnippets}`;

        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: extractPrompt }],
            max_tokens:  500,
            temperature: 0.0,
        }, { headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:extract');

        if (!res) return null;

        recordOpenAiUsage(
            res.data?.usage?.prompt_tokens     || 0,
            res.data?.usage?.completion_tokens || 0,
            'gpt-4o-mini'
        );

        const raw    = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        const parsed = JSON.parse(raw);
        parsed._domain = domain;

        const allRealEmails = [...new Set([
            ...regexFromAll.companyEmails,
            ...(parsed.contactEmails || []),
        ])].filter(isValidEmailFormat);
        parsed.contactEmails = allRealEmails.filter(email => {
            const ed = email.split('@')[1]?.toLowerCase();
            return ed === domain || ed?.includes(domain.split('.')[0]);
        });

        if (Array.isArray(parsed.employees)) {
            parsed.employees = parsed.employees.map(emp => {
                if (emp.email) {
                    const emailActuallyExists = allText.toLowerCase().includes(emp.email.toLowerCase());
                    if (!emailActuallyExists) {
                        console.warn(`🗑️ [REALITY CHECK] GPT invented email: ${emp.email} — removing`);
                        emp.email = null;
                    }
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
        setCachedResearch(domain, parsed);
        return parsed;

    } catch (err) {
        console.warn(`[Research Error] ${err.message}`);
        return null;
    }
}

// ─── SKYLINE AI PERSONALIZATION ENGINE ───────────────────────────────────────
// COMPLETELY REPLACED the old generic email generation with strict personalization
// Every message is scored (≥80 required) and must feel uniquely written for each company
async function generatePersonalizedEmailsForLead(companyData, contactPerson, domain, userProfile, openAiKey, detectedLanguage) {
    try {
        const companyName   = companyData.name;
        const mission       = companyData.mission   || null;
        const news          = companyData.recentNews || null;
        const industry      = companyData.industry  || 'their industry';
        const businessModel = companyData.model     || 'unknown';
        const senderName    = userProfile?.senderName || 'Alex';
        const usp           = userProfile?.usp || 'We build done-for-you outreach pipelines that replace manual prospecting';
        const contactName   = contactPerson?.name || null;
        const contactRole   = contactPerson?.role || null;
        const firstNameOnly = contactName ? contactName.split(' ')[0] : 'Hi';

        const multilingualBlock = _buildMultilingualEmailBlock(detectedLanguage);

        const personalizationPrompt = `${PERSONALIZATION_RULES}
${multilingualBlock}

━━━━━━━━━━━━━━━━━━━
COMPANY DATA
━━━━━━━━━━━━━━━━━━━
Company Name: ${companyName}
Industry: ${industry}
Business Model: ${businessModel}
Contact: ${contactName || 'Decision Maker'} (${contactRole || 'Business Owner'})
${mission ? `Mission: ${mission}` : ''}
${news ? `Recent News: ${news}` : ''}
Sender: ${senderName}
Value Prop: ${usp}

━━━━━━━━━━━━━━━━━━━
YOUR TASK
━━━━━━━━━━━━━━━━━━━

Generate THREE highly personalized outreach emails (initial, followup, breakup) for THIS SPECIFIC company.

CRITICAL RULES:
1. EVERY message must include:
   - Company-specific reference (their business type/product)
   - Role-specific angle (founder vs CEO vs marketing head)
   - Pain-point alignment (acquisition/lead gen/scaling/efficiency)
   - Contextual relevance to their industry

2. NO generic language allowed:
   - "I hope this email finds you well" → BANNED
   - "I am reaching out to introduce myself" → BANNED
   - "We help businesses grow" → BANNED
   - "cutting-edge solution" → BANNED
   - "innovative platform" → BANNED

3. Message structure (STRICT):
   1) Hook (specific to this company)
   2) Relevance statement (why you're reaching out)
   3) Value alignment (what you help with)
   4) Soft call-to-action

4. Tone: direct, confident, simple, human, non-salesy. No hype. No fluff.

5. ANTI-HALLUCINATION: Do NOT invent product features, achievements, or internal details. Only use provided data + safe industry logic.

6. PERSONALIZATION DEPTH SCORE: Score 0-100. ONLY ACCEPT scores ≥ 80.

Return JSON with personalization_score and signals_used:

{
  "initial": {
    "subject": "4-6 words, specific to ${companyName}",
    "body": "Follow strict structure above"
  },
  "followup": {
    "subject": "Re: [Initial Subject]",
    "body": "Fresh angle, not a repeat"
  },
  "breakup": {
    "subject": "Closing my file on ${companyName}",
    "body": "3 sentences, graceful exit"
  },
  "personalization_score": 92,
  "signals_used": ["company_context", "role_based_angle", "pain_point_alignment"],
  "risk_level": "low"
}`;

        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o',
            messages:    [{ role: 'user', content: personalizationPrompt }],
            max_tokens:  1500,
            temperature: 0.85, // Slightly higher for creativity while maintaining structure
        }, { headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:personalized_emails');

        if (!res) throw new Error('Personalized email generation returned null after retries');

        recordOpenAiUsage(
            res.data?.usage?.prompt_tokens     || 0,
            res.data?.usage?.completion_tokens || 0,
            'gpt-4o'
        );

        const raw = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        const parsed = JSON.parse(raw);
        
        // STRICT ACCEPTANCE CHECK: Reject messages with personalization_score < 80
        if (parsed.personalization_score < 80) {
            console.warn(`🔴 [PERSONALIZATION] Rejected — Score: ${parsed.personalization_score} (<80) for ${companyName}`);
            console.warn(`   Signals used: ${parsed.signals_used?.join(', ') || 'none'}`);
            throw new Error(`Personalization score too low: ${parsed.personalization_score}`);
        }
        
        console.log(`🟢 [PERSONALIZATION] Accepted — Score: ${parsed.personalization_score} for ${companyName}`);
        console.log(`   Signals: ${parsed.signals_used?.join(', ') || 'none'}`);
        
        return parsed;

    } catch (err) {
        console.warn(`[Personalized Email Gen Error] ${err.message}`);
        
        // Fallback with ULTRA-SPECIFIC personalization attempt (still avoids generic)
        const name = contactPerson?.name?.split(' ')[0] || 'there';
        const industryLower = (industry || '').toLowerCase();
        
        // Intelligent fallback that's still company-specific
        let specificHook = '';
        if (industryLower.includes('saas')) {
            specificHook = `Noticed ${companyName} is building in the ${industryLower} space.`;
        } else if (industryLower.includes('agency')) {
            specificHook = `Most ${industryLower} agencies I talk to have the same bottleneck: finding time to prospect between client work.`;
        } else if (industryLower.includes('ecommerce')) {
            specificHook = `Running ${companyName} means your margins depend on a steady stream of new customers.`;
        } else {
            specificHook = `Building ${companyName} in the ${industry} space comes with specific growth challenges.`;
        }
        
        return {
            initial: {
                subject: `${industry} growth for ${companyName.split(' ')[0]}`,
                body: `${name},\n\n${specificHook}\n\n${usp}. We replace manual prospecting so you focus on delivery, not searching.\n\nWorth a quick call this week?\n\nBest,\n${senderName}`,
            },
            followup: {
                subject: `Re: ${industry} growth for ${companyName.split(' ')[0]}`,
                body: `${name},\n\nFollowing up — most ${industry} operators say the same: there aren't enough hours to prospect and deliver.\n\nStill worth 15 minutes?\n\nBest,\n${senderName}`,
            },
            breakup: {
                subject: `Closing my file on ${companyName.split(' ')[0]}`,
                body: `${name},\n\nAssuming timing isn't right. I'll stop following up — reach out when it makes sense.\n\nBest,\n${senderName}`,
            },
            personalization_score: 75,
            signals_used: ['company_context', 'fallback_generation'],
            risk_level: 'medium'
        };
    }
}

function _aggressiveRejectionGate(lead, sourceEvaluation, emailEvaluation, intent) {
    const reasons = [];
    const signals = [];
    let confidence = 100;

    if (sourceEvaluation.score < 70) {
        reasons.push('Weak source quality');
        signals.push('low_source_quality');
        confidence -= 40;
    }

    if (emailEvaluation.score < 70) {
        reasons.push('Weak email confidence');
        signals.push('low_email_confidence');
        confidence -= 40;
    }

    if (emailEvaluation.type === 'generic') {
        reasons.push('Generic email (info/support/etc)');
        signals.push('generic_email');
        confidence -= 30;
    }

    if (!lead.role || lead.role === 'unknown' || lead.role === 'Owner') {
        if (!lead.linkedIn && !lead.recentNews) {
            reasons.push('No leadership evidence');
            signals.push('no_leadership_evidence');
            confidence -= 20;
        }
    }

    if (lead.hallucinationFlags && lead.hallucinationFlags.length > 0) {
        reasons.push('Hallucination risk detected');
        signals.push('hallucination_risk');
        confidence -= 50;
    }

    if (lead.dataScore < 30) {
        reasons.push('Incomplete business data');
        signals.push('incomplete_data');
        confidence -= 20;
    }

    if (intent.company_type && intent.company_type !== 'general') {
        const leadInd = (lead.industry || '').toLowerCase();
        const intentInd = intent.company_type.toLowerCase();
        if (leadInd !== 'unknown' && !leadInd.includes(intentInd) && !intentInd.includes(leadInd)) {
            reasons.push('Weak target relevance');
            signals.push('weak_target_match');
            confidence -= 30;
        }
    }

    if (signals.length >= 3) {
        confidence = Math.min(confidence, 20);
        reasons.push('Multiple weak signals combined');
    }

    const finalConfidence = Math.max(0, confidence);
    const accepted = finalConfidence >= 75;

    return {
        accepted,
        confidence: finalConfidence,
        reason: accepted ? 'Passed aggressive rejection gate' : reasons.join(', '),
        signals
    };
}

async function processOneCompany(result, intent, tavilyKey, apiKey, userProfile, onProgress, detectedLanguage) {
    try {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
        if (!domain) return null;
        if (isFreeEmailDomain(domain)) return null;

        const sourceEvaluation = await _evaluateSourceQuality(result.url, result.title, result.snippet);
        
        if (!sourceEvaluation.accepted) {
            console.log(`🔴 [SOURCE GATE] Rejected weak source (Score: ${sourceEvaluation.score}): ${result.url}`);
            console.log(`   Reason: ${sourceEvaluation.reason}`);
            return null;
        }
        
        console.log(`🟢 [SOURCE GATE] Accepted high-quality source (Score: ${sourceEvaluation.score}): ${result.url}`);

        const companyName = cleanCompanyName(result.title);
        if (!companyName) return null;

        const companyKey = companyName.toLowerCase().replace(/\s+/g, '');
        if (globalSeenCompanyNames.has(companyKey)) {
            console.log(`⏭️ [COMPANY DEDUP] Skipping duplicate company: ${companyName}`);
            return null;
        }
        globalSeenCompanyNames.add(companyKey);

        onProgress?.(`📋 Researching ${companyName}...`);
        console.log(`📋 Processing: ${companyName} (${domain})`);

        const [companyData, mxValid] = await Promise.all([
            researchCompanyForLead(companyName, domain, tavilyKey, apiKey, onProgress),
            validateMX(domain),
        ]);

        if (!mxValid) {
            console.warn(`🗑️ [REJECTED] ${companyName} — domain ${domain} has no MX records`);
            return null;
        }

        const dataScore = scoreDataCompleteness(companyData);
        if (dataScore < 10) {
            console.warn(`🗑️ Skipping ${companyName} — data score ${dataScore}/100`);
            return null;
        }

        const employees   = companyData?.employees || [];
        const bestContact = _pickBestContact(employees, intent.decision_maker);
        
        const candidateEmails = [
            ...(companyData?._regexEmails || []),
            ...(companyData?.contactEmails || []),
            ...(employees.filter(e => e.email && isValidEmailFormat(e.email)).map(e => e.email)),
        ].filter(isValidEmailFormat);

        if (candidateEmails.length === 0 && getTavilyRemaining() > 0) {
            onProgress?.(`🎯 Hunting real email for ${companyName}...`);
            const huntResult = await huntRealEmails(companyName, domain, tavilyKey);
            if (huntResult.companyEmails.length > 0) {
                candidateEmails.push(...huntResult.companyEmails.filter(isValidEmailFormat));
                console.log(`🔎 [EMAIL HUNT] Added ${huntResult.companyEmails.length} candidate(s) for validation`);
            }
        }

        if (candidateEmails.length === 0) {
            console.warn(`🗑️ [REJECTED] ${companyName} — no source-discoverable emails found`);
            return null;
        }

        onProgress?.(`🔬 Validating emails for ${companyName}...`);
        const validatedEmails = await rankAndFilterEmails(candidateEmails, domain);

        if (validatedEmails.length === 0) {
            console.warn(`🗑️ [REJECTED] ${companyName} — no emails passed validation threshold (${EMAIL_CONFIDENCE_THRESHOLD})`);
            return null;
        }

        const topEmail = validatedEmails[0];
        const resolvedEmail = topEmail.email;
        
        const emailEvaluation = _evaluateEmailConfidence(resolvedEmail, domain, topEmail.smtpResult, topEmail.mxValid, result.snippet);
        const classification = classifyEmail(resolvedEmail, domain);
        const emailConfidence = classification.type;
        const emailLabel = classification.label;
        const allEmailOptions = validatedEmails.map(v => v.email);

        console.log(`✅ ${companyName} → ${resolvedEmail} [${emailConfidence}] confidence:${topEmail.confidenceScore} smtp:${topEmail.smtpResult} MX:${mxValid}`);

        onProgress?.(`✍️ Writing personalized emails for ${companyName}...`);
        
        // REPLACED: Using the new Skyline AI Personalization Engine
        const emailSequence = await generatePersonalizedEmailsForLead(
            {
                name: companyName,
                mission: companyData?.mission,
                recentNews: companyData?.recentNews,
                industry: intent.company_type,
                model: companyData?.model,
            },
            bestContact,
            domain,
            userProfile,
            apiKey,
            detectedLanguage
        );

        const hallucinationCount = (companyData?._hallucinationFlags || []).length;

        const leadScore = scoreLeadQuality({
            emailConfidence, mxValid,
            hasRealName: !!bestContact?.name,
            hasLinkedIn: !!bestContact?.linkedIn,
            hasNews: !!companyData?.recentNews,
            hasMission: !!companyData?.mission,
            dataScore,
            hallucinationCount,
            pageScore: sourceEvaluation.score,
        });

        const lead = {
            name: bestContact?.name || companyName,
            company: companyName,
            domain,
            email: resolvedEmail,
            emailConfidence,
            emailLabel,
            emailValidation: {
                confidenceScore: topEmail.confidenceScore,
                verdict: topEmail.verdict,
                smtpResult: topEmail.smtpResult,
                reason: topEmail.reason,
            },
            allEmailOptions,
            role: bestContact?.role || (companyData?.model === 'B2B' ? 'Decision Maker' : 'Owner'),
            linkedIn: bestContact?.linkedIn || null,
            companySize: companyData?.size || 'unknown',
            companyModel: companyData?.model || 'unknown',
            industry: intent.company_type || 'unknown',
            hq: companyData?.hq || null,
            recentNews: companyData?.recentNews || null,
            leadScore,
            pageScore: sourceEvaluation.score,
            mxValid,
            dataScore,
            hallucinationFlags: companyData?._hallucinationFlags || [],
            emailLanguage: detectedLanguage.code,
            messages: [
                { type: 'initial', subject: emailSequence.initial.subject, body: emailSequence.initial.body },
                { type: 'followup', subject: emailSequence.followup.subject, body: emailSequence.followup.body },
                { type: 'breakup', subject: emailSequence.breakup.subject, body: emailSequence.breakup.body },
            ],
            personalization_score: emailSequence.personalization_score || 85,
            signals_used: emailSequence.signals_used || ['company_context'],
        };

        const rejectionCheck = _aggressiveRejectionGate(lead, sourceEvaluation, emailEvaluation, intent);
        
        if (!rejectionCheck.accepted) {
            console.log(`🔴 [REJECTION GATE] Rejected lead for ${companyName} (Confidence: ${rejectionCheck.confidence})`);
            console.log(`   Reason: ${rejectionCheck.reason}`);
            return null;
        }

        console.log(`🟢 [REJECTION GATE] Accepted lead for ${companyName} (Confidence: ${rejectionCheck.confidence})`);

        _leadMatchesIntent(lead, intent);

        return lead;

    } catch (err) {
        console.warn(`[processOneCompany Error] ${err.message}`);
        return null;
    }
}

async function _runLeadGenPipeline(safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, tavilyKey) {
    globalSeenCompanyNames.clear();

    const requestedCount = _parseRequestedCount(safeMessage) ?? QUANTITY_RULE_DEFAULT_MAX;
    console.log(`🔢 [QUANTITY CONTROL] User requested: ${requestedCount} leads`);

    const resolvedIntent = await _resolveTargetIntent(safeMessage, apiKey);
    
    if (!resolvedIntent.target_detected) {
        return {
            reply: `I couldn't precisely identify your target audience. Please be more specific about the company type, industry, or decision-maker you're looking for. (Confidence: ${resolvedIntent.confidence || 0})`,
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'Target unclear.' }],
        };
    }

    const intent = {
        target: resolvedIntent.company_type || 'businesses',
        industry: resolvedIntent.company_type || 'general',
        location: resolvedIntent.geography,
        preferredContact: resolvedIntent.decision_maker || 'Any',
        company_type: resolvedIntent.company_type,
        business_stage: resolvedIntent.business_stage,
        decision_maker: resolvedIntent.decision_maker,
        excluded_targets: resolvedIntent.excluded_targets || [],
        search_strategy: resolvedIntent.search_strategy || []
    };

    console.log(`🎯 Intent: ${JSON.stringify(intent)}`);

    onProgress?.(`🔍 Searching for ${intent.company_type || intent.industry} companies${intent.location ? ' in ' + intent.location : ''}...`);

    const searchPoolSize = Math.min(Math.max(requestedCount + 5, MAX_LEADS_RETURNED + 3), 15);

    const queries = _buildEntityFirstQueries(intent, searchPoolSize);
    console.log(`🔍 Primary Query: ${queries.primary}`);

    const rawResults = await searchWithTavily(queries.primary, tavilyKey, { maxResults: searchPoolSize });
    console.log(`🔎 RAW RESULTS (${rawResults.length}):`, rawResults.map(r => r.url));

    let fallbackResults = [];
    if (rawResults.length < MIN_POOL_SIZE && getTavilyRemaining() > 0) {
        console.log(`⚡ [FALLBACK QUERY] Primary pool thin (${rawResults.length}/${MIN_POOL_SIZE}) — trying entity-focus fallback`);
        const fallbackQuery = queries.entityFocus;
        console.log(`🔍 Fallback Query: ${fallbackQuery}`);
        try {
            fallbackResults = await searchWithTavily(fallbackQuery, tavilyKey, { maxResults: searchPoolSize });
            console.log(`🔎 FALLBACK RESULTS (${fallbackResults.length}):`, fallbackResults.map(r => r.url));
        } catch (fbErr) {
            console.warn(`⚠️ [FALLBACK QUERY] Failed: ${fbErr.message}`);
        }
    }

    const seenUrls = new Set(rawResults.map(r => r.url));
    const mergedRaw = [
        ...rawResults,
        ...fallbackResults.filter(r => !seenUrls.has(r.url)),
    ];

    if (mergedRaw.length === 0) {
        return {
            reply: 'No companies found. Try narrowing the industry or adding a location.',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'No leads found.' }],
        };
    }

    const SKIP_DOMAINS = [
        'linkedin.com','crunchbase.com','apollo.io','hunter.io',
        'yelp.com','clutch.co','g2.com','trustpilot.com',
        'bark.com','bark.london','upwork.com','fiverr.com','peopleperhour.com',
        'yell.com','thomsonlocal.com','checkatrade.com',
        'directory.com','yellowpages.com','manta.com',
        'hubspot.com','moz.com','semrush.com','ahrefs.com',
        'searchenginejournal.com','searchengineland.com',
        'entrepreneur.com','forbes.com','inc.com','businessinsider.com',
        'techcrunch.com','venturebeat.com','wired.com',
        'reddit.com','quora.com','medium.com','substack.com',
        'wikipedia.org','wikihow.com','indeed.com','glassdoor.com',
        'ziprecruiter.com','capterra.com','getapp.com','softwareadvice.com',
        'producthunt.com','angellist.com','f6s.com','goodfirms.co',
        'designrush.com','expertise.com','houzz.com','thumbtack.com',
        'homeadvisor.com','yelp.ca','yelp.co.uk','yelp.com.au',
    ];

    const cleanResults = [];
    for (const result of mergedRaw) {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
        if (!domain) continue;
        if (globalSeenDomains.has(domain)) continue;
        if (SKIP_DOMAINS.some(d => domain.includes(d))) continue;
        globalSeenDomains.add(domain);
        cleanResults.push({ ...result, _domain: domain });
        if (cleanResults.length >= requestedCount + 5) break;
    }

    console.log(`✅ Clean results after domain filter: ${cleanResults.length}`);

    if (cleanResults.length === 0) {
        return {
            reply: 'Found results but all were directory or editorial sites. Try a more specific industry or location.',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'No leads after filtering.' }],
        };
    }

    onProgress?.(`⚙️ Researching ${cleanResults.length} companies...`);
    const tasks = cleanResults.map(result => () =>
        processOneCompany(result, intent, tavilyKey, apiKey, userProfile, onProgress, detectedLanguage)
    );
    const settled = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);

    const allVerifiedLeads = settled
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value)
        .sort((a, b) => b.leadScore - a.leadScore);

    const leadsToReturn = _applyOutputQuantityRules(allVerifiedLeads, requestedCount);

    const _meta = {
        tavilyUsed: tavilyQuota.used,
        tavilyRemaining: getTavilyRemaining(),
        openAiCalls: openAiTracker.totalCallsThisSession,
        openAiInputTokens: openAiTracker.totalInputTokensThisSession,
        openAiOutputTokens: openAiTracker.totalOutputTokensThisSession,
        estimatedCostUSD: parseFloat(costTracker.estimatedUSDThisSession.toFixed(4)),
        totalVerified: allVerifiedLeads.length,
        totalReturned: leadsToReturn.length,
        requestedCount,
        fallbackUsed: fallbackResults.length > 0,
        entityFirstSearch: true,
        intentResolution: resolvedIntent
    };

    console.log(`🏁 Done. ${leadsToReturn.length} verified leads returned (from ${allVerifiedLeads.length} total verified).`);
    console.log(`📊 GPT: ${openAiTracker.totalCallsThisSession} calls | in:${openAiTracker.totalInputTokensThisSession} out:${openAiTracker.totalOutputTokensThisSession} tokens | ~$${costTracker.estimatedUSDThisSession.toFixed(4)}`);
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
            { role: 'user', content: safeMessage },
            { role: 'assistant', content: `[Generated ${leadsToReturn.length} verified leads with personalized emails]` },
        ],
        _meta,
    };
}

async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🟢 [AI ENGINE] Pipeline started...');
        onProgress?.('🧠 Understanding your request...');

        const apiKey    = process.env.OPENAI_API_KEY;
        const tavilyKey = process.env.TAVILY_API_KEY;

        const safeMessage = typeof message === 'string'
            ? message.slice(0, MAX_MESSAGE_LENGTH)
            : '';

        if (!safeMessage.trim()) {
            return {
                reply: 'How can I help you today? I can find leads, draft emails, answer business questions, or just chat.',
                updatedHistory: history,
            };
        }

        const detectedLanguage = _detectLanguage(safeMessage);
        console.log(`🌐 [LANGUAGE] Detected: ${detectedLanguage.name} (${detectedLanguage.code})`);

        const intent = await _classifyIntent(safeMessage, history, apiKey);
        console.log(`🎯 [INTENT] ${intent}`);
        onProgress?.(`🧠 Mode: ${intent.replace('_', ' ')}...`);
        
        if (intent === INTENT.LEAD_GEN) {
            return await _runLeadGenPipeline(
                safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, tavilyKey
            );
        }

        if (intent === INTENT.EMAIL_DRAFT) {
            const reply = await _handleEmailDraft(safeMessage, history, userProfile, apiKey);
            return {
                reply,
                updatedHistory: [
                    ...history,
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: reply },
                ],
            };
        }

        if (intent === INTENT.BUSINESS_QA) {
            const reply = await _handleBusinessQA(safeMessage, history, userProfile, apiKey);
            return {
                reply,
                updatedHistory: [
                    ...history,
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: reply },
                ],
            };
        }

        const reply = await _handleChat(safeMessage, history, userProfile, apiKey);
        return {
            reply,
            updatedHistory: [
                ...history,
                { role: 'user', content: safeMessage },
                { role: 'assistant', content: reply },
            ],
        };

    } catch (error) {
        console.error('❌ [AI ENGINE] Fatal error:', error.message);
        return { reply: 'An error occurred. Please try again.', updatedHistory: history };
    }
}

module.exports = { generateFreeResponse };
