const axios = require('axios');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const MAX_SEARCH_RESULTS = 40;
const MAX_LEADS_RETURNED = 3;
const TAVILY_LIMIT       = 1000;  // Free tier: 1000 requests/month

// ─── REASONING FILTER (injected into every GPT prompt that touches facts) ─────
const REASONING_FILTER = `
⚠️ REASONING FILTER — NON-NEGOTIABLE. READ BEFORE ANYTHING ELSE:
1. You are a strict fact extractor. You may ONLY use facts that appear verbatim or are clearly implied in the SNIPPETS provided in this prompt.
2. You MUST COMPLETELY IGNORE everything you know from your training data about this company, its people, its products, or its financials.
3. If a fact is not present in the snippets, you MUST return null for that field. Never guess. Never infer from training memory.
4. If a snippet contradicts your training data, the SNIPPET IS CORRECT. Training data is outdated. Snippets are live.
5. Never invent names, titles, funding rounds, dates, or locations. If you cannot find it in the snippets, it does not exist for this task.
6. The current year is 2026. Any reference to "current", "latest", or "now" means 2026. Reject any fact that appears to be from before 2024 unless it is historical context explicitly requested.
`;

// ─── PERSONALIZATION GUARDS ────────────────────────────────────────────────────
const BANNED_WORDS = [
    // AI filler
    'transformative','seamless','mission-critical','synergy','game-changer',
    'revolutionary','cutting-edge','innovative','disruptive','next-level',
    'holistic','robust','scalable','leverage','streamline','optimize',
    'empower','unlock','elevate','enhance','boost','accelerate','amplify',
    'delve','awe-inspiring','exciting','landscape','unleash','dynamic',
    'groundbreaking','paradigm','ecosystem','value-add','best-in-class',
    // Spam triggers
    'I hope this finds you well','I wanted to reach out','touch base',
    'circle back','quick question','just following up','as per my last email',
    'I am reaching out because','My name is','I hope you are doing well',
    'I hope you\'re having a great day',
    // Weak CTAs
    'let me know your thoughts','feel free to','do not hesitate',
    'please find attached','as mentioned','at your earliest convenience',
    // Vague filler
    'in today\'s world','in the current landscape','in this day and age',
    'more important than ever','going forward','moving forward'
];

function buildBannedWordsInstruction() {
    return `BANNED WORDS & PHRASES — HARD RULE. NEVER use any of the following:
${BANNED_WORDS.map(w => `  ✗ "${w}"`).join('\n')}

If you feel the urge to use one of these words, STOP. Replace it with a specific fact, number, name, or date from the research instead. Vague language is not allowed.`;
}

// ─── FINANCIAL SIZE SANITY THRESHOLDS ─────────────────────────────────────────
const ENTERPRISE_KEYWORDS = [
    'nasdaq','nyse','publicly traded','public company','ftse','fortune 500',
    'fortune 100','billion','trillion','s&p 500','listed company','ipo',
    'market cap','stock ticker','sec filing','annual report'
];

// ─── FLAG STORE ────────────────────────────────────────────────────────────────
const flagStore = {
    flaggedLeads:    [],
    flaggedContacts: [],
    flaggedDomains:  new Set(),
};

function flagBadLead(url, reason = 'user_reported') {
    const domain = extractDomain(url);
    flagStore.flaggedLeads.push({ url, reason, flaggedAt: new Date().toISOString() });
    flagStore.flaggedDomains.add(domain);
    console.warn(`🚩 [FLAG] Lead flagged: ${url} (Reason: ${reason}). Domain "${domain}" blocked for this session.`);
    return { flagged: true, domain, message: `"${domain}" excluded from future searches this session.` };
}

function flagBadContact(name, companyName, reason = 'user_reported') {
    flagStore.flaggedContacts.push({ name, companyName, reason, flaggedAt: new Date().toISOString() });
    console.warn(`🚩 [FLAG] Contact flagged: ${name} at ${companyName} (Reason: ${reason}).`);
    return { flagged: true, message: `"${name}" flagged and excluded from future outreach.` };
}

function getFlagSummary() {
    return {
        totalFlaggedLeads:    flagStore.flaggedLeads.length,
        totalFlaggedContacts: flagStore.flaggedContacts.length,
        skippedDomains:       [...flagStore.flaggedDomains],
    };
}

// ─── TAVILY QUOTA TRACKER ─────────────────────────────────────────────────────
const tavilyQuota = {
    used:      0,
    limit:     TAVILY_LIMIT,
    lastReset: Date.now(),
};

function checkTavilyReset() {
    const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - tavilyQuota.lastReset >= ONE_MONTH) {
        console.log(`♻️  [QUOTA] Tavily monthly quota reset. Was ${tavilyQuota.used}/${tavilyQuota.limit} — now 0.`);
        tavilyQuota.used      = 0;
        tavilyQuota.lastReset = Date.now();
    }
}

function getTavilyRemaining() {
    checkTavilyReset();
    return tavilyQuota.limit - tavilyQuota.used;
}

function recordTavilyUsage() {
    tavilyQuota.used += 1;
    const remaining = getTavilyRemaining();
    console.log(`📊 [QUOTA] Tavily: ${tavilyQuota.used}/${tavilyQuota.limit} used (${remaining} remaining).`);
    if (remaining <= 0) {
        console.warn('🔴 [QUOTA] Tavily monthly limit reached. No more searches until reset.');
    }
}

function getTavilyQuotaSummary() {
    checkTavilyReset();
    const remaining = getTavilyRemaining();
    const pct       = Math.round((tavilyQuota.used / tavilyQuota.limit) * 100);
    const status    = remaining <= 0
        ? '🔴 EXHAUSTED'
        : remaining < tavilyQuota.limit * 0.1
            ? '🟡 LOW'
            : '🟢 OK';
    return `📊 Tavily Search: ${tavilyQuota.used}/${tavilyQuota.limit} used (${pct}%) ${status} · Resets monthly`;
}

// ─── OPENAI TOKEN TRACKER ─────────────────────────────────────────────────────
const openAiTracker = {
    totalCallsThisSession:    0,
    totalTokensThisSession:   0,
    callLog: [],   // { fn, model, tokens, timestamp }
};

function recordOpenAiUsage(fnName, model, tokensUsed) {
    openAiTracker.totalCallsThisSession  += 1;
    openAiTracker.totalTokensThisSession += tokensUsed;
    openAiTracker.callLog.push({
        fn:        fnName,
        model,
        tokens:    tokensUsed,
        timestamp: new Date().toISOString(),
    });
    console.log(`🧮 [TOKENS] ${fnName} (${model}): ${tokensUsed} tokens. Session total: ${openAiTracker.totalTokensThisSession}`);
}

function getFullCreditDashboard() {
    checkTavilyReset();
    const tavilyRemaining = getTavilyRemaining();
    const tavilyPct       = Math.round((tavilyQuota.used / tavilyQuota.limit) * 100);
    const tavilyStatus    = tavilyRemaining <= 0 ? '🔴 EXHAUSTED'
        : tavilyRemaining < tavilyQuota.limit * 0.1 ? '🟡 LOW' : '🟢 OK';

    return {
        tavily: {
            used:      tavilyQuota.used,
            limit:     tavilyQuota.limit,
            remaining: tavilyRemaining,
            pct:       tavilyPct,
            status:    tavilyStatus,
        },
        openai: {
            callsThisSession:  openAiTracker.totalCallsThisSession,
            tokensThisSession: openAiTracker.totalTokensThisSession,
            callLog:           openAiTracker.callLog.slice(-10),  // Last 10 calls
        },
        flags: getFlagSummary(),
        summary: `📊 Tavily: ${tavilyQuota.used}/${tavilyQuota.limit} (${tavilyPct}%) ${tavilyStatus} | OpenAI: ${openAiTracker.totalCallsThisSession} calls, ${openAiTracker.totalTokensThisSession} tokens this session`,
    };
}

