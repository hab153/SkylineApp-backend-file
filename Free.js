'use strict';

const axios = require('axios');
const dns   = require('dns').promises;
const net   = require('net');

// ─── CONFIG & TRUST THRESHOLDS ───────────────────────────────────────────────
const MAX_LEADS_RETURNED = 5;
const TAVILY_LIMIT       = 1000;
const CONCURRENCY_LIMIT  = 2;
const CACHE_TTL_MS       = 60 * 60 * 1000;
const CURRENT_YEAR       = new Date().getFullYear();
const MAX_MESSAGE_LENGTH = 800;

// 🔥 TRUST PIPELINE: Aggressive Rejection Threshold
// Leads below this score are discarded to maintain premium quality.
const EMAIL_CONFIDENCE_THRESHOLD = 50; 

// ─── ROLE PRIORITY MAP (Stage 4: Decision Maker Engine) ──────────────────────
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

// ─── STAGE 2: SOURCE SELECTION ENGINE (Hard Blocklists) ──────────────────────
// These patterns result in IMMEDIATE REJECTION. No AI call. No validation.
const HARD_REJECT_URL_PATTERNS = [
    /\/blog\//i,
    /\/article\//i,
    /\/news\//i,
    /\/tutorial\//i,
    /\/how-to\//i,
    /\/guide\//i,
    /\/tips\//i,
    /\/resources\//i,
    /\/learn\//i,
    /\/wiki\//i,    /\/forum\//i,
    /\/category\//i,
    /\/tag\//i,
    /\/top-10\//i,
    /\/best-of\//i,
    /\/email-list\//i,
    /\/lead-list\//i,
    /\/buy-leads\//i,
    /\/directory\//i,
    /\.pdf$/i,
    /reddit\.com/i,
    /medium\.com/i,
    /quora\.com/i,
    /wikipedia\.org/i,
    /stackoverflow\.com/i,
    /hubspot\.com\/blog/i,
    /moz\.com\/blog/i,
    /semrush\.com\/blog/i,
];

const HIGH_VALUE_URL_PATTERNS = [
    /\/about/i,
    /\/team/i,
    /\/contact/i,
    /\/company/i,
    /\/people/i,
    /\/leadership/i,
    /\/founders/i,
    /\/our-story/i,
];

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

