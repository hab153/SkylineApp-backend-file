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

// Minimum confidence score to pass a lead through (LOWERED to allow more leads)
const EMAIL_CONFIDENCE_THRESHOLD = 15;

// ─── OUTPUT QUANTITY CONTROL CONSTANTS ───────────────────────────────────────
const QUANTITY_RULE_HARD_MIN     = 1; // Ensure at least 1 result if possible
const QUANTITY_RULE_ABSOLUTE_MIN = 1;
const QUANTITY_RULE_DEFAULT_MAX  = MAX_LEADS_RETURNED;

// ─── 🎯 ICP MATCHING ENGINE — RULES DATABASE ─────────────────────────────────
const ICP_RULES = {
    'saas_founder': {
        target_roles: ['ceo', 'founder', 'co-founder', 'cto', 'vp engineering'],
        company_sizes: ['1-10', '11-50', '51-200'],
        business_models: ['SaaS', 'B2B', 'Platform'],
        description: 'Decision makers at early-to-mid stage tech companies.'
    },
    'agency_owner': {
        target_roles: ['ceo', 'founder', 'owner', 'director', 'head of marketing'],
        company_sizes: ['1-10', '11-50'],
        business_models: ['Agency', 'Services', 'Consulting', 'Studio'],
        description: 'Owners of service-based businesses.'
    },
    'recruiter': {
        target_roles: ['hr manager', 'hr director', 'talent acquisition', 'head of people', 'ceo'],
        company_sizes: ['51-200', '200+'],
        business_models: ['B2B', 'B2C', 'SaaS', 'Services'],
        description: 'HR leaders at growing companies.'
    },
    'consultant': {
        target_roles: ['ceo', 'founder', 'owner', 'partner'],
        company_sizes: ['1-10', '11-50', '51-200'],
        business_models: ['Services', 'Consulting', 'Agency'],
        description: 'Business owners who need expert advice.'
    },
    'general': {
        target_roles: ['ceo', 'founder', 'owner', 'director', 'manager'],        company_sizes: ['1-10', '11-50', '51-200', '200+'],
        business_models: ['B2B', 'B2C', 'SaaS', 'Services', 'Agency'],
        description: 'General decision makers.'
    }
};

