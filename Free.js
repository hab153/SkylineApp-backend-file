const axios = require('axios');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const MAX_SEARCH_RESULTS = 40;
const MAX_LEADS_RETURNED = 3;
const TAVILY_LIMIT       = 1000;  // Free tier: 1000 requests/month

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

// ─── TAVILY SEARCH ────────────────────────────────────────────────────────────
async function searchWithTavily(query, tavilyKey, options = {}) {
    const response = await axios.post('https://api.tavily.com/search', {
        api_key:          tavilyKey,
        query,
        search_depth:     options.depth        || 'basic',
        max_results:      options.maxResults    || 10,
        include_answer:   options.includeAnswer || false,
        include_raw_content: options.rawContent || false,
    }, {
        headers: { 'Content-Type': 'application/json' }
    });

    return (response.data?.results || []).map(r => ({
        title:   r.title          || '',
        url:     r.url            || '',
        snippet: r.content        || '',
        date:    r.published_date || null,
    }));
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
                if (domain && !seenDomains.has(domain) && allResults.length < MAX_SEARCH_RESULTS) {
                    seenDomains.add(domain);
                    allResults.push(r);
                }
            }

        } catch (err) {
            console.warn(`⚠️  [Tavily] Search error: ${err.message}`);
            recordTavilyUsage();
        }    }

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

// ─── UPGRADE 1: DEEP NEWS INTELLIGENCE ────────────────────────────────────────
async function fetchCompanyNews(companyName, tavilyKey, openAiKey) {
    if (getTavilyRemaining() <= 0) {
        console.warn('🚫 [NEWS] Tavily quota exhausted.');
        return [];
    }

    try {
        console.log(`📰 [NEWS] Fetching deep intelligence for: "${companyName}"`);
        
        // Run 3 targeted queries in parallel
        const queries = [            `${companyName} news 2024 2025`,
            `${companyName} funding expansion launch partnership announcement`,
            `${companyName} problems challenges lawsuit controversy`
        ];

        const searchPromises = queries.map(q => searchWithTavily(q, tavilyKey, { maxResults: 5 }));
        const rawResultsArrays = await Promise.all(searchPromises);
        
        // Record usage for all 3 calls
        for (let i = 0; i < 3; i++) recordTavilyUsage();

        // Flatten and deduplicate by URL
        const allResults = rawResultsArrays.flat();
        const seenUrls = new Set();
        const uniqueResults = allResults.filter(r => {
            if (!r.url || seenUrls.has(r.url)) return false;
            seenUrls.add(r.url);
            return true;
        });

        // Take top 5
        const top5 = uniqueResults.slice(0, 5);

        if (top5.length === 0) return [];

        // Prepare snippets for GPT classification
        const snippetsForGPT = top5.map((r, idx) => 
            `ITEM ${idx}:\nTitle: ${r.title}\nSnippet: ${r.snippet}\nDate: ${r.date || 'Unknown'}`
        ).join('\n\n');

        // Classify sentiment and signalType using GPT-4o-mini
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{
                role: 'user',
                content: `Analyze the following 5 news items about "${companyName}". 
For each item, determine:
1. sentiment: "positive", "negative", or "neutral"
2. signalType: "growth", "risk", "funding", "product", "hiring", or "other"

Return ONLY a valid JSON array of objects with keys: index, sentiment, signalType.

DATA:
${snippetsForGPT}`
            }],
            max_tokens: 300,
            temperature: 0.1
        }, {
            headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }
        });
        let classifications = [];
        try {
            const raw = response.data.choices[0].message.content.trim();
            const cleaned = raw.replace(/```json|```/g, '').trim();
            classifications = JSON.parse(cleaned);
        } catch (e) {
            console.warn('⚠️ [NEWS] GPT classification failed, using defaults.');
        }

        // Map results to final shape
        const finalNews = top5.map((r, idx) => {
            const meta = classifications[idx] || {};
            return {
                headline: r.title,
                summary: r.snippet ? r.snippet.slice(0, 250) : '',
                url: r.url,
                date: r.date || 'Date unknown',
                sentiment: meta.sentiment || 'neutral',
                signalType: meta.signalType || 'other'
            };
        });

        console.log(`✅ [NEWS] Found ${finalNews.length} classified headlines.`);
        return finalNews;

    } catch (err) {
        console.warn(`⚠️ [NEWS] Failed: ${err.message}`);
        return [];
    }
}