// ─── TAVILY SEARCH (UPGRADED — Advanced depth + date filter) ─────────────────
async function searchWithTavily(query, tavilyKey, options = {}) {
    const response = await axios.post('https://api.tavily.com/search', {
        api_key:             tavilyKey,
        query,
        search_depth:        'advanced',           // MANDATORY: always advanced, never basic
        max_results:         options.maxResults || 10,
        include_answer:      options.includeAnswer || false,
        include_raw_content: options.rawContent    || false,
    }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 12000,   // 12 second timeout — never hang the pipeline
    });

    const results = (response.data?.results || []).map(r => ({
        title:   r.title          || '',
        url:     r.url            || '',
        snippet: r.content        || '',
        date:    r.published_date || null,
    }));

    // ── STRICT DATE FILTER ──────────────────────────────────────────────────
    // Priority 1: Results from last 30 days
    // Priority 2: Results from last 90 days
    // Priority 3: All results (fallback — never block the pipeline)
    const now         = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

    const recent30  = results.filter(r => r.date && (now - new Date(r.date).getTime()) <= THIRTY_DAYS);
    const recent90  = results.filter(r => r.date && (now - new Date(r.date).getTime()) <= NINETY_DAYS);
    const undated   = results.filter(r => !r.date);

    let prioritized;
    if (recent30.length >= 2) {
        prioritized = [...recent30, ...undated];
        console.log(`📅 [DATE FILTER] ${recent30.length} results from last 30 days — prioritized.`);
    } else if (recent90.length >= 2) {
        prioritized = [...recent90, ...undated];
        console.log(`📅 [DATE FILTER] Falling back to 90-day window (${recent90.length} results).`);
    } else {
        prioritized = results;
        console.log(`📅 [DATE FILTER] No recent results — using all ${results.length} (verify dates manually).`);
    }

    return prioritized;
}

// ─── MULTI-STEP SEARCH RE-QUERY LOOP ─────────────────────────────────────────
async function searchWithFallback(primaryQuery, fallbackQuery, tavilyKey, options = {}) {
    let results = [];

    // ── Attempt 1: Primary query ────────────────────────────────────────────
    try {
        if (getTavilyRemaining() <= 0) throw new Error('Quota exhausted');
        console.log(`🔍 [SEARCH] Primary query: "${primaryQuery}"`);
        results = await searchWithTavily(primaryQuery, tavilyKey, options);
        recordTavilyUsage();
        console.log(`📦 [SEARCH] Primary returned ${results.length} results.`);
    } catch (err) {
        console.warn(`⚠️ [SEARCH] Primary failed: ${err.message}`);
        recordTavilyUsage();
    }

    // ── Attempt 2: Fallback if primary is weak (fewer than 2 results) ───────
    if (results.length < 2 && fallbackQuery && getTavilyRemaining() > 0) {
        console.log(`🔄 [RE-QUERY] Primary weak. Triggering fallback: "${fallbackQuery}"`);
        try {
            const fallbackResults = await searchWithTavily(fallbackQuery, tavilyKey, options);
            recordTavilyUsage();
            results = [...results, ...fallbackResults];
            console.log(`✅ [RE-QUERY] Fallback added ${fallbackResults.length} results. Total: ${results.length}`);
        } catch (err) {
            console.warn(`⚠️ [RE-QUERY] Fallback failed: ${err.message}`);
            recordTavilyUsage();
        }
    }

    return results;
}

// ─── MULTI-QUERY SEARCH RUNNER ────────────────────────────────────────────────
async function searchBusinessesOnline(queries, tavilyKey) {
    const allResults  = [];
    const seenDomains = new Set();

    for (const query of queries) {
        if (allResults.length >= MAX_SEARCH_RESULTS) break;

        if (getTavilyRemaining() <= 0) {
            console.warn('🚫 [SEARCH] Tavily quota exhausted. Cannot continue searching.');
            break;
        }

        try {
            console.log(`🔍 [Tavily] Query: "${query}"`);
            const results = await searchWithTavily(query, tavilyKey);
            recordTavilyUsage();

            for (const r of results) {
                const domain = extractDomain(r.url || '');

                // Skip flagged domains
                if (flagStore.flaggedDomains.has(domain)) {
                    console.log(`⏭️ [SKIP] Flagged domain skipped: ${domain}`);
                    continue;
                }

                if (domain && !seenDomains.has(domain) && allResults.length < MAX_SEARCH_RESULTS) {
                    seenDomains.add(domain);
                    allResults.push(r);
                }
            }

        } catch (err) {
            console.warn(`⚠️  [Tavily] Search error: ${err.message}`);
            recordTavilyUsage();
        }
    }

    console.log(`📦 [SEARCH] Done — ${allResults.length} unique results collected.`);
    return allResults;
}

// ─── SESSION STORE ────────────────────────────────────────────────────────────
const sessionStore = new Map();

function getSession(userId) {
    if (!sessionStore.has(userId)) {
        sessionStore.set(userId, {
            phase: 'intake',
            profile: {
                targetDescription: null,
                industry:          null,
                painPoint:         null,
                location:          null,
                businessSize:      null,
                budget:            null,
            },
            lastSearchQueries: [],
            lastLeads:         [],
            lastResearchCache: {},  // companyUrl -> ResearchReport
        });
    }
    return sessionStore.get(userId);
}