// ─── 🌐 HIGH-QUALITY SOURCE ENGINE — TIERS ───────────────────────────────────
const SOURCE_TIERS = {
    TIER_1_GOLD: {
        name: 'Official Company Site',
        patterns: [
            /\/about/i, /\/team/i, /\/contact/i, /\/company/i,
            /\/people/i, /\/leadership/i, /\/founders/i, /\/our-story/i,
            /\/press/i, /\/newsroom/i, /\/investors/i
        ],
        trustScore: 95,
        priority: 1
    },
    TIER_2_SILVER: {
        name: 'Professional Network/Database',
        domains: ['linkedin.com', 'crunchbase.com', 'angellist.com', 'wellfound.com', 'pitchbook.com'],
        trustScore: 70,
        priority: 2
    },
    TIER_3_BRONZE: {
        name: 'Company Blog/News',
        patterns: [/\/blog\//i, /\/news\//i, /\/articles\//i],
        trustScore: 40,
        priority: 3
    },
    HARD_BLOCK: {
        name: 'Low Quality/Spam',
        domains: [
            'yelp.com', 'clutch.co', 'g2.com', 'trustpilot.com',
            'bark.com', 'upwork.com', 'fiverr.com', 'peopleperhour.com',
            'yellowpages.com', 'manta.com', 'directory.com',
            'hubspot.com', 'moz.com', 'semrush.com', 'ahrefs.com',
            'searchenginejournal.com', 'entrepreneur.com', 'forbes.com',
            'inc.com', 'businessinsider.com', 'techcrunch.com',
            'reddit.com', 'quora.com', 'medium.com', 'substack.com',
            'wikipedia.org', 'wikihow.com', 'indeed.com', 'glassdoor.com',
            'growthlist.co', 'bookyourdata.com', 'capchase.com', 'getleadwave.io', 
            'openvc.app', 'fundraiseinsider.com', 'datarade.ai'
        ],
        patterns: [
            /top\s*\d+/i, /best\s*\d+/i, /list\s*of/i, /review/i,
            /affiliate/i, /sponsored/i, /ad/i, /buy-email-list/i
        ],
        trustScore: 0,
        priority: 99    }
};

// ─── 🧍 REAL PERSON DISCOVERY ENGINE — HIERARCHY MAP ─────────────────────────
const ROLE_HIERARCHY = {
    'ceo':            { level: 1, dept: 'executive', title: 'Chief Executive Officer', focus: 'strategy,revenue,growth' },
    'founder':        { level: 1, dept: 'executive', title: 'Founder', focus: 'vision,product,market-fit' },
    'co-founder':     { level: 1, dept: 'executive', title: 'Co-Founder', focus: 'vision,product,market-fit' },
    'president':      { level: 1, dept: 'executive', title: 'President', focus: 'operations,strategy' },
    'cto':            { level: 2, dept: 'engineering', title: 'Chief Technology Officer', focus: 'tech-stack,efficiency,security' },
    'cfo':            { level: 2, dept: 'finance', title: 'Chief Financial Officer', focus: 'costs,roi,budget' },
    'cmo':            { level: 2, dept: 'marketing', title: 'Chief Marketing Officer', focus: 'brand,leads,cac' },
    'vp':             { level: 2, dept: 'various', title: 'Vice President', focus: 'department-specific' },
    'vice president': { level: 2, dept: 'various', title: 'Vice President', focus: 'department-specific' },
    'director':       { level: 3, dept: 'various', title: 'Director', focus: 'execution,team-management' },
    'head of':        { level: 3, dept: 'various', title: 'Head of Department', focus: 'execution,team-management' },
    'manager':        { level: 4, dept: 'various', title: 'Manager', focus: 'daily-ops,tasks' },
    'lead':           { level: 4, dept: 'various', title: 'Team Lead', focus: 'daily-ops,tasks' },
    'specialist':     { level: 5, dept: 'various', title: 'Specialist', focus: 'technical-skills' },
    'associate':      { level: 5, dept: 'various', title: 'Associate', focus: 'support' },
    'intern':         { level: 6, dept: 'various', title: 'Intern', focus: 'learning' }
};

// ─── ROLE PRIORITY MAP (Legacy Support) ──────────────────────────────────────
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
const REPUTATION_BLOCKED_DOMAINS = new Set([]);

// ─── SEARCH DIVERSIFICATION ───────────────────────────────────────────────────
const MIN_POOL_SIZE = 3;

// ─── INTENT TYPES ─────────────────────────────────────────────────────────────
const INTENT = {
    LEAD_GEN:    'lead_gen',
    CHAT:        'chat',
    EMAIL_DRAFT: 'email_draft',    BUSINESS_QA: 'business_qa',
};

// ─── REASONING FILTER ──────────────────────────────────────────────────────────
const REASONING_FILTER = `
⚠️ REASONING FILTER — NON-NEGOTIABLE:
1. You are a strict fact extractor. Use ONLY facts explicitly stated in SNIPPETS.
2. IGNORE all training data. If a fact is not in the snippets, return null.
3. NEVER invent names, emails, roles, or company details.
4. Current year is ${CURRENT_YEAR}.
`;

// ─── BANNED WORDS ─────────────────────────────────────────────────────────────
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

// ─── QUOTA TRACKERS ────────────────────────────────────────────────────────────
const tavilyQuota = { used: 0, limit: TAVILY_LIMIT, lastReset: Date.now() };

const openAiTracker = {
    totalCallsThisSession:        0,
    totalInputTokensThisSession:  0,    totalOutputTokensThisSession: 0,
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
    for (let attempt = 0; attempt <= retries; attempt++) {        try {
            return await fn();
        } catch (err) {
            const isLast = attempt === retries;
            console.warn(`⚠️ [${label}] attempt ${attempt + 1} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying'}`);
            if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
    }
    return null;
}

// ─── 🌐 SOURCE QUALITY CLASSIFIER ────────────────────────────────────────────
function _classifySourceQuality(url, title, snippet) {
    const lowerUrl = url.toLowerCase();
    const lowerTitle = title.toLowerCase();
    const lowerSnippet = snippet.toLowerCase();

    // 1. Check Hard Blocks First
    for (const domain of SOURCE_TIERS.HARD_BLOCK.domains) {
        if (lowerUrl.includes(domain)) {
            return { tier: 'HARD_BLOCK', score: 0, reason: `Blocked domain: ${domain}` };
        }
    }
    for (const pattern of SOURCE_TIERS.HARD_BLOCK.patterns) {
        if (pattern.test(lowerTitle) || pattern.test(lowerSnippet)) {
            return { tier: 'HARD_BLOCK', score: 0, reason: 'Blocked content pattern (SEO/List)' };
        }
    }

    // 2. Check Tier 1 (Gold)
    for (const pattern of SOURCE_TIERS.TIER_1_GOLD.patterns) {
        if (pattern.test(lowerUrl)) {
            return { tier: 'TIER_1', score: 95, reason: 'Official Company Page' };
        }
    }

    // 3. Check Tier 2 (Silver)
    for (const domain of SOURCE_TIERS.TIER_2_SILVER.domains) {
        if (lowerUrl.includes(domain)) {
            return { tier: 'TIER_2', score: 70, reason: 'Professional Network' };
        }
    }
    // 4. Check Tier 3 (Bronze)
    for (const pattern of SOURCE_TIERS.TIER_3_BRONZE.patterns) {
        if (pattern.test(lowerUrl)) {
            return { tier: 'TIER_3', score: 40, reason: 'Company Blog/News' };
        }
    }

    // 5. Default: Unknown/Generic    return { tier: 'UNKNOWN', score: 50, reason: 'Generic Source' };
}

// ─── PAGE BUSINESS RELEVANCE SCORER ──────────────────────────────────────────
function _scorePageBusinessRelevance(result) {
    const url     = (result.url     || '').toLowerCase();
    const title   = (result.title   || '').toLowerCase();
    const snippet = (result.snippet || '').toLowerCase();
    
    // Get Source Quality
    const sourceInfo = _classifySourceQuality(url, title, snippet);
    
    // If Hard Blocked, return negative score to ensure rejection
    if (sourceInfo.tier === 'HARD_BLOCK') {
        return -100;
    }

    let score = sourceInfo.score; // Start with source trust score
    
    // Bonus for High Value Title Signals
    const HIGH_VALUE_TITLE_SIGNALS = [
        'agency', 'studio', 'solutions', 'services', 'group', 'partners',
        'consulting', 'technologies', 'software', 'platform', 'media',
        'marketing', 'creative', 'digital', 'design', 'development',
        'co.', 'inc', 'ltd', 'llc', 'corp',
    ];
    for (const signal of HIGH_VALUE_TITLE_SIGNALS) {
        if (title.includes(signal)) { score += 12; break; }
    }

    // Penalty for Low Value Title Signals
    const LOW_VALUE_TITLE_SIGNALS = [
        'how to', 'guide', 'tutorial', 'best practices', 'tips for',
        'what is', 'introduction to', 'overview of', 'list of',
        'top 10', 'top 5', '10 ways', '5 ways', '7 ways',
        'blog post', 'article', 'free download', 'pdf',
    ];
    for (const signal of LOW_VALUE_TITLE_SIGNALS) {
        if (title.includes(signal)) { score -= 20; break; }
    }
    // Snippet Signals
    if (snippet.includes('@'))                     score += 10;
    if (snippet.includes('contact'))               score += 5;
    if (/ceo|founder|owner|director/.test(snippet)) score += 10;
    if (/agency|studio|solutions|services/.test(snippet)) score += 8;

    if (/how to|what is|tutorial|step.by.step|learn how/.test(snippet)) score -= 15;
    if (/read more|subscribe|newsletter|download free/.test(snippet))   score -= 10;

    return Math.max(0, Math.min(100, score));}

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

// ─── ENTITY-FIRST SEARCH QUERY BUILDER ───────────────────────────────────────
function _buildEntityFirstQueries(intent, poolSize) {
    const loc   = intent.location ? `"${intent.location}"` : '';
    const ind   = intent.industry || '';
    const tgt   = intent.target   || '';

    // IMPROVED: Focus on funding/news/hiring to avoid listicles
    const primary = [
        `"${tgt}"`, ind, loc,
        'raised funding OR series A OR seed round OR hiring OR jobs',
        '-site:linkedin.com -site:crunchbase.com -site:glassdoor.com -site:indeed.com',
        '-"list of" -"top 10" -"best companies"',
    ].filter(Boolean).join(' ');

    const entityFocus = [
        ind, loc,
        'official website company',
        '"about us" OR "our team" OR "meet the team"',
        '"contact us" OR "get in touch"',
    ].filter(Boolean).join(' ');
    
    const dmFocus = [
        `"${ind}"`, loc,
        'CEO OR founder OR owner OR director',        '"email" OR "contact"',
        '-site:linkedin.com -site:crunchbase.com',
    ].filter(Boolean).join(' ');

    return { primary, entityFocus, dmFocus };
}

// ─── REAL EMAIL HUNTING ────────────────────────────────────────────────────────
function extractEmailsFromText(text, companyDomain) {
    if (!text || !companyDomain) return { companyEmails: [], allEmails: [] };
    const emailRegex    = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const allFound      = [...new Set(text.match(emailRegex) || [])];
    const domainRoot    = companyDomain.split('.')[0].toLowerCase();
    const companyEmails = allFound.filter(e => {
        const ed = e.split('@')[1]?.toLowerCase() || '';
        return ed === companyDomain || ed.includes(domainRoot);
    });
    return { companyEmails, allEmails: allFound };
}

async function huntRealEmails(companyName, domain, tavilyKey) {
    if (getTavilyRemaining() <= 0) return { companyEmails: [], allEmails: [] };
    
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
    return extractEmailsFromText(allText, domain);
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
    ];    const isGeneric = GENERIC_PREFIXES.some(p =>
        localPart === p || localPart.startsWith(p + '.')
    );

    if (!domainMatches) return { type: 'unrelated-domain', label: 'Wrong domain',           trustLevel: 0  };
    if (isGeneric)      return { type: 'confirmed-generic', label: '✓ Contact email (real)', trustLevel: 70 };
    if (localPart.includes('.') || /[a-z]{2,}[a-z]{2,}/.test(localPart)) {
        return          { type: 'confirmed-personal', label: '✓ Personal email (real)',      trustLevel: 90 };
    }
    return              { type: 'confirmed-other',   label: '✓ Email (real)',                trustLevel: 75 };
}

// ─── DISPOSABLE / SPAM DOMAIN BLOCKLIST ──────────────────────────────────────
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

// ─── SMTP PROBE ───────────────────────────────────────────────────────────────
async function smtpProbeEmail(email, domain) {
    try {
        const mxRecords = await dns.resolveMx(domain);
        if (!mxRecords || mxRecords.length === 0) return 'unknown';

        const sorted = mxRecords.sort((a, b) => a.priority - b.priority);
        const mxHost = sorted[0].exchange;

        return await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                try { socket.destroy(); } catch {}
                resolve('unknown');
            }, 8000);
            const socket = net.createConnection(25, mxHost);
            let   buffer = '';
            let   stage  = 0;

            socket.on('error', (err) => {
                clearTimeout(timeout);
                resolve('unknown');            });

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
                        if (code === 250 || code === 251) resolve('valid');
                        else if (code === 550 || code === 551 || code === 553 || code === 554) resolve('invalid');
                        else resolve('unknown');
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
        return 'unknown';
    }
}
// ─── CATCH-ALL DETECTION ─────────────────────────────────────────────────────
async function isCatchAllDomain(domain) {
    const randomString = Math.random().toString(36).substring(7);
    const fakeEmail = `${randomString}@${domain}`;
    const result = await smtpProbeEmail(fakeEmail, domain);    return result !== 'invalid';
}