// ─── UPGRADE 2: COMPANY PROFILE BUILDER ───────────────────────────────────────
async function extractMissionStatement(companyUrl, companyName, tavilyKey, openAiKey) {
    if (getTavilyRemaining() <= 0) {
        return {
            missionStatement: null,
            founded: null,
            headquarters: null,
            employeeCount: "unknown",
            businessModel: "unknown",
            primaryProduct: null,
            websiteUrl: companyUrl || null
        };
    }

    try {
        console.log(`🎯 [PROFILE] Building profile for: "${companyName}"`);
        const query = `${companyName} about us mission founded headquarters employees business model`;
        const results = await searchWithTavily(query, tavilyKey, { maxResults: 5 });        recordTavilyUsage();

        if (results.length === 0) {
            return {
                missionStatement: null,
                founded: null,
                headquarters: null,
                employeeCount: "unknown",
                businessModel: "unknown",
                primaryProduct: null,
                websiteUrl: companyUrl || null
            };
        }

        const snippets = results.map(r => `SOURCE: ${r.url}\n${r.snippet}`).join('\n\n');

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{
                role: 'user',
                content: `Extract the following details about "${companyName}" from the snippets below. 
Return ONLY valid JSON with these exact keys:
{
  "missionStatement": "string or null",
  "founded": "year string or null",
  "headquarters": "city, country string or null",
  "employeeCount": "one of: 1-10, 11-50, 51-200, 201-500, 500+, unknown",
  "businessModel": "one of: B2B, B2C, B2B2C, marketplace, SaaS, services, unknown",
  "primaryProduct": "one sentence description or null",
  "websiteUrl": "url string or null"
}

SNIPPETS:
${snippets}`
            }],
            max_tokens: 300,
            temperature: 0.1
        }, {
            headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }
        });

        const raw = response.data.choices[0].message.content.trim();
        const cleaned = raw.replace(/```json|```/g, '').trim();
        const profile = JSON.parse(cleaned);

        // Ensure websiteUrl is populated if found in search but not in JSON
        if (!profile.websiteUrl && companyUrl) profile.websiteUrl = companyUrl;
        
        console.log(`✅ [PROFILE] Profile built.`);
        return profile;
    } catch (err) {
        console.warn(`⚠️ [PROFILE] Failed: ${err.message}`);
        return {
            missionStatement: null,
            founded: null,
            headquarters: null,
            employeeCount: "unknown",
            businessModel: "unknown",
            primaryProduct: null,
            websiteUrl: companyUrl || null
        };
    }
}

