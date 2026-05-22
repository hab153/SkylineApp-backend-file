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

// Minimum confidence score to pass a lead through
const EMAIL_CONFIDENCE_THRESHOLD = 28;

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

// ─── CONTENT QUALITY FILTER — LOW-VALUE PAGE SIGNALS ─────────────────────────
// NEW: Used in _scorePageBusinessRelevance() to reject editorial/SEO noise early.
const LOW_VALUE_URL_PATTERNS = [
    /\/blog\//i,    /\/article\//i,
    /\/news\//i,
    /\/tutorial\//i,
    /\/how-to\//i,
    /\/guide\//i,
    /\/tips\//i,
    /\/resources\//i,
    /\/learn\//i,
    /\/wiki\//i,
    /\/forum\//i,
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

// ─── INTENT TYPES ─────────────────────────────────────────────────────────────
const INTENT = {
    LEAD_GEN:    'lead_gen',
    CHAT:        'chat',    EMAIL_DRAFT: 'email_draft',
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

// ─── QUOTA TRACKERS ────────────────────────────────────────────────────────────const tavilyQuota = { used: 0, limit: TAVILY_LIMIT, lastReset: Date.now() };

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
function setCachedResearch(domain, data) {    researchCache.set(domain, { data, timestamp: Date.now() });
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

// ─── NEW: PAGE BUSINESS RELEVANCE SCORER ─────────────────────────────────────
// Scores a search result 0–100 for B2B business entity relevance BEFORE
// committing Tavily quota to research it. High-value pages get processed;
// low-value content pages are rejected early to reduce noise and hallucination.
//
// Score bands:
//   70–100 : Process — strong business entity signal
//   40–69  : Process — moderate signal, worth checking
//   0–39   : Reject — likely blog/SEO/editorial content
//
function _scorePageBusinessRelevance(result) {
    const url     = (result.url     || '').toLowerCase();
    const title   = (result.title   || '').toLowerCase();
    const snippet = (result.snippet || '').toLowerCase();

    let score = 50; // neutral baseline

    // ── Hard reject: known low-value URL patterns ─────────────────────────
    for (const pattern of LOW_VALUE_URL_PATTERNS) {
        if (pattern.test(url)) {
            score -= 35;
            console.log(`🔴 [PAGE SCORE] Low-value URL pattern matched: ${url} → score penalised`);
            break;
        }
    }

    // ── Bonus: high-value URL structure signals ───────────────────────────
    for (const pattern of HIGH_VALUE_URL_PATTERNS) {
        if (pattern.test(url)) { score += 15; break; }
    }

    // ── Title signals ─────────────────────────────────────────────────────
    for (const signal of HIGH_VALUE_TITLE_SIGNALS) {        if (title.includes(signal)) { score += 12; break; }
    }
    for (const signal of LOW_VALUE_TITLE_SIGNALS) {
        if (title.includes(signal)) { score -= 20; break; }
    }

    // ── Snippet contact/email signals ─────────────────────────────────────
    if (snippet.includes('@'))                     score += 10;
    if (snippet.includes('contact'))               score += 5;
    if (/ceo|founder|owner|director/.test(snippet)) score += 10;
    if (/agency|studio|solutions|services/.test(snippet)) score += 8;

    // ── Penalise generic informational content ────────────────────────────
    if (/how to|what is|tutorial|step.by.step|learn how/.test(snippet)) score -= 15;
    if (/read more|subscribe|newsletter|download free/.test(snippet))   score -= 10;

    const finalScore = Math.max(0, Math.min(100, score));
    return finalScore;
}

// ─── NEW: INTENT NORMALIZATION ENGINE ────────────────────────────────────────
// Validates that a discovered lead actually matches the structured intent.
// Returns true if the lead should be included, false if it should be rejected.
// This acts as a post-discovery FILTER gate — precision over volume.
//
function _leadMatchesIntent(lead, intentParams) {
    if (!intentParams || !lead) return true; // no constraints = pass all

    const industryLower = (intentParams.industry || '').toLowerCase();
    const targetLower   = (intentParams.target_role || '').toLowerCase();

    // Skip validation if intent is vague/generic
    const GENERIC_TERMS = ['general', 'any', 'all', 'business', 'company', 'businesses'];
    const isVagueIntent = GENERIC_TERMS.some(t =>
        industryLower.includes(t) || targetLower.includes(t)
    );
    if (isVagueIntent) return true;

    // Check if the lead's industry context aligns
    const leadIndustry = (lead.industry || '').toLowerCase();
    const leadCompany  = (lead.company  || '').toLowerCase();
    const leadDomain   = (lead.domain   || '').toLowerCase();

    // If lead has an explicit industry tag and it's set, do a loose keyword match
    if (leadIndustry && leadIndustry !== 'unknown') {
        const intentKeywords = industryLower.split(/\s+/).filter(w => w.length > 3);
        const anyMatch = intentKeywords.some(kw =>
            leadIndustry.includes(kw) || leadCompany.includes(kw) || leadDomain.includes(kw)
        );
        // If we have strong keywords and zero match, flag but don't hard-reject        // (domain/company names don't always contain the industry word)
        if (!anyMatch && intentKeywords.length > 1) {
            console.log(`⚠️ [INTENT FILTER] Weak industry match for "${lead.company}" — industry: "${leadIndustry}" vs intent: "${industryLower}"`);
        }
    }

    // Role filter: if user requested a specific contact type, enforce it
    const preferredContact = (intentParams.target_role || 'any').toLowerCase();
    if (preferredContact && preferredContact !== 'any') {
        const leadRole = (lead.role || '').toLowerCase();
        if (leadRole && !leadRole.includes(preferredContact.split(' ')[0])) {
            console.log(`⚠️ [INTENT FILTER] Role mismatch: "${leadRole}" vs requested "${preferredContact}" for ${lead.company}`);
            // Don't hard-reject on role alone — best contact was already selected by priority
        }
    }

    return true; // Pass — filtering is advisory/logging for now to avoid false rejections
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

// ─── DISCOVERY LAYER (NEW SECOND LAYER) ───────────────────────────────────────
// Responsible for finding raw company candidates based on intent.
// Focuses on HIGH RECALL (breadth) rather than precision.
// Output: Array of { company, domain, source_url }
//
async function _runDiscovery(intentParams, tavilyKey, requestedCount) {
    console.log(`🔎 [DISCOVERY] Starting discovery for: ${intentParams.industry} in ${intentParams.location || 'Global'}`);    
    // 1. Generate Synonym/Expansion Queries for Broad Coverage
    const industry = intentParams.industry || '';
    const location = intentParams.location ? `"${intentParams.location}"` : '';
    const type     = intentParams.business_type || '';
    
    // Basic queries
    const queries = [
        `${industry} companies ${location}`,
        `${industry} businesses ${location}`,
        `${type} ${industry} ${location}`,
        `top ${industry} firms ${location}`,
        `${industry} agencies ${location}`,
        `${industry} startups ${location}`,
        `${industry} manufacturers ${location}`,
        `${industry} services ${location}`,
    ].filter(q => q.trim().length > 5); // Remove empty/short queries

    // Deduplication sets
    const seenDomains = new Set();
    const candidates  = [];
    
    // 2. Execute Search Queries (Parallel with concurrency limit)
    // We want to cast a wide net, so we run multiple queries
    const maxQueries = 6; // Limit to avoid excessive API usage in one go
    const queriesToRun = queries.slice(0, maxQueries);
    
    console.log(`🔎 [DISCOVERY] Running ${queriesToRun.length} discovery queries...`);

    for (const query of queriesToRun) {
        if (candidates.length >= requestedCount * 3) break; // Stop if we have enough raw candidates
        
        try {
            const results = await searchWithTavily(query, tavilyKey, { maxResults: 5 });
            
            for (const res of results) {
                let domain = '';
                try {
                    const urlObj = new URL(res.url);
                    domain = urlObj.hostname.replace('www.', '');
                } catch (e) { continue; }

                // Skip if we've already seen this domain
                if (seenDomains.has(domain)) continue;
                
                // Skip known non-company domains (social, directories, etc.)
                const SKIP_DISCOVERY_DOMAINS = [
                    'linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com',
                    'crunchbase.com', 'apollo.io', 'hunter.io', 'zoominfo.com',
                    'yelp.com', 'yellowpages.com', 'trustpilot.com', 'glassdoor.com',                    'medium.com', 'reddit.com', 'quora.com', 'wikipedia.org',
                    'youtube.com', 'vimeo.com', 'tiktok.com', 'pinterest.com',
                    'github.com', 'gitlab.com', 'stackoverflow.com',
                    'indeed.com', 'monster.com', 'careerbuilder.com',
                    'amazon.com', 'ebay.com', 'etsy.com', 'shopify.com',
                    'wordpress.com', 'wix.com', 'squarespace.com',
                    'google.com', 'bing.com', 'yahoo.com',
                    'bbc.com', 'cnn.com', 'reuters.com', 'bloomberg.com',
                    'forbes.com', 'entrepreneur.com', 'inc.com', 'techcrunch.com',
                    'hubspot.com', 'salesforce.com', 'microsoft.com', 'apple.com',
                    'netflix.com', 'spotify.com', 'uber.com', 'lyft.com',
                    'airbnb.com', 'booking.com', 'expedia.com', 'tripadvisor.com',
                    'ycombinator.com', 'angellist.com', 'producthunt.com',
                    'slideshow.net', 'slideshare.net', 'scribd.com',
                    'issuu.com', 'calameo.com', 'flipbook.com',
                    'pdfdrive.com', 'docdroid.net', 'docplayer.net',
                    'academia.edu', 'researchgate.net', 'springer.com',
                    'elsevier.com', 'sciencedirect.com', 'jstor.org',
                    'nature.com', 'science.org', 'cell.com', 'lanet.com',
                    'nih.gov', 'ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov',
                    'who.int', 'cdc.gov', 'fda.gov', 'epa.gov', 'usda.gov',
                    'un.org', 'worldbank.org', 'imf.org', 'oecd.org',
                    'europa.eu', 'ec.europa.eu', 'gov.uk', 'gov.ca',
                    'gov.ny.us', 'gov.tx.us', 'gov.fl.us', 'gov.il.us',
                    'gov.pa.us', 'gov.oh.us', 'gov.mi.us', 'gov.ga.us',
                    'gov.nc.us', 'gov.nj.us', 'gov.va.us', 'gov.ma.us',
                    'gov.in.us', 'gov.az.us', 'gov.tn.us', 'gov.mo.us',
                    'gov.md.us', 'gov.wi.us', 'gov.mn.us', 'gov.co.us',
                    'gov.al.us', 'gov.sc.us', 'gov.ok.us', 'gov.ky.us',
                    'gov.or.us', 'gov.ct.us', 'gov.ia.us', 'gov.ms.us',
                    'gov.ar.us', 'gov.ks.us', 'gov.ut.us', 'gov.nv.us',
                    'gov.nm.us', 'gov.wv.us', 'gov.ne.us', 'gov.id.us',
                    'gov.hi.us', 'gov.me.us', 'gov.nh.us', 'gov.ri.us',
                    'gov.mt.us', 'gov.de.us', 'gov.sd.us', 'gov.nd.us',
                    'gov.ak.us', 'gov.vt.us', 'gov.wy.us', 'gov.dc.us',
                    'gov.pr.us', 'gov.vi.us', 'gov.gu.us', 'gov.as.us',
                    'gov.mp.us', 'gov.um.us', 'gov.aq.us', 'gov.bq.us',
                    'gov.cw.us', 'gov.sx.us', 'gov.aw.us', 'gov.bb.us',
                    'gov.dm.us', 'gov.gd.us', 'gov.ht.us', 'gov.jm.us',
                    'gov.kn.us', 'gov.lc.us', 'gov.vc.us', 'gov.tt.us',
                    'gov.ag.us', 'gov.bs.us', 'gov.bz.us', 'gov.cr.us',
                    'gov.sv.us', 'gov.gt.us', 'gov.hn.us', 'gov.ni.us',
                    'gov.pa.us', 'gov.py.us', 'gov.pe.us', 'gov.sr.us',
                    'gov.uy.us', 'gov.ve.us', 'gov.bo.us', 'gov.cl.us',
                    'gov.co.us', 'gov.ec.us', 'gov.gf.us', 'gov.gy.us',
                    'gov.fk.us', 'gov.gs.us', 'gov.tk.us', 'gov.to.us',
                    'gov.tv.us', 'gov.nr.us', 'gov.pw.us', 'gov.fm.us',
                    'gov.mh.us', 'gov.ki.us', 'gov.sb.us', 'gov.vu.us',
                    'gov.fj.us', 'gov.ws.us', 'gov.as.us', 'gov.gu.us',
                    'gov.mp.us', 'gov.pr.us', 'gov.vi.us', 'gov.um.us',                    'gov.aq.us', 'gov.bq.us', 'gov.cw.us', 'gov.sx.us',
                    'gov.aw.us', 'gov.bb.us', 'gov.dm.us', 'gov.gd.us',
                    'gov.ht.us', 'gov.jm.us', 'gov.kn.us', 'gov.lc.us',
                    'gov.vc.us', 'gov.tt.us', 'gov.ag.us', 'gov.bs.us',
                    'gov.bz.us', 'gov.cr.us', 'gov.sv.us', 'gov.gt.us',
                    'gov.hn.us', 'gov.ni.us', 'gov.pa.us', 'gov.py.us',
                    'gov.pe.us', 'gov.sr.us', 'gov.uy.us', 'gov.ve.us',
                    'gov.bo.us', 'gov.cl.us', 'gov.co.us', 'gov.ec.us',
                    'gov.gf.us', 'gov.gy.us', 'gov.fk.us', 'gov.gs.us',
                    'gov.tk.us', 'gov.to.us', 'gov.tv.us', 'gov.nr.us',
                    'gov.pw.us', 'gov.fm.us', 'gov.mh.us', 'gov.ki.us',
                    'gov.sb.us', 'gov.vu.us', 'gov.fj.us', 'gov.ws.us'
                ];
                
                if (SKIP_DISCOVERY_DOMAINS.some(d => domain.includes(d))) continue;
                
                // Basic validation: must look like a company page (not a blog post or news article)
                // We use a very loose filter here to ensure HIGH RECALL
                if (LOW_VALUE_URL_PATTERNS.some(p => p.test(res.url))) continue;

                seenDomains.add(domain);
                candidates.push({
                    company: res.title || domain,
                    domain: domain,
                    source_url: res.url,
                    snippet: res.snippet || ''
                });
            }
        } catch (err) {
            console.warn(`⚠️ [DISCOVERY] Query failed: ${query} - ${err.message}`);
        }
    }

    console.log(`✅ [DISCOVERY] Found ${candidates.length} raw candidates.`);
    return candidates;
}

// ─── FILTERING LAYER (NEW THIRD LAYER) ────────────────────────────────────────
// Responsible for cleaning raw discovery results.
// Removes noise, duplicates, and irrelevant sites before deep research.
// Output: Array of { company, domain, source_url, relevance_score }
//
async function _runFiltering(rawCandidates, intentParams) {
    console.log(`🧹 [FILTERING] Starting filtering for ${rawCandidates.length} candidates...`);
    
    const filtered = [];
    const seenDomains = new Set();
    
    for (const candidate of rawCandidates) {
        const domain = candidate.domain.toLowerCase();        
        // 1. Duplicate Handling
        if (seenDomains.has(domain)) {
            console.log(`⏭️ [FILTERING] Duplicate domain skipped: ${domain}`);
            continue;
        }
        
        // 2. Hard Filters (Domain Quality & Business Relevance)
        // Check against known non-business or low-quality patterns
        const isLowValueUrl = LOW_VALUE_URL_PATTERNS.some(p => p.test(candidate.source_url));
        const isLowValueTitle = LOW_VALUE_TITLE_SIGNALS.some(s => (candidate.company || '').toLowerCase().includes(s));
        
        if (isLowValueUrl || isLowValueTitle) {
            console.log(`🔴 [FILTERING] Hard reject (low value): ${candidate.company} (${domain})`);
            continue;
        }
        
        // 3. Content Signals (Relevance Scoring)
        // We use the existing scorer to determine if it's worth researching
        const mockResult = {
            url: candidate.source_url,
            title: candidate.company,
            snippet: candidate.snippet
        };
        const relevanceScore = _scorePageBusinessRelevance(mockResult);
        
        // Threshold: Only keep candidates with moderate-to-high relevance
        // This prevents wasting API credits on blogs or news articles that slipped through
        if (relevanceScore < 40) {
            console.log(`🔴 [FILTERING] Soft reject (low score ${relevanceScore}): ${candidate.company} (${domain})`);
            continue;
        }
        
        seenDomains.add(domain);
        filtered.push({
            company: candidate.company,
            domain: domain,
            source_url: candidate.source_url,
            relevance_score: relevanceScore
        });
    }
    
    console.log(`✅ [FILTERING] ${filtered.length} candidates passed filtering.`);
    return filtered;
}

// ─── REAL EMAIL HUNTING ────────────────────────────────────────────────────────
function extractEmailsFromText(text, companyDomain) {
    if (!text || !companyDomain) return { companyEmails: [], allEmails: [] };
    const emailRegex    = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;    const allFound      = [...new Set(text.match(emailRegex) || [])];
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

// ─── DEAD STUB — DO NOT CALL ──────────────────────────────────────────────────
// Preserved for audit trail. Intentionally disabled.
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
    try {        const mxRecords = await dns.resolveMx(domain);
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
                            console.warn(`❌ [SMTP PROBE] ${email} → INVALID (${code})`);                            resolve('invalid');
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

// ─── FULL EMAIL VALIDATION PIPELINE ──────────────────────────────────────────
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

    const classification = classifyEmail(normalisedEmail, domain);

    let smtpResult = 'unknown';
    try {
        smtpResult = await smtpProbeEmail(normalisedEmail, emailDomain);
    } catch (e) {
        console.warn(`[SMTP PROBE CATCH] ${e.message}`);
    }
    result.smtpResult = smtpResult;

    if (smtpResult === 'invalid') {
        result.reason          = 'SMTP probe: mailbox does not exist';
        result.confidenceScore = 0;
        return result;
    }

    if (smtpResult === 'valid') {
        if (classification.type === 'confirmed-personal') {
            result.confidenceScore = 95;
            result.verdict         = 'verified';
            result.reason          = 'SMTP-confirmed personal email';        } else {
            result.confidenceScore = 78;
            result.verdict         = 'verified';
            result.reason          = 'SMTP-confirmed role/generic email';
        }
    } else {
        if (classification.type === 'confirmed-personal') {
            result.confidenceScore = 65;
            result.verdict         = 'probable';
            result.reason          = 'Found in public source, personal format, MX valid, SMTP inconclusive';
        } else if (classification.type === 'confirmed-generic' || classification.type === 'confirmed-other') {
            result.confidenceScore = 52;
            result.verdict         = 'probable';
            result.reason          = 'Found in public source, role email, MX valid, SMTP inconclusive';
        } else {
            result.confidenceScore = 30;
            result.verdict         = 'probable';
            result.reason          = 'Source-found, MX valid, format unclear';
        }
    }

    return result;
}

// ─── MULTI-EMAIL VALIDATION & RANKING ────────────────────────────────────────
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

// ─── VALIDATION ────────────────────────────────────────────────────────────────
async function validateMX(domain) {
    try {
        const records = await dns.resolveMx(domain);        return records && records.length > 0;
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
    }    return flags;
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

    // NEW: page relevance score bonus (0–10 points for high-quality entity pages)
    if (pageScore && pageScore >= 70) score += 10;
    else if (pageScore && pageScore >= 50) score += 5;

    score -= (hallucinationCount || 0) * 8;

    return Math.max(0, Math.min(score, 100));
}

// ─── ROLE PRIORITY PICKER ─────────────────────────────────────────────────────
function _pickBestContact(employees, preferredContact) {
    if (!employees || employees.length === 0) return null;

    const preferred = (preferredContact || '').toLowerCase().trim();

    if (preferred && preferred !== 'any') {        const match = employees.find(e =>
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
    const rtlNote = detectedLanguage.rtl        ? `NOTE: ${detectedLanguage.name} is a right-to-left language. Format text accordingly.`
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

// ─── OUTPUT QUANTITY CONTROL — _applyOutputQuantityRules ─────────────────────
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

// ─── INTENT PARSING ENGINE (NEW FIRST LAYER) ──────────────────────────────────
// Replaces the old _classifyIntent.
// Converts raw user request into a strict, machine-readable intent schema.
//
async function _parseUserIntent(message, history, apiKey) {
    const recentHistory = (history || []).slice(-6)
        .map(h => `${h.role}: ${h.content}`)
        .join('\n');

    const parsingPrompt = `You are the Intent Parsing Engine. Your job is to convert raw user requests into a strict, structured intent object.
    
    RULES:
    1. Identify the primary intent_type: "lead_gen", "email_draft", "business_qa", or "chat".
    2. If intent_type is "lead_gen", extract parameters: industry, business_type, target_role, location, purpose, constraints.
    3. Normalize synonyms (e.g., "boss" -> "CEO", "founder" -> "Founder").
    4. If a field is missing, use safe defaults (e.g., location: "Global", purpose: "outreach").
    5. NEVER hallucinate specific companies or contacts.
    6. Return ONLY valid JSON.

    RECENT CONVERSATION:
    ${recentHistory || 'None'}

    USER MESSAGE: "${message}"

    OUTPUT FORMAT:
    {
      "intent_type": "lead_gen" | "email_draft" | "business_qa" | "chat",
      "parameters": {
        "industry": "string (e.g., 'SaaS', 'Fashion', 'Logistics')",
        "business_type": "string (e.g., 'Startup', 'Enterprise', 'Agency')",
        "target_role": "string (e.g., 'CEO', 'Founder', 'Head of Growth')",
        "location": "string (e.g., 'China', 'London', 'Global')",
        "purpose": "string (e.g., 'outreach', 'partnerships', 'sales')",
        "constraints": ["string"] (e.g., ['only verified', 'exclude startups'])
      }
    }`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: parsingPrompt }],
            max_tokens:  250,
            temperature: 0.0,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:intentParse');

        if (!res) {
            // Fallback to chat if parsing fails            return {
                intent_type: INTENT.CHAT,
                parameters: {}
            };
        }

        recordOpenAiUsage(
            res.data?.usage?.prompt_tokens     || 0,
            res.data?.usage?.completion_tokens || 0,
            'gpt-4o-mini'
        );

        const raw = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        const parsed = JSON.parse(raw);

        // Ensure basic structure integrity
        if (!parsed.intent_type) parsed.intent_type = INTENT.CHAT;
        if (!parsed.parameters) parsed.parameters = {};

        console.log(`🎯 [INTENT PARSED] Type: ${parsed.intent_type} | Params: ${JSON.stringify(parsed.parameters)}`);
        return parsed;

    } catch (err) {
        console.warn('[Intent Parsing Failed]:', err.message);
        // Fallback to chat on error
        return {
            intent_type: INTENT.CHAT,
            parameters: {}
        };
    }
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

    const messages = [        { role: 'system',  content: systemPrompt },
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

// ─── BUSINESS QA HANDLER ──────────────────────────────────────────────────────
async function _handleBusinessQA(message, history, userProfile, apiKey) {
    const usp = userProfile?.usp || null;

    const systemPrompt = `You are a sharp senior business strategist and operator.You give direct, actionable business advice with zero corporate fluff.
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
CRITICAL: Do NOT construct any email. Do NOT guess. If not in snippets: null or empty array.SNIPPETS:
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
                emp.emailConfidence = emp.email ? 'confirmed-personal' : 'none';
                return emp;
            });
        }

        const hallucinations = detectHallucinations(companyName, parsed);
        if (hallucinations.length > 0) {
            console.warn(`⚠️ [HALLUCINATION] ${companyName}:`, hallucinations);
            parsed._hallucinationFlags = hallucinations;
            if (Array.isArray(parsed.employees)) {                parsed.employees = parsed.employees.filter(emp => {
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
            },            breakup: {
                subject: `Closing my file on ${company}`,
                body:    `${name},\n\nAssuming timing isn't right for ${company} right now — I'll stop following up. Reach out whenever it makes sense.\n\nBest,\n${sender}`,
            },
        };
    }
}

// ─── SINGLE COMPANY PIPELINE ──────────────────────────────────────────────────
// EMAIL RESOLUTION CHAIN:
//   TIER 1 — Regex-extracted emails from search snippets → validated by full pipeline
//   TIER 2 — Reality-checked employee email from GPT extract → validated by full pipeline
//   TIER 3 — huntRealEmails (contact/directory search) → validated by full pipeline
//   TIER 4 — REMOVED (guessEmailPatterns — fabricated, never call)
//
// NEW: page business relevance score gating before committing research quota.
//
async function processOneCompany(result, intentParams, tavilyKey, apiKey, userProfile, onProgress, detectedLanguage) {
    try {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
        if (!domain) return null;
        if (isFreeEmailDomain(domain)) return null;

        // NEW: Page business relevance gate — reject low-value content pages early
        const pageScore = _scorePageBusinessRelevance(result);
        if (pageScore < 30) {
            console.log(`🔴 [PAGE GATE] Rejected low-value page (score:${pageScore}): ${result.url}`);
            return null;
        }
        console.log(`🟢 [PAGE GATE] Accepted page (score:${pageScore}): ${result.url}`);

        const companyName = cleanCompanyName(result.title);
        if (!companyName) return null;

        // Company name dedup
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
        // Use target_role from structured intent
        const bestContact = _pickBestContact(employees, intentParams.target_role);

        // ── COLLECT ALL CANDIDATE EMAILS ────────────────────────────────────
        const candidateEmails = [
            ...(companyData?._regexEmails || []),
            ...(companyData?.contactEmails || []),
            ...(employees
                .filter(e => e.email && isValidEmailFormat(e.email))
                .map(e => e.email)
            ),
        ].filter(isValidEmailFormat);

        // ── TIER 3: EMAIL HUNT if no candidates yet ──────────────────────────
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

        // ── FULL VALIDATION PIPELINE ─────────────────────────────────────────
        onProgress?.(`🔬 Validating emails for ${companyName}...`);
        const validatedEmails = await rankAndFilterEmails(candidateEmails, domain);

        if (validatedEmails.length === 0) {
            console.warn(`🗑️ [REJECTED] ${companyName} — no emails passed validation threshold (${EMAIL_CONFIDENCE_THRESHOLD})`);
            return null;
        }
        const topEmail        = validatedEmails[0];
        const resolvedEmail   = topEmail.email;
        const classification  = classifyEmail(resolvedEmail, domain);
        const emailConfidence = classification.type;
        const emailLabel      = classification.label;
        const allEmailOptions = validatedEmails.map(v => v.email);

        console.log(`✅ ${companyName} → ${resolvedEmail} [${emailConfidence}] confidence:${topEmail.confidenceScore} smtp:${topEmail.smtpResult} MX:${mxValid}`);

        onProgress?.(`✍️ Writing emails for ${companyName}...`);

        const emailSequence = await generateEmailsForLead(
            {
                name:        companyName,
                mission:     companyData?.mission,
                recentNews:  companyData?.recentNews,
                industry:    intentParams.industry,
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
            pageScore,
        });

        const lead = {
            name:               bestContact?.name || companyName,
            company:            companyName,
            domain,
            email:              resolvedEmail,
            emailConfidence,
            emailLabel,
            emailValidation: {
                confidenceScore: topEmail.confidenceScore,
                verdict:         topEmail.verdict,
                smtpResult:      topEmail.smtpResult,                reason:          topEmail.reason,
            },
            allEmailOptions,
            role:               bestContact?.role || (companyData?.model === 'B2B' ? 'Decision Maker' : 'Owner'),
            linkedIn:           bestContact?.linkedIn  || null,
            companySize:        companyData?.size      || 'unknown',
            companyModel:       companyData?.model     || 'unknown',
            industry:           intentParams.industry  || 'unknown',
            hq:                 companyData?.hq        || null,
            recentNews:         companyData?.recentNews || null,
            leadScore,
            pageScore,
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

        // NEW: Intent match validation (advisory — logs mismatches, doesn't hard-reject)
        _leadMatchesIntent(lead, intentParams);

        return lead;

    } catch (err) {
        console.warn(`[processOneCompany Error] ${err.message}`);
        return null;
    }
}

// ─── LEAD GEN PIPELINE ────────────────────────────────────────────────────────
// Upgrades in this version (all additive, zero breaking changes):
//   1. Entity-first search using _buildEntityFirstQueries()
//   2. Page relevance scoring gate in processOneCompany()
//   3. Fallback query on thin primary pool
//   4. Company name dedup reset per pipeline run
//   5. Session _meta passthrough in return object
//   6. Expanded SKIP_DOMAINS list with more SEO/directory sites
//
async function _runLeadGenPipeline(safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, tavilyKey, intentParams) {

    // Reset company name dedup for each fresh pipeline run
    globalSeenCompanyNames.clear();

    // Parse user-requested quantity
    const requestedCount = _parseRequestedCount(safeMessage) ?? QUANTITY_RULE_DEFAULT_MAX;    console.log(`🔢 [QUANTITY CONTROL] User requested: ${requestedCount} leads`);

    // ─── NEW SECOND LAYER: DISCOVERY ─────────────────────────────────────────────
    // Find raw candidates first
    const rawCandidates = await _runDiscovery(intentParams, tavilyKey, requestedCount);
    
    if (rawCandidates.length === 0) {
        return {
            reply:          'No companies found during discovery. Try narrowing the industry or adding a location.',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'No leads found.' }],
        };
    }

    // ─── NEW THIRD LAYER: FILTERING ──────────────────────────────────────────────
    // Clean the raw candidates before expensive research
    const filteredCandidates = await _runFiltering(rawCandidates, intentParams);

    if (filteredCandidates.length === 0) {
        return {
            reply:          'Found potential companies but none passed quality filtering. Try a different industry.',
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: 'No leads after filtering.' }],
        };
    }

    onProgress?.(`⚙️ Processing ${filteredCandidates.length} filtered companies...`);

    // Convert filtered candidates into the format expected by processOneCompany
    const discoveryResults = filteredCandidates.map(c => ({
        title: c.company,
        url: c.source_url,
        snippet: '' // Snippet not needed here as we have relevance score
    }));

    // Process each discovered company through the existing verification/research pipeline
    const tasks = discoveryResults.map(result => () =>
        processOneCompany(result, intentParams, tavilyKey, apiKey, userProfile, onProgress, detectedLanguage)
    );
    
    // Run with concurrency limit
    const settled = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);

    const allVerifiedLeads = settled
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value)
        .sort((a, b) => b.leadScore - a.leadScore);

    // Apply CRITICAL OUTPUT QUANTITY RULE
    const leadsToReturn = _applyOutputQuantityRules(allVerifiedLeads, requestedCount);

    // Build session meta    const _meta = {
        tavilyUsed:         tavilyQuota.used,
        tavilyRemaining:    getTavilyRemaining(),
        openAiCalls:        openAiTracker.totalCallsThisSession,
        openAiInputTokens:  openAiTracker.totalInputTokensThisSession,
        openAiOutputTokens: openAiTracker.totalOutputTokensThisSession,
        estimatedCostUSD:   parseFloat(costTracker.estimatedUSDThisSession.toFixed(4)),
        totalVerified:      allVerifiedLeads.length,
        totalReturned:      leadsToReturn.length,
        requestedCount,
        discoveryCandidates: rawCandidates.length,
        filteredCandidates: filteredCandidates.length,
    };

    console.log(`🏁 Done. ${leadsToReturn.length} verified leads returned (from ${allVerifiedLeads.length} total verified).`);
    console.log(`📊 GPT: ${openAiTracker.totalCallsThisSession} calls | in:${openAiTracker.totalInputTokensThisSession} out:${openAiTracker.totalOutputTokensThisSession} tokens | ~$${costTracker.estimatedUSDThisSession.toFixed(4)}`);
    console.log(`🔍 Tavily: ${tavilyQuota.used}/${tavilyQuota.limit}`);

    if (leadsToReturn.length === 0) {
        return {
            reply:          'Found companies but no emails passed verification. Try a different industry or location.',
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

// ─── MAIN: generateFreeResponse ────────────────────────────────────────────────
// Function signature, return shape, all intent branches, and all existing
// environment variables are preserved 100%.
//
async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🟢 [AI ENGINE] Pipeline started...');
        onProgress?.('🧠 Understanding your request...');

        const apiKey    = process.env.OPENAI_API_KEY;
        const tavilyKey = process.env.TAVILY_API_KEY;

        const safeMessage = typeof message === 'string'            ? message.slice(0, MAX_MESSAGE_LENGTH)
            : '';

        if (!safeMessage.trim()) {
            return {
                reply:          'How can I help you today? I can find leads, draft emails, answer business questions, or just chat.',
                updatedHistory: history,
            };
        }

        const detectedLanguage = _detectLanguage(safeMessage);
        console.log(`🌐 [LANGUAGE] Detected: ${detectedLanguage.name} (${detectedLanguage.code})`);

        // ─── NEW FIRST LAYER: INTENT PARSING ─────────────────────────────────────
        const parsedIntent = await _parseUserIntent(safeMessage, history, apiKey);
        const intentType = parsedIntent.intent_type;
        const intentParams = parsedIntent.parameters;

        console.log(`🎯 [INTENT ROUTER] ${intentType}`);
        onProgress?.(`🧠 Mode: ${intentType.replace('_', ' ')}...`);

        if (intentType === INTENT.LEAD_GEN) {
            return await _runLeadGenPipeline(
                safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, tavilyKey, intentParams
            );
        }

        if (intentType === INTENT.EMAIL_DRAFT) {
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

        if (intentType === INTENT.BUSINESS_QA) {
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