// ─── 📧 EMAIL VERIFICATION ENGINE — MULTI-SOURCE VALIDATION ──────────────────
async function validateEmailFull(email, domain, sourceTier = 'UNKNOWN', patternType = 'none') {
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
        sourceTier:      sourceTier,
        patternType:     patternType
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

    const classification = classifyEmail(normalisedEmail, domain);
    const isCatchAll = await isCatchAllDomain(domain);
    
    let smtpResult = 'unknown';
    if (!isCatchAll) {
        smtpResult = await smtpProbeEmail(normalisedEmail, emailDomain);
    } else {
        smtpResult = 'catch-all';
    }
    result.smtpResult = smtpResult;

    // ─── COMPOSITE CONFIDENCE SCORING ────────────────────────────────────────
    let score = 0;

    // 1. Base Score from Syntax/MX
    score += 20; 

    // 2. SMTP Verification Boost/Penalty
    if (smtpResult === 'valid') {
        score += 40;
    } else if (smtpResult === 'invalid') {
        score = 0; // Hard reject
        result.reason = 'SMTP probe: mailbox does not exist';
        result.confidenceScore = 0;
        return result;
    } else if (smtpResult === 'catch-all') {
        score += 10; // Lower confidence for catch-all
    } else {
        score += 5; // Unknown SMTP
    }

    // 3. Pattern Type Boost
    if (patternType === 'confirmed-personal') score += 20;
    else if (patternType === 'confirmed-generic') score += 10;
    else if (patternType === 'guessed-pattern') score += 15; // Inferred patterns are valuable
    else if (patternType === 'risky-catchall') score += 5;

    // 4. Source Tier Boost
    if (sourceTier === 'TIER_1') score += 15;
    else if (sourceTier === 'TIER_2') score += 10;
    else if (sourceTier === 'TIER_3') score += 5;
    else if (sourceTier === 'HARD_BLOCK') score = 0; // Should have been filtered earlier
    // 5. Role Classification Adjustment
    if (classification.type === 'confirmed-personal') score += 10;
    else if (classification.type === 'confirmed-generic') score += 5;

    result.confidenceScore = Math.min(100, score);
    // Determine Verdict
    if (result.confidenceScore >= 80) {
        result.verdict = 'verified';
        result.reason = 'High confidence: Valid format, MX, and strong source/pattern signals';
    } else if (result.confidenceScore >= 50) {
        result.verdict = 'probable';
        result.reason = 'Medium confidence: Valid format and MX, but weak SMTP or source signals';
    } else if (result.confidenceScore >= 15) { // LOWERED THRESHOLD FOR RISKY
        result.verdict = 'risky';
        result.reason = 'Low confidence: Valid format, but high risk due to catch-all or low-quality source';
    } else {
        result.verdict = 'rejected';
        result.reason = 'Insufficient confidence score';
    }

    return result;
}

// ─── MULTI-EMAIL VALIDATION & RANKING ────────────────────────────────────────
async function rankAndFilterEmails(emails, domain, sourceTier = 'UNKNOWN') {
    if (!emails || emails.length === 0) return [];

    const unique = [...new Set(emails.map(e => (typeof e === 'string' ? e.toLowerCase().trim() : e)))];

    const validated = await Promise.all(
        unique.map(email => validateEmailFull(email, domain, sourceTier, 'none')) // Default pattern type, updated in pipeline
    );

    const passing = validated
        .filter(r => r.confidenceScore >= EMAIL_CONFIDENCE_THRESHOLD)
        .sort((a, b) => b.confidenceScore - a.confidenceScore);

    return passing;
}

// ─── VALIDATION ────────────────────────────────────────────────────────────────
async function validateMX(domain) {
    try {
        const records = await dns.resolveMx(domain);
        return records && records.length > 0;
    } catch { return false; }
}

function isValidEmailFormat(email) {
    if (!email || typeof email !== 'string') return false;    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}
const FREE_EMAIL_PROVIDERS = new Set([
    'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com',
    'protonmail.com','aol.com','mail.com','yandex.com','zoho.com',
    'mailinator.com','guerrillamail.com','tempmail.com','throwam.com',
]);
function isFreeEmailDomain(domain) { return FREE_EMAIL_PROVIDERS.has(domain.toLowerCase()); }

// ─── HALLUCINATION DETECTION ──────────────────────────────────────────────────
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
    return flags;
}

// ─── SCORING ───────────────────────────────────────────────────────────────────
function scoreDataCompleteness(extracted) {
    if (!extracted) return 0;
    let score = 0;
    if (extracted.mission    && extracted.mission    !== 'unknown') score += 15;
    if (extracted.hq         && extracted.hq         !== 'unknown') score += 10;
    if (extracted.size       && extracted.size        !== 'unknown') score += 10;
    if (extracted.model      && extracted.model       !== 'unknown') score += 10;
    if (extracted.recentNews)                                        score += 15;
    if (extracted.contactEmails?.length > 0)                         score += 15;    if (extracted.employees?.length > 0)                             score += 15;
    if (extracted.employees?.some(e => e.email))                     score += 10;
    return Math.min(score, 100);
}

// ─── 🧠 LEAD CONFIDENCE MODEL — UNIFIED TRUST SCORE ──────────────────────────
function calculateFinalTrustScore({ 
    emailValidation, 
    bestContact, 
    companyData, 
    pageScore, 
    userPersona 
}) {
    let score = 0;

    // 1. Source Quality (0-25 points)
    if (pageScore >= 90) score += 25; // Tier 1
    else if (pageScore >= 70) score += 15; // Tier 2
    else if (pageScore >= 40) score += 5;  // Tier 3
    else score += 0;

    // 2. Person Clarity (0-25 points)
    if (bestContact?.name) score += 15;
    if (bestContact?.role) score += 10;

    // 3. Email Confidence (0-25 points)
    if (emailValidation?.confidenceScore >= 80) score += 25;
    else if (emailValidation?.confidenceScore >= 50) score += 15;
    else if (emailValidation?.confidenceScore >= 15) score += 5; // LOWERED THRESHOLD
    else score += 0;

    // 4. Company Legitimacy (0-15 points)
    if (companyData?.size && companyData.size !== 'unknown') score += 5;
    if (companyData?.model && companyData.model !== 'unknown') score += 5;
    if (companyData?.mission) score += 5;

    // 5. Role Relevance (0-10 points)
    const rules = ICP_RULES[userPersona] || ICP_RULES['general'];
    const leadRole = (bestContact?.role || '').toLowerCase();
    const roleMatch = rules.target_roles.some(r => leadRole.includes(r));
    if (roleMatch) score += 10;

    return Math.min(100, score);
}

function getConfidenceLevel(score) {
    if (score >= 75) return 'HIGH';
    if (score >= 40) return 'MEDIUM';
    return 'LOW';
}
// ─── 🧍 REAL PERSON DISCOVERY ENGINE — CONTACT PICKER ────────────────────────
function _pickBestContact(employees, preferredContact, userPersona) {
    if (!employees || employees.length === 0) return null;
    const preferred = (preferredContact || '').toLowerCase().trim();
    // 1. Try to match preferred contact exactly
    if (preferred && preferred !== 'any') {
        const match = employees.find(e =>
            e.role && e.role.toLowerCase().includes(preferred)
        );
        if (match) return match;
    }

    // 2. Rank by Hierarchy Level (Lower number = Higher Seniority)
    const ranked = [...employees].sort((a, b) => {
        const aRoleKey = Object.keys(ROLE_HIERARCHY).find(key => 
            (a.role || '').toLowerCase().includes(key)
        );
        const bRoleKey = Object.keys(ROLE_HIERARCHY).find(key => 
            (b.role || '').toLowerCase().includes(key)
        );
        const aLevel = aRoleKey ? ROLE_HIERARCHY[aRoleKey].level : 99;
        const bLevel = bRoleKey ? ROLE_HIERARCHY[bRoleKey].level : 99;

        return aLevel - bLevel;
    });

    return ranked[0];
}

// ─── CONCURRENCY ──────────────────────────────────────────────────────────────
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

// ─── COMPANY NAME CLEANER ─────────────────────────────────────────────────────
function cleanCompanyName(rawTitle) {
    let name = rawTitle.split(/[|\-–]/)[0].trim();
    name = name.replace(/\b(Ltd|LLC|Inc|Limited|PLC)\s*$/gi, '').trim();
    if (name.length > 50) name = name.substring(0, 50).trim();
    const REJECT = ['home','about','contact','services','welcome','index'];
    if (!name || REJECT.includes(name.toLowerCase())) return null;
    return name;
}