// ─── BANNED WORDS ─────────────────────────────────────────────────────────────
const BANNED_ADJECTIVES = [    'transformative','seamless','mission-critical','synergy','game-changer',
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

// ─── PERSISTENT DEDUP & CACHE ──────────────────────────────────────────────────
const globalSeenDomains = new Set();
const globalSeenCompanyNames = new Set();
const researchCache = new Map();

function getCachedResearch(domain) {
    const hit = researchCache.get(domain);
    if (!hit) return null;
    if (Date.now() - hit.timestamp > CACHE_TTL_MS) { researchCache.delete(domain); return null; }
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

// ─── STAGE 2: SOURCE QUALITY SCORER ──────────────────────────────────────────
function _scorePageBusinessRelevance(result) {
    const url     = (result.url     || '').toLowerCase();
    const title   = (result.title   || '').toLowerCase();
    const snippet = (result.snippet || '').toLowerCase();
    // Hard Reject Check
    for (const pattern of HARD_REJECT_URL_PATTERNS) {
        if (pattern.test(url)) return 0; // Immediate rejection
    }

    let score = 50; // neutral baseline

    // Bonus: high-value URL structure signals
    for (const pattern of HIGH_VALUE_URL_PATTERNS) {
        if (pattern.test(url)) { score += 20; break; }
    }

    // Title signals
    if (/agency|studio|solutions|services|group|partners|consulting|technologies|software|platform|media|marketing|creative|digital|design|development|co\.|inc|ltd|llc|corp/i.test(title)) {
        score += 15;
    }
    
    // Penalise generic informational content
    if (/how to|what is|tutorial|step.by.step|learn how|read more|subscribe|newsletter|download free/i.test(snippet)) {
        score -= 20;
    }

    return Math.max(0, Math.min(100, score));
}

// ─── STAGE 1: INTENT ENGINE ──────────────────────────────────────────────────
async function _classifyAndExtractIntent(message, history, apiKey) {
    const recentHistory = (history || []).slice(-6).map(h => `${h.role}: ${h.content}`).join('\n');

    const classifyPrompt = `You are an intent classifier and parameter extractor.
Classify the user message into EXACTLY ONE intent:
1. "lead_gen"    — user wants to find leads, prospect companies, get contacts.
2. "email_draft" — user wants to write/draft an email.
3. "business_qa" — user wants business advice/strategy.
4. "chat"        — greetings, small talk.

If intent is "lead_gen", extract parameters. If intent is unclear or vague, set "needsClarification" to true.

Return ONLY valid JSON:
{
  "intent": "lead_gen" | "email_draft" | "business_qa" | "chat",
  "needsClarification": boolean,
  "clarificationQuestion": "string or null",
  "params": {
    "industry": "string or null",
    "location": "string or null",
    "decisionMaker": ["Founder", "CEO"],
    "painSignals": ["customer acquisition"],
    "target": "string"  }
}

RECENT CONVERSATION:
${recentHistory || 'None'}

USER MESSAGE: "${message}"`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: classifyPrompt }],
            max_tokens:  200,
            temperature: 0.0,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:intent');

        if (!res) return { intent: INTENT.CHAT, params: {} };

        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o-mini');

        const raw    = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        const parsed = JSON.parse(raw);

        return {
            intent: parsed.intent === 'lead_gen' ? INTENT.LEAD_GEN : 
                    parsed.intent === 'email_draft' ? INTENT.EMAIL_DRAFT :
                    parsed.intent === 'business_qa' ? INTENT.BUSINESS_QA : INTENT.CHAT,
            needsClarification: parsed.needsClarification,
            clarificationQuestion: parsed.clarificationQuestion,
            params: parsed.params || {}
        };

    } catch (err) {
        console.warn('[Intent Classify Failed]:', err.message);
        return { intent: INTENT.CHAT, params: {} };
    }
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
            include_raw_content: false,        }, { headers: { 'Content-Type': 'application/json' }, timeout: 12000 });

        recordTavilyUsage();
        return (response.data?.results || []).map(r => ({
            title:   r.title   || '',
            url:     r.url     || '',
            snippet: r.content || '',
            date:    r.published_date || null,
        }));
    }, `Tavily:${query.slice(0, 40)}`) ?? [];
}

// ─── STAGE 5: EMAIL DISCOVERY & VALIDATION ───────────────────────────────────
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
    const isGeneric = GENERIC_PREFIXES.some(p => localPart === p || localPart.startsWith(p + '.'));

    if (!domainMatches) return { type: 'unrelated-domain', label: 'Wrong domain', trustLevel: 0 };
    if (isGeneric)      return { type: 'confirmed-generic', label: 'Contact Email', trustLevel: 60 };
    if (localPart.includes('.') || /[a-z]{2,}[a-z]{2,}/.test(localPart)) {
        return          { type: 'confirmed-personal', label: 'Personal Email', trustLevel: 95 };
    }
    return              { type: 'confirmed-other',   label: 'Verified Email', trustLevel: 75 };
}

const DISPOSABLE_DOMAINS = new Set([
    'mailinator.com','guerrillamail.com','tempmail.com','throwam.com',
    'yopmail.com','trashmail.com','fakeinbox.com','sharklasers.com',
    'guerrillamailblock.com','grr.la','guerrillamail.info','spam4.me',    'dispostable.com','maildrop.cc','discard.email','spamgourmet.com',
    'spamgourmet.net','spamgourmet.org','wegwerfmail.de','wegwerfmail.net',
    'wegwerfmail.org','10minutemail.com','10minutemail.net','10minutemail.org',
    'tempr.email','mailnull.com','spamfree24.org','spamfree24.de',
    'spamfree24.eu','spamfree24.info','spamfree24.net','spamfree.eu',
    'spamoff.de',
]);

function isDisposableDomain(domain) { return DISPOSABLE_DOMAINS.has(domain.toLowerCase()); }