function resetSession(userId) {
    sessionStore.delete(userId);
    return getSession(userId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ███  MODULE 1 — THE RESEARCH MODULE ("The Eyes")
// ═══════════════════════════════════════════════════════════════════════════════

// ─── SNIPPET CLEANER (Facebook/Slang Filter) ──────────────────────────────────
function cleanSearchSnippets(results, companyName) {
    if (!results || results.length === 0) return results;

    const snippetText = results.map(r => r.snippet || '').join(' ').toLowerCase();
    const localSignals = [
        'facebook','fb.com','whatsapp','follow us','like our page',
        'pls','plz','dm us','inbox us','repost','share this',
        'lol','haha','amazing grace','brother','sister','brethren',
        'click the link in bio','tap the link','swipe up','story time',
        'blessed','amen','prayer','🙏','😂','🔥','❤️','👇'
    ];
    const isLocalContent = localSignals.some(s => snippetText.includes(s));

    if (!isLocalContent) return results;

    console.log(`🧹 [CLEANER] Social/local content detected for "${companyName}". Sanitizing snippets...`);

    return results.map(r => ({
        ...r,
        snippet: (r.snippet || '')
            .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
            .replace(/[\u{2600}-\u{27BF}]/gu, '')
            .replace(/\b(pls|plz|dm us|inbox us|follow us|like our page|repost|share this|tap the link|swipe up|click the link in bio)\b/gi, '')
            .replace(/\b(lol|haha|omg|lmao|tbh|imo|fyi|smh|ngl|blessed|amen)\b/gi, '')
            .replace(/\s{2,}/g, ' ')
            .trim()
    }));
}

// ─── NULL SANITIZER ───────────────────────────────────────────────────────────
function sanitizeProfile(profile, companyName) {
    // ZERO NULLS POLICY: Every field must return a professional human-readable value
    return {
        missionStatement: profile.missionStatement
            || `${companyName} is an active business — mission statement not publicly indexed.`,
        founded:          profile.founded
            || 'Founding year not publicly listed',
        headquarters:     profile.headquarters
            || 'Headquarters location not indexed',
        employeeCount:    (profile.employeeCount && profile.employeeCount !== 'unknown')
            ? profile.employeeCount
            : 'Team size not publicly listed',
        businessModel:    (profile.businessModel && profile.businessModel !== 'unknown')
            ? profile.businessModel
            : 'Business model not classified',
        primaryProduct:   profile.primaryProduct
            || `${companyName}'s core offering — details not publicly indexed.`,
        websiteUrl:       profile.websiteUrl || null,
    };
}

// ─── DEEP NEWS INTELLIGENCE + BUYING SIGNALS + SENTIMENT ─────────────────────
async function fetchCompanyNews(companyName, tavilyKey, openAiKey) {
    if (getTavilyRemaining() <= 0) {
        console.warn('🚫 [NEWS] Tavily quota exhausted.');
        return [];
    }

    try {
        console.log(`📰 [NEWS] Running deep intelligence fetch for: "${companyName}"`);

        // 3 parallel targeted queries — each hunting a different signal type
        const [rawGrowth, rawRisk, rawHiring] = await Promise.allSettled([
            searchWithTavily(`${companyName} news announcement expansion launch 2025 2026`, tavilyKey, { maxResults: 5 }),
            searchWithTavily(`${companyName} funding raised investment series valuation 2025 2026`, tavilyKey, { maxResults: 5 }),
            searchWithTavily(`${companyName} hiring jobs team growth problems challenges`, tavilyKey, { maxResults: 5 }),
        ]);

        recordTavilyUsage();
        recordTavilyUsage();
        recordTavilyUsage();

        const allRaw = [
            ...(rawGrowth.status  === 'fulfilled' ? rawGrowth.value  : []),
            ...(rawRisk.status    === 'fulfilled' ? rawRisk.value    : []),
            ...(rawHiring.status  === 'fulfilled' ? rawHiring.value  : []),
        ];

        // Deduplicate by URL
        const seenUrls   = new Set();
        const deduped    = allRaw.filter(r => {
            if (!r.url || seenUrls.has(r.url)) return false;
            seenUrls.add(r.url);
            return true;
        });

        // Clean social media noise
        const cleaned = cleanSearchSnippets(deduped, companyName);
        const top5    = cleaned.slice(0, 5);

        if (top5.length === 0) return [];

        // Single GPT-4o-mini batch call to classify all items
        const snippetsForGPT = top5.map((r, i) =>
            `ITEM ${i}:\nTitle: ${r.title}\nSnippet: ${r.snippet?.slice(0, 300) || ''}\nDate: ${r.date || 'Unknown'}\nURL: ${r.url}`
        ).join('\n\n---\n\n');

        const classifyResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{
                role: 'user',
                content: `${REASONING_FILTER}

TASK: Analyze these ${top5.length} news items about "${companyName}".
For each item, return:
- sentiment: "positive", "negative", or "neutral"
- signalType: "growth" | "risk" | "funding" | "product" | "hiring" | "expansion" | "other"
- buyingSignal: true if this news indicates the company is growing, hiring, expanding, or just received funding (any of these = likely buying). false otherwise.
- sourceUrl: copy the URL exactly from the item

Return ONLY a valid JSON array. No markdown. No explanation:
[
  { "index": 0, "sentiment": "...", "signalType": "...", "buyingSignal": true, "sourceUrl": "..." },
  ...
]

NEWS ITEMS:
${snippetsForGPT}`
            }],
            max_tokens: 400,
            temperature: 0.1,
        }, {
            headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }
        });

        recordOpenAiUsage('fetchCompanyNews', 'gpt-4o-mini', classifyResponse.data?.usage?.total_tokens || 0);

        let classifications = [];
        try {
            const raw      = classifyResponse.data.choices[0].message.content.trim();
            const cleaned2 = raw.replace(/```json|```/g, '').trim();
            classifications = JSON.parse(cleaned2);
        } catch (e) {
            console.warn('⚠️ [NEWS] Classification parse failed. Using defaults.');
        }

        const finalNews = top5.map((r, idx) => {
            const meta = classifications.find(c => c.index === idx) || {};
            return {
                headline:     r.title,
                summary:      r.snippet ? r.snippet.slice(0, 250) : '',
                url:          r.url,     // SOURCE URL always included for verification
                date:         r.date    || 'Date not indexed',
                sentiment:    meta.sentiment   || 'neutral',
                signalType:   meta.signalType  || 'other',
                buyingSignal: meta.buyingSignal ?? false,
            };
        });

        console.log(`✅ [NEWS] ${finalNews.length} classified headlines. Buying signals: ${finalNews.filter(n => n.buyingSignal).length}`);
        return finalNews;

    } catch (err) {
        console.warn(`⚠️ [NEWS] Failed: ${err.message}`);
        return [];
    }
}

// ─── FULL COMPANY PROFILE BUILDER ─────────────────────────────────────────────
async function extractMissionStatement(companyUrl, companyName, tavilyKey, openAiKey) {
    const defaultProfile = {
        missionStatement: null,
        founded:          null,
        headquarters:     null,
        employeeCount:    'unknown',
        businessModel:    'unknown',
        primaryProduct:   null,
        websiteUrl:       companyUrl || null,
        isEnterprise:     false,
        companySizeClass: 'unknown',  // 'local' | 'sme' | 'enterprise' | 'unknown'
    };

    if (getTavilyRemaining() <= 0) return sanitizeProfile(defaultProfile, companyName);

    try {
        console.log(`🎯 [PROFILE] Building company profile for: "${companyName}"`);

        const results = await searchWithTavily(
            `${companyName} about us mission founded headquarters employees business model`,
            tavilyKey, { maxResults: 5 }
        );
        recordTavilyUsage();

        if (results.length === 0) return sanitizeProfile(defaultProfile, companyName);

        const cleaned  = cleanSearchSnippets(results, companyName);
        const snippets = cleaned.map(r => `SOURCE: ${r.url}\n${r.snippet}`).join('\n\n');

        // ── FINANCIAL SANITY CHECK: Detect enterprise/public companies ──────
        const allText        = snippets.toLowerCase();
        const isEnterprise   = ENTERPRISE_KEYWORDS.some(kw => allText.includes(kw));
        const companySizeClass = isEnterprise ? 'enterprise' : 'unknown';

        if (isEnterprise) {
            console.log(`💡 [PROFILE] Enterprise/public company detected for "${companyName}". Size guard active.`);
        }

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{
                role: 'user',
                content: `${REASONING_FILTER}

TASK: Extract the following details about "${companyName}" from the snippets only.
Return ONLY valid JSON with these exact keys. No markdown. No explanation:
{
  "missionStatement": "string or null",
  "founded":          "year string or null",
  "headquarters":     "city, country string or null",
  "employeeCount":    "one of: 1-10 | 11-50 | 51-200 | 201-500 | 500+ | unknown",
  "businessModel":    "one of: B2B | B2C | B2B2C | marketplace | SaaS | services | unknown",
  "primaryProduct":   "one sentence description or null",
  "websiteUrl":       "url string or null"
}

ADDITIONAL RULE: If the snippets show words like 'billion', 'trillion', 'publicly traded', 'NASDAQ', 'NYSE', 'Fortune 500', 'IPO' — set employeeCount to "500+" and businessModel to one of the B2B/B2C options, never leave as unknown.

SNIPPETS:
${snippets}`
            }],
            max_tokens: 350,
            temperature: 0.1,
        }, {
            headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }
        });

        recordOpenAiUsage('extractMissionStatement', 'gpt-4o-mini', response.data?.usage?.total_tokens || 0);

        const raw      = response.data.choices[0].message.content.trim();
        const cleaned2 = raw.replace(/```json|```/g, '').trim();
        const profile  = JSON.parse(cleaned2);

        if (!profile.websiteUrl && companyUrl) profile.websiteUrl = companyUrl;
        profile.isEnterprise   = isEnterprise;
        profile.companySizeClass = companySizeClass;

        const sanitized = sanitizeProfile(profile, companyName);
        console.log(`✅ [PROFILE] Profile built. Enterprise: ${isEnterprise}`);
        return { ...sanitized, isEnterprise, companySizeClass };

    } catch (err) {
        console.warn(`⚠️ [PROFILE] Failed: ${err.message}`);
        return sanitizeProfile(defaultProfile, companyName);
    }
}