// ─── MULTILINGUAL ENGINE ──────────────────────────────────────────────────────
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
    ];    for (const lang of langPatterns) {
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

// ─── OUTPUT QUANTITY CONTROL — _parseRequestedCount ──────────────────────────
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
        if (n >= 1 && n <= 100) return n;
    }
    const givePattern = /\b(?:give|find|get|show|fetch|pull|return|bring)\s+(?:me\s+)?(\d{1,3})\b/i;
    const giveMatch   = message.match(givePattern);
    if (giveMatch) {
        const n = parseInt(giveMatch[1], 10);
        if (n >= 1 && n <= 100) return n;
    }
    for (const [word, num] of Object.entries(wordToNum)) {
        const wordPattern = new RegExp(`\\b${word}\\s*(?:leads?|emails?|contacts?|companies|results?|prospects?)?\\b`, 'i');
        if (wordPattern.test(lower)) return num;
    }
    const topPattern = /\btop\s+(\d{1,3})\b/i;
    const topMatch   = message.match(topPattern);
    if (topMatch) {
        const n = parseInt(topMatch[1], 10);
        if (n >= 1 && n <= 100) return n;
    }

    return null;
}

// ─── OUTPUT QUANTITY CONTROL — _applyOutputQuantityRules ─────────────────────
function _applyOutputQuantityRules(leads, requestedMax) {
    if (!Array.isArray(leads)) return [];
    const totalVerified = leads.length;
    const cap           = Math.min(requestedMax, QUANTITY_RULE_DEFAULT_MAX);
    if (totalVerified === 0) return [];
    if (totalVerified === 1) return [leads[0]];

    const effectiveMin = QUANTITY_RULE_HARD_MIN;
    const sliceTo      = Math.max(effectiveMin, Math.min(cap, totalVerified));

    return leads.slice(0, sliceTo);
}

// ─── 🧠 TRUE INTENT ENGINE (ADVANCED LEVEL) ──────────────────────────────────
async function _analyzeDeepIntent(message, history, apiKey) {
    const recentHistory = (history || []).slice(-6)
        .map(h => `${h.role}: ${h.content}`)
        .join('\n');

    const prompt = `
You are a Senior Sales Strategist and Intent Analyst.
Analyze the user's message to determine their TRUE intent, persona, and readiness.

USER MESSAGE: "${message}"
RECENT HISTORY:
${recentHistory || 'None'}

Return ONLY valid JSON:
{
  "primary_intent": "lead_gen" | "email_draft" | "business_qa" | "chat",
  "user_persona": "saas_founder" | "agency_owner" | "recruiter" | "consultant" | "general",
  "buying_intent": "high" | "medium" | "low" | "none",
  "urgency": "high" | "medium" | "low",
  "outbound_readiness": boolean,  "icp_mismatch": boolean,
  "reasoning": "Brief explanation"}
Rules:
- "user_persona": Infer from context. E.g., if they mention "clients" and "projects", likely "agency_owner". If "users" and "product", likely "saas_founder".- "icp_mismatch": True if request is too vague.
`;
    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: prompt }],
            max_tokens:  250,
            temperature: 0.1,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:deep_intent');
        if (!res) return { primary_intent: INTENT.CHAT, user_persona: 'general', buying_intent: 'low', urgency: 'low', outbound_readiness: false, icp_mismatch: true };

        recordOpenAiUsage(
            res.data?.usage?.prompt_tokens     || 0,
            res.data?.usage?.completion_tokens || 0,
            'gpt-4o-mini'
        );
        const raw = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        return JSON.parse(raw);

    } catch (err) {
        console.warn('[Deep Intent Analysis Failed]:', err.message);
        return { primary_intent: INTENT.CHAT, user_persona: 'general', buying_intent: 'low', urgency: 'low', outbound_readiness: false, icp_mismatch: true };
    }
}

// ─── 🎯 ICP MATCHING ENGINE — VALIDATOR ──────────────────────────────────────
function _validateICP(lead, userPersona) {
    // Default to general rules if persona unknown
    const rules = ICP_RULES[userPersona] || ICP_RULES['general'];
    
    const leadRole = (lead.role || '').toLowerCase();
    const leadSize = (lead.companySize || '').toLowerCase();
    const leadModel = (lead.companyModel || '').toLowerCase();

    // 1. Role Check
    const roleMatch = rules.target_roles.some(r => leadRole.includes(r));
    if (!roleMatch) {
        return { valid: false, reason: `Role mismatch: Found '${lead.role}', but ICP for ${userPersona} requires ${rules.target_roles.join(', ')}` };
    }

    // 2. Size Check (Optional, but good for filtering)
    if (leadSize && leadSize !== 'unknown') {
        const sizeMatch = rules.company_sizes.some(s => leadSize.includes(s) || s.includes(leadSize));
        if (!sizeMatch) {
            // Soft fail for size, just log it, don't hard reject unless strict
            console.log(`⚠️ [ICP] Size mismatch: ${leadSize} not in preferred ${rules.company_sizes}`);
        }    }
    // 3. Business Model Check
    if (leadModel && leadModel !== 'unknown') {
        const modelMatch = rules.business_models.some(m => leadModel.includes(m) || m.includes(leadModel));
        if (!modelMatch) {
             return { valid: false, reason: `Model mismatch: Company is '${leadModel}', but ICP for ${userPersona} targets ${rules.business_models.join(', ')}` };
        }
    }

    return { valid: true, reason: 'Matches ICP criteria' };
}

// ─── CHAT HANDLER ─────────────────────────────────────────────────────────────
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