const FREE_EMAIL_PROVIDERS = new Set([
    'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com',
    'protonmail.com','aol.com','mail.com','yandex.com','zoho.com',
]);
function isFreeEmailDomain(domain) { return FREE_EMAIL_PROVIDERS.has(domain.toLowerCase()); }

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

            socket.on('error', () => { clearTimeout(timeout); resolve('unknown'); });
            socket.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\r\n');
                buffer = lines.pop();                for (const line of lines) {
                    if (!line) continue;
                    const code = parseInt(line.slice(0, 3), 10);
                    if (stage === 0 && code === 220) { socket.write(`EHLO mailcheck.local\r\n`); stage = 1; }
                    else if (stage === 1 && (code === 250 || code === 220)) { socket.write(`MAIL FROM:<probe@mailcheck.local>\r\n`); stage = 2; }
                    else if (stage === 2 && code === 250) { socket.write(`RCPT TO:<${email}>\r\n`); stage = 3; }
                    else if (stage === 3) {
                        clearTimeout(timeout);
                        socket.write('QUIT\r\n');
                        socket.destroy();
                        if (code === 250 || code === 251) resolve('valid');
                        else if (code >= 500) resolve('invalid');
                        else resolve('unknown');
                    }
                }
            });
            socket.on('close', () => { clearTimeout(timeout); if (stage < 3) resolve('unknown'); });
        });
    } catch (err) {
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

    if (!isValidEmailFormat(normalisedEmail)) { result.reason = 'Invalid syntax'; return result; }
    result.syntaxValid = true;

    const emailDomain = normalisedEmail.split('@')[1]?.toLowerCase();
    if (!emailDomain) { result.reason = 'No domain'; return result; }
    if (isDisposableDomain(emailDomain)) { result.disposable = true; result.reason = 'Disposable domain'; return result; }
    if (isFreeEmailDomain(emailDomain)) { result.reason = 'Free email provider'; return result; }
    if (REPUTATION_BLOCKED_DOMAINS.has(emailDomain)) { result.reason = 'Blocked domain'; return result; }

    const domainRoot   = domain.split('.')[0].toLowerCase();
    result.domainMatch = emailDomain === domain || emailDomain.includes(domainRoot);
    if (!result.domainMatch) { result.reason = 'Domain mismatch'; return result; }
    result.mxValid = await validateMX(emailDomain);
    if (!result.mxValid) { result.reason = 'No MX records'; return result; }

    const classification = classifyEmail(normalisedEmail, domain);
    let smtpResult = 'unknown';
    try { smtpResult = await smtpProbeEmail(normalisedEmail, emailDomain); } catch (e) {}
    result.smtpResult = smtpResult;

    if (smtpResult === 'invalid') {
        result.reason = 'Mailbox does not exist';
        return result;
    }

    if (smtpResult === 'valid') {
        result.confidenceScore = classification.type === 'confirmed-personal' ? 95 : 78;
        result.verdict         = 'verified';
        result.reason          = 'SMTP-confirmed';
    } else {
        if (classification.type === 'confirmed-personal') {
            result.confidenceScore = 65;
            result.verdict         = 'probable';
            result.reason          = 'Strong personal format, MX valid';
        } else if (classification.type === 'confirmed-generic') {
            result.confidenceScore = 52;
            result.verdict         = 'probable';
            result.reason          = 'Role email, MX valid';
        } else {
            result.confidenceScore = 30;
            result.verdict         = 'weak';
            result.reason          = 'Weak match';
        }
    }
    return result;
}

async function rankAndFilterEmails(emails, domain) {
    if (!emails || emails.length === 0) return [];
    const unique = [...new Set(emails.map(e => (typeof e === 'string' ? e.toLowerCase().trim() : e)))];
    const validated = await Promise.all(unique.map(email => validateEmailFull(email, domain)));
    
    // 🔥 AGGRESSIVE REJECTION: Filter out weak emails
    const passing = validated
        .filter(r => r.confidenceScore >= EMAIL_CONFIDENCE_THRESHOLD)
        .sort((a, b) => b.confidenceScore - a.confidenceScore);

    return passing;
}