// ─── VERIFICATION AGENT ───────────────────────────────────────────────────────
async function verifyDecisionMakers(decisionMakers, companyName, researchSnippets, openAiKey) {
    if (!decisionMakers || decisionMakers.length === 0) return [];

    try {
        console.log(`🔎 [VERIFY] Running liveness check on ${decisionMakers.length} contact(s) for "${companyName}"...`);

        const verifyPrompt = `${REASONING_FILTER}

TASK: You are a Verification Agent. Your only job is to confirm whether each person listed below is currently and actively in their stated role at "${companyName}" right now in 2026.

PEOPLE TO VERIFY:
${JSON.stringify(decisionMakers.map(d => ({ name: d.name, title: d.title, sourceUrl: d.sourceUrl || null })), null, 2)}

LIVE RESEARCH SNIPPETS:
${researchSnippets || 'No snippets provided — treat all as unverified.'}

STATUS RULES:
- "confirmed": Snippets from 2025 or 2026 actively show this person in this exact role.
- "unverified": Mentioned but no recent date confirmation found in snippets.
- "likely_outdated": Any of these is true: snippet says "former", "ex-", "previously", "resigned", "retired", "passed away", "no longer", "left the company", or the only references are from before 2024.

Return ONLY valid JSON. No markdown:
{
  "verified": [
    {
      "name":           "...",
      "title":          "...",
      "linkedinUrl":    "...",
      "source":         "...",
      "sourceUrl":      "...",
      "isHiring":       boolean,
      "recentActivity": "...",
      "livenessStatus": "confirmed | unverified | likely_outdated",
      "livenessNote":   "brief reason or null"
    }
  ]
}`;

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: verifyPrompt }],
            max_tokens: 600,
            temperature: 0.1,
        }, {
            headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }
        });

        recordOpenAiUsage('verifyDecisionMakers', 'gpt-4o-mini', response.data?.usage?.total_tokens || 0);

        const raw     = response.data.choices[0].message.content.trim();
        const cleaned = raw.replace(/```json|```/g, '').trim();
        const parsed  = JSON.parse(cleaned);

        const safe    = parsed.verified.filter(p => p.livenessStatus !== 'likely_outdated');
        const removed = parsed.verified.length - safe.length;

        if (removed > 0) {
            console.warn(`⚠️ [VERIFY] ${removed} contact(s) removed (likely outdated). ${safe.length} safe to use.`);
        } else {
            console.log(`✅ [VERIFY] All ${safe.length} contact(s) passed liveness check.`);
        }

        return safe;

    } catch (err) {
        console.warn(`⚠️ [VERIFY] Liveness check failed: ${err.message}. Returning unverified list as fallback.`);
        return decisionMakers;
    }
}

// ─── LINKEDIN SIGNAL HUNTER + LIVENESS DETECTION ─────────────────────────────
async function findDecisionMakers(companyName, tavilyKey, openAiKey) {
    if (getTavilyRemaining() <= 0) return [];

    try {
        console.log(`👤 [DECISION MAKERS] Hunting for current leadership at: "${companyName}"`);

        // Primary: LinkedIn/Crunchbase lookup
        // Fallback: General leadership/hiring search
        const [res1, res2] = await Promise.all([
            searchWithFallback(
                `${companyName} CEO founder director site:linkedin.com OR site:crunchbase.com`,
                `${companyName} current leadership team executives management 2025 2026`,
                tavilyKey, { maxResults: 5 }
            ),
            searchWithFallback(
                `${companyName} head of sales marketing VP growth director hiring 2025 2026`,
                `${companyName} staff employees personnel team`,
                tavilyKey, { maxResults: 5 }
            ),
        ]);
        // Note: recordTavilyUsage() is called inside searchWithFallback — do NOT call again here

        const combined = [...res1, ...res2];
        if (combined.length === 0) return [];

        const cleaned  = cleanSearchSnippets(combined, companyName);
        const snippets = cleaned.map(r => `SOURCE: ${r.url}\nDATE: ${r.date || 'Unknown'}\n${r.snippet}`).join('\n\n');

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{
                role: 'user',
                content: `${REASONING_FILTER}

TASK: Extract up to 5 current decision makers at "${companyName}" from the snippets.

CRITICAL LIVENESS RULES:
- "confirmed": Snippets actively show this person in this role in 2025 or 2026.
- "unverified": Snippets mention them but give no recent date confirmation.
- "likely_outdated": Snippets suggest they left, were replaced, retired, or passed away.
- NEVER mark someone as confirmed based on undated snippets alone.
- If a snippet says "former", "ex-", "previously", "resigned", "passed away", "retired" — mark as likely_outdated.

Return ONLY valid JSON. No markdown:
{
  "decisionMakers": [
    {
      "name":           "Full Name",
      "title":          "Current Job Title",
      "linkedinUrl":    "url or null",
      "source":         "linkedin | crunchbase | news | other",
      "sourceUrl":      "the exact URL this was found at",
      "isHiring":       boolean,
      "recentActivity": "brief note on recent post/announcement or null",
      "livenessStatus": "confirmed | unverified | likely_outdated",
      "livenessNote":   "brief reason for status, or null"
    }
  ]
}

SNIPPETS:
${snippets}`
            }],
            max_tokens: 600,
            temperature: 0.1,
        }, {
            headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }
        });

        recordOpenAiUsage('findDecisionMakers', 'gpt-4o-mini', response.data?.usage?.total_tokens || 0);

        const raw      = response.data.choices[0].message.content.trim();
        const cleaned2 = raw.replace(/```json|```/g, '').trim();
        const parsed   = JSON.parse(cleaned2);

        // Filter out dangerous contacts immediately
        const allFound = parsed.decisionMakers || [];
        const safe     = allFound.filter(dm => dm.livenessStatus !== 'likely_outdated');
        const removed  = allFound.length - safe.length;

        if (removed > 0) {
            console.warn(`⚠️ [LIVENESS] Removed ${removed} likely-outdated contact(s). Safe: ${safe.length}`);
        }
        console.log(`✅ [DECISION MAKERS] ${safe.length} verified contacts found.`);
        return safe;

    } catch (err) {
        console.warn(`⚠️ [DECISION MAKERS] Failed: ${err.message}`);
        return [];
    }
}

// ─── FINANCIAL INTELLIGENCE + SIZE SANITY GUARD ───────────────────────────────
async function fetchFinancialSignals(companyName, tavilyKey, openAiKey) {
    const emptyShape = {
        lastFundingRound:   'No public funding data',
        amountRaised:       null,
        investors:          [],
        estimatedRevenue:   null,
        growthSignal:       'unknown',
        companySizeVerdict: 'unknown',   // 'bootstrapped' | 'sme' | 'funded' | 'public' | 'unknown'
        financialSources:   [],
    };

    if (getTavilyRemaining() <= 0) {
        console.warn('🚫 [FINANCE] Quota exhausted.');
        return emptyShape;
    }

    try {
        console.log(`💰 [FINANCE] Scanning financial signals for: "${companyName}"`);

        const [res1, res2] = await Promise.all([
            searchWithFallback(
                `${companyName} funding raised investment series valuation 2025 2026`,
                `${companyName} investors backed venture capital`,
                tavilyKey, { maxResults: 5 }
            ),
            searchWithFallback(
                `${companyName} revenue annual report profit growth 2025 2026`,
                `${companyName} financial results earnings turnover`,
                tavilyKey, { maxResults: 5 }
            ),
        ]);

        const combined = [...res1, ...res2];
        if (combined.length === 0) return emptyShape;

        const cleaned  = cleanSearchSnippets(combined, companyName);
        const snippets = cleaned.map(r => `SOURCE: ${r.url}\nDATE: ${r.date || 'Unknown'}\n${r.snippet}`).join('\n\n');
        const fallbackSources = combined.map(r => r.url).filter(Boolean).slice(0, 3);

        // ── FINANCIAL SANITY CHECK ───────────────────────────────────────────
        const allText    = snippets.toLowerCase();
        const isPublic   = ENTERPRISE_KEYWORDS.some(kw => allText.includes(kw));
        const hasBillions = allText.includes('billion') || allText.includes('trillion');

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{
                role: 'user',
                content: `${REASONING_FILTER}

TASK: Extract financial signals for "${companyName}" from the snippets only.

SANITY CHECK RULES (mandatory):
- If snippets mention "billion", "trillion", "NASDAQ", "NYSE", "publicly traded", "IPO", "Fortune 500" — companySizeVerdict MUST be "public". Never call this company "bootstrapped" or "small".
- If snippets mention "Series A/B/C/D", "seed round", "venture capital", "raised $" — companySizeVerdict MUST be "funded".
- Only use "bootstrapped" if the snippets explicitly use that word.
- If no financial signals exist at all — use "unknown".

Return ONLY valid JSON. No markdown:
{
  "lastFundingRound":   "Series X, Seed, IPO, Public, or No public data",
  "amountRaised":       "$Xm or $Xb or null",
  "investors":          ["name1", "name2"],
  "estimatedRevenue":   "range string or null",
  "growthSignal":       "scaling | stable | struggling | unknown",
  "companySizeVerdict": "bootstrapped | sme | funded | public | unknown",
  "financialSources":   ["url1", "url2"]
}

SNIPPETS:
${snippets}`
            }],
            max_tokens: 350,
            temperature: 0.1,
        }, {
            headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }
        });

        recordOpenAiUsage('fetchFinancialSignals', 'gpt-4o-mini', response.data?.usage?.total_tokens || 0);

        const raw      = response.data.choices[0].message.content.trim();
        const cleaned2 = raw.replace(/```json|```/g, '').trim();
        const data     = JSON.parse(cleaned2);

        // Override if sanity check detects enterprise signals the model missed
        if (isPublic || hasBillions) {
            if (data.companySizeVerdict === 'bootstrapped' || data.companySizeVerdict === 'sme') {
                console.warn(`⚠️ [FINANCE] Sanity override: Model said "${data.companySizeVerdict}" but public/enterprise signals detected. Correcting to "public".`);
                data.companySizeVerdict = 'public';
            }
        }

        if (!data.financialSources || data.financialSources.length === 0) {
            data.financialSources = fallbackSources;
        }

        console.log(`✅ [FINANCE] Verdict: ${data.companySizeVerdict}. Signal: ${data.growthSignal}`);
        return data;

    } catch (err) {
        console.warn(`⚠️ [FINANCE] Failed: ${err.message}`);
        return emptyShape;
    }
}