// ─── EMAIL DRAFT HANDLER ──────────────────────────────────────────────────────
async function _handleEmailDraft(message, history, userProfile, apiKey) {
    const senderName = userProfile?.senderName || 'Alex';
    const usp        = userProfile?.usp || null;

    const recentContext = (history || [])
        .slice(-6)
        .map(h => `${h.role}: ${h.content}`)
        .join('\n');

    const draftPrompt = `${buildBannedWordsInstruction()}

You are a world-class B2B email copywriter.
Write the email the user is asking for based on their instructions below.

SENDER NAME: ${senderName}
${usp ? `SENDER VALUE PROP: ${usp}` : ''}

RECENT CONTEXT:
${recentContext || 'None'}

USER INSTRUCTION: "${message}"

Rules:
- Write a complete, ready-to-send email
- Subject line must be specific and compelling (4-7 words)
- Never use banned adjectives or phrases listed above
- Never invent stats or percentages
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
            max_tokens:  600,            temperature: 0.7,
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

// ─── BUSINESS QA HANDLER ──────────────────────────────────────────────────────
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
            temperature: 0.5,        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:businessqa');

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

// ─── PATTERN INFERENCE ENGINE ────────────────────────────────────────────────
function _inferEmailPattern(knownEmployees, targetName, domain) {
    if (!knownEmployees || knownEmployees.length < 2) return null;
    
    const verified = knownEmployees.filter(e => e.email && e.email.includes(domain));
    if (verified.length < 2) return null;

    const patterns = [];
    const targetFirst = targetName.split(' ')[0].toLowerCase();
    const targetLast = targetName.split(' ').slice(-1)[0].toLowerCase();

    verified.forEach(emp => {
        const empFirst = emp.name.split(' ')[0].toLowerCase();
        const empLast = emp.name.split(' ').slice(-1)[0].toLowerCase();
        const empEmailLocal = emp.email.split('@')[0];

        if (empEmailLocal === `${empFirst}.${empLast}`) patterns.push('first.last');
        else if (empEmailLocal === `${empFirst[0]}${empLast}`) patterns.push('flast');
        else if (empEmailLocal === `${empFirst}${empLast[0]}`) patterns.push('firstl');
        else if (empEmailLocal === `${empFirst}_${empLast}`) patterns.push('first_last');
        else if (empEmailLocal === `${empFirst}`) patterns.push('first');
    });

    if (patterns.length === 0) return null;
    
    const mode = patterns.sort((a,b) =>
        patterns.filter(v => v===a).length - patterns.filter(v => v===b).length
    ).pop();
    let generatedLocal = '';
    switch(mode) {
        case 'first.last': generatedLocal = `${targetFirst}.${targetLast}`; break;
        case 'flast': generatedLocal = `${targetFirst[0]}${targetLast}`; break;
        case 'firstl': generatedLocal = `${targetFirst}${targetLast[0]}`; break;
        case 'first_last': generatedLocal = `${targetFirst}_${targetLast}`; break;        case 'first': generatedLocal = `${targetFirst}`; break;
        default: return null;
    }
    return `${generatedLocal}@${domain}`;
}

// ─── ⚡ SIGNAL DETECTION ENGINE — BUYING SIGNALS ─────────────────────────────
async function detectBuyingSignals(companyName, domain, tavilyKey) {
    if (getTavilyRemaining() <= 0) return [];

    // Search for recent news, hiring, funding, product launches
    const signalQuery = `"${companyName}" (funding OR raised OR investment OR hired OR hiring OR jobs OR launched OR new product OR expansion OR opened office) after:${CURRENT_YEAR}-01-01`;
    
    const signalResults = await searchWithTavily(signalQuery, tavilyKey, { maxResults: 5 });
    
    const signals = [];
    const signalKeywords = {
        funding: ['funding', 'raised', 'investment', 'series a', 'series b', 'seed round'],
        hiring: ['hiring', 'jobs', 'careers', 'open position', 'looking for'],
        product: ['launched', 'new product', 'release', 'update', 'feature'],
        expansion: ['expansion', 'opened office', 'new location', 'entered market']
    };

    for (const result of signalResults) {
        const text = `${result.title} ${result.snippet}`.toLowerCase();
        
        for (const [type, keywords] of Object.entries(signalKeywords)) {
            if (keywords.some(kw => text.includes(kw))) {
                signals.push({
                    type: type,
                    description: result.title,
                    date: result.date || 'Recent',
                    url: result.url
                });
                break; // Only one type per result to avoid duplicates
            }
        }
    }

    return signals;
}

// ─── COMPANY RESEARCH ─────────────────────────────────────────────────────────
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

        // 🧍 ENHANCED EXTRACTION PROMPT FOR REAL PERSON DISCOVERY
        const extractPrompt = `${REASONING_FILTER}
Extract company intelligence for "${companyName}" (domain: ${domain}).
CRITICAL: Focus on finding REAL HUMANS with specific roles.Return ONLY valid JSON:
{
  "mission": "one sentence company mission or null",
  "hq": "City, Country or null",
  "size": "1-10 | 11-50 | 51-200 | 200+ | unknown",
  "model": "B2B | B2C | SaaS | Services | E-commerce | Agency | unknown",
  "recentNews": "one sentence most recent news or null",
  "contactEmails": ["role-based emails literally found in text. Max 3. Empty array if none."],
  "employees": [    {
      "name": "Full Name ONLY if explicitly in snippets. null otherwise. NEVER invent.",
      "role": "Exact title: CEO | Founder | Co-Founder | Director | VP | Manager | Head of X",
      "email": "Email ONLY if literally in snippets. null otherwise. NEVER invent or construct.",
      "linkedIn": "LinkedIn URL if found. null otherwise.",
      "department": "Infer department from role (e.g., Sales, Engineering, Marketing) or null"
    }
  ]
}
SNIPPETS:
${allSnippets}`;

        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {            model:       'gpt-4o-mini',
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
                        emp.email = null;
                    }
                }
                emp.emailConfidence = emp.email ? 'confirmed-personal' : 'none';
                return emp;            });
        }
        const hallucinations = detectHallucinations(companyName, parsed);
        if (hallucinations.length > 0) {
            parsed._hallucinationFlags = hallucinations;
            if (Array.isArray(parsed.employees)) {
                parsed.employees = parsed.employees.filter(emp => {
                    const isSuspect = hallucinations.some(f => emp.name && f.includes(emp.name));
                    return !isSuspect;
                });
            }
        }

        parsed._regexEmails = regexFromAll.companyEmails;
        setCachedResearch(domain, parsed);        return parsed;

    } catch (err) {
        console.warn(`[Research Error] ${err.message}`);
        return null;
    }
}

// ─── ✍️ DEEP PERSONALIZATION ENGINE — CONTEXT GENERATOR ──────────────────────
function generateDeepPersonalizationContext(companyData, contactPerson, industry) {
    const { mission, recentNews, model, size } = companyData;
    const { role, name } = contactPerson || {};
    
    let context = `TARGET: ${companyData.name}\n`;
    context += `INDUSTRY: ${industry}\n`;
    context += `MODEL: ${model}\n`;
    context += `SIZE: ${size}\n`;
    
    if (mission) context += `MISSION: ${mission}\n`;
    if (recentNews) context += `RECENT NEWS: ${recentNews}\n`;
    if (role) {
        const roleInfo = Object.values(ROLE_HIERARCHY).find(r => role.toLowerCase().includes(r.title.toLowerCase()) || role.toLowerCase().includes(r.dept));
        if (roleInfo) {
            context += `ROLE FOCUS: ${roleInfo.focus}\n`;
        }
    }

    // Industry Pain Mapping
    const pains = {
        'SaaS': 'churn, feature adoption, customer support load, scaling infrastructure',
        'Agency': 'scope creep, client retention, resource allocation, billing delays',
        'E-commerce': 'cart abandonment, supply chain logistics, customer acquisition cost, returns',
        'Consulting': 'billable hours utilization, proposal win rate, knowledge management',
        'Manufacturing': 'supply chain disruptions, quality control, equipment downtime',
        'Healthcare': 'patient scheduling, compliance, staff burnout, insurance claims'    };
    
    const mappedPain = pains[industry] || 'operational efficiency, growth bottlenecks, market competition';
    context += `COMMON PAINS: ${mappedPain}\n`;

    return context;
}

// ─── 🧾 OUTREACH STRATEGY ENGINE — STRATEGY DATABASE ─────────────────────────
const OUTREACH_STRATEGIES = {
    'saas_founder_growth': {
        id: 'saas_founder_growth',
        persona: 'saas_founder',
        angle: 'Growth & Scaling',
        painPoints: ['Churn reduction', 'User acquisition cost', 'Feature adoption', 'Scaling infrastructure'],
        timing: { initial: 'Tue/Wed 10AM', followup1: 'Fri 2PM', followup2: 'Next Tue 10AM' },        variationTest: ['Subject: Quick question about [Company] growth', 'Subject: Idea for [Company] user retention']
    },
    'agency_owner_acquisition': {
        id: 'agency_owner_acquisition',
        persona: 'agency_owner',
        angle: 'Client Acquisition & Retention',
        painPoints: ['Scope creep', 'Client churn', 'Resource allocation', 'Billing delays'],
        timing: { initial: 'Mon/Thu 9AM', followup1: 'Wed 11AM', followup2: 'Next Mon 9AM' },
        variationTest: ['Subject: Helping [Company] land more clients', 'Subject: Streamlining [Company] client onboarding']
    },
    'recruiter_pipeline': {
        id: 'recruiter_pipeline',
        persona: 'recruiter',
        angle: 'Hiring Pipeline Efficiency',
        painPoints: ['Time-to-hire', 'Candidate quality', 'Interview scheduling', 'Offer acceptance rates'],
        timing: { initial: 'Tue/Thu 11AM', followup1: 'Fri 3PM', followup2: 'Next Wed 11AM' },
        variationTest: ['Subject: Speeding up [Company] hiring process', 'Subject: Better candidates for [Company] roles']
    },
    'consultant_expertise': {
        id: 'consultant_expertise',
        persona: 'consultant',
        angle: 'Expertise & Authority Building',
        painPoints: ['Billable hours', 'Proposal win rate', 'Knowledge management', 'Client education'],
        timing: { initial: 'Wed/Fri 10AM', followup1: 'Mon 2PM', followup2: 'Next Thu 10AM' },
        variationTest: ['Subject: Enhancing [Company] consulting impact', 'Subject: Idea for [Company] thought leadership']
    },
    'general_decision_maker': {
        id: 'general_decision_maker',
        persona: 'general',
        angle: 'Operational Efficiency',
        painPoints: ['Cost reduction', 'Process automation', 'Team productivity', 'Market competitiveness'],
        timing: { initial: 'Tue/Wed 10AM', followup1: 'Fri 2PM', followup2: 'Next Tue 10AM' },
        variationTest: ['Subject: Improving [Company] operations', 'Subject: Idea for [Company] efficiency']
    }};

// ─── 🧾 OUTREACH STRATEGY ENGINE — SELECTOR ──────────────────────────────────
function selectOutreachStrategy(userPersona, industry, role) {
    // Map persona to strategy key
    const strategyMap = {
        'saas_founder': 'saas_founder_growth',
        'agency_owner': 'agency_owner_acquisition',
        'recruiter': 'recruiter_pipeline',
        'consultant': 'consultant_expertise',
        'general': 'general_decision_maker'
    };

    const strategyKey = strategyMap[userPersona] || 'general_decision_maker';
    const strategy = OUTREACH_STRATEGIES[strategyKey];

    // Customize angle based on industry if possible    if (industry && strategy.painPoints) {
        // Add industry-specific pain points if available
        const industryPains = {
            'SaaS': ['Churn', 'CAC', 'Adoption'],
            'Agency': ['Scope Creep', 'Retention', 'Billing'],
            'E-commerce': ['Cart Abandonment', 'Logistics', 'Returns'],
            'Consulting': ['Utilization', 'Win Rate', 'Knowledge'],
            'Manufacturing': ['Supply Chain', 'Quality', 'Downtime'],
            'Healthcare': ['Scheduling', 'Compliance', 'Burnout']
        };
        if (industryPains[industry]) {
            strategy.customPains = industryPains[industry];
        }
    }

    return strategy;
}

// ─── EMAIL SEQUENCE WRITER ────────────────────────────────────────────────────
async function generateEmailsForLead(companyData, contactPerson, domain, userProfile, openAiKey, detectedLanguage, outreachStrategy, buyingSignals) {
    try {
        const companyName   = companyData.name;
        const mission       = companyData.mission   || null;
        const news          = companyData.recentNews || null;
        const industry      = companyData.industry  || 'their industry';
        const businessModel = companyData.model     || 'unknown';
        const senderName    = userProfile?.senderName || 'Alex';
        const usp           = userProfile?.usp || null;
        const contactName   = contactPerson?.name || null;
        const contactRole   = contactPerson?.role || null;
        const firstNameOnly = contactName ? contactName.split(' ')[0] : null;
        const uspToUse = (usp && usp.trim().length > 10) ? usp
            : 'We build done-for-you outreach pipelines that replace manual prospecting — so business owners spend time closing, not searching.';
        // Generate Deep Personalization Context
        const personalizationContext = generateDeepPersonalizationContext(companyData, contactPerson, industry);

        // Integrate Outreach Strategy
        const strategyContext = `
OUTREACH STRATEGY:
- ANGLE: ${outreachStrategy.angle}
- KEY PAINS: ${outreachStrategy.painPoints.join(', ')}
- CUSTOM PAINS: ${outreachStrategy.customPains ? outreachStrategy.customPains.join(', ') : 'N/A'}
- TIMING: Initial on ${outreachStrategy.timing.initial}, Follow-up 1 on ${outreachStrategy.timing.followup1}, Follow-up 2 on ${outreachStrategy.timing.followup2}
- VARIATION TEST: ${outreachStrategy.variationTest.join(' | ')}
`;

        // Integrate Buying Signals
        let signalContext = '';
        if (buyingSignals && buyingSignals.length > 0) {
            const topSignal = buyingSignals[0];            signalContext = `
BUYING SIGNAL DETECTED:
- TYPE: ${topSignal.type.toUpperCase()}
- DESCRIPTION: ${topSignal.description}
- DATE: ${topSignal.date}
- URL: ${topSignal.url}

INSTRUCTION: Use this signal as the PRIMARY HOOK in Email 1. Connect our value prop to this specific event.
`;
        }

        const multilingualBlock = _buildMultilingualEmailBlock(detectedLanguage);

        const writePrompt = `${buildBannedWordsInstruction()}${multilingualBlock}

You are a world-class B2B cold email copywriter who specialises in writing for specific industries.
You NEVER write generic emails. Every word is tailored to the recipient's exact business type.

PERSONALIZATION CONTEXT:
${personalizationContext}

${strategyContext}

${signalContext}

SENDER: ${senderName}
VALUE PROP: ${uspToUse}

─── EMAIL 1 — INITIAL OUTREACH ───
Subject: 4-6 words. Specific to ${companyName} or ${industry}. NOT generic. Use one of the variation test subjects if applicable.
Salutation: "${firstNameOnly || 'Hi'}" — alone on its own line. NEVER skip. NEVER "Dear".

Para 1 — Hook:
${buyingSignals && buyingSignals.length > 0 ? 
  `Reference the BUYING SIGNAL specifically: "${buyingSignals[0].description}". Show you are aware of their recent activity. 1-2 sentences.` :
  news    ? `Reference this news specifically: "${news}". Show you read it. 1-2 sentences.` :
  mission ? `Reference this mission: "${mission}". Connect it to something real. 1-2 sentences.` :
            `Reference a real, specific challenge related to ${outreachStrategy.angle} that ${industry} ${businessModel} businesses face daily.
             Do NOT say "I noticed you are growing" or anything vague.
             Write something a ${contactRole || 'business owner'} in ${industry} would read and think "how did they know?"
             1-2 sentences only.`}

Para 2 — Value:
Connect "${uspToUse}" to how it solves the specific problem you referenced, focusing on ${outreachStrategy.angle}.
Describe the mechanism — what actually happens, step by step. One concrete sentence.
NO invented stats. NO percentages. NO vague promises.

Para 3 — CTA:
One soft ask. "Worth 15 minutes this week?" — one sentence only.
Sign-off: Best, ${senderName}
─── EMAIL 2 — FOLLOW-UP (3 days later) ───
Subject: "Re: " + Email 1 subject exactly.
Salutation: "${firstNameOnly || 'Hi'}" — alone on its own line.
Para 1: Add ONE new observation about ${companyName} OR a specific trend in ${industry} related to ${outreachStrategy.angle} that is relevant right now. NOT a repeat of Email 1. 1-2 sentences.
Para 2: Re-state the ask in a fresh way, emphasizing the benefit of ${outreachStrategy.angle}. Max 2 sentences.
Sign-off: Best, ${senderName}

─── EMAIL 3 — BREAK-UP (7 days later) ───
Subject: "Closing my file on ${companyName}"
Salutation: "${firstNameOnly || 'Hi'}" — alone on its own line.
3 sentences total. Acknowledge timing. No sell. Leave door open gracefully. Mention ${outreachStrategy.angle} briefly.
Sign-off: Best, ${senderName}

HARD RULES:
- Every email MUST open with the salutation line before any other text.
- NEVER invent stats, percentages, or results.
- NEVER use banned words.
- NEVER write a generic email that could work for any industry — it must only work for ${industry}.
- If you write something a plumber and a SaaS founder could both receive unchanged, rewrite it.
- Use the PERSONALIZATION CONTEXT, OUTREACH STRATEGY, and BUYING SIGNALS to inform every sentence.

Return ONLY valid JSON:
{
  "initial":  { "subject": "string", "body": "string" },
  "followup": { "subject": "string", "body": "string" },
  "breakup":  { "subject": "string", "body": "string" }
}`;

        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o',
            messages:    [{ role: 'user', content: writePrompt }],
            max_tokens:  1000,
            temperature: 0.7,
        }, { headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:emailgen');
        if (!res) throw new Error('Email generation returned null after retries');

        recordOpenAiUsage(
            res.data?.usage?.prompt_tokens     || 0,
            res.data?.usage?.completion_tokens || 0,
            'gpt-4o'
        );

        const raw = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        return JSON.parse(raw);
    } catch (err) {
        console.warn(`[Email Gen Error] ${err.message}`);

        const name     = contactPerson?.name?.split(' ')[0] || 'Hi';
        const industry = companyData.industry || 'your sector';        const company  = companyData.name     || 'your business';
        const sender   = userProfile?.senderName || 'Alex';
        const usp      = userProfile?.usp || 'We build outreach pipelines that cut manual prospecting time.';
        return {
            initial: {
                subject: `One thought on ${company}`,
                body:    `${name},\n\nRunning a ${industry} business means most of your day goes to work that doesn't directly close deals.\n\n${usp}\n\nWorth 15 minutes this week?\n\nBest,\n${sender}`,
            },
            followup: {
                subject: `Re: One thought on ${company}`,
                body:    `${name},\n\nFloating this back up — most ${industry} operators I speak to say the same thing: there aren't enough hours to prospect and deliver at the same time.\n\nStill worth a quick chat?\n\nBest,\n${sender}`,
            },
            breakup: {
                subject: `Closing my file on ${company}`,
                body:    `${name},\n\nAssuming timing isn't right for ${company} right now — I'll stop following up. Reach out whenever it makes sense.\n\nBest,\n${sender}`,
            },
        };
    }
}