// ─── STAGE 3: COMPANY REALITY ENGINE ─────────────────────────────────────────
async function researchCompanyForLead(companyName, domain, tavilyKey, openAiKey, onProgress) {    const cached = getCachedResearch(domain);
    if (cached) return cached;
    if (getTavilyRemaining() <= 1) return null;

    try {
        onProgress?.(`🔍 Researching ${companyName}...`);

        // Search for official pages and decision makers
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
      "email": "Email ONLY if literally in snippets. null otherwise. NEVER invent or construct.",      "linkedIn": "LinkedIn URL if found. null otherwise."
    }
  ]
}
CRITICAL: Do NOT construct any email. Do NOT guess. If not in snippets: null or empty array.
SNIPPETS:
${allSnippets}`;

        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: extractPrompt }],
            max_tokens:  500,
            temperature: 0.0,
        }, { headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:extract');

        if (!res) return null;
        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o-mini');

        const raw    = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        const parsed = JSON.parse(raw);
        parsed._domain = domain;

        // Reality Check: Remove hallucinated emails
        if (Array.isArray(parsed.employees)) {
            parsed.employees = parsed.employees.map(emp => {
                if (emp.email) {
                    const emailActuallyExists = allText.toLowerCase().includes(emp.email.toLowerCase());
                    if (!emailActuallyExists) emp.email = null;
                }
                return emp;
            });
        }

        const allRealEmails = [...new Set([
            ...regexFromGeneral.companyEmails,
            ...(parsed.contactEmails || []),
        ])].filter(isValidEmailFormat);
        
        parsed.contactEmails = allRealEmails.filter(email => {
            const ed = email.split('@')[1]?.toLowerCase();
            return ed === domain || ed?.includes(domain.split('.')[0]);
        });

        setCachedResearch(domain, parsed);
        return parsed;

    } catch (err) {
        console.warn(`[Research Error] ${err.message}`);
        return null;
    }}

// ─── STAGE 7: PERSONALIZATION ENGINE ─────────────────────────────────────────
async function generateEmailsForLead(companyData, contactPerson, domain, userProfile, openAiKey, detectedLanguage, painSignals) {
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

        const painContext = painSignals && painSignals.length > 0 
            ? `The user indicated the target struggles with: ${painSignals.join(', ')}. Address this specifically.` 
            : '';

        const multilingualBlock = detectedLanguage.rtl
            ? `NOTE: ${detectedLanguage.name} is RTL. Format accordingly.`
            : '';

        const writePrompt = `${buildBannedWordsInstruction()}
MULTILINGUAL ENGINE: Write entirely in ${detectedLanguage.name}.
${multilingualBlock}

You are a world-class B2B cold email copywriter.
TARGET COMPANY: ${companyName}
INDUSTRY: ${industry}
BUSINESS TYPE: ${businessModel}
CONTACT: ${contactName} (${contactRole || 'Decision Maker'})
${painContext}
SENDER: ${senderName}
VALUE PROP: ${uspToUse}

─── EMAIL 1 — INITIAL OUTREACH ───
Subject: 4-6 words. Specific to ${companyName} or ${industry}. NOT generic.
Salutation: "${firstNameOnly || 'Hi'}" — alone on its own line. NEVER skip. NEVER "Dear".

Para 1 — Hook:
${news    ? `Reference this news specifically: "${news}". Show you read it. 1-2 sentences.` :
  mission ? `Reference this mission: "${mission}". Connect it to something real. 1-2 sentences.` :
            `Reference a real, specific challenge that ${industry} ${businessModel} businesses face daily.
             Do NOT say "I noticed you are growing" or anything vague.
             Write something a ${contactRole || 'business owner'} in ${industry} would read and think "how did they know?"             1-2 sentences only.`}

Para 2 — Value:
Connect "${uspToUse}" to how it solves the specific problem you referenced.
Describe the mechanism — what actually happens, step by step. One concrete sentence.
NO invented stats. NO percentages. NO vague promises.

Para 3 — CTA:
One soft ask. "Worth 15 minutes this week?" — one sentence only.

Sign-off: Best, ${senderName}