// ─── MASTER ORCHESTRATOR ──────────────────────────────────────────────────────
async function runCompanyResearch(companyNameOrUrl, tavilyKey, openAiKey) {
    const companyName = extractCompanyName(companyNameOrUrl);
    const companyUrl  = companyNameOrUrl.startsWith('http') ? companyNameOrUrl : null;

    console.log(`\n🔬 [RESEARCH] ═══ Starting full research on: "${companyName}" ═══`);
    const startTime = Date.now();

    // Run all 4 research modules in parallel
    // Promise.allSettled — one failure NEVER kills the report
    const results = await Promise.allSettled([
        fetchCompanyNews(companyName, tavilyKey, openAiKey),
        extractMissionStatement(companyUrl, companyName, tavilyKey, openAiKey),
        findDecisionMakers(companyName, tavilyKey, openAiKey),
        fetchFinancialSignals(companyName, tavilyKey, openAiKey),
    ]);

    // Extract or use default shapes
    const newsIntelligence  = results[0].status === 'fulfilled' ? results[0].value : [];
    const companyProfile    = results[1].status === 'fulfilled' ? results[1].value : sanitizeProfile({
        missionStatement: null, founded: null, headquarters: null,
        employeeCount: 'unknown', businessModel: 'unknown',
        primaryProduct: null, websiteUrl: companyUrl,
    }, companyName);
    const rawDecisionMakers = results[2].status === 'fulfilled' ? results[2].value : [];
    const financialSignals  = results[3].status === 'fulfilled' ? results[3].value : {
        lastFundingRound: 'No public funding data', amountRaised: null,
        investors: [], estimatedRevenue: null, growthSignal: 'unknown',
        companySizeVerdict: 'unknown', financialSources: [],
    };

    // Collect all research snippets for the liveness verification agent
    const allResearchText = [
        ...newsIntelligence.map(n => n.summary || ''),
        ...rawDecisionMakers.map(d => d.recentActivity || ''),
    ].filter(Boolean).join('\n');

    // Run the Verification Agent on all decision makers
    const decisionMakers = rawDecisionMakers.length > 0
        ? await verifyDecisionMakers(rawDecisionMakers, companyName, allResearchText, openAiKey)
        : [];

    // Buying signals summary
    const buyingSignals = {
        hasFundingSignal:   newsIntelligence.some(n => n.signalType === 'funding'),
        hasHiringSignal:    newsIntelligence.some(n => n.signalType === 'hiring')
                            || decisionMakers.some(d => d.isHiring),
        hasExpansionSignal: newsIntelligence.some(n => n.signalType === 'expansion' || n.signalType === 'growth'),
        topBuyingSignal:    newsIntelligence.find(n => n.buyingSignal) || null,
    };

    // Research quality scoring
    const hasRichNews  = newsIntelligence.length >= 3;
    const hasNews      = newsIntelligence.length >= 1;
    const hasRichDMs   = decisionMakers.length >= 2;
    const hasDMs       = decisionMakers.length >= 1;
    const hasFinData   = financialSignals.companySizeVerdict !== 'unknown'
                         || financialSignals.amountRaised;

    let researchQuality;
    if (hasRichNews && hasRichDMs && hasFinData) researchQuality = 'rich';
    else if (hasNews || hasDMs)                  researchQuality = 'moderate';
    else                                          researchQuality = 'sparse';

    // Module failure notes
    const researchNotes = [];
    if (results[0].status === 'rejected') researchNotes.push('⚠️ News module failed — no headlines available');
    if (results[1].status === 'rejected') researchNotes.push('⚠️ Profile module failed — using defaults');
    if (results[2].status === 'rejected') researchNotes.push('⚠️ Decision Maker module failed');
    if (results[3].status === 'rejected') researchNotes.push('⚠️ Financial module failed');
    if (researchQuality === 'sparse')     researchNotes.push('⚠️ Sparse data — results may be limited for this company');

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Latency guard — warn if over 20 seconds
    if (parseFloat(duration) > 20) {
        console.warn(`⚠️ [LATENCY] Research took ${duration}s — exceeded 20s target. Investigate parallel bottleneck.`);
    }

    const researchReport = {
        companyName,
        companyUrl:       companyUrl || null,
        researchedAt:     new Date().toISOString(),
        researchDuration: `${duration}s`,
        tavilyCallsUsed:  tavilyQuota.used,
        companyProfile,
        newsIntelligence,
        decisionMakers,
        financialSignals,
        buyingSignals,
        researchQuality,
        researchNotes,
    };

    console.log(`✅ [RESEARCH] ═══ Complete in ${duration}s. Quality: ${researchQuality} | DMs: ${decisionMakers.length} | News: ${newsIntelligence.length} ═══\n`);
    return researchReport;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ███  MODULE 2 — THE WRITING ENGINE ("The Brain")
// ═══════════════════════════════════════════════════════════════════════════════

// ─── BUILD USER CONTEXT FROM PROFILE ─────────────────────────────────────────
function buildUserContext(userProfile) {
    return {
        usp:          userProfile?.usp          || 'We help businesses grow with AI-powered automation.',
        senderName:   userProfile?.senderName   || 'Your Name',
        senderTitle:  userProfile?.senderTitle  || 'Founder',
        companyName:  userProfile?.companyName  || 'Your Company',
        tone:         userProfile?.tone         || 'professional but conversational',
        goal:         userProfile?.goal         || 'book a discovery call',
        product:      userProfile?.product      || 'our solution',
    };
}

// ─── HUMAN-GRADE WRITING ENGINE ───────────────────────────────────────────────
async function generatePersonalizedEmail(researchReport, userProfileContext, openAiKey) {
    console.log(`✍️  [WRITING ENGINE] Generating email for: "${researchReport.companyName}"`);

    const topNews       = researchReport.newsIntelligence?.find(n => n.buyingSignal)
                          || researchReport.newsIntelligence?.[0]
                          || null;
    const decisionMaker = researchReport.decisionMakers?.[0] || null;
    const profile       = researchReport.companyProfile || {};
    const financial     = researchReport.financialSignals || {};
    const buying        = researchReport.buyingSignals || {};

    // ── Hiring Hook Builder ──────────────────────────────────────────────────
    const hiringDM = researchReport.decisionMakers?.find(dm => dm.isHiring);
    const hiringSignalBlock = hiringDM
        ? `HIRING SIGNAL DETECTED: ${hiringDM.name} (${hiringDM.title}) is actively hiring. Their open role may be exactly what the sender's product replaces or accelerates. If using this hook, "connectionToProduct" MUST explain how the sender's product addresses the gap they are hiring for (e.g., "They are hiring a sales rep — our AI Sales Engine does that job autonomously").`
        : 'Hiring Signal: None detected.';

    // ── Step 1: GPT-4o-mini — intelligence extraction ───────────────────────
    const intelligencePrompt = `${REASONING_FILTER}

TASK: You are a B2B outreach intelligence analyst. Identify the STRONGEST personalisation hook for a cold email.

LIVE RESEARCH:
Company: ${researchReport.companyName}
Mission: ${profile.missionStatement || 'Not found'}
Business Model: ${profile.businessModel || 'Unknown'}
Employee Count: ${profile.employeeCount || 'Unknown'}
Top News: ${topNews ? `"${topNews.headline}" — ${topNews.summary} (Source: ${topNews.url})` : 'None found'}
Financial Signal: ${financial.lastFundingRound || 'None'} ${financial.amountRaised ? `| Raised: ${financial.amountRaised}` : ''} | Size: ${financial.companySizeVerdict || 'unknown'}
Decision Maker: ${decisionMaker ? `${decisionMaker.name}, ${decisionMaker.title} (Status: ${decisionMaker.livenessStatus})` : 'Not found'}
${hiringSignalBlock}

SENDER CONTEXT:
USP: ${userProfileContext.usp}
Product: ${userProfileContext.product}
Sender: ${userProfileContext.senderName}, ${userProfileContext.senderTitle} at ${userProfileContext.companyName}
Goal: ${userProfileContext.goal}
Tone: ${userProfileContext.tone}

Return ONLY valid JSON. No markdown:
{
  "primaryHook":          "<single strongest personalisation angle — must reference a specific live data point: news headline, funding event, hiring signal, expansion news. Never use generic praise.>",
  "connectionToProduct":  "<how the hook directly connects to the sender's specific product/USP — be concrete>",
  "suggestedSubjectLine": "<MAXIMUM 5 WORDS. Must reference one specific detail from the research. Examples: 'After your Series B', 'Re: Lagos expansion move', 'Noticed your sales hire'. BANNED subject words: enhance, improve, grow, transform, boost, optimize, revolutionize, upcoming, streamline, leverage, empower>",
  "recipientFirstName":   "<first name only of decision maker, or null>",
  "recipientTitle":       "<job title or null>",
  "hiringHook":           "<if hiring signal exists: one sentence connecting their open role to sender's product. Otherwise null.>",
  "patternInterruptOpener": "<a single data-backed opening sentence that does NOT start with 'I', 'We', 'My name', or 'I hope'. Must reference a specific fact: a date, a number, a city, a product name, an event. This is the first sentence of the email.>"
}`;

    let intelligence = null;
    try {
        const miniResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: intelligencePrompt }],
            max_tokens:  400,
            temperature: 0.2,
        }, {
            headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }
        });
        recordOpenAiUsage('generatePersonalizedEmail:intelligence', 'gpt-4o-mini', miniResponse.data?.usage?.total_tokens || 0);
        const raw     = miniResponse.data.choices[0].message.content.trim();
        const cleaned = raw.replace(/```json|```/g, '').trim();
        intelligence  = JSON.parse(cleaned);
    } catch (err) {
        console.warn(`⚠️ [WRITING ENGINE] Intelligence extraction failed: ${err.message}`);
    }

    // ── NO-NULL RECIPIENT POLICY ─────────────────────────────────────────────
    let recipientGreeting;
    if (intelligence?.recipientFirstName) {
        recipientGreeting = `Hi ${intelligence.recipientFirstName},`;
    } else if (intelligence?.recipientTitle) {
        recipientGreeting = `Hi ${intelligence.recipientTitle},`;
    } else if (profile.businessModel === 'B2B') {
        recipientGreeting = `Hi Sales Leader,`;
    } else {
        recipientGreeting = `Hi ${researchReport.companyName} Team,`;
    }

    // ── Step 2: GPT-4o — write the final email ──────────────────────────────
    const writingPrompt = `You are an elite B2B cold email copywriter. Your emails get replies because they sound like a sharp human who did real research — not like an AI running a template.

${buildBannedWordsInstruction()}

STRICT STRUCTURE RULES:
- Exactly 3 short paragraphs. No headers. No bullet points. No lists.
- Paragraph 1: START with this exact opening (do not change it): "${intelligence?.patternInterruptOpener || `${researchReport.companyName}'s recent move caught my attention.`}"
  Then in 1-2 more sentences, expand on the hook with a specific detail from the research. This paragraph must prove you did real research.