// ─── SINGLE COMPANY PIPELINE ──────────────────────────────────────────────────
async function processOneCompany(result, intent, userPersona, tavilyKey, apiKey, userProfile, onProgress, detectedLanguage) {
    try {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
        if (!domain) return null;
        if (isFreeEmailDomain(domain)) return null;

        // 🌐 SOURCE QUALITY GATE
        const pageScore = _scorePageBusinessRelevance(result);
        
        // Hard Reject if Source is Blocked or Score is too low
        if (pageScore <= 0) {
            console.log(`🚫 [SOURCE BLOCKED] Rejected due to low quality source: ${result.url}`);
            return null;
        }
        if (pageScore < 30) {
            console.log(`🔴 [PAGE GATE] Rejected low-value page (score:${pageScore}): ${result.url}`);
            return null;
        }

        const companyName = cleanCompanyName(result.title);
        if (!companyName) return null;
        const companyKey = companyName.toLowerCase().replace(/\s+/g, '');
        if (globalSeenCompanyNames.has(companyKey)) {
            return null;
        }
        globalSeenCompanyNames.add(companyKey);

        onProgress?.(`📋 Researching ${companyName}...`);        const [companyData, mxValid] = await Promise.all([
            researchCompanyForLead(companyName, domain, tavilyKey, apiKey, onProgress),
            validateMX(domain),
        ]);
        if (!mxValid) {
            return null;
        }
        const dataScore = scoreDataCompleteness(companyData);
        if (dataScore < 10) {
            console.log(`🟡 [WEAK COMPANY] Rejected due to low data completeness (score:${dataScore}): ${companyName}`);
            return null;
        }

        const employees   = companyData?.employees || [];
        
        // 🧍 USE NEW REAL PERSON DISCOVERY ENGINE
        const bestContact = _pickBestContact(employees, intent.preferredContact, userPersona);

        // FIX: If no clear role/person found, try to infer or use default for small startups
        if (!bestContact || !bestContact.name) {
            console.log(`🟡 [UNCLEAR ROLE] No clear contact found for ${companyName}. Attempting fallback.`);
            // If we have a company name but no person, we can't send a personalized email easily.
            // However, if we have a name but no role, we can assume Founder/CEO for small companies.
            if (bestContact && bestContact.name && !bestContact.role) {
                 bestContact.role = 'Founder'; // Default assumption for early-stage
                 console.log(`ℹ️ [ASSUMPTION] Assuming role 'Founder' for ${bestContact.name}`);
            } else {
                return null;
            }
        }

        // ── COLLECT ALL CANDIDATE EMAILS ────────────────────────────────────
        const candidateEmails = [
            ...(companyData?._regexEmails || []),
            ...(companyData?.contactEmails || []),
            ...(employees
                .filter(e => e.email && isValidEmailFormat(e.email))
                .map(e => e.email)
            ),
        ].filter(isValidEmailFormat);
        // ── NEW: PATTERN INFERENCE IF NO EMAILS FOUND ───────────────────────
        let inferredEmail = null;
        if (candidateEmails.length === 0 && bestContact && bestContact.name) {
            inferredEmail = _inferEmailPattern(employees, bestContact.name, domain);
            if (inferredEmail) {
                candidateEmails.push(inferredEmail);
                console.log(`🧠 [PATTERN INFERENCE] Generated: ${inferredEmail} for ${bestContact.name}`);
            }
        }
        // ── TIER 3: EMAIL HUNT if still no candidates ───────────────────────
        if (candidateEmails.length === 0 && getTavilyRemaining() > 0) {
            onProgress?.(`🎯 Hunting real email for ${companyName}...`);
            const huntResult = await huntRealEmails(companyName, domain, tavilyKey);
            if (huntResult.companyEmails.length > 0) {
                candidateEmails.push(...huntResult.companyEmails.filter(isValidEmailFormat));
            }
        }

        // FALLBACK: If still no emails, use generic info@ or hello@ if domain is valid
        if (candidateEmails.length === 0) {
            const genericEmails = [`info@${domain}`, `hello@${domain}`, `contact@${domain}`];
            for (const genEmail of genericEmails) {
                if (isValidEmailFormat(genEmail)) {
                    candidateEmails.push(genEmail);
                    console.log(`ℹ️ [FALLBACK] Added generic email: ${genEmail}`);
                    break; // Just add one generic email as fallback
                }
            }
        }

        if (candidateEmails.length === 0) {
            console.log(`🟡 [NO EMAIL] Rejected due to no email found: ${companyName}`);
            return null;
        }
        // ── FULL VALIDATION PIPELINE WITH SOURCE TIER ────────────────────────
        onProgress?.(`🔬 Validating emails for ${companyName}...`);
        
        // Determine source tier for validation scoring
        const sourceInfo = _classifySourceQuality(result.url, result.title, result.snippet);
        const sourceTier = sourceInfo.tier;

        const validatedEmails = await rankAndFilterEmails(candidateEmails, domain, sourceTier);

        if (validatedEmails.length === 0) {
            console.log(`🟡 [INVALID EMAIL] Rejected due to no valid emails: ${companyName}`);
            return null;
        }

        const topEmail        = validatedEmails[0];
        const resolvedEmail   = topEmail.email;        
        let emailConfidenceType = classifyEmail(resolvedEmail, domain).type;
        if (topEmail.verdict === 'risky-catchall') emailConfidenceType = 'risky-catchall';
        else if (inferredEmail && resolvedEmail === inferredEmail) {
             emailConfidenceType = 'guessed-pattern';
        }

        // RELAXED: Allow generic emails from low-tier sources if no other option exists
        // Previously rejected generic emails from Tier 3/Unknown. Now we allow them if they are the only option.
        if (emailConfidenceType === 'confirmed-generic' && (sourceTier === 'TIER_3' || sourceTier === 'UNKNOWN')) {            console.log(`ℹ️ [GENERIC EMAIL] Accepted generic email from low-tier source as fallback: ${companyName}`);
            // Do not return null here anymore
        }

        const emailLabel      = topEmail.reason;
        const allEmailOptions = validatedEmails.map(v => v.email);
        onProgress?.(`✍️ Writing emails for ${companyName}...`);

        // 🧾 SELECT OUTREACH STRATEGY
        const outreachStrategy = selectOutreachStrategy(userPersona, intent.industry, bestContact.role);

        // ⚡ DETECT BUYING SIGNALS
        const buyingSignals = await detectBuyingSignals(companyName, domain, tavilyKey);

        const emailSequence = await generateEmailsForLead(
            {
                name:        companyName,
                mission:     companyData?.mission,
                recentNews:  companyData?.recentNews,
                industry:    intent.industry,
                model:       companyData?.model,
            },
            bestContact,
            domain,
            userProfile,
            apiKey,
            detectedLanguage,
            outreachStrategy,
            buyingSignals
        );

        const hallucinationCount = (companyData?._hallucinationFlags || []).length;

        // 🧠 CALCULATE FINAL TRUST SCORE
        const trustScore = calculateFinalTrustScore({
            emailValidation: topEmail,
            bestContact: bestContact,
            companyData: companyData,
            pageScore: pageScore,
            userPersona: userPersona
        });
        const confidenceLevel = getConfidenceLevel(trustScore);

        // RELAXED: Accept MEDIUM and LOW confidence leads to ensure output
        // Previously rejected LOW. Now we accept MEDIUM and LOW.
        if (confidenceLevel === 'LOW') {
            console.log(`ℹ️ [LOW CONFIDENCE] Accepted low confidence lead (score:${trustScore}) to ensure output: ${companyName}`);
            // Do not return null here anymore
        }
        const lead = {
            name:               bestContact?.name || companyName,
            company:            companyName,
            domain,
            email:              resolvedEmail,
            emailConfidence:    emailConfidenceType,
            emailLabel,
            emailValidation: {
                confidenceScore: topEmail.confidenceScore,
                verdict:         topEmail.verdict,
                smtpResult:      topEmail.smtpResult,
                reason:          topEmail.reason,
            },
            allEmailOptions,
            role:               bestContact?.role || (companyData?.model === 'B2B' ? 'Decision Maker' : 'Owner'),
            linkedIn:           bestContact?.linkedIn  || null,
            companySize:        companyData?.size      || 'unknown',
            companyModel:       companyData?.model     || 'unknown',
            industry:           intent.industry        || 'unknown',
            hq:                 companyData?.hq        || null,
            recentNews:         companyData?.recentNews || null,
            trustScore,         // New Unified Score
            confidenceLevel,    // New Unified Level
            pageScore,
            mxValid,
            dataScore,
            hallucinationFlags: companyData?._hallucinationFlags || [],
            emailLanguage:      detectedLanguage.code,
            outreachStrategy:   outreachStrategy.id, // Store strategy ID
            buyingSignals:      buyingSignals, // Store detected signals
            messages: [
                { type: 'initial',  subject: emailSequence.initial.subject,  body: emailSequence.initial.body  },
                { type: 'followup', subject: emailSequence.followup.subject, body: emailSequence.followup.body },
                { type: 'breakup',  subject: emailSequence.breakup.subject,  body: emailSequence.breakup.body  },
            ],
        };
        // 🎯 ICP VALIDATION GATE
        const icpCheck = _validateICP(lead, userPersona);
        if (!icpCheck.valid) {
            console.log(`🚫 [ICP REJECTED] ${companyName}: ${icpCheck.reason}`);
            return null; // Hard reject if ICP doesn't match
        }

        return lead;
    } catch (err) {
        console.warn(`[processOneCompany Error] ${err.message}`);
        return null;
    }
}
// ─── LEAD GEN PIPELINE ────────────────────────────────────────────────────────
async function _runLeadGenPipeline(safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, tavilyKey) {

    globalSeenCompanyNames.clear();

    const requestedCount = _parseRequestedCount(safeMessage) ?? QUANTITY_RULE_DEFAULT_MAX;
    
    // 1. DEEP INTENT ANALYSIS (Includes Persona Detection)
    const deepIntent = await _analyzeDeepIntent(safeMessage, history, apiKey);
    const userPersona = deepIntent.user_persona || 'general';
    if (deepIntent.icp_mismatch) {
        return {
            reply: 'Your request is a bit too broad. To find the right leads, could you specify the industry or company size you are targeting?',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'Request too broad.' }],
        };
    }

    if (deepIntent.primary_intent !== INTENT.LEAD_GEN) {
        if (deepIntent.primary_intent === INTENT.EMAIL_DRAFT) return await _handleEmailDraft(safeMessage, history, userProfile, apiKey);
        if (deepIntent.primary_intent === INTENT.BUSINESS_QA) return await _handleBusinessQA(safeMessage, history, userProfile, apiKey);
        return await _handleChat(safeMessage, history, userProfile, apiKey);
    }

    // Extract standard parameters for search
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
            recordOpenAiUsage(
                intentRes.data?.usage?.prompt_tokens     || 0,
                intentRes.data?.usage?.completion_tokens || 0,
                'gpt-4o-mini'
            );
            const raw    = intentRes.data.choices[0].message.content.replace(/```json|```/g, '');
            const parsed = JSON.parse(raw);            intent = { ...intent, ...parsed };
        }
    } catch (e) { console.warn('[Intent Parse Failed]:', e.message); }

    onProgress?.(`🔍 Searching for ${intent.industry} companies${intent.location ? ' in ' + intent.location : ''}...`);

    const searchPoolSize = Math.min(
        Math.max(requestedCount + 5, MAX_LEADS_RETURNED + 3),
        15
    );
    const queries = _buildEntityFirstQueries(intent, searchPoolSize);
    const rawResults = await searchWithTavily(queries.primary, tavilyKey, { maxResults: searchPoolSize });
    let fallbackResults = [];
    if (rawResults.length < MIN_POOL_SIZE && getTavilyRemaining() > 0) {
        const fallbackQuery = queries.entityFocus;
        try {
            fallbackResults = await searchWithTavily(fallbackQuery, tavilyKey, { maxResults: searchPoolSize });
        } catch (fbErr) { console.warn(`⚠️ [FALLBACK QUERY] Failed: ${fbErr.message}`); }
    }

    const seenUrls  = new Set(rawResults.map(r => r.url));
    const mergedRaw = [
        ...rawResults,
        ...fallbackResults.filter(r => !seenUrls.has(r.url)),
    ];

    if (mergedRaw.length === 0) {
        return {
            reply:          'No companies found. Try narrowing the industry or adding a location.',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'No leads found.' }],
        };
    }

    // 🌐 APPLY SOURCE QUALITY FILTERING EARLY
    const cleanResults = [];
    for (const result of mergedRaw) {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
        if (!domain) continue;
        if (globalSeenDomains.has(domain)) continue;        
        // Check Source Quality
        const sourceInfo = _classifySourceQuality(result.url, result.title, result.snippet);
        if (sourceInfo.tier === 'HARD_BLOCK') {
            console.log(`🚫 [SOURCE BLOCKED] Skipping ${result.url} (${sourceInfo.reason})`);
            continue;
        }

        globalSeenDomains.add(domain);
        cleanResults.push({ ...result, _domain: domain, _sourceTier: sourceInfo.tier });
        if (cleanResults.length >= requestedCount + 5) break;    }

    if (cleanResults.length === 0) {
        return {
            reply:          'Found results but all were low-quality or blocked sources. Try a more specific industry or location.',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'No leads after filtering.' }],
        };
    }
    onProgress?.(`⚙️ Researching ${cleanResults.length} companies...`);
    const tasks = cleanResults.map(result => () =>
        processOneCompany(result, intent, userPersona, tavilyKey, apiKey, userProfile, onProgress, detectedLanguage)
    );
    const settled = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);
    const allVerifiedLeads = settled
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value)
        .sort((a, b) => b.trustScore - a.trustScore); // Sort by new Trust Score

    const leadsToReturn = _applyOutputQuantityRules(allVerifiedLeads, requestedCount);

    const _meta = {
        tavilyUsed:         tavilyQuota.used,
        tavilyRemaining:    getTavilyRemaining(),
        openAiCalls:        openAiTracker.totalCallsThisSession,
        openAiInputTokens:  openAiTracker.totalInputTokensThisSession,
        openAiOutputTokens: openAiTracker.totalOutputTokensThisSession,
        estimatedCostUSD:   parseFloat(costTracker.estimatedUSDThisSession.toFixed(4)),
        totalVerified:      allVerifiedLeads.length,
        totalReturned:      leadsToReturn.length,
        requestedCount,
        buyingIntent:       deepIntent.buying_intent,
        urgency:            deepIntent.urgency,
        userPersona:        userPersona,
    };
    if (leadsToReturn.length === 0) {
        return {
            reply:          'Found companies but no emails passed verification or ICP matching. Try a different industry or location.',
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
    };}

