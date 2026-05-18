'use strict';

const axios = require('axios');
const dns   = require('dns').promises;

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const MAX_LEADS_RETURNED = 5;
const TAVILY_LIMIT       = 1000;
const CONCURRENCY_LIMIT  = 2;
const CACHE_TTL_MS       = 60 * 60 * 1000;
const CURRENT_YEAR       = new Date().getFullYear();
const MAX_MESSAGE_LENGTH = 800;

// ─── INTENT TYPES ─────────────────────────────────────────────────────────────
const INTENT = {
    LEAD_GEN:     'lead_gen',
    CHAT:         'chat',
    EMAIL_DRAFT:  'email_draft',
    BUSINESS_QA:  'business_qa',
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

// ─── QUOTA TRACKERS ────────────────────────────────────────────────────────────
const tavilyQuota = { used: 0, limit: TAVILY_LIMIT, lastReset: Date.now() };

const openAiTracker = {
    totalCallsThisSession:         0,
    totalInputTokensThisSession:   0,
    totalOutputTokensThisSession:  0,
};
const costTracker = { estimatedUSDThisSession: 0 };

function checkTavilyReset() {
    const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - tavilyQuota.lastReset >= ONE_MONTH) {
        tavilyQuota.used = 0;
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

// ─── REAL EMAIL HUNTING ────────────────────────────────────────────────────────
function extractEmailsFromText(text, companyDomain) {
    if (!text || !companyDomain) return { companyEmails: [], allEmails: [] };
    const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const allFound   = [...new Set(text.match(emailRegex) || [])];
    const domainRoot = companyDomain.split('.')[0].toLowerCase();
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

    const allText  = [...contactResults, ...directoryResults]
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

    if (!domainMatches) return { type: 'unrelated-domain', label: 'Wrong domain',             trustLevel: 0  };
    if (isGeneric)      return { type: 'confirmed-generic', label: '✓ Contact email (real)',   trustLevel: 70 };
    if (localPart.includes('.') || /[a-z]{2,}[a-z]{2,}/.test(localPart)) {
        return          { type: 'confirmed-personal', label: '✓ Personal email (real)',        trustLevel: 90 };
    }
    return              { type: 'confirmed-other',   label: '✓ Email (real)',                  trustLevel: 75 };
}

function guessEmailPatterns(fullName, domain) {
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

// ─── VALIDATION ────────────────────────────────────────────────────────────────
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
    if (extracted.recentNews) {
        const yearMatch = extracted.recentNews.match(/\b(20\d{2})\b/);
        if (yearMatch && parseInt(yearMatch[1]) < CURRENT_YEAR - 2) {
            flags.push(`recentNews stale (${yearMatch[1]}): "${extracted.recentNews}"`);
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
    if (extracted.contactEmails?.length > 0)                         score += 15;
    if (extracted.employees?.length > 0)                             score += 15;
    if (extracted.employees?.some(e => e.email))                     score += 10;
    return Math.min(score, 100);
}

function scoreLeadQuality({ emailConfidence, mxValid, hasRealName, hasLinkedIn, hasNews, hasMission, dataScore, hallucinationCount }) {
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

    score -= (hallucinationCount || 0) * 8;

    return Math.max(0, Math.min(score, 100));
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
    name = name.replace(
        /\b(Ltd|LLC|Inc|Limited|PLC)\s*$/gi, ''
    ).trim();
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

// ─── INTENT CLASSIFIER ────────────────────────────────────────────────────────
// NEW: classifies every incoming message before routing it
// Returns one of: lead_gen | chat | email_draft | business_qa
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

// ─── CHAT HANDLER ─────────────────────────────────────────────────────────────
// NEW: handles conversational messages with full memory context
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

    // Build full memory context from history (last 20 messages max)
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
// NEW: drafts a standalone email from natural language instructions
// Does NOT trigger the lead gen pipeline — purely drafts what the user describes
async function _handleEmailDraft(message, history, userProfile, apiKey) {
    const senderName = userProfile?.senderName || 'Alex';
    const usp        = userProfile?.usp || null;

    // Pull context from recent history so follow-up edits work naturally
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

        // Return as a human-readable formatted reply so the frontend can display it
        return `Here's your email:\n\n**Subject:** ${parsed.subject}\n\n${parsed.body}`;

    } catch (err) {
        console.warn('[Email Draft Error]:', err.message);
        return 'I had trouble drafting that email. Can you give me a bit more detail about who it\'s for and what you want to say?';
    }
}

// ─── BUSINESS QA HANDLER ──────────────────────────────────────────────────────
// NEW: handles business strategy, advice, calculations, analysis
async function _handleBusinessQA(message, history, userProfile, apiKey) {
    const senderName = userProfile?.senderName || 'there';
    const usp        = userProfile?.usp || null;

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

        const allText    = [...generalResults, ...employeeResults].map(r => `${r.title} ${r.snippet} ${r.url}`).join(' ');
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
SNIPPETS:
${allSnippets}`;

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
                if (emp.name && !emp.email && domain) {
                    emp.emailGuesses    = guessEmailPatterns(emp.name, domain);
                    emp.emailConfidence = 'guessed-pattern';
                } else if (emp.email) {
                    emp.emailGuesses    = [emp.email];
                    emp.emailConfidence = 'confirmed-personal';
                }
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

// ─── EMAIL SEQUENCE WRITER ────────────────────────────────────────────────────
async function generateEmailsForLead(companyData, contactPerson, domain, userProfile, openAiKey, detectedLanguage) {
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

        const industryContext = `
INDUSTRY: ${industry}
BUSINESS TYPE: ${businessModel}
CONTACT ROLE: ${contactRole || 'Business Owner/Decision Maker'}

INDUSTRY CONTEXT (use this when mission/news are not available):
Write as if you genuinely understand the day-to-day reality of running a ${industry} ${businessModel} business.
Think about: what does a ${contactRole || 'owner'} in ${industry} actually struggle with daily?
What does their pipeline look like? What wastes their time? What keeps them up at night?
Reference these realities naturally — do NOT mention this instruction in the email.
The goal: the reader thinks "this person actually understands my world", not "this is a template."
`;

        const multilingualBlock = _buildMultilingualEmailBlock(detectedLanguage);

        const writePrompt = `${buildBannedWordsInstruction()}
${multilingualBlock}

You are a world-class B2B cold email copywriter who specialises in writing for specific industries.
You NEVER write generic emails. Every word is tailored to the recipient's exact business type.

TARGET COMPANY: ${companyName}
${contactName ? `CONTACT: ${contactName} (${contactRole || 'Decision Maker'})` : `CONTACT: Decision maker at ${companyName}`}
${mission ? `COMPANY MISSION: ${mission}` : ''}
${news    ? `RECENT NEWS: ${news}` : ''}
SENDER: ${senderName}
VALUE PROP: ${uspToUse}
${industryContext}

─── EMAIL 1 — INITIAL OUTREACH ───
Subject: 4-6 words. Specific to ${companyName} or ${industry}. NOT generic.
Salutation: "${firstNameOnly || 'Hi'}" — alone on its own line. NEVER skip. NEVER "Dear".

Para 1 — Hook:
${news    ? `Reference this news specifically: "${news}". Show you read it. 1-2 sentences.` :
  mission ? `Reference this mission: "${mission}". Connect it to something real. 1-2 sentences.` :
            `Reference a real, specific challenge that ${industry} ${businessModel} businesses face daily.
             Do NOT say "I noticed you are growing" or anything vague.
             Write something a ${contactRole || 'business owner'} in ${industry} would read and think "how did they know?"
             1-2 sentences only.`}

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

Para 1: Add ONE new observation about ${companyName} OR a specific trend in ${industry} that is relevant right now. NOT a repeat of Email 1. 1-2 sentences.
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
- NEVER write a generic email that could work for any industry — it must only work for ${industry}.
- If you write something a plumber and a SaaS founder could both receive unchanged, rewrite it.

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

// ─── SINGLE COMPANY PIPELINE ──────────────────────────────────────────────────
async function processOneCompany(result, intent, tavilyKey, apiKey, userProfile, onProgress, detectedLanguage) {
    try {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
        if (!domain) return null;
        if (isFreeEmailDomain(domain)) return null;

        const companyName = cleanCompanyName(result.title);
        if (!companyName) return null;

        onProgress?.(`📋 Researching ${companyName}...`);
        console.log(`📋 Processing: ${companyName} (${domain})`);

        const [companyData, mxValid] = await Promise.all([
            researchCompanyForLead(companyName, domain, tavilyKey, apiKey, onProgress),
            validateMX(domain),
        ]);

        if (!mxValid) console.warn(`⚠️ [MX FAIL] ${domain} — high bounce risk`);

        const dataScore = scoreDataCompleteness(companyData);
        if (dataScore < 10) {
            console.warn(`🗑️ Skipping ${companyName} — data score ${dataScore}/100`);
            return null;
        }

        let bestContact = null;
        const employees = companyData?.employees || [];
        if (employees.length > 0) {
            const preferred = intent.preferredContact?.toLowerCase();
            bestContact = employees.find(e =>
                e.role && preferred && preferred !== 'any' &&
                e.role.toLowerCase().includes(preferred)
            ) || employees[0];
        }

        let resolvedEmail   = null;
        let emailConfidence = null;
        let emailLabel      = null;
        let allEmailOptions = [];
        const regexEmails   = companyData?._regexEmails || [];

        if (regexEmails.length > 0) {
            const c = classifyEmail(regexEmails[0], domain);
            resolvedEmail = regexEmails[0]; emailConfidence = c.type; emailLabel = c.label;
            allEmailOptions = regexEmails;
            console.log(`✅ [TIER 1/2] Regex email: ${resolvedEmail}`);

        } else if (bestContact?.email && isValidEmailFormat(bestContact.email)) {
            resolvedEmail = bestContact.email; emailConfidence = 'confirmed-personal';
            emailLabel = '✓ Personal email (real)'; allEmailOptions = [bestContact.email];
            console.log(`✅ [TIER 3] Reality-checked employee email: ${resolvedEmail}`);

        } else if (getTavilyRemaining() > 0) {
            onProgress?.(`🎯 Hunting real email for ${companyName}...`);
            const huntResult = await huntRealEmails(companyName, domain, tavilyKey);
            if (huntResult.companyEmails.length > 0) {
                const c = classifyEmail(huntResult.companyEmails[0], domain);
                resolvedEmail = huntResult.companyEmails[0]; emailConfidence = c.type;
                emailLabel = c.label; allEmailOptions = huntResult.companyEmails;
                console.log(`✅ [TIER 4] Email hunt found: ${resolvedEmail}`);
            }
        }

        if (!resolvedEmail && bestContact?.name) {
            const guesses = guessEmailPatterns(bestContact.name, domain);
            resolvedEmail = guesses[0]; emailConfidence = 'guessed-pattern';
            emailLabel = '⚠️ Pattern guess — NOT verified'; allEmailOptions = guesses;
            console.log(`⚠️ [TIER 5] Pattern guess: ${resolvedEmail}`);
        }

        if (!resolvedEmail || !isValidEmailFormat(resolvedEmail)) {
            console.warn(`🗑️ [REJECTED] ${companyName} — no reliable email found at any tier`);
            return null;
        }

        onProgress?.(`✍️ Writing emails for ${companyName}...`);

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
            detectedLanguage
        );

        const hallucinationCount = (companyData?._hallucinationFlags || []).length;

        const leadScore = scoreLeadQuality({
            emailConfidence, mxValid,
            hasRealName:       !!bestContact?.name,
            hasLinkedIn:       !!bestContact?.linkedIn,
            hasNews:           !!companyData?.recentNews,
            hasMission:        !!companyData?.mission,
            dataScore,
            hallucinationCount,
        });

        console.log(`✅ ${companyName} → ${resolvedEmail} [${emailConfidence}] Score:${leadScore}/100 MX:${mxValid}`);

        return {
            name:               bestContact?.name || companyName,
            company:            companyName,
            domain,
            email:              resolvedEmail,
            emailConfidence,
            emailLabel,
            allEmailOptions,
            role:               bestContact?.role || (companyData?.model === 'B2B' ? 'Decision Maker' : 'Owner'),
            linkedIn:           bestContact?.linkedIn  || null,
            companySize:        companyData?.size      || 'unknown',
            companyModel:       companyData?.model     || 'unknown',
            industry:           intent.industry        || 'unknown',
            hq:                 companyData?.hq        || null,
            recentNews:         companyData?.recentNews || null,
            leadScore,
            mxValid,
            dataScore,
            hallucinationFlags: companyData?._hallucinationFlags || [],
            emailLanguage:      detectedLanguage.code,
            messages: [
                { type: 'initial',  subject: emailSequence.initial.subject,  body: emailSequence.initial.body  },
                { type: 'followup', subject: emailSequence.followup.subject, body: emailSequence.followup.body },
                { type: 'breakup',  subject: emailSequence.breakup.subject,  body: emailSequence.breakup.body  },
            ],
        };

    } catch (err) {
        console.warn(`[processOneCompany Error] ${err.message}`);
        return null;
    }
}

// ─── LEAD GEN PIPELINE (extracted from generateFreeResponse for clarity) ──────
// All original lead gen logic — zero changes to the algorithm
async function _runLeadGenPipeline(safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, tavilyKey) {
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
            const parsed = JSON.parse(raw);
            intent = { ...intent, ...parsed };
            console.log(`🎯 Intent: ${JSON.stringify(intent)}`);
        }
    } catch (e) { console.warn('[Intent Parse Failed]:', e.message); }

    onProgress?.(`🔍 Searching for ${intent.industry} companies${intent.location ? ' in ' + intent.location : ''}...`);
    const locationClause = intent.location ? `"${intent.location}"` : '';

    const query = [
        `"${intent.target}"`, intent.industry, locationClause,
        'contact email CEO founder',
        'inurl:about OR inurl:team OR inurl:contact OR inurl:contact-us',
    ].filter(Boolean).join(' ');

    console.log(`🔍 Query: ${query}`);
    const rawResults = await searchWithTavily(query, tavilyKey, { maxResults: 10 });
    console.log(`🔎 RAW RESULTS (${rawResults.length}):`, rawResults.map(r => r.url));

    if (rawResults.length === 0) {
        return {
            reply:          'No companies found. Try narrowing the industry or adding a location.',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'No leads found.' }],
        };
    }

    const SKIP_DOMAINS = [
        'linkedin.com','crunchbase.com','apollo.io','hunter.io',
        'yelp.com','clutch.co','g2.com','trustpilot.com',
        'bark.com','bark.london','upwork.com','fiverr.com','peopleperhour.com',
        'yell.com','thomsonlocal.com','checkatrade.com',
        'directory.com','yellowpages.com','manta.com',
    ];

    const cleanResults = [];
    for (const result of rawResults) {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
        if (!domain)                                                  continue;
        if (globalSeenDomains.has(domain))                           continue;
        if (SKIP_DOMAINS.some(d => domain.includes(d)))              continue;
        globalSeenDomains.add(domain);
        cleanResults.push({ ...result, _domain: domain });
        if (cleanResults.length >= MAX_LEADS_RETURNED + 3) break;
    }

    console.log(`✅ Clean results after filter: ${cleanResults.length}`);

    if (cleanResults.length === 0) {
        return {
            reply:          'Found results but all were directory sites. Try a more specific industry or location.',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'No leads after filtering.' }],
        };
    }

    onProgress?.(`⚙️ Researching ${cleanResults.length} companies...`);
    const tasks = cleanResults.map(result => () =>
        processOneCompany(result, intent, tavilyKey, apiKey, userProfile, onProgress, detectedLanguage)
    );
    const settled = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);

    const leadsToReturn = settled
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value)
        .sort((a, b) => b.leadScore - a.leadScore)
        .slice(0, MAX_LEADS_RETURNED);

    console.log(`🏁 Done. ${leadsToReturn.length} leads.`);
    console.log(`📊 GPT: ${openAiTracker.totalCallsThisSession} calls | in:${openAiTracker.totalInputTokensThisSession} out:${openAiTracker.totalOutputTokensThisSession} tokens | ~$${costTracker.estimatedUSDThisSession.toFixed(4)}`);
    console.log(`🔍 Tavily: ${tavilyQuota.used}/${tavilyQuota.limit}`);

    if (leadsToReturn.length === 0) {
        return {
            reply:          'Found companies but could not verify enough data. Try a different industry or location.',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'No leads extracted.' }],
        };
    }

    return {
        reply: JSON.stringify(leadsToReturn),
        updatedHistory: [
            ...history,
            { role: 'user',      content: safeMessage },
            { role: 'assistant', content: `[Generated ${leadsToReturn.length} leads]` },
        ],
    };
}

