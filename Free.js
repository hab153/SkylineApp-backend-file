const axios = require('axios');
const dns   = require('dns').promises;

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const MAX_LEADS_RETURNED    = 5;
const TAVILY_LIMIT          = 1000;
const CONCURRENCY_LIMIT     = 2;              // [FIX-SPEED] Max parallel company pipelines
const CACHE_TTL_MS          = 60 * 60 * 1000; // [FIX-COST] Cache research results for 1 hour

// ─── REASONING FILTER ──────────────────────────────────────────────────────────
const REASONING_FILTER = `
⚠️ REASONING FILTER — NON-NEGOTIABLE:
1. You are a strict fact extractor. Use ONLY facts explicitly stated in SNIPPETS.
2. IGNORE all training data. If a fact is not in the snippets, return null.
3. NEVER invent names, emails, roles, or company details.
4. Current year is 2026.
`;

// ─── BANNED WORDS ──────────────────────────────────────────────────────────────
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

function buildBannedWordsInstruction() {
    return `BANNED WORDS — NEVER use any of these: ${BANNED_WORDS.join(', ')}. Always replace with a specific, concrete fact.`;
}

// ─── QUOTA TRACKERS ────────────────────────────────────────────────────────────
const tavilyQuota   = { used: 0, limit: TAVILY_LIMIT, lastReset: Date.now() };
const openAiTracker = { totalCallsThisSession: 0, totalTokensThisSession: 0 };
// [FIX-COST] Rough cost tracker — gpt-4o-mini ~$0.30/1M tokens blended
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

// ─── [FIX-COST] IN-MEMORY RESEARCH CACHE ──────────────────────────────────────
// Prevents re-searching the same domain within 1 hour. Kills duplicate Tavily spend.
const researchCache = new Map();