// ─── UPGRADE 3: LINKEDIN SIGNAL HUNTER ────────────────────────────────────────
async function findDecisionMakers(companyName, tavilyKey, openAiKey) {
    if (getTavilyRemaining() <= 0) return [];

    try {
        console.log(`👤 [DECISION MAKERS] Hunting signals for: "${companyName}"`);
        
        // Run 2 parallel queries
        const q1 = `${companyName} CEO founder director site:linkedin.com OR site:crunchbase.com`;
        const q2 = `${companyName} head of sales marketing growth VP director hiring`;
        
        const [res1, res2] = await Promise.all([
            searchWithTavily(q1, tavilyKey, { maxResults: 5 }),
            searchWithTavily(q2, tavilyKey, { maxResults: 5 })
        ]);
        
        recordTavilyUsage(); // Call 1
        recordTavilyUsage(); // Call 2

        const combined = [...res1, ...res2];
        if (combined.length === 0) return [];

        const snippets = combined.map(r => `SOURCE: ${r.url}\n${r.snippet}`).join('\n\n');

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{
                role: 'user',
                content: `From these snippets about "${companyName}", extract up to 5 key decision makers.
Identify if they are likely hiring based on context.
Return ONLY valid JSON:
{
  "decisionMakers": [
    { 
      "name": "Full Name",       "title": "Job Title", 
      "linkedinUrl": "url or null", 
      "source": "linkedin | crunchbase | news | other",
      "isHiring": boolean,
      "recentActivity": "brief note on recent post/announcement or null"
    }
  ]
}

SNIPPETS:
${snippets}`
            }],
            max_tokens: 400,
            temperature: 0.1
        }, {
            headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }
        });

        const raw = response.data.choices[0].message.content.trim();
        const cleaned = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        
        console.log(`✅ [DECISION MAKERS] Found ${parsed.decisionMakers?.length || 0}.`);
        return parsed.decisionMakers || [];

    } catch (err) {
        console.warn(`⚠️ [DECISION MAKERS] Failed: ${err.message}`);
        return [];
    }
}

// ─── UPGRADE 4: FINANCIAL SIGNALS ─────────────────────────────────────────────
async function fetchFinancialSignals(companyName, tavilyKey, openAiKey) {
    const emptyShape = {
        lastFundingRound: "Unknown",
        amountRaised: null,
        investors: [],
        estimatedRevenue: null,
        growthSignal: "unknown",
        financialSources: []
    };

    if (getTavilyRemaining() <= 0) {
        console.warn('🚫 [FINANCE] Tavily quota exhausted.');
        return emptyShape;
    }

    try {
        console.log(`💰 [FINANCE] Checking financial health for: "${companyName}"`);
        const q1 = `${companyName} funding raised investment series valuation 2024 2025`;
        const q2 = `${companyName} revenue growth profit annual report`;

        const [res1, res2] = await Promise.all([
            searchWithTavily(q1, tavilyKey, { maxResults: 5 }),
            searchWithTavily(q2, tavilyKey, { maxResults: 5 })
        ]);

        recordTavilyUsage(); // Call 1
        recordTavilyUsage(); // Call 2

        const combined = [...res1, ...res2];
        if (combined.length === 0) return emptyShape;

        const snippets = combined.map(r => `SOURCE: ${r.url}\n${r.snippet}`).join('\n\n');
        const sources = combined.map(r => r.url).slice(0, 2);

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{
                role: 'user',
                content: `Extract financial signals for "${companyName}" from the snippets.
Return ONLY valid JSON:
{
  "lastFundingRound": "Series A, Seed, IPO, or Unknown",
  "amountRaised": "$Xm or null",
  "investors": ["name1", "name2"],
  "estimatedRevenue": "range string or null",
  "growthSignal": "scaling | stable | struggling | unknown",
  "financialSources": ["url1", "url2"]
}

SNIPPETS:
${snippets}`
            }],
            max_tokens: 300,
            temperature: 0.1
        }, {
            headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }
        });

        const raw = response.data.choices[0].message.content.trim();
        const cleaned = raw.replace(/```json|```/g, '').trim();
        const data = JSON.parse(cleaned);

        // Merge sources if GPT didn't catch them
        if (!data.financialSources || data.financialSources.length === 0) {
            data.financialSources = sources;
        }
        console.log(`✅ [FINANCE] Signals extracted.`);
        return data;

    } catch (err) {
        console.warn(`⚠️ [FINANCE] Failed: ${err.message}`);
        return emptyShape;
    }
}