─── EMAIL 2 — FOLLOW-UP (3 days later) ───
Subject: "Re: " + Email 1 subject exactly.
Salutation: "${firstNameOnly || 'Hi'}" — alone on its own line.
Para 1: Add ONE new observation about ${companyName} OR a specific trend in ${industry}.
Para 2: Re-state the ask in a fresh way. Max 2 sentences.
Sign-off: Best, ${senderName}

─── EMAIL 3 — BREAK-UP (7 days later) ───
Subject: "Closing my file on ${companyName}"
Salutation: "${firstNameOnly || 'Hi'}" — alone on its own line.
3 sentences total. Acknowledge timing. No sell. Leave door open gracefully.
Sign-off: Best, ${senderName}

HARD RULES:
- Every email MUST open with the salutation line before any other text.
- NEVER invent stats, percentages, or results.
- NEVER use banned words.
- NEVER write a generic email that could work for any industry.

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
        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o');

        const raw = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        return JSON.parse(raw);
    } catch (err) {
        console.warn(`[Email Gen Error] ${err.message}`);
        // Fallback template
        const name     = contactPerson?.name?.split(' ')[0] || 'Hi';
        const industry = companyData.industry || 'your sector';
        const company  = companyData.name     || 'your business';
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

// ─── STAGE 4 & 5: SINGLE COMPANY PIPELINE ────────────────────────────────────
async function processOneCompany(result, intentParams, tavilyKey, apiKey, userProfile, onProgress, detectedLanguage) {
    try {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
        if (!domain) return null;
        if (isFreeEmailDomain(domain)) return null;

        // STAGE 2: Source Selection Gate
        const pageScore = _scorePageBusinessRelevance(result);
        if (pageScore === 0) {
            console.log(`🔴 [SOURCE REJECT] Blocked low-value URL: ${result.url}`);
            return null;
        }

        const companyName = result.title.split(/[|\-–]/)[0].trim().replace(/\b(Ltd|LLC|Inc|Limited|PLC)\s*$/gi, '').trim();
        if (!companyName || companyName.length < 3) return null;

        // Dedup
        const companyKey = companyName.toLowerCase().replace(/\s+/g, '');
        if (globalSeenCompanyNames.has(companyKey)) return null;
        globalSeenCompanyNames.add(companyKey);
        onProgress?.(`📋 Researching ${companyName}...`);

        const [companyData, mxValid] = await Promise.all([
            researchCompanyForLead(companyName, domain, tavilyKey, apiKey, onProgress),
            validateMX(domain),
        ]);

        if (!mxValid) return null;

        // STAGE 3: Company Reality Check
        const employees   = companyData?.employees || [];
        const hasIdentifiableHumans = employees.length > 0 || (companyData?.mission && companyData.mission !== 'unknown');
        
        if (!hasIdentifiableHumans) {
            console.log(`🗑️ [REALITY REJECT] ${companyName} — No identifiable humans or mission.`);
            return null;
        }

        // STAGE 4: Decision Maker Engine
        const preferredContacts = intentParams.decisionMaker || ['Founder', 'CEO'];
        let bestContact = null;
        
        // Try to find preferred contact first
        for (const role of preferredContacts) {
            const match = employees.find(e => e.role && e.role.toLowerCase().includes(role.toLowerCase()));
            if (match) { bestContact = match; break; }
        }
        
        // If no preferred contact, pick highest priority
        if (!bestContact && employees.length > 0) {
            const ranked = [...employees].sort((a, b) => {
                const aRole = (a.role || '').toLowerCase();
                const bRole = (b.role || '').toLowerCase();
                const aScore = Object.entries(ROLE_PRIORITY).find(([key]) => aRole.includes(key))?.[1] ?? 99;
                const bScore = Object.entries(ROLE_PRIORITY).find(([key]) => bRole.includes(key))?.[1] ?? 99;
                return aScore - bScore;
            });
            bestContact = ranked[0];
        }

        // Collect Candidate Emails
        const candidateEmails = [
            ...(companyData?._regexEmails || []),
            ...(companyData?.contactEmails || []),
            ...(employees.filter(e => e.email && isValidEmailFormat(e.email)).map(e => e.email)),
        ].filter(isValidEmailFormat);

        if (candidateEmails.length === 0) return null;

        // STAGE 5: Email Validation        onProgress?.(`🔬 Validating emails for ${companyName}...`);
        const validatedEmails = await rankAndFilterEmails(candidateEmails, domain);

        if (validatedEmails.length === 0) return null;

        const topEmail        = validatedEmails[0];
        const resolvedEmail   = topEmail.email;
        const classification  = classifyEmail(resolvedEmail, domain);
        
        // 🔥 AGGRESSIVE REJECTION: Reject generic emails if we have a specific person
        if (bestContact && classification.type === 'confirmed-generic') {
             // Only accept generic if no personal email was found in the validated list
             const hasPersonal = validatedEmails.some(e => e.email && classifyEmail(e.email, domain).type === 'confirmed-personal');
             if (hasPersonal) return null; 
        }

        onProgress?.(`✍️ Writing emails for ${companyName}...`);

        const emailSequence = await generateEmailsForLead(
            {
                name:        companyName,
                mission:     companyData?.mission,
                recentNews:  companyData?.recentNews,
                industry:    intentParams.industry || 'unknown',
                model:       companyData?.model,
            },
            bestContact,
            domain,
            userProfile,
            apiKey,
            detectedLanguage,
            intentParams.painSignals
        );

        // STAGE 8: Output Experience Construction
        let verificationLabel = "Standard Match";
        if (topEmail.confidenceScore >= 90) verificationLabel = "Strong Match";
        else if (topEmail.confidenceScore >= 70) verificationLabel = "Verified";
        else if (topEmail.confidenceScore >= 50) verificationLabel = "Probable";

        const lead = {
            company:            companyName,
            website:            result.url,
            industry:           intentParams.industry || 'unknown',
            decisionMaker: {
                name:               bestContact?.name || companyName,
                role:               bestContact?.role || (companyData?.model === 'B2B' ? 'Decision Maker' : 'Owner'),
                email:              resolvedEmail,
                confidence:         topEmail.confidenceScore,
                verification:       verificationLabel,            },
            whyMatched: [
                `${companyData?.model || 'B2B'} company`,
                bestContact ? `${bestContact.role} identified` : "Decision maker identified",
                intentParams.painSignals && intentParams.painSignals.length > 0 ? `Focus: ${intentParams.painSignals[0]}` : "Industry match"
            ],
            personalizedMessage: emailSequence.initial.body,
            leadScore:           topEmail.confidenceScore,
        };

        return lead;

    } catch (err) {
        console.warn(`[processOneCompany Error] ${err.message}`);
        return null;
    }
}

// ─── MAIN PIPELINE ORCHESTRATOR ──────────────────────────────────────────────
async function _runLeadGenPipeline(safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, tavilyKey) {
    globalSeenCompanyNames.clear();

    // STAGE 1: Intent Engine
    const intentData = await _classifyAndExtractIntent(safeMessage, history, apiKey);
    
    if (intentData.needsClarification) {
        return {
            reply:          intentData.clarificationQuestion || "Could you specify the industry or location?",
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: intentData.clarificationQuestion }],
        };
    }

    const intentParams = intentData.params;
    console.log(`🎯 Intent Params: ${JSON.stringify(intentParams)}`);

    onProgress?.(`🔍 Searching for ${intentParams.industry || 'companies'}...`);

    // Build Query
    const loc   = intentParams.location ? `"${intentParams.location}"` : '';
    const ind   = intentParams.industry || '';
    const query = [
        `"${intentParams.target || ind}"`, ind, loc,
        'contact email CEO founder',
        'inurl:about OR inurl:team OR inurl:contact',
    ].filter(Boolean).join(' ');

    const rawResults = await searchWithTavily(query, tavilyKey, { maxResults: 15 });
    
    if (rawResults.length === 0) {
        return {            reply:          'No companies found. Try narrowing the industry or adding a location.',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'No leads found.' }],
        };
    }

    // STAGE 2: Source Filtering
    const SKIP_DOMAINS = [
        'linkedin.com','crunchbase.com','apollo.io','hunter.io',
        'yelp.com','clutch.co','g2.com','trustpilot.com',
        'bark.com','upwork.com','fiverr.com','peopleperhour.com',
        'yell.com','thomsonlocal.com','checkatrade.com',
        'directory.com','yellowpages.com','manta.com',
        'hubspot.com','moz.com','semrush.com','ahrefs.com',
        'searchenginejournal.com','searchengineland.com',
        'entrepreneur.com','forbes.com','inc.com','businessinsider.com',
        'techcrunch.com','venturebeat.com','wired.com',
        'reddit.com','quora.com','medium.com','substack.com',
        'wikipedia.org','wikihow.com',
        'indeed.com','glassdoor.com','ziprecruiter.com',
        'capterra.com','getapp.com','softwareadvice.com',
        'producthunt.com','angellist.com','f6s.com',
        'goodfirms.co','designrush.com','expertise.com',
        'houzz.com','thumbtack.com','homeadvisor.com',
    ];

    const cleanResults = [];
    for (const result of rawResults) {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
        if (!domain)                                                  continue;
        if (globalSeenDomains.has(domain))                           continue;
        if (SKIP_DOMAINS.some(d => domain.includes(d)))              continue;
        
        // Double check hard reject patterns
        if (_scorePageBusinessRelevance(result) === 0) continue;

        globalSeenDomains.add(domain);
        cleanResults.push({ ...result, _domain: domain });
        if (cleanResults.length >= 10) break;
    }

    if (cleanResults.length === 0) {
        return {
            reply:          'Found results but all were directory or editorial sites. Try a more specific industry.',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'No leads after filtering.' }],
        };
    }

    onProgress?.(`⚙️ Researching ${cleanResults.length} companies...`);
    const tasks = cleanResults.map(result => () =>        processOneCompany(result, intentParams, tavilyKey, apiKey, userProfile, onProgress, detectedLanguage)
    );
    
    // Concurrency Control
    const results   = [];
    const executing = new Set();
    for (const task of tasks) {
        const promise = task()
            .then(result => { executing.delete(promise); return result; })
            .catch(err   => { executing.delete(promise); return null; });
        results.push(promise);
        executing.add(promise);
        if (executing.size >= CONCURRENCY_LIMIT) await Promise.race(executing);
    }
    const settled = await Promise.allSettled(results);

    const allVerifiedLeads = settled
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value)
        .sort((a, b) => b.leadScore - a.leadScore);

    const leadsToReturn = allVerifiedLeads.slice(0, MAX_LEADS_RETURNED);

    const _meta = {
        tavilyUsed:         tavilyQuota.used,
        tavilyRemaining:    getTavilyRemaining(),
        openAiCalls:        openAiTracker.totalCallsThisSession,
        estimatedCostUSD:   parseFloat(costTracker.estimatedUSDThisSession.toFixed(4)),
        totalVerified:      allVerifiedLeads.length,
        totalReturned:      leadsToReturn.length,
    };

    if (leadsToReturn.length === 0) {
        return {
            reply:          'Found companies but no emails passed our strict verification. Try a different industry.',
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
// ─── OTHER HANDLERS (Chat, Draft, QA) ────────────────────────────────────────
async function _handleChat(message, history, userProfile, apiKey) {
    // ... (Same as previous implementation)
    const senderName = userProfile?.senderName || 'there';
    const usp        = userProfile?.usp || null;
    const systemPrompt = `You are an intelligent AI assistant and business operator. You are direct, sharp, and genuinely helpful. ${usp ? `The user's business value proposition is: "${usp}". Reference this naturally when relevant.` : ''}`;
    const memoryMessages = (history || []).slice(-20).map(h => ({ role: h.role, content: h.content }));
    const messages = [{ role: 'system', content: systemPrompt }, ...memoryMessages, { role: 'user', content: message }];

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini', messages, max_tokens: 600, temperature: 0.7,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:chat');
        if (!res) return 'I had trouble responding — please try again.';
        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o-mini');
        return res.data.choices[0].message.content.trim();
    } catch (err) {
        return 'Something went wrong. Please try again.';
    }
}