// ─── MAIN: generateFreeResponse ────────────────────────────────────────────────
// PRESERVED: same function signature and return shape — zero breaking changes
// UPGRADED:  now routes to chat / email_draft / business_qa / lead_gen based on intent
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
                reply:           'How can I help you today? I can find leads, draft emails, answer business questions, or just chat.',
                updatedHistory:  history,
            };
        }

        const detectedLanguage = _detectLanguage(safeMessage);
        console.log(`🌐 [LANGUAGE] Detected: ${detectedLanguage.name} (${detectedLanguage.code})`);

        // ── INTENT CLASSIFICATION ─────────────────────────────────────────────
        const intent = await _classifyIntent(safeMessage, history, apiKey);
        console.log(`🎯 [INTENT] ${intent}`);
        onProgress?.(`🧠 Mode: ${intent.replace('_', ' ')}...`);

        // ── ROUTING ───────────────────────────────────────────────────────────
        if (intent === INTENT.LEAD_GEN) {
            // Original lead gen pipeline — fully preserved, zero changes
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
                    { role: 'user',      content: safeMessage },
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
                    { role: 'user',      content: safeMessage },
                    { role: 'assistant', content: reply },
                ],
            };
        }

        // Default: CHAT — handles greetings, small talk, follow-ups, clarifications
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