function getCachedResearch(domain) {
    const hit = researchCache.get(domain);
    if (!hit) return null;
    if (Date.now() - hit.timestamp > CACHE_TTL_MS) { researchCache.delete(domain); return null; }
    console.log(`💾 [CACHE HIT] ${domain} — skipping Tavily searches`);
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

// ─── EMAIL PATTERN GUESSER ─────────────────────────────────────────────────────
// Returns ordered guesses from most-likely to least-likely corporate formats
function guessEmailPatterns(fullName, domain) {
    if (!fullName || !domain) return [];
    const parts = fullName.toLowerCase().trim().split(/\s+/);
    if (parts.length < 2) return [`${parts[0]}@${domain}`];
    const [first, last] = [parts[0], parts[parts.length - 1]];
    return [
        `${first}.${last}@${domain}`,       // john.smith@  ← most common globally
        `${first}@${domain}`,               // john@
        `${first[0]}${last}@${domain}`,     // jsmith@
        `${first}${last[0]}@${domain}`,     // johns@
        `${first}_${last}@${domain}`,       // john_smith@
        `${last}.${first}@${domain}`,       // smith.john@
        `${first[0]}.${last}@${domain}`,    // j.smith@
    ];
}

// ─── [FIX-EMAIL-VERIFICATION] MX RECORD VALIDATOR ─────────────────────────────
// DNS check: does this domain actually have a mail server?
// If MX fails → bounce risk is HIGH. We flag it, not hide it.
async function validateMX(domain) {
    try {
        const records = await dns.resolveMx(domain);
        return records && records.length > 0;
    } catch {
        return false;
    }
}

// ─── [FIX-EMAIL-VERIFICATION] EMAIL FORMAT VALIDATOR ──────────────────────────
function isValidEmailFormat(email) {
    if (!email || typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

// ─── [FIX-EMAIL-VERIFICATION] FREE EMAIL PROVIDER DETECTOR ───────────────────
const FREE_EMAIL_PROVIDERS = new Set([
    'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com',
    'protonmail.com','aol.com','mail.com','yandex.com','zoho.com',
    'mailinator.com','guerrillamail.com','tempmail.com','throwam.com'
]);
function isFreeEmailDomain(domain) {
    return FREE_EMAIL_PROVIDERS.has(domain.toLowerCase());
}

// ─── [FIX-DATA-QUALITY] HALLUCINATION DETECTOR ────────────────────────────────
// Scans extracted data for red flags before it pollutes a lead object
function detectHallucinations(companyName, extracted) {
    const flags = [];

    if (Array.isArray(extracted.employees)) {
        extracted.employees.forEach((emp, i) => {
            // Flag: employee name contains the company name (GPT confusing entity)
            if (emp.name && companyName &&
                emp.name.toLowerCase().includes(companyName.toLowerCase().split(' ')[0])) {
                flags.push(`Employee[${i}] name contains company name: "${emp.name}"`);
            }
            // Flag: employee email domain doesn't match company domain
            if (emp.email && extracted._domain) {
                const emailDomain = emp.email.split('@')[1];
                if (emailDomain && emailDomain !== extracted._domain &&
                    !emailDomain.includes(extracted._domain.split('.')[0])) {
                    flags.push(`Employee[${i}] email domain "${emailDomain}" ≠ company domain "${extracted._domain}"`);
                }
            }
        });
    }

    // Flag: mission sounds suspiciously generic
    if (extracted.mission) {
        const genericPhrases = ['helping businesses','empowering companies','world-class','innovative solutions','cutting-edge'];
        if (genericPhrases.some(p => extracted.mission.toLowerCase().includes(p))) {
            flags.push(`Mission may be hallucinated/generic: "${extracted.mission}"`);
        }
    }

    // Flag: recentNews references old years (stale data)
    if (extracted.recentNews) {
        const yearMatch = extracted.recentNews.match(/\b(20\d{2})\b/);
        if (yearMatch && parseInt(yearMatch[1]) < 2023) {
            flags.push(`recentNews appears stale (year ${yearMatch[1]}): "${extracted.recentNews}"`);
        }
    }

    return flags;
}

// ─── [FIX-DATA-QUALITY] DATA COMPLETENESS SCORER (0-100) ─────────────────────
// Used to skip companies with too little data and save quota
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

// ─── [FIX-DEFENSIBILITY] LEAD QUALITY SCORER (0-100) ─────────────────────────
// This score shows in the UI — gives users confidence in each lead
function scoreLeadQuality({ emailConfidence, mxValid, hasRealName, hasLinkedIn, hasNews, hasMission, dataScore }) {
    let score = 0;
    // Email quality (most impactful on deliverability)
    if (emailConfidence === 'confirmed')              score += 35;
    else if (emailConfidence === 'confirmed-generic') score += 25;
    else if (emailConfidence === 'guessed-pattern')   score += 15;
    else                                              score +=  5;

    if (mxValid)        score += 20; // Domain actually receives mail
    if (hasRealName)    score += 15; // Named contact = personalization possible
    if (hasLinkedIn)    score += 10; // LinkedIn = can verify + connect
    if (hasNews)        score += 10; // Active company = responsive to outreach
    if (hasMission)     score +=  5; // Richer personalization context
    if (dataScore > 60) score +=  5; // Bonus for high data completeness

    return Math.min(score, 100);
}

// ─── [FIX-SPEED] CONCURRENCY POOL ─────────────────────────────────────────────
// Processes N async tasks at a time. One failure doesn't kill the batch.
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

// ─── COMPANY RESEARCH (Dual Search + Cache + Selective Deep Search) ────────────
async function researchCompanyForLead(companyName, domain, tavilyKey, openAiKey, onProgress) {
    // [FIX-COST] Cache check — skip if we already searched this domain recently
    const cached = getCachedResearch(domain);
    if (cached) return cached;

    if (getTavilyRemaining() <= 1) return null;

    try {
        onProgress?.(`🔍 Searching info on ${companyName}...`);

        // SEARCH 1: General info + public contact emails
        const generalResults = await searchWithTavily(
            `"${companyName}" contact email "contact@" OR "sales@" OR "info@" OR "hello@" site:${domain} OR site:linkedin.com OR site:crunchbase.com mission about 2025 2026`,
            tavilyKey, { maxResults: 5 }
        );

        const generalSnippets = generalResults
            .map(r => `SOURCE: ${r.url}\nTITLE: ${r.title}\n${r.snippet}`)
            .join('\n\n---\n\n');

        // [FIX-COST] SELECTIVE DEEP SEARCH:
        // Only fire employee search if general results are thin or lack email signals
        const hasEmailSignal    = generalSnippets.includes('@') || generalSnippets.toLowerCase().includes('contact');
        const needsEmployeeSearch = generalResults.length < 3 || !hasEmailSignal;

        let employeeResults = [];
        if (needsEmployeeSearch && getTavilyRemaining() > 0) {
            onProgress?.(`👤 Finding decision-makers at ${companyName}...`);
            employeeResults = await searchWithTavily(
                `"${companyName}" CEO OR founder OR "head of" OR "director of" OR "VP of" email LinkedIn`,
                tavilyKey, { maxResults: 4 }
            );
        }

        const allSnippets = [...generalResults, ...employeeResults]
            .map(r => `SOURCE: ${r.url}\nTITLE: ${r.title}\n${r.snippet}`)
            .join('\n\n---\n\n');

        if (allSnippets.trim().length === 0) return null;

        // EXTRACT structured data
        const extractPrompt = `${REASONING_FILTER}

You are extracting verified contact intelligence for the company "${companyName}" (domain: ${domain}).

Return ONLY valid JSON with this exact structure:
{
  "mission": "one sentence company mission or null",
  "hq": "City, Country or null",
  "size": "1-10 | 11-50 | 51-200 | 200+ | unknown",
  "model": "B2B | B2C | SaaS | Services | E-commerce | Agency | unknown",
  "recentNews": "one sentence about the most recent relevant company news or null",
  "contactEmails": [
    "Only generic role-based emails found in snippets: contact@, sales@, info@, hello@, support@, team@. Max 3. Empty array if none found."
  ],
  "employees": [
    {
      "name": "Full Name — ONLY if explicitly mentioned by name in snippets. null otherwise.",
      "role": "Their exact job title from snippets. CEO | Founder | Co-Founder | Director | VP | Manager | Head of X",
      "email": "Their email IF explicitly found in snippets. null otherwise. NEVER invent.",
      "linkedIn": "Their LinkedIn profile URL if found in snippets. null otherwise."
    }
  ]
}

STRICT RULES:
- contactEmails: ONLY emails literally visible in snippets. Do NOT construct them.
- employees: ONLY real named humans explicitly mentioned. Max 3.
- If a field is not in snippets, it is null. Never invent data.
- Return ONLY the JSON object. No markdown, no explanation.

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

        // Attach domain for cross-validation
        parsed._domain = domain;

        // [FIX-DATA-QUALITY] Hallucination scan
        const hallucinations = detectHallucinations(companyName, parsed);
        if (hallucinations.length > 0) {
            console.warn(`⚠️ [HALLUCINATION FLAGS] ${companyName}:`, hallucinations);
            parsed._hallucinationFlags = hallucinations;
            // Remove employees that triggered hallucination flags
            if (Array.isArray(parsed.employees)) {
                parsed.employees = parsed.employees.filter(emp => {
                    const isSuspect = hallucinations.some(f => f.includes(emp.name));
                    if (isSuspect) console.warn(`🗑️ Removed suspect employee: ${emp.name}`);
                    return !isSuspect;
                });
            }
        }

        // Enrich employees with pattern-guessed emails
        if (Array.isArray(parsed.employees)) {
            parsed.employees = parsed.employees.map(emp => {
                if (emp.name && !emp.email && domain) {
                    emp.emailGuesses    = guessEmailPatterns(emp.name, domain);
                    emp.emailConfidence = 'guessed';
                } else if (emp.email) {
                    emp.emailGuesses    = [emp.email];
                    emp.emailConfidence = 'confirmed';
                }
                return emp;
            });
        }

        // [FIX-COST] Store in cache
        setCachedResearch(domain, parsed);
        return parsed;

    } catch (err) {
        console.warn(`[Research Error] ${err.message}`);
        return null;
    }
}

// ─── EMAIL SEQUENCE WRITER ─────────────────────────────────────────────────────
async function generateEmailsForLead(companyData, contactPerson, domain, userProfile, openAiKey) {
    try {
        const companyName   = companyData.name;
        const mission       = companyData.mission || null;
        const news          = companyData.recentNews || null;
        const senderName    = userProfile?.senderName || 'Alex';
        const usp           = userProfile?.usp || 'We help businesses grow with AI automation.';
        const contactName   = contactPerson?.name || null;
        const contactRole   = contactPerson?.role || null;
        const firstNameOnly = contactName ? contactName.split(' ')[0] : null;

        const writePrompt = `${buildBannedWordsInstruction()}

You are a world-class B2B cold email copywriter. Write a 3-email outreach sequence.

TARGET COMPANY: ${companyName}
${contactName ? `CONTACT: ${contactName} (${contactRole || 'Decision Maker'})` : 'CONTACT: General company contact'}
${mission ? `COMPANY MISSION: ${mission}` : ''}
${news    ? `RECENT NEWS: ${news}` : ''}
SENDER: ${senderName}
VALUE PROP: ${usp}

EMAIL 1 — INITIAL:
- Subject: 4-6 words. Specific. References company or news. No generic openers.
- Para 1: Hook using ${news || mission || `${companyName}'s work`}. 1-2 sentences.
- Para 2: Connect "${usp}" to a specific result. No vague claims.
- Para 3: One soft CTA. Example: "Worth 15 minutes this week?"
- Salutation: "${firstNameOnly || 'Hi'}" — never "Dear" or "Hello Team".
- Sign-off: Best, ${senderName}

EMAIL 2 — FOLLOW-UP (3 days later):
- Subject: "Re: " + Email 1 subject.
- 2 paragraphs. New insight or relevant result. Re-state CTA. Max 4 sentences.

EMAIL 3 — BREAK-UP (7 days later):
- Subject: "Closing my file on ${companyName}"
- 3 sentences. No sell. Acknowledge timing. Leave door open gracefully.

NO banned words. Every sentence earns its place.

Return ONLY valid JSON:
{
  "initial":  { "subject": "string", "body": "string" },
  "followup": { "subject": "string", "body": "string" },
  "breakup":  { "subject": "string", "body": "string" }
}`;

        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: writePrompt }],
            max_tokens: 700,
            temperature: 0.65,
        }, { headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' } });

        recordOpenAiUsage(res.data?.usage?.total_tokens || 0);

        const raw = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        return JSON.parse(raw);

    } catch (err) {
        console.warn(`[Email Gen Error] ${err.message}`);
        const name = contactPerson?.name?.split(' ')[0] || 'Hi';
        return {
            initial:  { subject: `Quick thought on ${companyData.name}`, body: `${name},\n\nSaw what ${companyData.name} is building — worth a direct note.\n\n${userProfile?.usp || 'We help teams move faster.'}\n\nOpen to 15 minutes this week?\n\nBest,\n${userProfile?.senderName || 'Alex'}` },
            followup: { subject: `Re: Quick thought on ${companyData.name}`, body: `${name},\n\nFloating this back up — wanted to share one result we've seen at similar companies.\n\nStill worth a chat?\n\nBest,\n${userProfile?.senderName || 'Alex'}` },
            breakup:  { subject: `Closing my file on ${companyData.name}`, body: `${name},\n\nAssuming the timing isn't right — I'll stop following up. Reach out whenever it makes sense.\n\nBest,\n${userProfile?.senderName || 'Alex'}` }
        };
    }
}

// ─── SINGLE COMPANY PIPELINE ───────────────────────────────────────────────────
// Fully self-contained pipeline for one company.
// Runs in parallel with other companies via runWithConcurrency.
async function processOneCompany(result, intent, tavilyKey, apiKey, userProfile, onProgress) {
    try {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
        if (!domain) return null;

        // Skip results that landed on free email providers (junk results)
        if (isFreeEmailDomain(domain)) return null;

        let companyName = result.title.split(/[|\-–]/)[0].trim();
        if (companyName.length > 40) companyName = companyName.substring(0, 40).trim();
        if (!companyName || companyName.toLowerCase() === 'home') return null;

        onProgress?.(`📋 Researching ${companyName}...`);
        console.log(`📋 Processing: ${companyName} (${domain})`);

        // [FIX-SPEED] MX validation runs in parallel with company research
        const [companyData, mxValid] = await Promise.all([
            researchCompanyForLead(companyName, domain, tavilyKey, apiKey, onProgress),
            validateMX(domain)
        ]);

        if (!mxValid) {
            console.warn(`⚠️ [MX FAIL] ${domain} — no mail server found. High bounce risk.`);
        }

        // [FIX-DATA-QUALITY] Gate: skip low-data companies
        const dataScore = scoreDataCompleteness(companyData);
        if (dataScore < 10) {
            console.warn(`🗑️ Skipping ${companyName} — data score too low (${dataScore}/100)`);
            return null;
        }

        // Select best contact by preferred role
        let bestContact = null;
        const employees = companyData?.employees || [];
        if (employees.length > 0) {
            const preferred = intent.preferredContact?.toLowerCase();
            bestContact = employees.find(e =>
                e.role && preferred && preferred !== 'any' &&
                e.role.toLowerCase().includes(preferred)
            ) || employees[0];
        }

        // ── Resolve best email (priority chain) ──────────────────────────────
        let resolvedEmail   = null;
        let emailConfidence = 'guessed-fallback';
        let allEmailOptions = [];

        if (bestContact?.email && isValidEmailFormat(bestContact.email)) {
            resolvedEmail   = bestContact.email;
            emailConfidence = 'confirmed';
            allEmailOptions = [bestContact.email];
        } else if (bestContact?.emailGuesses?.length > 0) {
            resolvedEmail   = bestContact.emailGuesses[0];
            emailConfidence = 'guessed-pattern';
            allEmailOptions = bestContact.emailGuesses;
        } else if (companyData?.contactEmails?.length > 0) {
            const validContacts = companyData.contactEmails.filter(isValidEmailFormat);
            if (validContacts.length > 0) {
                resolvedEmail   = validContacts[0];
                emailConfidence = 'confirmed-generic';
                allEmailOptions = validContacts;
            }
        }

        if (!resolvedEmail || !isValidEmailFormat(resolvedEmail)) {
            resolvedEmail   = `contact@${domain}`;
            emailConfidence = 'guessed-fallback';
            allEmailOptions = [`contact@${domain}`, `info@${domain}`, `hello@${domain}`];
        }

        onProgress?.(`✍️ Writing email sequence for ${companyName}...`);

        const emailSequence = await generateEmailsForLead(
            { name: companyName, mission: companyData?.mission, recentNews: companyData?.recentNews },
            bestContact,
            domain,
            userProfile,
            apiKey
        );

        // [FIX-DEFENSIBILITY] Score lead quality for frontend badge
        const leadScore = scoreLeadQuality({
            emailConfidence,
            mxValid,
            hasRealName:  !!bestContact?.name,
            hasLinkedIn:  !!bestContact?.linkedIn,
            hasNews:      !!companyData?.recentNews,
            hasMission:   !!companyData?.mission,
            dataScore
        });

        console.log(`✅ ${companyName} → ${resolvedEmail} [${emailConfidence}] Score: ${leadScore}/100 MX: ${mxValid}`);

        return {
            // Contact
            name:             bestContact?.name || companyName,
            company:          companyName,
            domain:           domain,
            email:            resolvedEmail,
            emailConfidence:  emailConfidence,
            allEmailOptions:  allEmailOptions,
            role:             bestContact?.role || (companyData?.model === 'B2B' ? 'Decision Maker' : 'Owner'),
            linkedIn:         bestContact?.linkedIn || null,
            // Company
            companySize:      companyData?.size || 'unknown',
            companyModel:     companyData?.model || 'unknown',
            hq:               companyData?.hq || null,
            recentNews:       companyData?.recentNews || null,
            // Quality signals (for frontend display)
            leadScore:        leadScore,
            mxValid:          mxValid,
            dataScore:        dataScore,
            hallucinationFlags: companyData?._hallucinationFlags || [],
            // Email sequence
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

        // ── STEP 1: Parse intent ──────────────────────────────────────────────
        const intentPrompt = `Extract lead generation parameters from this message: "${message}".
Return ONLY valid JSON:
{
  "target": "description of ideal customer or company type",
  "industry": "specific industry or niche",
  "location": "city, country, or region — null if not mentioned",
  "preferredContact": "CEO | Founder | Marketing | Sales | Owner | Any"
}
If unsure, make a reasonable inference. Do not return null for target or industry.`;

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
        } catch (e) {
            console.warn('[Intent Parse Failed] Using defaults:', e.message);
        }

        // ── STEP 2: Search for companies ──────────────────────────────────────
        onProgress?.(`🔍 Searching for ${intent.industry} companies${intent.location ? ' in ' + intent.location : ''}...`);

        const locationClause = intent.location ? `"${intent.location}"` : '';
        const query = [
            `"${intent.target}"`,
            intent.industry,
            locationClause,
            'contact email CEO founder',
            'site:linkedin.com OR site:crunchbase.com OR site:apollo.io OR inurl:about OR inurl:team OR inurl:contact'
        ].filter(Boolean).join(' ');

        console.log(`🔍 Search Query: ${query}`);
        const rawResults = await searchWithTavily(query, tavilyKey, { maxResults: 10 });

        if (rawResults.length === 0) {
            return {
                reply: "No companies found for that search. Try narrowing the industry or adding a location.",
                updatedHistory: [...history,
                    { role: 'user', content: message },
                    { role: 'assistant', content: 'No leads found.' }
                ]
            };
        }

        // ── STEP 3: Deduplicate and filter raw results ────────────────────────
        const SKIP_DOMAINS = ['linkedin.com','crunchbase.com','apollo.io','hunter.io','yelp.com','clutch.co','g2.com','trustpilot.com'];
        const seenDomains  = new Set();
        const cleanResults = [];

        for (const result of rawResults) {
            let domain = '';
            try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
            if (!domain || seenDomains.has(domain)) continue;
            if (SKIP_DOMAINS.some(d => domain.includes(d))) continue;
            seenDomains.add(domain);
            cleanResults.push({ ...result, _domain: domain });
            if (cleanResults.length >= MAX_LEADS_RETURNED + 3) break; // Buffer for pipeline failures
        }

        // ── STEP 4: [FIX-SPEED] Parallel pipeline with concurrency cap ────────
        onProgress?.(`⚙️ Researching ${cleanResults.length} companies in parallel...`);

        const tasks = cleanResults.map(result => () =>
            processOneCompany(result, intent, tavilyKey, apiKey, userProfile, onProgress)
        );

        const settled = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);

        // Collect, filter nulls, sort by score descending
        const leadsToReturn = settled
            .filter(r => r.status === 'fulfilled' && r.value !== null)
            .map(r => r.value)
            .sort((a, b) => b.leadScore - a.leadScore) // [FIX-DEFENSIBILITY] Best leads first
            .slice(0, MAX_LEADS_RETURNED);

        // ── STEP 5: Session cost report ───────────────────────────────────────
        console.log(`🏁 Done. ${leadsToReturn.length} leads built.`);
        console.log(`📊 GPT calls: ${openAiTracker.totalCallsThisSession} | Tokens: ${openAiTracker.totalTokensThisSession} | Cost: ~$${costTracker.estimatedUSDThisSession.toFixed(4)}`);
        console.log(`🔍 Tavily: ${tavilyQuota.used}/${tavilyQuota.limit} used this month`);

        if (leadsToReturn.length === 0) {
            return {
                reply: "Found companies but couldn't verify enough data to build leads. Try a different industry or location.",
                updatedHistory: [...history,
                    { role: 'user', content: message },
                    { role: 'assistant', content: 'No leads extracted.' }
                ]
            };
        }

        return {
            reply: JSON.stringify(leadsToReturn),
            updatedHistory: [...history,
                { role: 'user', content: message },
                { role: 'assistant', content: `[Generated ${leadsToReturn.length} leads]` }
            ]
        };

    } catch (error) {
        console.error('❌ [LEAD ENGINE] Fatal error:', error.message);
        return {
            reply: "An error occurred while generating leads. Please try again.",
            updatedHistory: history
        };
    }
}

module.exports = { generateFreeResponse };