// ─── MAIN: generateFreeResponse ────────────────────────────────────────────────
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
                reply:          'How can I help you today? I can find leads, draft emails, answer business questions, or just chat.',
                updatedHistory: history,
            };
        }

        const detectedLanguage = _detectLanguage(safeMessage);

        // Deep Intent Analysis determines the path
        const deepIntent = await _analyzeDeepIntent(safeMessage, history, apiKey);
        
        if (deepIntent.primary_intent === INTENT.LEAD_GEN) {
            return await _runLeadGenPipeline(
                safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, tavilyKey
            );
        }

        if (deepIntent.primary_intent === INTENT.EMAIL_DRAFT) {
            const reply = await _handleEmailDraft(safeMessage, history, userProfile, apiKey);
            return {
                reply,
                updatedHistory: [
                    ...history,
                    { role: 'user',      content: safeMessage },
                    { role: 'assistant', content: reply },
                ],
            };
        }

        if (deepIntent.primary_intent === INTENT.BUSINESS_QA) {
            const reply = await _handleBusinessQA(safeMessage, history, userProfile, apiKey);
            return {
                reply,
                updatedHistory: [
                    ...history,                    { role: 'user',      content: safeMessage },
                    { role: 'assistant', content: reply },
                ],
            };
        }

        // INTENT.CHAT (default)
        const reply = await _handleChat(safeMessage, history, userProfile, apiKey);
        return {
            reply,
            updatedHistory: [
                ...history,
                { role: 'user',      content: safeMessage },
                { role: 'assistant', content: reply },
            ],
        };

    } catch (error) {
        console.error('❌ [AI ENGINE] Fatal error:', error.message);
        return { reply: 'An error occurred. Please try again.', updatedHistory: history };
    }
}

module.exports = { generateFreeResponse };