async function _handleEmailDraft(message, history, userProfile, apiKey) {
    // ... (Same as previous implementation)
    const senderName = userProfile?.senderName || 'Alex';
    const usp        = userProfile?.usp || null;
    const draftPrompt = `${buildBannedWordsInstruction()}
You are a world-class B2B email copywriter.
SENDER NAME: ${senderName}
${usp ? `SENDER VALUE PROP: ${usp}` : ''}
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
Return ONLY valid JSON: { "subject": "string", "body": "string" }`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o', messages: [{ role: 'user', content: draftPrompt }], max_tokens: 600, temperature: 0.7,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:emaildraft');
        if (!res) throw new Error('Draft returned null');
        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o');
        const raw    = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        const parsed = JSON.parse(raw);        return `Here's your email:\n\n**Subject:** ${parsed.subject}\n\n${parsed.body}`;
    } catch (err) {
        return 'I had trouble drafting that email. Can you give me a bit more detail?';
    }
}

async function _handleBusinessQA(message, history, userProfile, apiKey) {
    // ... (Same as previous implementation)
    const usp = userProfile?.usp || null;
    const systemPrompt = `You are a sharp senior business strategist and operator. You give direct, actionable business advice with zero corporate fluff. ${usp ? `The user runs a business with this value proposition: "${usp}". Use this as context when relevant.` : ''}`;
    const memoryMessages = (history || []).slice(-12).map(h => ({ role: h.role, content: h.content }));
    const messages = [{ role: 'system', content: systemPrompt }, ...memoryMessages, { role: 'user', content: message }];

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o', messages, max_tokens: 800, temperature: 0.5,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:businessqa');
        if (!res) return 'I had trouble with that — please try again.';
        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o');
        return res.data.choices[0].message.content.trim();
    } catch (err) {
        return 'Something went wrong. Please try again.';
    }
}

