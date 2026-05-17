// This file will contain the updated lead engine code.

const axios = require('axios');
const dns   = require('dns').promises;

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const MAX_LEADS_RETURNED = 5;
const TAVILY_LIMIT       = 1000;
const CONCURRENCY_LIMIT  = 2;
const CACHE_TTL_MS       = 60 * 60 * 1000;

// ─── REASONING FILTER ──────────────────────────────────────────────────────────
const REASONING_FILTER = `
⚠️ REASONING FILTER — NON-NEGOTIABLE:
1. You are a strict fact extractor. Use ONLY facts explicitly stated in SNIPPETS.
2. IGNORE all training data. If a fact is not in the snippets, return null.
3. NEVER invent names, emails, roles, or company details.
4. Current year is 2026.
`;

// ─── BANNED WORDS + STATS ─────────────────────────────────────────────────────
const BANNED_WORDS = [
    'transformative','seamless','mission-critical','synergy','game-changer',
    'revolutionary','cutting-edge','innovative','disruptive','next-level',
    'holistic','robust','scalable','leverage','streamline','optimize',
    'empower','unlock','elevate','enhance','boost','accelerate','amplify',
    'delve','awe-inspiring','exciting','landscape','unleash','dynamic',
    'groundbreaking','paradigm','ecosystem','value-add','best-in-class',
    'I hope this finds you well','I wanted to reach out','touch base',
    'circle back','quick question','just following up','as per my last email',
    'I am reaching out because','My name is','I hope you are doing well',
    'let me know your thoughts','feel free to','do not hesitate',
    'please find attached','as mentioned','at your earliest convenience',
    'in today\'s world','in the current landscape','going forward'
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
    return `BANNED WORDS — NEVER use: ${BANNED_WORDS.join(', ')}. Replace with specific facts.\n${BANNED_STATS_INSTRUCTION}`;
}

// ─── QUOTA TRACKERS ────────────────────────────────────────────────────────────
const tavilyQuota   = { used: 0, limit: TAVILY_LIMIT, lastReset: Date.now() };
const openAiTracker = { totalCallsThisSession: 0, totalTokensThisSession: 0 };
const costTracker   = { estimatedUSDThisSession: 0 };

function checkTavilyReset() {
    const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - tavilyQuota.lastReset >= ONE_MONTH) {
        tavilyQuota.used = 0;
        tavilyQuota.lastReset = Date.now();
    }
}
function getTavilyRemaining() { checkTavilyReset(); return tavilyQuota.limit - tavilyQuota.used; }
function recordTavilyUsage()  { tavilyQuota.used += 1; }
function recordOpenAiUsage(tokensUsed) {
    openAiTracker.totalCallsThisSession  += 1;
    openAiTracker.totalTokensThisSession += tokensUsed;
    costTracker.estimatedUSDThisSession  += (tokensUsed / 1_000_000) * 0.30;
}

// ─── IN-MEMORY RESEARCH CACHE ──────────────────────────────────────────────────
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

// ─── TAVILY SEARCH ─────────────────────────────────────────────────────────────
async function searchWithTavily(query, tavilyKey, options = {}) {
    if (getTavilyRemaining() <= 0) throw new Error('Tavily quota exhausted');
    try {
        const response = await axios.post('https://api.tavily.com/search', {
            api_key: tavilyKey,
            query,
            search_depth: 'advanced',
            max_results: options.maxResults || 5,
            include_answer: false,
            include_raw_content: false,
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 12000 });

        recordTavilyUsage();
        return (response.data?.results || []).map(r => ({
            title:   r.title || '',
            url:     r.url || '',
            snippet: r.content || '',
            date:    r.published_date || null,
        }));
    } catch (err) {
        console.warn(`[Tavily Error] ${err.message}`);
        return [];
    }
}