- Paragraph 2: Connect their specific situation to "${userProfileContext.product}" and the sender's USP: "${userProfileContext.usp}". Be concrete. Name a specific outcome, number, or mechanic. No vague promises.
- Paragraph 3: Soft CTA — ONE sentence only. Goal: "${userProfileContext.goal}". Do NOT use "feel free to", "do not hesitate", or "let me know your thoughts".
- Tone: ${userProfileContext.tone}.
- Vary sentence length. Mix short punchy sentences with slightly longer ones. Avoid uniform rhythm.
- Never start ANY sentence with "I hope", "I wanted", "My name is", "We are a company that", "As a", "I am reaching out".
${intelligence?.hiringHook ? `- Hiring Hook available (use if stronger than primary hook): "${intelligence.hiringHook}"` : ''}

EMAIL CONSTRUCTION:
Greeting: ${recipientGreeting}
Primary Research Hook: ${intelligence?.primaryHook || topNews?.headline || `${researchReport.companyName}'s recent activity`}
Product Connection: ${intelligence?.connectionToProduct || userProfileContext.usp}
Sender Signature: ${userProfileContext.senderName}, ${userProfileContext.senderTitle} at ${userProfileContext.companyName}

Write ONLY the email body — no subject line, no sender name, no signature block. Start with the greeting on its own line, then the first paragraph.`;

    try {
        const gpt4Response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o',
            messages:    [{ role: 'user', content: writingPrompt }],
            max_tokens:  450,
            temperature: 0.7,
        }, {
            headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }
        });

        recordOpenAiUsage('generatePersonalizedEmail:writing', 'gpt-4o', gpt4Response.data?.usage?.total_tokens || 0);

        const emailBody = gpt4Response.data.choices[0].message.content.trim();

        return {
            subjectLine:    intelligence?.suggestedSubjectLine || `Re: ${researchReport.companyName}`,
            recipient:      recipientGreeting,
            body:           emailBody,
            primaryHook:    intelligence?.primaryHook    || null,
            hiringHook:     intelligence?.hiringHook     || null,
            newsUsed:       topNews?.headline             || null,
            newsSourceUrl:  topNews?.url                  || null,
            decisionMaker:  decisionMaker?.name           || null,
            livenessStatus: decisionMaker?.livenessStatus || null,
        };

    } catch (err) {
        console.warn(`⚠️ [WRITING ENGINE] Email generation failed: ${err.message}`);
        return null;
    }
}

// ─── REPORT FORMATTER ─────────────────────────────────────────────────────────
function formatResearchAndEmailReport(researchReport, emailDraft) {
    const lines = [
        `🔬 **Intelligence Report — ${researchReport.companyName}**`,
        `⏱ Researched in ${researchReport.researchDuration} · Quality: ${researchReport.researchQuality?.toUpperCase()}`,
        `📅 Date: ${new Date(researchReport.researchedAt).toUTCString()}\n`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `\n📋 **COMPANY PROFILE**\n`,
    ];

    const p = researchReport.companyProfile || {};
    // ZERO NULLS POLICY: every field goes through a display guard
    lines.push(`🎯 **Mission:** ${p.missionStatement || `${researchReport.companyName} — mission not publicly indexed.`}`);
    lines.push(`🏢 **HQ:** ${p.headquarters || 'Location not indexed'}`);
    lines.push(`📅 **Founded:** ${p.founded || 'Not listed'}`);
    lines.push(`👥 **Team Size:** ${p.employeeCount || 'Not listed'}`);
    lines.push(`🔧 **Model:** ${p.businessModel || 'Not classified'}`);
    lines.push(`📦 **Product:** ${p.primaryProduct || `${researchReport.companyName}'s offering — not indexed.`}\n`);

    // News
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`\n📰 **INTELLIGENCE HEADLINES**\n`);
    if (researchReport.newsIntelligence?.length > 0) {
        researchReport.newsIntelligence.forEach((n, i) => {
            const buyingTag = n.buyingSignal ? ' 🟢 BUYING SIGNAL' : '';
            lines.push(`  ${i + 1}. [${n.sentiment?.toUpperCase()}] ${n.headline}${buyingTag}`);
            lines.push(`     📅 ${n.date} · 🔗 ${n.url}`);
        });
    } else {
        lines.push(`  No headlines indexed for this company. Consider direct website research.`);
    }
    lines.push('');

    // Decision Makers
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`\n👤 **VERIFIED DECISION MAKERS**\n`);
    if (researchReport.decisionMakers?.length > 0) {
        researchReport.decisionMakers.forEach(dm => {
            const liveness = dm.livenessStatus === 'confirmed' ? '✅ Confirmed Active' : '⚠️ Unverified';
            lines.push(`  • ${dm.name} — ${dm.title} [${liveness}]`);
            if (dm.linkedinUrl)    lines.push(`    🔗 ${dm.linkedinUrl}`);
            if (dm.isHiring)       lines.push(`    🚀 Hiring signal detected`);
            if (dm.recentActivity) lines.push(`    📡 ${dm.recentActivity}`);
        });
    } else {
        lines.push(`  No verified contacts found. Consider using the company's general contact or a department-level approach.`);
    }
    lines.push('');

    // Financial
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`\n💰 **FINANCIAL SIGNALS**\n`);
    const fin = researchReport.financialSignals;
    if (fin) {
        lines.push(`  • Size Verdict: ${fin.companySizeVerdict || 'Not determined'}`);
        lines.push(`  • Last Funding: ${fin.lastFundingRound || 'No public data'}`);
        if (fin.amountRaised)     lines.push(`  • Raised: ${fin.amountRaised}`);
        if (fin.estimatedRevenue) lines.push(`  • Revenue: ${fin.estimatedRevenue}`);
        lines.push(`  • Growth Signal: ${fin.growthSignal || 'Unknown'}`);
        if (fin.financialSources?.length > 0) {
            lines.push(`  • Sources: ${fin.financialSources.join(' | ')}`);
        }
    } else {
        lines.push(`  No financial data indexed. Company may be bootstrapped or pre-announcement.`);
    }
    lines.push('');

    // Email Draft
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    if (emailDraft) {
        lines.push(`\n✉️  **PERSONALIZED EMAIL DRAFT**\n`);
        lines.push(`📌 **Subject:** ${emailDraft.subjectLine}`);
        lines.push(`👤 **To:** ${emailDraft.recipient}\n`);
        lines.push(emailDraft.body);
        lines.push('');
        if (emailDraft.newsUsed) {
            lines.push(`📡 *Hook source: "${emailDraft.newsUsed}" — ${emailDraft.newsSourceUrl || ''}*`);
        }
        if (emailDraft.hiringHook) {
            lines.push(`🚀 *Hiring hook available: "${emailDraft.hiringHook}"*`);
        }
        if (emailDraft.livenessStatus) {
            lines.push(`🔎 *Contact liveness: ${emailDraft.livenessStatus}*`);
        }
    } else {
        lines.push(`\n✉️  **Email Draft:** Research completed but email could not be generated. Try again or check OpenAI quota.`);
    }

    // Research notes
    if (researchReport.researchNotes?.length > 0) {
        lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        lines.push(`\n⚠️ **Research Notes:**`);
        researchReport.researchNotes.forEach(note => lines.push(`  ${note}`));
    }

    lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`\n${getFullCreditDashboard().summary}`);

    return lines.join('\n');
}