function _detectLanguage(message) {
    // ... (Same as previous implementation)
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
        { code: 'fr', name: 'French',     rtl: false, pattern: /\b(merci|bonjour|comment|nous|vous|les|des|une|pour|avec|très|aussi|notre|votre|pouvez|entreprise|besoin|système|équipe)\b/ },        { code: 'de', name: 'German',     rtl: false, pattern: /\b(danke|hallo|bitte|wie|haben|sind|kann|wir|das|die|der|und|nicht|ich|sie|mit|für|eine|unser|team|system|prozess|brauchen)\b/ },
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

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────
async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🟢 [AI ENGINE] Pipeline started...');
        onProgress?.('🧠 Understanding your request...');

        const apiKey    = process.env.OPENAI_API_KEY;
        const tavilyKey = process.env.TAVILY_API_KEY;

        const safeMessage = typeof message === 'string' ? message.slice(0, MAX_MESSAGE_LENGTH) : '';
        if (!safeMessage.trim()) {
            return { reply: 'How can I help you today?', updatedHistory: history };
        }

        const detectedLanguage = _detectLanguage(safeMessage);
        console.log(`🌐 [LANGUAGE] Detected: ${detectedLanguage.name} (${detectedLanguage.code})`);

        const intentData = await _classifyAndExtractIntent(safeMessage, history, apiKey);
        const intent = intentData.intent;
        console.log(`🎯 [INTENT] ${intent}`);
        onProgress?.(`🧠 Mode: ${intent.replace('_', ' ')}...`);

        if (intent === INTENT.LEAD_GEN) {
            return await _runLeadGenPipeline(safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, tavilyKey);
        }
        if (intent === INTENT.EMAIL_DRAFT) {
            const reply = await _handleEmailDraft(safeMessage, history, userProfile, apiKey);
            return { reply, updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: reply }] };
        }
        if (intent === INTENT.BUSINESS_QA) {            const reply = await _handleBusinessQA(safeMessage, history, userProfile, apiKey);
            return { reply, updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: reply }] };
        }

        // INTENT.CHAT (default)
        const reply = await _handleChat(safeMessage, history, userProfile, apiKey);
        return { reply, updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: reply }] };

    } catch (error) {
        console.error('❌ [AI ENGINE] Fatal error:', error.message);
        return { reply: 'An error occurred. Please try again.', updatedHistory: history };
    }
}

module.exports = { generateFreeResponse };