// ─── REAL EMAIL HUNTING SYSTEM ─────────────────────────────────────────────────
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
    const allText = [...contactResults, ...directoryResults]
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
    const domainRoot = domain.split('.')[0].toLowerCase();
    const domainMatches = emailDomain === domain || emailDomain?.includes(domainRoot);
    const GENERIC_PREFIXES = ['contact','info','hello','sales','team','support','enquiries','enquiry','admin','office','mail','general','press','media'];
    const isGeneric = GENERIC_PREFIXES.some(p => localPart === p || localPart.startsWith(p + '.'));

    if (!domainMatches) return { type: 'unrelated-domain', label: 'Wrong domain', trustLevel: 0 };

    // Check for founder/CEO specific patterns (Tier 1)
    if (localPart.includes('founder') || localPart.includes('ceo')) {
        return { type: 'confirmed-founder-ceo', label: '✓ Founder/CEO email (real)', trustLevel: 100 };
    }
    // Check for personal work email patterns (Tier 2)
    if (localPart.includes('.') || /[a-z]{2,}[a-z]{2,}/.test(localPart)) {
        return { type: 'confirmed-personal', label: '✓ Personal email (real)', trustLevel: 90 };
    }
    // Check for generic inbox (Tier 4)
    if (isGeneric) {
        return { type: 'confirmed-generic', label: '✓ Contact email (real)', trustLevel: 40 };
    }
    // Other confirmed emails
    return { type: 'confirmed-other', label: '✓ Email (real)', trustLevel: 75 };
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

// ─── VALIDATION SYSTEMS ───────────────────────────────────────────────────────
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
    'mailinator.com','guerrillamail.com','tempmail.com','throwam.com'
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
                if (emailDomain && emailDomain !== extracted._domain &&
                    !emailDomain.includes(extracted._domain.split('.')[0])) {
                    flags.push(`Employee[${i}] email domain "${emailDomain}" ≠ company domain "${extracted._domain}"`);
                }
            }
        });
    }
    if (extracted.mission) {
        const genericPhrases = ['helping businesses','empowering companies','world-class','innovative solutions','cutting-edge'];
        if (genericPhrases.some(p => extracted.mission.toLowerCase().includes(p))) {
            flags.push(`Mission may be generic/hallucinated: "${extracted.mission}"`);
        }
    }
    if (extracted.recentNews) {
        const yearMatch = extracted.recentNews.match(/\b(20\d{2})\b/);
        if (yearMatch && parseInt(yearMatch[1]) < 2023) {
            flags.push(`recentNews stale (${yearMatch[1]}): "${extracted.recentNews}"`);
        }
    }
    return flags;
}

function scoreDataCompleteness(extracted) {
    if (!extracted) return 0;
    let score = 0;
    if (extracted.mission && extracted.mission !== 'unknown')   score += 15;
    if (extracted.hq && extracted.hq !== 'unknown')             score += 10;
    if (extracted.size && extracted.size !== 'unknown')         score += 10;
    if (extracted.model && extracted.model !== 'unknown')       score += 10;
    if (extracted.recentNews)                                    score += 15;
    if (extracted.contactEmails?.length > 0)                    score += 15;
    if (extracted.employees?.length > 0)                        score += 15;
    if (extracted.employees?.some(e => e.email))                score += 10;
    return Math.min(score, 100);
}

function scoreLeadQuality({ emailConfidence, mxValid, hasRealName, hasLinkedIn, hasNews, hasMission, dataScore, contactRole, emailSource }) {
    let score = 0;

    // Founder identified: +25
    if (contactRole && (contactRole.toLowerCase().includes('founder') || contactRole.toLowerCase().includes('ceo'))) {
        score += 25;
    }

    // Personal email: +25
    if (emailConfidence === 'confirmed-personal') {
        score += 25;
    }

    // Exact domain match: +15 (This is implicitly handled if emailConfidence is not \'unrelated-domain\')
    // We can add a small bonus if the email domain is exactly the company domain.
    // This would require passing the actual email to this function, or a specific flag from classifyEmail.
    // For now, we'll assume if it's a confirmed email and not unrelated, it gets this.
    // Let's add a small implicit bonus if the email is confirmed and matches the domain.
    if (emailConfidence.startsWith('confirmed') && emailConfidence !== 'unrelated-domain') {
        score += 15; // This is a proxy for 'exact domain match'
    }

    // MX verified: +10
    if (mxValid) {
        score += 10;
    }

    // Publicly visible: +10 (Assuming regex and hunt emails from company site are publicly visible)
    if (emailSource === 'regex' || emailSource === 'hunt') {
        score += 10;
    }

    // Team page source: +10 (This would require more granular source tracking, for now, we'll assume if a bestContact is found, it's a good signal)
    if (hasRealName) { // If we have a real name, it implies a source like a team page or LinkedIn
        score += 10;
    }

    // Generic inbox: -30
    if (emailConfidence === 'confirmed-generic') {
        score -= 30;
    }

    // Fallback guess: -40
    if (emailConfidence === 'guessed-fallback') {
        score -= 40;
    }

    // Directory source: -50 (This would require huntRealEmails to explicitly mark results from directories)
    // For now, we don't have a direct way to identify a 'directory source'.
    // If huntRealEmails returns a low confidence email, it might implicitly be penalized by its confidence type.

    // Other signals (adjusted to fit new scale if necessary)
    if (hasLinkedIn)    score += 5;
    if (hasNews)        score += 5;
    if (hasMission)     score += 5;
    if (dataScore > 60) score += 5;

    return Math.min(Math.max(score, 0), 100); // Ensure score is between 0 and 100
}