// ─── STRUCTURED JSON OUTPUT ───────────────────────────────────────────────────
// Produces the clean JSON object Month 2 needs for automated sending
function generateStructuredLeadJSON(researchReport, emailDraft, userProfile) {
    const dm = researchReport.decisionMakers?.[0] || null;
    return {
        lead: {
            companyName:      researchReport.companyName,
            companyUrl:       researchReport.companyUrl,
            researchedAt:     researchReport.researchedAt,
            researchQuality:  researchReport.researchQuality,
            industry:         researchReport.companyProfile?.businessModel || 'unknown',
            companySizeClass: researchReport.financialSignals?.companySizeVerdict || 'unknown',
            buyingSignals: {
                hasFunding:   researchReport.buyingSignals?.hasFundingSignal   || false,
                hasHiring:    researchReport.buyingSignals?.hasHiringSignal    || false,
                hasExpansion: researchReport.buyingSignals?.hasExpansionSignal || false,
            },
        },
        contact: dm ? {
            name:           dm.name,
            title:          dm.title,
            linkedinUrl:    dm.linkedinUrl || null,
            livenessStatus: dm.livenessStatus,
            isHiring:       dm.isHiring || false,
        } : null,
        outreach: emailDraft ? {
            subjectLine: emailDraft.subjectLine,
            greeting:    emailDraft.recipient,
            body:        emailDraft.body,
            hookSource:  emailDraft.newsUsed      || null,
            hookUrl:     emailDraft.newsSourceUrl || null,
            hiringHook:  emailDraft.hiringHook    || null,
        } : null,
        sender: {
            name:    userProfile?.senderName  || null,
            title:   userProfile?.senderTitle || null,
            company: userProfile?.companyName || null,
            goal:    userProfile?.goal        || null,
        },
        meta: {
            generatedAt:     new Date().toISOString(),
            tavilyCallsUsed: researchReport.tavilyCallsUsed,
            readyForSending: !!(emailDraft && dm && dm.livenessStatus !== 'likely_outdated'),
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ███  STEP 1: PARSE USER INTENT (unchanged)
// ═══════════════════════════════════════════════════════════════════════════════
async function parseLeadIntent(message, history, currentProfile, apiKey) {
    const historySnippet = history.slice(-4).map(h => `${h.role}: ${h.content}`).join('\n');

    const prompt = `You are a lead generation analyst. Extract structured search parameters from this sales professional's message.

CONVERSATION HISTORY:
${historySnippet || 'None'}

USER MESSAGE: "${message}"

CURRENT KNOWN PROFILE:
${JSON.stringify(currentProfile, null, 2)}

Also detect if the user is asking to research a specific company by URL or name (e.g. "research Moniepoint", "write an email for stripe.com").

Return ONLY valid JSON — no markdown:
{
  "targetDescription": "<type of customer/business they want>",
  "industry": "<industry or niche>",
  "painPoint": "<problem the target businesses have>",
  "location": "<geographic focus or null>",
  "businessSize": "<startup | small | medium | enterprise | any>",
  "budget": "<low | mid | high | unknown>",
  "searchQueries": [
    "<specific ready-to-run search string — business directory angle>",
    "<specific ready-to-run search string — LinkedIn/news signal angle>",
    "<specific ready-to-run search string — pain point / job posting angle>"
  ],
  "isNewSearch": <true if new request, false if refining>,
  "researchTarget": "<company name or URL if user wants company research, else null>",
  "mode": "<'leads' if searching for new leads | 'research' if researching a specific company>"
}

Rules: searchQueries must be real, specific, ready-to-run strings. Return ONLY the JSON.`;

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: prompt }],
            max_tokens:  350,
            temperature: 0.1
        }, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
        });

        recordOpenAiUsage('parseLeadIntent', 'gpt-4o-mini', response.data?.usage?.total_tokens || 0);

        const raw     = response.data.choices[0].message.content.trim();
        const cleaned = raw.replace(/```json|```/g, '').trim();
        return JSON.parse(cleaned);

    } catch (err) {
        console.warn('⚠️ [LEAD FINDER] Intent parsing failed:', err.message);
        return null;
    }
}