// ─── UPGRADE 5: MASTER ORCHESTRATOR ───────────────────────────────────────────
async function runCompanyResearch(companyNameOrUrl, tavilyKey, openAiKey) {
    const companyName = extractCompanyName(companyNameOrUrl);
    const companyUrl  = companyNameOrUrl.startsWith('http') ? companyNameOrUrl : null;

    console.log(`\n🔬 [RESEARCH] Starting full research on: "${companyName}"`);
    const startTime = Date.now();

    // Check Cache
    const userId = 'temp-research'; // Temporary session for standalone test if needed, otherwise handled by caller
    // Note: In the main router, cache is checked before calling this. 
    // However, if called directly, we assume no cache here or rely on caller.

    // Run all 4 upgraded functions in parallel
    const results = await Promise.allSettled([
        fetchCompanyNews(companyName, tavilyKey, openAiKey),       // Index 0
        extractMissionStatement(companyUrl, companyName, tavilyKey, openAiKey), // Index 1
        findDecisionMakers(companyName, tavilyKey, openAiKey),     // Index 2
        fetchFinancialSignals(companyName, tavilyKey, openAiKey)   // Index 3
    ]);

    // Extract data or default shapes
    const newsIntelligence = results[0].status === 'fulfilled' ? results[0].value : [];
    const companyProfile   = results[1].status === 'fulfilled' ? results[1].value : {
        missionStatement: null, founded: null, headquarters: null, 
        employeeCount: "unknown", businessModel: "unknown", 
        primaryProduct: null, websiteUrl: companyUrl
    };
    const decisionMakers   = results[2].status === 'fulfilled' ? results[2].value : [];
    const financialSignals = results[3].status === 'fulfilled' ? results[3].value : {
        lastFundingRound: "Unknown", amountRaised: null, investors: [], 
        estimatedRevenue: null, growthSignal: "unknown", financialSources: []
    };

    // Calculate Quality
    let quality = "sparse";
    const hasNews = newsIntelligence.length >= 1;
    const hasRichNews = newsIntelligence.length >= 3;
    const hasDMs = decisionMakers.length >= 1;
    const hasRichDMs = decisionMakers.length >= 2;
    const hasFinData = financialSignals.lastFundingRound !== "Unknown" || financialSignals.amountRaised;
    if (hasRichNews && hasRichDMs && hasFinData) {
        quality = "rich";
    } else if (hasNews || hasDMs) {
        quality = "moderate";
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // Notes
    const notes = [];
    if (results[0].status === 'rejected') notes.push("News module failed");
    if (results[1].status === 'rejected') notes.push("Profile module failed");
    if (results[2].status === 'rejected') notes.push("Decision Maker module failed");
    if (results[3].status === 'rejected') notes.push("Financial module failed");

    const researchReport = {
        companyName,
        companyUrl:       companyUrl || null,
        researchedAt:     new Date().toISOString(),
        researchDuration: `${duration}s`,
        tavilyCallsUsed:  9, // Fixed max per spec: 3+1+2+2+1 reserve
        companyProfile,
        newsIntelligence,
        decisionMakers,
        financialSignals,
        researchQuality:  quality,
        researchNotes:    notes
    };

    console.log(`✅ [RESEARCH] Complete in ${researchReport.researchDuration}. Quality: ${quality}`);
    return researchReport;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ███  MODULE 2 — THE WRITING ENGINE ("The Brain")
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 2A: BUILD USER CONTEXT FROM PROFILE ──────────────────────────────────────
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
// ─── 2B: DRAFT PERSONALIZED EMAIL (GPT-4o-mini processes, GPT-4o writes) ──────
async function generatePersonalizedEmail(researchReport, userProfileContext, openAiKey) {
    console.log(`✍️  [WRITING ENGINE] Generating email for: "${researchReport.companyName}"`);

    // Adapt to new structure: newsIntelligence is an array, companyProfile is an object
    const topNews         = researchReport.newsIntelligence?.[0] || null;
    const decisionMaker   = researchReport.decisionMakers?.[0] || null;
    const missionSnippet  = researchReport.companyProfile?.missionStatement || null;

    // ── Step 1: GPT-4o-mini — extract key intelligence & connection points ──
    const intelligencePrompt = `You are a B2B outreach analyst. Given this research, identify the STRONGEST personalisation hooks.

RESEARCH:
Company: ${researchReport.companyName}
Mission: ${missionSnippet || 'Unknown'}
Top News: ${topNews ? `"${topNews.headline}" — ${topNews.summary}` : 'None found'}
Decision Maker: ${decisionMaker ? `${decisionMaker.name}, ${decisionMaker.title}` : 'Unknown'}

SENDER CONTEXT:
USP: ${userProfileContext.usp}
Product: ${userProfileContext.product}
Goal: ${userProfileContext.goal}

Return ONLY valid JSON:
{
  "primaryHook": "<the single strongest personalisation angle — must be from live news or mission>",
  "connectionToProduct": "<how the hook directly connects to sender's product/USP>",
  "suggestedSubjectLine": "<compelling subject line under 8 words>",
  "recipientFirstName": "<first name of decision maker or null>",
  "recipientTitle": "<job title or null>"
}`;

    let intelligence = null;
    try {
        const miniResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: intelligencePrompt }],
            max_tokens:  250,
            temperature: 0.2,
        }, {
            headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }
        });
        const raw     = miniResponse.data.choices[0].message.content.trim();
        const cleaned = raw.replace(/```json|```/g, '').trim();
        intelligence  = JSON.parse(cleaned);
    } catch (err) {
        console.warn(`⚠️ [WRITING ENGINE] Intelligence extraction failed: ${err.message}`);
    }
    // ── Step 2: GPT-4o — write the final human-quality email ──
    const recipientLine = intelligence?.recipientFirstName
        ? `Hi ${intelligence.recipientFirstName},`
        : `Hi there,`;

    const writingPrompt = `You are an elite B2B copywriter. Write a cold outreach email using ONLY the provided research hooks. No generic filler.

RULES:
- Exactly 3 paragraphs.
- Paragraph 1: Open with the PRIMARY HOOK (reference real news or mission). Never start with "I hope", "My name is", or "I wanted to reach out."
- Paragraph 2: Connect their situation directly to "${userProfileContext.product}" and the sender's USP. Be specific. No fluff.
- Paragraph 3: Soft CTA — goal is to "${userProfileContext.goal}". One sentence max.
- Tone: ${userProfileContext.tone}.
- Sound like a sharp human, not an AI. Vary sentence length.
- Do NOT use: "I hope this finds you well", "game-changer", "synergy", "touch base", "circle back", "revolutionary."

EMAIL BLUEPRINT:
Subject: ${intelligence?.suggestedSubjectLine || `Quick thought on ${researchReport.companyName}`}
Recipient: ${recipientLine}
Primary Hook: ${intelligence?.primaryHook || topNews?.headline || `${researchReport.companyName}'s recent activity`}
Product Connection: ${intelligence?.connectionToProduct || userProfileContext.usp}
Sender: ${userProfileContext.senderName}, ${userProfileContext.senderTitle} at ${userProfileContext.companyName}