async function runWithConcurrency(tasks, limit) {
    const results   = [];
    const executing = new Set();
    for (const task of tasks) {
        const promise = task()
            .then(result => { executing.delete(promise); return result; })
            .catch(()    => { executing.delete(promise); return null;   });
        results.push(promise);
        executing.add(promise);
        if (executing.size >= limit) await Promise.race(executing);
    }
    return Promise.allSettled(results);
}

function cleanCompanyName(rawTitle) {
    let name = rawTitle.split(/[|\-–]/)[0].trim();
    name = name.replace(
        /\b(Office|Offices|Ltd|LLC|Inc|Limited|PLC|Group|Agency|London|UK|US|USA|International|Global)\s*$/gi, ''
    ).trim();
    if (name.length > 40) name = name.substring(0, 40).trim();
    const REJECT = ['home','about','contact','services','welcome','index'];
    if (!name || REJECT.includes(name.toLowerCase())) return null;
    return name;
}

// ─── MULTILINGUAL ENGINE ───────────────────────────────────────────────────────
function _detectLanguage(message) {
    if (!message || typeof message !== 'string') return { code: 'en', name: 'English', rtl: false };

    const text = message.trim();

    if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text)) {
        if (/[\u0698\u06AF\u06CC\u06BE]/.test(text)) return { code: 'fa', name: 'Farsi',  rtl: true };
        if (/[\u06C1\u06BE\u06D2]/.test(text))        return { code: 'ur', name: 'Urdu',   rtl: true };
        return { code: 'ar', name: 'Arabic', rtl: true };
    }
    if (/[\u0590-\u05FF\uFB1D-\uFB4F]/.test(text))  return { code: 'he', name: 'Hebrew',   rtl: true  };
    if (/[\u0400-\u04FF]/.test(text))                return { code: 'ru', name: 'Russian',  rtl: false };
    if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(text)) {
        if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return { code: 'ja', name: 'Japanese', rtl: false };
        return { code: 'zh', name: 'Chinese', rtl: false };
    }
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text))  return { code: 'ja', name: 'Japanese', rtl: false };
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(text))  return { code: 'ko', name: 'Korean',   rtl: false };
    if (/[\u0900-\u097F]/.test(text))                return { code: 'hi', name: 'Hindi',    rtl: false };
    if (/[\u0E00-\u0E7F]/.test(text))                return { code: 'th', name: 'Thai',     rtl: false };
    if (/[\u0370-\u03FF]/.test(text))                return { code: 'el', name: 'Greek',    rtl: false };

    const lower = text.toLowerCase();
    const langPatterns = [
        { code: 'es', name: 'Spanish',    rtl: false, pattern: /\b(gracias|hola|por favor|cómo|está|estás|que|también|sí|no|bien|buenas|buenos días|estimado|empresa|necesito|quiero|podría|tenemos|nuestro|sistema|equipo|proceso)\b/ },
        { code: 'fr', name: 'French',     rtl: false, pattern: /\b(merci|bonjour|comment|est-ce|nous|vous|les|des|une|pour|avec|sur|mais|très|aussi|bien|notre|votre|pouvez|entreprise|besoin|système|équipe)\b/ },
        { code: 'de', name: 'German',     rtl: false, pattern: /\b(danke|hallo|bitte|wie|haben|sind|kann|wir|das|die|der|und|nicht|ich|sie|mit|für|eine|unser|team|system|prozess|brauchen)\b/ },
        { code: 'pt', name: 'Portuguese', rtl: false, pattern: /\b(obrigado|olá|como|temos|nosso|empresa|preciso|quero|poderia|sistema|equipe|processo|também|muito|para|com|por)\b/ },
        { code: 'it', name: 'Italian',    rtl: false, pattern: /\b(grazie|ciao|come|abbiamo|nostro|azienda|bisogno|voglio|potrebbe|sistema|squadra|processo|anche|molto|per|con)\b/ },
        { code: 'nl', name: 'Dutch',      rtl: false, pattern: /\b(bedankt|hallo|hoe|wij|onze|bedrijf|nodig|wil|zou|systeem|team|proces|ook|heel|voor|met)\b/ },
        { code: 'pl', name: 'Polish',     rtl: false, pattern: /\b(dziękuję|cześć|jak|mamy|nasz|firma|potrzebuję|chcę|mógłby|system|zespół|proces|też|bardzo|dla|z)\b/ },
        { code: 'tr', name: 'Turkish',    rtl: false, pattern: /\b(teşekkür|merhaba|nasıl|bizim|şirket|ihtiyaç|istiyorum|olur|sistem|ekip|süreç|ayrıca|çok|için|ile)\b/ },
        { code: 'sv', name: 'Swedish',    rtl: false, pattern: /\b(tack|hej|hur|vi|vårt|företag|behöver|vill|skulle|system|team|prosess|också|mycket|för|med)\b/ },
        { code: 'no', name: 'Norwegian',  rtl: false, pattern: /\b(takk|hei|hvordan|vi|vår|selskap|trenger|vil|ville|system|team|prosess|også|veldig|for|med)\b/ },
        { code: 'da', name: 'Danish',     rtl: false, pattern: /\b(tak|hej|hvordan|vi|vores|virksomhed|behøver|vil|ville|system|team|proces|også|meget|for|med)\b/ },
        { code: 'fi', name: 'Finnish',    rtl: false, pattern: /\b(kiitos|hei|miten|meillä|meidän|yritys|tarvitsen|haluan|voisi|järjestelmä|tiimi|prosessi|myös|paljon|varten)\b/ },
        { code: 'id', name: 'Indonesian', rtl: false, pattern: /\b(terima kasih|halo|bagaimana|kami|perusahaan|butuh|ingin|bisa|sistem|tim|proses|juga|sangat|untuk|dengan)\b/ },
        { code: 'ms', name: 'Malay',      rtl: false, pattern: /\b(terima kasih|hai|bagaimana|kami|syarikat|perlu|mahu|boleh|sistem|pasukan|proses|juga|sangat|untuk|dengan)\b/ },
        { code: 'vi', name: 'Vietnamese', rtl: false, pattern: /\b(cảm ơn|xin chào|như thế nào|chúng tôi|công ty|cần|muốn|có thể|hệ thống|đội|quy trình|cũng|rất|cho|với)\b/ },
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

// ─── COMPANY RESEARCH ─────────────────────────────────────────────────────────
async function researchCompanyForLead(companyName, domain, tavilyKey, openAiKey, onProgress) {
    const cached = getCachedResearch(domain);
    if (cached) return cached;
    if (getTavilyRemaining() <= 1) return null;
    try {
        onProgress?.(`🔍 Researching ${companyName}...`);
        const generalResults = await searchWithTavily(
            `"${companyName}" contact email "contact@" OR "sales@" OR "info@" OR "hello@" site:${domain} mission about team leadership 2025 2026`,
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
        const regexFromAll = extractEmailsFromText(allText, domain);
        const allSnippets  = [...generalResults, ...employeeResults]
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
      "email": "Email ONLY if literally in snippets. null otherwise. NEVER invent or construct.",
      "linkedIn": "LinkedIn URL if found. null otherwise."
    }
  ]
}
CRITICAL: Do NOT construct any email. Do NOT guess. If not in snippets: null or empty array.
SNIPPETS:
${allSnippets}`;

        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: extractPrompt }],
            max_tokens: 500,
            temperature: 0.0,
        }, { headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' } });
        recordOpenAiUsage(res.data?.usage?.total_tokens || 0);
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

        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: writePrompt }],
            max_tokens: 900,
            temperature: 0.7,
        }, { headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' } });
        recordOpenAiUsage(res.data?.usage?.total_tokens || 0);
        const raw = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        return JSON.parse(raw);

    } catch (err) {
        console.warn(`[Email Gen Error] ${err.message}`);
        const name = contactPerson?.name?.split(' ')[0] || 'Hi';
        return {
            initial:  { subject: `Quick thought on ${companyData.name}`, body: `${name},\n\nSaw what ${companyData.name} is working on — worth a direct note.\n\n${userProfile?.usp || 'We build outreach pipelines that cut manual prospecting.'}\n\nOpen to 15 minutes this week?\n\nBest,\n${userProfile?.senderName || 'Alex'}` },
            followup: { subject: `Re: Quick thought on ${companyData.name}`, body: `${name},\n\nFloating this back up — one thing I noticed about ${companyData.industry || 'your industry'} that felt relevant.\n\nStill worth a chat?\n\nBest,\n${userProfile?.senderName || 'Alex'}` },
            breakup:  { subject: `Closing my file on ${companyData.name}`, body: `${name},\n\nAssuming timing isn't right — I'll stop following up. Reach out whenever it makes sense.\n\nBest,\n${userProfile?.senderName || 'Alex'}` }
        };
    }
}

// ─── SINGLE COMPANY PIPELINE ───────────────────────────────────────────────────
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
            validateMX(domain)
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

        // ── EMAIL RESOLUTION: Tiered priority chain ───────────────────────────
        let resolvedEmail   = null;
        let emailConfidence = 'none';
        let emailLabel      = 'Not found';
        let allEmailOptions = [];

        // TIER 1: Real emails found on page (regex from companyData)
        const regexEmails = companyData?._regexEmails || [];
        if (regexEmails.length > 0) {
            const classified = classifyEmail(regexEmails[0], domain);
            if (classified.trustLevel >= 95) { // Tier 1 confidence
                resolvedEmail = regexEmails[0];
                emailConfidence = classified.type;
                emailLabel = classified.label;
                allEmailOptions = regexEmails;
                console.log(`✅ [TIER 1] Regex email: ${resolvedEmail}`);
            }
        }

        // TIER 2: Personal email matching (if bestContact has an email)
        if (!resolvedEmail && bestContact?.email && isValidEmailFormat(bestContact.email)) {
            const classified = classifyEmail(bestContact.email, domain);
            if (classified.trustLevel >= 70) { // Tier 2 confidence
                resolvedEmail = bestContact.email;
                emailConfidence = classified.type;
                emailLabel = classified.label;
                allEmailOptions = [bestContact.email];
                console.log(`✅ [TIER 2] Reality-checked employee email: ${resolvedEmail}`);
            }
        }

        // TIER 2 (cont.): Guessed patterns (if bestContact name exists and no email yet)
        if (!resolvedEmail && bestContact?.name) {
            const guesses = guessEmailPatterns(bestContact.name, domain);
            for (const guess of guesses) {
                // For guessed patterns, we need to ensure MX validity and domain validity
                // MX validation is already done at the company level (mxValid variable)
                // Domain validity is handled by classifyEmail
                const classified = classifyEmail(guess, domain);
                if (classified.trustLevel >= 70 && mxValid) { // Tier 2 confidence and MX valid
                    resolvedEmail = guess;
                    emailConfidence = 'guessed-pattern'; // Specific type for guessed patterns
                    emailLabel = '⚠️ Pattern guess (MX valid)';
                    allEmailOptions = guesses;
                    console.log(`⚠️ [TIER 2] Pattern guess: ${resolvedEmail}`);
                    break;
                }
            }
        }

        // TIER 3: Linked Signals (currently covered by huntRealEmails, which searches broader)
        // The current huntRealEmails function already searches external sources like hunter.io, rocketreach.co
        // which can provide emails based on linked signals. We'll keep it as is for now,
        // but ensure its results are classified and scored appropriately.
        if (!resolvedEmail && getTavilyRemaining() > 0) {
            onProgress?.(`🎯 Hunting real email for ${companyName}...`);
            const huntResult = await huntRealEmails(companyName, domain, tavilyKey);
            if (huntResult.companyEmails.length > 0) {
                const classified = classifyEmail(huntResult.companyEmails[0], domain);
                // Only use if confidence is reasonable, as huntRealEmails can return various types
                if (classified.trustLevel >= 60) { // Assuming Tier 3/4 confidence for hunt results
                    resolvedEmail = huntResult.companyEmails[0];
                    emailConfidence = classified.type;
                    emailLabel = classified.label;
                    allEmailOptions = huntResult.companyEmails;
                    console.log(`✅ [TIER 3/4] Email hunt found: ${resolvedEmail}`);
                }
            }
        }

        // TIER 4: Generic Emails
        if (!resolvedEmail) {
            const genericEmails = [`info@${domain}`, `contact@${domain}`, `hello@${domain}`, `team@${domain}`];
            for (const genericEmail of genericEmails) {
                const classified = classifyEmail(genericEmail, domain);
                if (classified.trustLevel >= 30 && mxValid) { // Tier 4 confidence and MX valid
                    resolvedEmail = genericEmail;
                    emailConfidence = classified.type;
                    emailLabel = classified.label;
                    allEmailOptions = [genericEmail];
                    console.log(`⚠️ [TIER 4] Generic fallback: ${resolvedEmail}`);
                    break;
                }
            }
        }

        // TIER 5: No Result / Low Confidence
        if (!resolvedEmail || !isValidEmailFormat(resolvedEmail) || classifyEmail(resolvedEmail, domain).trustLevel < 50) {
            console.log(`❌ [TIER 5] No reliable email found for ${companyName}. Rejecting lead.`);
            return null; // Reject lead if no reliable email found
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

        let emailSource = null;
        if (emailConfidence === 'confirmed-founder-ceo' || emailConfidence === 'confirmed-personal' || emailConfidence === 'confirmed-other') {
            emailSource = 'regex'; // Direct extraction from page
        } else if (emailConfidence === 'guessed-pattern') {
            emailSource = 'guess'; // Pattern-based guess
        } else if (emailConfidence.includes('hunt')) { // Emails found via huntRealEmails
            emailSource = 'hunt';
        } else if (emailConfidence === 'confirmed-generic') {
            emailSource = 'generic'; // Generic inbox fallback
        }

        const leadScore = scoreLeadQuality({
            emailConfidence, mxValid,
            hasRealName:  !!bestContact?.name,
            hasLinkedIn:  !!bestContact?.linkedIn,
            hasNews:      !!companyData?.recentNews,
            hasMission:   !!companyData?.mission,
            dataScore,
            contactRole:  bestContact?.role,
            emailSource:  emailSource
        });

        console.log(`✅ ${companyName} → ${resolvedEmail} [${emailConfidence}] Score:${leadScore}/100 MX:${mxValid}`);

        return {
            name:            bestContact?.name || companyName,
            company:         companyName,
            domain:          domain,
            email:           resolvedEmail,
            emailConfidence: emailConfidence,
            emailLabel:      emailLabel,
            allEmailOptions: allEmailOptions,
            role:            bestContact?.role || (companyData?.model === 'B2B' ? 'Decision Maker' : 'Owner'),
            linkedIn:        bestContact?.linkedIn || null,
            companySize:     companyData?.size  || 'unknown',
            companyModel:    companyData?.model || 'unknown',
            industry:        intent.industry    || 'unknown',
            hq:              companyData?.hq    || null,
            recentNews:      companyData?.recentNews || null,
            leadScore,
            mxValid,
            dataScore,
            hallucinationFlags: companyData?._hallucinationFlags || [],
            emailLanguage:   detectedLanguage.code,
            messages: [
                { type: 'initial',  subject: emailSequence.initial.subject,  body: emailSequence.initial.body  },
                { type: 'followup', subject: emailSequence.followup.subject, body: emailSequence.followup.body },
                { type: 'breakup',  subject: emailSequence.breakup.subject,  body: emailSequence.breakup.body  }
            ]
        };

    } catch (err) {
        console.warn(`[processOneCompany Error] ${err.message}`);
        return null;
    }
}

// ─── MAIN: generateFreeResponse ────────────────────────────────────────────────
async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🟢 [LEAD ENGINE] Pipeline started...');
        onProgress?.('🧠 Understanding your request...');

        const apiKey    = process.env.OPENAI_API_KEY;
        const tavilyKey = process.env.TAVILY_API_KEY;

        const detectedLanguage = _detectLanguage(message);
        console.log(`🌐 [LANGUAGE] Detected: ${detectedLanguage.name} (${detectedLanguage.code})`);

        const intentPrompt = `Extract lead generation parameters from: "${message}".
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
            const intentRes = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: intentPrompt }],
                max_tokens: 150,
                temperature: 0.1,
            }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
            recordOpenAiUsage(intentRes.data?.usage?.total_tokens || 0);
            const raw    = intentRes.data.choices[0].message.content.replace(/```json|```/g, '');
            const parsed = JSON.parse(raw);
            intent = { ...intent, ...parsed };
            console.log(`🎯 Intent: ${JSON.stringify(intent)}`);
        } catch (e) { console.warn('[Intent Parse Failed]:', e.message); }

        onProgress?.(`🔍 Searching for ${intent.industry} companies${intent.location ? ' in ' + intent.location : ''}...`);
        const locationClause = intent.location ? `"${intent.location}"` : '';

        // ── FIX: Removed site:linkedin/crunchbase/apollo from query.
        // Those domains were being returned by Tavily and then immediately
        // killed by SKIP_DOMAINS — resulting in 0 cleanResults every time.
        // Now we target actual company websites via inurl: patterns only.
        const query = [
            `"${intent.target}"`, intent.industry, locationClause,
            'contact email CEO founder',
            'inurl:about OR inurl:team OR inurl:contact OR inurl:contact-us'
        ].filter(Boolean).join(' ');

        console.log(`🔍 Query: ${query}`);
        const rawResults = await searchWithTavily(query, tavilyKey, { maxResults: 10 });
        console.log(`🔎 RAW RESULTS (${rawResults.length}):`, rawResults.map(r => r.url));

        if (rawResults.length === 0) {
            return {
                reply: "No companies found. Try narrowing the industry or adding a location.",
                updatedHistory: [...history, { role: 'user', content: message }, { role: 'assistant', content: 'No leads found.' }]
            };
        }

        const SKIP_DOMAINS = [
            'linkedin.com','crunchbase.com','apollo.io','hunter.io',
            'yelp.com','clutch.co','g2.com','trustpilot.com',
            'bark.com','bark.london','upwork.com','fiverr.com','peopleperhour.com',
            'yell.com','thomsonlocal.com','checkatrade.com',
            'directory.com','yellowpages.com','manta.com',
        ];
        const seenDomains  = new Set();
        const cleanResults = [];
        for (const result of rawResults) {
            let domain = '';
            try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
            if (!domain || seenDomains.has(domain)) continue;
            if (SKIP_DOMAINS.some(d => domain.includes(d))) {
                console.log(`🗑️ Skipping known bad domain: ${domain}`);
                continue;
            }
            seenDomains.add(domain);
            cleanResults.push(result);
        }

        console.log(`✨ CLEAN RESULTS (${cleanResults.length}):`, cleanResults.map(r => r.url));

        if (cleanResults.length === 0) {
            return {
                reply: "No relevant company websites found. Try a different search query.",
                updatedHistory: [...history, { role: 'user', content: message }, { role: 'assistant', content: 'No clean leads found.' }]
            };
        }

        onProgress?.(`Processing ${cleanResults.length} companies...`);

        const companyTasks = cleanResults.slice(0, MAX_LEADS_RETURNED).map(result =>
            () => processOneCompany(result, intent, tavilyKey, apiKey, userProfile, onProgress, detectedLanguage)
        );

        const processedLeads = (await runWithConcurrency(companyTasks, CONCURRENCY_LIMIT))
            .filter(res => res.status === 'fulfilled' && res.value !== null)
            .map(res => res.value);

        const filteredLeads = processedLeads.filter(lead => lead.leadScore >= 50);

        console.log(`✅ Pipeline finished. Found ${filteredLeads.length} qualified leads.`);

        if (filteredLeads.length === 0) {
            return {
                reply: "No qualified leads found with a score of 50 or higher. Try refining your search criteria.",
                updatedHistory: [...history, { role: 'user', content: message }, { role: 'assistant', content: 'No qualified leads found.' }]
            };
        }

        const replyText = `Found ${filteredLeads.length} qualified leads. Here are the top results:\n\n` +
            filteredLeads.map(lead => {
                const contactInfo = lead.email ? `${lead.email} (Confidence: ${lead.emailConfidence}, Score: ${lead.leadScore}/100)` : 'No email found';
                return `**${lead.company}** (${lead.domain})\nRole: ${lead.role}\nContact: ${lead.name}\nEmail: ${contactInfo}\nNews: ${lead.recentNews || 'N/A'}\nLinkedIn: ${lead.linkedIn || 'N/A'}\n`;
            }).join('\n---\n\n');

        return {
            reply: replyText,
            leads: filteredLeads,
            updatedHistory: [...history, { role: 'user', content: message }, { role: 'assistant', content: replyText }]
        };

    } catch (err) {
        console.error('🔴 [LEAD ENGINE] Unhandled error:', err);
        return {
            reply: `An unexpected error occurred: ${err.message}`,
            updatedHistory: [...history, { role: 'user', content: message }, { role: 'assistant', content: `Error: ${err.message}` }]
        };
    }
}

module.exports = { generateFreeResponse };