// ─── STEP 2: AI RANKS AND PICKS TOP 3 (unchanged) ────────────────────────────
async function rankAndSelectTopLeads(rawResults, profile, apiKey) {
    if (rawResults.length === 0) return [];

    const compactResults = rawResults.map((r, i) => ({
        index:   i,
        title:   r.title,
        url:     r.url,
        snippet: r.snippet?.slice(0, 180) || '',
        date:    r.date || null,
    }));

    const prompt = `You are an elite B2B lead analyst.
TARGET PROFILE:
${JSON.stringify(profile, null, 2)}

From the ${rawResults.length} results below, select EXACTLY ${MAX_LEADS_RETURNED} best leads.

RAW RESULTS:
${JSON.stringify(compactResults, null, 2)}
Return ONLY valid JSON:
{
  "leads": [
    {
      "rank": 1,
      "businessName": "<name>",
      "url": "<url>",
      "industry": "<their industry>",
      "opportunitySignal": "<why they likely need help — specific to their snippet>",
      "outreachAngle": "<personalised opening line for outreach>",
      "fitScore": <1-10>
    }
  ]
}

Rules: rank by fitScore descending. opportunitySignal must reference their actual snippet. Return ONLY the JSON.`;

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: prompt }],
            max_tokens:  600,
            temperature: 0.2
        }, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
        });

        recordOpenAiUsage('rankAndSelectTopLeads', 'gpt-4o-mini', response.data?.usage?.total_tokens || 0);

        const raw     = response.data.choices[0].message.content.trim();
        const cleaned = raw.replace(/```json|```/g, '').trim();
        return JSON.parse(cleaned).leads || [];

    } catch (err) {
        console.warn('⚠️ [LEAD FINDER] Ranking failed:', err.message);
        return [];
    }
}

// ─── STEP 3: FORMAT LEAD RESPONSE (unchanged) ─────────────────────────────────
function formatLeadResponse(leads, profile, totalSearched) {
    if (leads.length === 0) {
        return [
            `🔍 Searched ${totalSearched} businesses — no strong matches for "${profile.targetDescription || 'your request'}".`,
            `Try: add a location, name a specific pain point, or narrow the niche.`,
            ``,
            getTavilyQuotaSummary(),
        ].join('\n');
    }

    const lines = [
        `🎯 **Lead Search Complete**`,
        `${totalSearched} businesses searched · Top ${leads.length} returned\n`,
        `**Target:** ${profile.targetDescription || 'As described'}\n`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ];

    leads.forEach((lead, i) => {
        lines.push(
            `\n**#${lead.rank} — ${lead.businessName}** · Fit: ${lead.fitScore}/10`,
            `🌐 ${lead.url || 'URL not found'}`,
            `🏭 ${lead.industry}`,
            `📡 Opportunity: ${lead.opportunitySignal}`,
            `✉️  Outreach: *"${lead.outreachAngle}"*`,
            i < leads.length - 1 ? `\n─────────────────────────────────────` : ''
        );
    });

    lines.push(
        `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `\n${getTavilyQuotaSummary()}`,
        `\nRefine: give a location, different niche, or say "Find more like #1".`,
        `\n💡 Tip: Say "Research [company name]" to get a full intel report + personalized email.`
    );

    return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ███  MAIN EXPORT — ROUTER (leads mode OR research+write mode)
// ═══════════════════════════════════════════════════════════════════════════════
async function generateFreeResponse(message, history, userProfile) {
    try {
        console.log('🟢 [LEAD FINDER] Processing...');

        const userId    = userProfile?.userId || 'default';
        const apiKey    = process.env.OPENAI_API_KEY;
        const tavilyKey = process.env.TAVILY_API_KEY;

        let session = getSession(userId);

        // ── Parse intent ──
        const intent = await parseLeadIntent(message, history, session.profile, apiKey);

        if (intent) {
            if (intent.isNewSearch && session.lastLeads.length > 0) session = resetSession(userId);

            const p = session.profile;
            if (intent.targetDescription) p.targetDescription = intent.targetDescription;
            if (intent.industry)          p.industry          = intent.industry;
            if (intent.painPoint)         p.painPoint         = intent.painPoint;
            if (intent.location)          p.location          = intent.location;
            if (intent.businessSize)      p.businessSize      = intent.businessSize;
            if (intent.budget)            p.budget            = intent.budget;
            session.lastSearchQueries = intent.searchQueries || [];
        }

        // ══════════════════════════════════════════════════════════════════════
        // ROUTE A: RESEARCH + EMAIL MODE
        // Triggered when user says "research X", "write email for X", "intel on X"
        // ══════════════════════════════════════════════════════════════════════
        if (intent?.mode === 'research' && intent?.researchTarget) {
            const target = intent.researchTarget;

            // Check cache first (avoid re-researching same company in session)
            let researchReport = session.lastResearchCache?.[target];

            if (!researchReport) {
                researchReport = await runCompanyResearch(target, tavilyKey, apiKey);
                if (session.lastResearchCache) {
                    session.lastResearchCache[target] = researchReport;
                }
            } else {
                console.log(`⚡ [RESEARCH] Cache hit for: "${target}"`);
            }

            // Build user context from userProfile
            const userCtx    = buildUserContext(userProfile);
            const emailDraft = await generatePersonalizedEmail(researchReport, userCtx, apiKey);
            const reply      = formatResearchAndEmailReport(researchReport, emailDraft);

            const newHistory = [
                ...history,
                { role: 'user',      content: message },
                { role: 'assistant', content: reply   }
            ];

            return {
                reply,
                updatedHistory: newHistory.slice(-12),
                researchReport,
                emailDraft,
                mode:           'research',
                quotaStatus:    getTavilyQuotaSummary(),
            };
        }

        // ══════════════════════════════════════════════════════════════════════
        // ROUTE B: LEAD SEARCH MODE (original behaviour — fully preserved)
        // ══════════════════════════════════════════════════════════════════════
        const rawResults  = await searchBusinessesOnline(session.lastSearchQueries, tavilyKey);
        const topLeads    = await rankAndSelectTopLeads(rawResults, session.profile, apiKey);
        session.lastLeads = topLeads;
        session.phase     = 'complete';

        const reply = formatLeadResponse(topLeads, session.profile, rawResults.length);

        const newHistory = [
            ...history,
            { role: 'user',      content: message },
            { role: 'assistant', content: reply   }
        ];

        return {
            reply,
            updatedHistory: newHistory.slice(-12),
            leads:          topLeads,
            totalSearched:  rawResults.length,
            quotaStatus:    getTavilyQuotaSummary(),
            mode:           'leads',
        };

    } catch (error) {
        console.error('❌ [LEAD FINDER] Error:', error.message);
        throw new Error('Lead search service temporarily unavailable.');
    }
}

// ─── UTILITY ───────────────────────────────────────────────────────────────────
function extractDomain(url) {
    try { return new URL(url).hostname.replace('www.', ''); }
    catch { return url; }
}

function extractCompanyName(input) {
    if (!input) return 'Unknown Company';
    try {
        const hostname = new URL(input.startsWith('http') ? input : `https://${input}`).hostname;
        return hostname.replace('www.', '').split('.')[0]
            .replace(/-/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
    } catch {
        return input.trim();
    }
}

// ─── EXPORTS ───────────────────────────────────────────────────────────────────
module.exports = {
    generateFreeResponse,
    flagBadLead,
    flagBadContact,
    getFlagSummary,
    getFullCreditDashboard,
    generateStructuredLeadJSON,
};