Write ONLY the email body (no subject line, no signature). Start directly with the opening line.`;

    try {
        const gpt4Response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o',
            messages:    [{ role: 'user', content: writingPrompt }],
            max_tokens:  400,
            temperature: 0.7,
        }, {
            headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }
        });

        const emailBody = gpt4Response.data.choices[0].message.content.trim();

        return {
            subjectLine:    intelligence?.suggestedSubjectLine || `Quick thought on ${researchReport.companyName}`,
            recipient:      recipientLine,
            body:           emailBody,
            primaryHook:    intelligence?.primaryHook    || null,
            newsUsed:       topNews?.headline            || null,
            decisionMaker:  decisionMaker?.name          || null,
        };

    } catch (err) {
        console.warn(`⚠️ [WRITING ENGINE] Email generation failed: ${err.message}`);
        return null;
    }}

// ─── 2C: FORMAT THE DIRECTOR'S REPORT ─────────────────────────────────────────
function formatResearchAndEmailReport(researchReport, emailDraft) {
    const lines = [
        `🔬 **Intelligence Report — ${researchReport.companyName}**`,
        `⏱ Researched in ${researchReport.researchDuration}\n`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `\n📋 **RESEARCH SUMMARY**\n`,
    ];

    // Mission (from new companyProfile object)
    lines.push(`🎯 **Mission:** ${researchReport.companyProfile?.missionStatement || 'Not found'}\n`);

    // News (from new newsIntelligence array)
    if (researchReport.newsIntelligence?.length > 0) {
        lines.push(`📰 **Latest Headlines:**`);
        researchReport.newsIntelligence.forEach((n, i) => {
            lines.push(`  ${i + 1}. ${n.headline} (${n.sentiment})`);
            lines.push(`     📅 ${n.date} · ${n.url}`);
        });
        lines.push('');
    } else {
        lines.push(`📰 **Latest Headlines:** None found\n`);
    }

    // Decision Makers (from new decisionMakers array)
    if (researchReport.decisionMakers?.length > 0) {
        lines.push(`👤 **Decision Makers:**`);
        researchReport.decisionMakers.forEach(dm => {
            lines.push(`  • ${dm.name} — ${dm.title}`);
            if (dm.isHiring) lines.push(`    🚀 *Hiring Signal Detected*`);
        });
        lines.push('');
    } else {
        lines.push(`👤 **Decision Makers:** Not identified\n`);
    }

    // Financials (New Section)
    const fin = researchReport.financialSignals;
    if (fin && fin.lastFundingRound !== "Unknown") {
        lines.push(`💰 **Financial Signals:**`);
        lines.push(`  • Last Round: ${fin.lastFundingRound}`);
        if (fin.amountRaised) lines.push(`  • Raised: ${fin.amountRaised}`);
        if (fin.growthSignal) lines.push(`  • Growth: ${fin.growthSignal}`);
        lines.push('');
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    // Email Draft
    if (emailDraft) {
        lines.push(`\n✉️  **PERSONALIZED EMAIL DRAFT**\n`);
        lines.push(`📌 **Subject:** ${emailDraft.subjectLine}`);
        lines.push(`👤 **To:** ${emailDraft.recipient}\n`);
        lines.push(emailDraft.body);
        lines.push('');
        if (emailDraft.newsUsed) {
            lines.push(`📡 *Hook source: "${emailDraft.newsUsed}"*`);
        }
    } else {
        lines.push(`\n✉️  **Email Draft:** Could not be generated.\n`);
    }

    lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`\n${getTavilyQuotaSummary()}`);

    return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ███  STEP 1: PARSE USER INTENT (unchanged + extended)
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
    "<specific ready-to-run search string — pain point / job posting angle>"  ],
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
        `🎯 **Lead Search Complete**`,        `${totalSearched} businesses searched · Top ${leads.length} returned\n`,
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
            if (intent.location)          p.location          = intent.location;            if (intent.businessSize)      p.businessSize      = intent.businessSize;
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
                updatedHistory:  newHistory.slice(-12),
                researchReport,
                emailDraft,
                mode:            'research',
                quotaStatus:     getTavilyQuotaSummary(),
            };
        }

        // ══════════════════════════════════════════════════════════════════════
        // ROUTE B: LEAD SEARCH MODE (original behaviour — fully preserved)
        // ══════════════════════════════════════════════════════════════════════
        const rawResults  = await searchBusinessesOnline(session.lastSearchQueries, tavilyKey);
        const topLeads    = await rankAndSelectTopLeads(rawResults, session.profile, apiKey);        session.lastLeads = topLeads;
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
        // If it's a URL, pull the domain name and clean it up
        const hostname = new URL(input.startsWith('http') ? input : `https://${input}`).hostname;
        return hostname.replace('www.', '').split('.')[0]
            .replace(/-/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
    } catch {
        // It's already a plain company name
        return input.trim();
    }
}

module.exports = { generateFreeResponse };
