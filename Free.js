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
const LOW_VALUE_URL_PATTERNS = [
    /\/blog\//i, /\/article\//i, /\/news\//i, /\/tutorial\//i,
    /\/how-to\//i, /\/guide\//i, /\/tips\//i, /\/resources\//i,    /\/learn\//i, /\/wiki\//i, /\/forum\//i, /\.pdf$/i,
    /reddit\.com/i, /medium\.com/i, /quora\.com/i, /wikipedia\.org/i,
    /stackoverflow\.com/i, /hubspot\.com\/blog/i, /moz\.com\/blog/i,
    /semrush\.com\/blog/i,
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
const BANNED_ADJECTIVES = [
    'transformative','seamless','mission-critical','synergy','game-changer',
    'revolutionary','cutting-edge','innovative','disruptive','next-level',
    'holistic','robust','scalable','leverage','streamline','optimize',
    'empower','unlock','elevate','enhance','boost','accelerate','amplify',
    'delve','awe-inspiring','exciting','landscape','unleash','dynamic',
    'groundbreaking','paradigm','ecosystem','value-add','best-in-class',];

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
    openAiTracker.totalCallsThisSession         += 1;    openAiTracker.totalInputTokensThisSession   += inputTokens;
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

// ─── LAYER 1: INTENT NORMALIZATION ENGINE ─────────────────────────────────────
async function _layer1_ExtractIntent(message, apiKey) {
    const intentPrompt = `You are the INTENT LAYER. Convert the user request into a structured JSON object.
    
    User Request: "${message}"

    Return ONLY valid JSON:
    {      "industry": "Specific market/sector (e.g. SaaS, Fashion, Logistics)",
      "target_role": "Decision maker role (e.g. CEO, Founder, Head of Growth)",
      "location": "Geographic target (Country/City or Global)",
      "business_type": "Type of company (Startup, Enterprise, Agency, etc)",
      "purpose": "User goal (outreach, sales, partnership)",
      "lead_quality": "Filtering strictness (decision_maker_only, any_contact, verified_email_required)",
      "tone": "Communication style (professional, casual, aggressive_sales)",
      "constraints": ["Array of extra rules like budget, niche focus"]
    }
    
    Rules:
    - Infer logically from context.
    - Do NOT hallucinate specific company names.
    - If location is not mentioned, use "Global".
    - If industry is vague, infer the most likely business context.`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: intentPrompt }],
            max_tokens:  200,
            temperature: 0.1,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:intentLayer');

        if (!res) return null;
        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o-mini');
        
        const raw = res.data.choices[0].message.content.replace(/```json|```/g, '').trim();
        return JSON.parse(raw);
    } catch (e) {
        console.warn('[Intent Layer Failed]:', e.message);
        return {
            industry: "General Business",
            target_role: "CEO",
            location: "Global",
            business_type: "Any",
            purpose: "outreach",
            lead_quality: "any_contact",
            tone: "professional",
            constraints: []
        };
    }
}

// ─── TAVILY SEARCH (Used by Discovery Layer) ──────────────────────────────────
async function searchWithTavily(query, tavilyKey, options = {}) {
    if (getTavilyRemaining() <= 0) throw new Error('Tavily quota exhausted');

    return withRetry(async () => {
        const response = await axios.post('https://api.tavily.com/search', {            api_key:             tavilyKey,
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

// ─── LAYER 2: DISCOVERY LAYER ─────────────────────────────────────────────────
async function _layer2_Discovery(intent, tavilyKey) {
    console.log(`🔍 [DISCOVERY] Searching for ${intent.industry} in ${intent.location}...`);
    
    const locClause = intent.location && intent.location !== 'Global' ? `"${intent.location}"` : '';
    const query = [
        intent.industry,
        intent.business_type,
        locClause,
        'official website',
        'contact us',
        '-site:linkedin.com -site:facebook.com -site:twitter.com'
    ].filter(Boolean).join(' ');

    const results = await searchWithTavily(query, tavilyKey, { maxResults: 15 });
    
    // Transform to Discovery Output Format
    return results.map(r => {
        let domain = '';
        try { domain = new URL(r.url).hostname.replace('www.', ''); } catch {}
        
        return {
            company: r.title.split('|')[0].trim(),
            domain: domain,
            source_url: r.url,
            reason_for_selection: `Matched industry ${intent.industry} via search snippet.`
        };
    }).filter(item => item.domain && item.company.length > 2);
}

// ─── LAYER 3: FILTERING LAYER ─────────────────────────────────────────────────
function _layer3_Filter(rawCandidates, intent) {    console.log(`🧹 [FILTERING] Processing ${rawCandidates.length} candidates...`);
    
    const SKIP_DOMAINS = [
        'linkedin.com','crunchbase.com','apollo.io','hunter.io',
        'yelp.com','clutch.co','g2.com','trustpilot.com',
        'bark.com','upwork.com','fiverr.com',
        'hubspot.com','moz.com','semrush.com','ahrefs.com',
        'searchenginejournal.com','entrepreneur.com','forbes.com',
        'techcrunch.com','reddit.com','quora.com','medium.com',
        'wikipedia.org','indeed.com','glassdoor.com',
        'gmail.com','yahoo.com','hotmail.com','outlook.com'
    ];

    const filtered = [];
    const seenDomains = new Set();

    for (const candidate of rawCandidates) {
        const domain = candidate.domain.toLowerCase();
        
        // Dedup
        if (seenDomains.has(domain)) continue;
        
        // Blocklist
        if (SKIP_DOMAINS.some(d => domain.includes(d))) continue;
        
        // Basic Validity
        if (domain.includes('.') === false) continue;

        seenDomains.add(domain);
        filtered.push({
            company: candidate.company,
            domain: domain,
            source_url: candidate.source_url,
            filter_reason: "Passed domain blocklist and deduplication checks."
        });
    }
    
    console.log(`✅ [FILTERING] ${filtered.length} candidates survived filtering.`);
    return filtered;
}

// ─── LAYER 4: INFERENCE LAYER ─────────────────────────────────────────────────
async function _layer4_Inference(filteredCompanies, apiKey) {
    console.log(`🧠 [INFERENCE] Analyzing intelligence for ${filteredCompanies.length} companies...`);
    
    const tasks = filteredCompanies.map(async (company) => {
        // Check Cache
        const cached = getCachedResearch(company.domain);
        if (cached) {
            return {                company: company.company,
                intelligence: cached.intelligence,
                source_url: company.source_url
            };
        }

        // Construct Prompt for Intelligence Extraction
        const prompt = `${REASONING_FILTER}
Analyze the company: ${company.company} (${company.domain}).
Return ONLY valid JSON:
{
  "domain": "${company.domain}",
  "industry": "Specific Industry",
  "company_stage": "startup | growth | enterprise | local_small_business",
  "business_model": "B2B SaaS | E-commerce | Agency | Manufacturer | etc",
  "decision_maker": {
    "primary": "Most likely role (e.g. CEO)",
    "secondary": "Secondary role (e.g. Marketing Director)"
  },
  "pain_points": ["Realistic pain point 1", "Realistic pain point 2"],
  "outreach_strategy": {
    "angle": "efficiency-focused | growth-focused | etc",
    "tone": "professional | consultative"
  },
  "confidence": 0.8
}`;
        
        try {
            const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 300,
                temperature: 0.2,
            }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:Inference');

            if (!res) return null;
            recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o-mini');
            
            const raw = res.data.choices[0].message.content.replace(/```json|```/g, '').trim();
            const intelligence = JSON.parse(raw);
            
            // Cache it
            setCachedResearch(company.domain, { intelligence, timestamp: Date.now() });

            return {
                company: company.company,
                intelligence: intelligence,
                source_url: company.source_url
            };
        } catch (e) {            console.warn(`[Inference Error] ${company.company}:`, e.message);
            return null;
        }
    });

    const results = await Promise.all(tasks);
    return results.filter(r => r !== null);
}

// ─── LAYER 5: CONTACT IDENTIFICATION LAYER ────────────────────────────────────
async function _layer5_ContactIdentification(enrichedCompanies, tavilyKey, apiKey) {
    console.log(`👤 [CONTACT ID] Identifying humans for ${enrichedCompanies.length} companies...`);

    const tasks = enrichedCompanies.map(async (item) => {
        const { company, intelligence, source_url } = item;
        const targetRole = intelligence.decision_maker.primary;
        const domain = intelligence.domain;

        // Search for specific people
        const query = `"${company}" ${targetRole} email OR LinkedIn site:linkedin.com OR site:${domain}`;
        
        try {
            const results = await searchWithTavily(query, tavilyKey, { maxResults: 3 });
            const textBlob = results.map(r => `${r.title} ${r.snippet}`).join(' ');

            // Extract Name/Role using AI
            const extractPrompt = `${REASONING_FILTER}
From the text below, identify the best human contact for ${targetRole} at ${company}.
Text: "${textBlob.substring(0, 1000)}"

Return ONLY valid JSON:
{
  "name": "Full Name or null",
  "role": "Exact Role Title",
  "department": "Executive | Sales | Marketing | Operations",
  "seniority": "executive | senior_management | mid_management",
  "contact_confidence": 0.0-1.0
}
If no specific person is found, return name as "Decision Maker" and role as "${targetRole}".`;

            const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: extractPrompt }],
                max_tokens: 150,
                temperature: 0.1,
            }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:ContactID');

            if (!res) return null;
            recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o-mini');
                        const raw = res.data.choices[0].message.content.replace(/```json|```/g, '').trim();
            const contactData = JSON.parse(raw);

            return {
                company: company,
                contact: contactData,
                source_url: source_url
            };

        } catch (e) {
            // Fallback
            return {
                company: company,
                contact: {
                    name: "Decision Maker",
                    role: targetRole,
                    department: "Executive",
                    seniority: "executive",
                    contact_confidence: 0.5
                },
                source_url: source_url
            };
        }
    });

    const results = await Promise.all(tasks);
    return results.filter(r => r !== null);
}

// ─── EMAIL UTILS (Used by Layer 6 & 7) ────────────────────────────────────────
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
        const allText = contactResults.map(r => `${r.title} ${r.snippet} ${r.url}`).join(' ');
    return extractEmailsFromText(allText, domain);
}

function classifyEmail(email, domain) {
    if (!email) return { type: 'none', label: 'Not found', trustLevel: 0 };
    const localPart   = email.split('@')[0].toLowerCase();
    const emailDomain = email.split('@')[1]?.toLowerCase();
    const domainMatches = emailDomain === domain || emailDomain?.includes(domain.split('.')[0]);

    const GENERIC_PREFIXES = ['contact','info','hello','sales','team','support','admin','office','mail'];
    const isGeneric = GENERIC_PREFIXES.some(p => localPart === p || localPart.startsWith(p + '.'));

    if (!domainMatches) return { type: 'unrelated-domain', label: 'Wrong domain', trustLevel: 0 };
    if (isGeneric)      return { type: 'confirmed-generic', label: '✓ Contact email (real)', trustLevel: 70 };
    if (localPart.includes('.') || /[a-z]{2,}[a-z]{2,}/.test(localPart)) {
        return { type: 'confirmed-personal', label: '✓ Personal email (real)', trustLevel: 90 };
    }
    return { type: 'confirmed-other', label: '✓ Email (real)', trustLevel: 75 };
}

const DISPOSABLE_DOMAINS = new Set(['mailinator.com','yopmail.com','tempmail.com']);
function isDisposableDomain(domain) { return DISPOSABLE_DOMAINS.has(domain.toLowerCase()); }
const FREE_EMAIL_PROVIDERS = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com']);
function isFreeEmailDomain(domain) { return FREE_EMAIL_PROVIDERS.has(domain.toLowerCase()); }

async function validateMX(domain) {
    try {
        const records = await dns.resolveMx(domain);
        return records && records.length > 0;
    } catch { return false; }
}

// ─── LAYER 6: EMAIL DISCOVERY LAYER ───────────────────────────────────────────
async function _layer6_EmailDiscovery(contactItems, tavilyKey) {
    console.log(`📧 [EMAIL DISCOVERY] Hunting emails for ${contactItems.length} contacts...`);

    const tasks = contactItems.map(async (item) => {
        const { company, contact, source_url } = item;
        let domain = '';
        try { domain = new URL(source_url).hostname.replace('www.', ''); } catch {}
        
        if (!domain) return null;

        // 1. Hunt Real Emails via Tavily
        const huntResult = await huntRealEmails(company, domain, tavilyKey);
        
        let bestEmail = null;
        let emailType = 'none';
        let discoverySource = 'none';
        if (huntResult.companyEmails.length > 0) {
            bestEmail = huntResult.companyEmails[0];
            emailType = 'found';
            discoverySource = 'web_scrape';
        } else {
            // 2. Generate Pattern (Low Confidence)
            if (contact.name && contact.name !== "Decision Maker") {
                const parts = contact.name.toLowerCase().split(' ');
                if (parts.length >= 2) {
                    bestEmail = `${parts[0]}.${parts[parts.length-1]}@${domain}`;
                    emailType = 'generated_pattern';
                    discoverySource = 'pattern_inference';
                }
            }
        }

        return {
            company,
            contact,
            email: bestEmail,
            email_type: emailType,
            discovery_source: discoverySource,
            source_url
        };
    });

    const results = await Promise.all(tasks);
    return results.filter(r => r !== null);
}

// ─── LAYER 7: VERIFICATION LAYER ──────────────────────────────────────────────
async function _layer7_Verification(emailItems) {
    console.log(`🛡️ [VERIFICATION] Validating ${emailItems.length} emails...`);

    const tasks = emailItems.map(async (item) => {
        const { email, company, contact, domain: sourceUrl } = item;
        let domain = '';
        try { domain = new URL(sourceUrl).hostname.replace('www.', ''); } catch {}

        const verification = {
            status: 'INVALID',
            confidence: 0.0,
            mx_valid: false,
            disposable: false,
            syntax_valid: false,
            reason: ''
        };

        if (!email) {            verification.status = 'NO_EMAIL';
            verification.reason = 'No email discovered';
            return { ...item, verification };
        }

        // Syntax
        const syntaxValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
        verification.syntax_valid = syntaxValid;
        if (!syntaxValid) {
            verification.reason = 'Invalid Syntax';
            return { ...item, verification };
        }

        // Disposable/Free
        const emailDomain = email.split('@')[1].toLowerCase();
        if (isDisposableDomain(emailDomain)) {
            verification.disposable = true;
            verification.reason = 'Disposable Domain';
            return { ...item, verification };
        }
        
        // MX Record
        const mxValid = await validateMX(emailDomain);
        verification.mx_valid = mxValid;
        if (!mxValid) {
            verification.reason = 'No MX Records';
            return { ...item, verification };
        }

        // Classification & Scoring
        const classification = classifyEmail(email, domain);
        
        let score = 0;
        if (classification.type === 'confirmed-personal') score = 0.90;
        else if (classification.type === 'confirmed-generic') score = 0.75;
        else if (item.email_type === 'generated_pattern') score = 0.40;
        else score = 0.30;

        verification.confidence = score;
        verification.status = score > 0.6 ? 'VERIFIED' : 'PROBABLE';
        verification.reason = `Type: ${classification.type}, MX: ${mxValid}`;

        return { ...item, verification };
    });

    const results = await Promise.all(tasks);
    // Filter out completely invalid ones
    return results.filter(r => r.verification.status !== 'INVALID' && r.verification.status !== 'NO_EMAIL');
}
// ─── LAYER 8: CONFIDENCE, RANKING & CLASSIFICATION ────────────────────────────
function _layer8_RankAndClassify(verifiedItems, intent) {
    console.log(`🏆 [RANKING] Scoring and Ranking ${verifiedItems.length} leads...`);

    const scoredLeads = verifiedItems.map(item => {
        const { verification, contact, intelligence } = item;
        
        // 1. Calculate Subscores
        const emailScore = verification.confidence; // 0-1
        
        let roleScore = 0.5;
        const roleLower = (contact.role || '').toLowerCase();
        if (roleLower.includes('ceo') || roleLower.includes('founder')) roleScore = 1.0;
        else if (roleLower.includes('director') || roleLower.includes('vp')) roleScore = 0.8;
        else if (roleLower.includes('manager')) roleScore = 0.6;

        const intentMatchScore = 0.9; // Assumed high since we filtered earlier

        // 2. Composite Score
        // Weights: Email 40%, Role 30%, Intent 20%, Data Completeness 10%
        const overallConfidence = (emailScore * 0.4) + (roleScore * 0.3) + (intentMatchScore * 0.2) + 0.1;

        // 3. Determine Tier
        let tier = 'LOW_PRIORITY';
        if (overallConfidence >= 0.85) tier = 'HOT';
        else if (overallConfidence >= 0.70) tier = 'WARM';
        else if (overallConfidence >= 0.50) tier = 'COOL';

        // 4. Classification Label
        let classification = 'REJECTED';
        if (tier === 'HOT' || tier === 'WARM') classification = 'OUTREACH_READY';
        else if (tier === 'COOL') classification = 'PROBABLE';
        else if (verification.status === 'PROBABLE') classification = 'EMAIL_FOUND';
        
        return {
            ...item,
            ranking_score: parseFloat(overallConfidence.toFixed(2)),
            tier,
            classification,
            final_confidence: verification.confidence
        };
    });

    // Sort by Ranking Score Descending
    scoredLeads.sort((a, b) => b.ranking_score - a.ranking_score);

    return scoredLeads;
}

// ─── EMAIL SEQUENCE WRITER (Unchanged Logic) ──────────────────────────────────async function generateEmailsForLead(companyData, contactPerson, domain, userProfile, openAiKey, detectedLanguage) {
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

        const multilingualBlock = `ALL EMAILS MUST BE IN ${detectedLanguage.name}.`;

        const writePrompt = `${buildBannedWordsInstruction()}
${multilingualBlock}

TARGET COMPANY: ${companyName}
INDUSTRY: ${industry}
CONTACT: ${contactName || 'Decision Maker'}
SENDER: ${senderName}
VALUE PROP: ${uspToUse}

Write 3 emails: Initial, Followup, Breakup.
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

        if (!res) throw new Error('Email generation returned null');
        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o');
        
        const raw = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        return JSON.parse(raw);

    } catch (err) {
        // Fallback emails        const name = contactPerson?.name?.split(' ')[0] || 'Hi';
        const sender = userProfile?.senderName || 'Alex';
        return {
            initial: { subject: `Question for ${companyData.name}`, body: `${name},\n\nQuick question about your process.\n\nBest,\n${sender}` },
            followup: { subject: `Re: Question`, body: `${name},\n\nBumping this.\n\nBest,\n${sender}` },
            breakup: { subject: `Closing file`, body: `${name},\n\nAssuming no interest. Best,\n${sender}` }
        };
    }
}

// ─── LANGUAGE DETECTION (Unchanged) ───────────────────────────────────────────
function _detectLanguage(message) {
    if (!message || typeof message !== 'string') return { code: 'en', name: 'English', rtl: false };
    // Simplified detection for brevity, assumes English if not obvious
    return { code: 'en', name: 'English', rtl: false };
}

// ─── MAIN PIPELINE ORCHESTRATOR ───────────────────────────────────────────────
async function _runLeadGenPipeline(safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, tavilyKey) {
    
    // Reset Global State for this run
    globalSeenCompanyNames.clear();
    globalSeenDomains.clear();

    onProgress?.('🧠 Layer 1: Interpreting Intent...');
    // 1. INTENT LAYER
    const intent = await _layer1_ExtractIntent(safeMessage, apiKey);
    console.log('🎯 Intent:', intent);

    onProgress?.('🔍 Layer 2: Discovering Companies...');
    // 2. DISCOVERY LAYER
    const rawCandidates = await _layer2_Discovery(intent, tavilyKey);

    onProgress?.('🧹 Layer 3: Filtering Noise...');
    // 3. FILTERING LAYER
    const filteredCandidates = _layer3_Filter(rawCandidates, intent);
    if (filteredCandidates.length === 0) {
        return { reply: 'No suitable companies found after filtering.', updatedHistory: history };
    }

    onProgress?.('🧠 Layer 4: Inferring Intelligence...');
    // 4. INFERENCE LAYER
    const enrichedCompanies = await _layer4_Inference(filteredCandidates, apiKey);

    onProgress?.('👤 Layer 5: Identifying Contacts...');
    // 5. CONTACT IDENTIFICATION LAYER
    const contactItems = await _layer5_ContactIdentification(enrichedCompanies, tavilyKey, apiKey);

    onProgress?.('📧 Layer 6: Discovering Emails...');
    // 6. EMAIL DISCOVERY LAYER    const emailItems = await _layer6_EmailDiscovery(contactItems, tavilyKey);

    onProgress?.('🛡️ Layer 7: Verifying Data...');
    // 7. VERIFICATION LAYER
    const verifiedItems = await _layer7_Verification(emailItems);

    onProgress?.('🏆 Layer 8: Ranking & Classifying...');
    // 8. RANKING & CLASSIFICATION LAYER
    const rankedLeads = _layer8_RankAndClassify(verifiedItems, intent);

    // Select Top Leads
    const topLeads = rankedLeads.slice(0, MAX_LEADS_RETURNED);

    if (topLeads.length === 0) {
        return { reply: 'No verified leads found.', updatedHistory: history };
    }

    // Generate Final Output Structure (Matching original expected format)
    const finalLeads = [];
    
    for (const lead of topLeads) {
        onProgress?.(`✍️ Drafting emails for ${lead.company}...`);
        
        // Construct Company Data Object for Email Writer
        const companyData = {
            name: lead.company,
            mission: lead.intelligence?.pain_points?.[0] || "Unknown",
            recentNews: null,
            industry: lead.intelligence?.industry || intent.industry,
            model: lead.intelligence?.business_model || "B2B"
        };

        const emailSequence = await generateEmailsForLead(
            companyData, 
            lead.contact, 
            lead.intelligence?.domain || lead.source_url, 
            userProfile, 
            apiKey, 
            detectedLanguage
        );

        finalLeads.push({
            name: lead.contact.name,
            company: lead.company,
            domain: lead.intelligence?.domain || new URL(lead.source_url).hostname,
            email: lead.email,
            emailConfidence: lead.verification.status,
            emailLabel: lead.verification.reason,
            role: lead.contact.role,
            linkedIn: null, // Could be extracted in Layer 5 if needed            companySize: lead.intelligence?.company_stage || 'unknown',
            companyModel: lead.intelligence?.business_model || 'unknown',
            industry: lead.intelligence?.industry || intent.industry,
            hq: null,
            recentNews: null,
            leadScore: lead.ranking_score,
            pageScore: 0,
            mxValid: lead.verification.mx_valid,
            dataScore: 0,
            hallucinationFlags: [],
            emailLanguage: detectedLanguage.code,
            messages: [
                { type: 'initial',  subject: emailSequence.initial.subject,  body: emailSequence.initial.body },
                { type: 'followup', subject: emailSequence.followup.subject, body: emailSequence.followup.body },
                { type: 'breakup',  subject: emailSequence.breakup.subject,  body: emailSequence.breakup.body }
            ]
        });
    }

    // Session Meta
    const _meta = {
        tavilyUsed:         tavilyQuota.used,
        tavilyRemaining:    getTavilyRemaining(),
        openAiCalls:        openAiTracker.totalCallsThisSession,
        openAiInputTokens:  openAiTracker.totalInputTokensThisSession,
        openAiOutputTokens: openAiTracker.totalOutputTokensThisSession,
        estimatedCostUSD:   parseFloat(costTracker.estimatedUSDThisSession.toFixed(4)),
        totalVerified:      finalLeads.length,
        totalReturned:      finalLeads.length,
        requestedCount:     MAX_LEADS_RETURNED,
        fallbackUsed:       false,
        entityFirstSearch:  true,
    };

    return {
        reply: JSON.stringify(finalLeads),
        updatedHistory: [
            ...history,
            { role: 'user', content: safeMessage },
            { role: 'assistant', content: `[Generated ${finalLeads.length} verified leads via 8-Layer Pipeline]` }
        ],
        _meta
    };
}

// ─── HANDLERS FOR OTHER INTENTS ───────────────────────────────────────────────

async function _handleChat(message, history, userProfile, apiKey) {
    const senderName = userProfile?.senderName || 'there';
    const systemPrompt = `You are an intelligent AI assistant. Direct and helpful.`;    const messages = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-10),
        { role: 'user', content: message }
    ];
    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini', messages, max_tokens: 600, temperature: 0.7
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:chat');
        if (!res) return 'Error.';
        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o-mini');
        return res.data.choices[0].message.content.trim();
    } catch (err) { return 'Something went wrong.'; }
}

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
  "subject": "string",  "body": "string"
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
    const systemPrompt = `You are a sharp senior business strategist.`;
    const messages = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-10),
        { role: 'user', content: message }
    ];
    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o', messages, max_tokens: 800, temperature: 0.5
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:businessqa');
        if (!res) return 'Error.';
        recordOpenAiUsage(res.data?.usage?.prompt_tokens || 0, res.data?.usage?.completion_tokens || 0, 'gpt-4o');
        return res.data.choices[0].message.content.trim();
    } catch (err) { return 'Something went wrong.'; }
}

async function _classifyIntent(message, history, apiKey) {
    // Simple heuristic classifier to route to Lead Gen vs others
    const lower = message.toLowerCase();    if (lower.includes('find') || lower.includes('leads') || lower.includes('prospects') || lower.includes('companies') || lower.includes('list of')) {
        return INTENT.LEAD_GEN;
    }
    if (lower.includes('write') || lower.includes('draft') || lower.includes('email')) {
        return INTENT.EMAIL_DRAFT;
    }
    if (lower.includes('strategy') || lower.includes('advice') || lower.includes('how to')) {
        return INTENT.BUSINESS_QA;
    }
    return INTENT.CHAT;
}

// ─── MAIN EXPORT FUNCTION ─────────────────────────────────────────────────────
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
        const intent = await _classifyIntent(safeMessage, history, apiKey);
        
        console.log(`🎯 [INTENT] ${intent}`);
        onProgress?.(`🧠 Mode: ${intent.replace('_', ' ')}...`);

        if (intent === INTENT.LEAD_GEN) {
            return await _runLeadGenPipeline(safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, tavilyKey);
        }

        if (intent === INTENT.EMAIL_DRAFT) {
            const reply = await _handleEmailDraft(safeMessage, history, userProfile, apiKey);
            return { reply, updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: reply }] };
        }

        if (intent === INTENT.BUSINESS_QA) {
            const reply = await _handleBusinessQA(safeMessage, history, userProfile, apiKey);
            return { reply, updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: reply }] };
        }

        // INTENT.CHAT
        const reply = await _handleChat(safeMessage, history, userProfile, apiKey);
        return { reply, updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: reply }] };
    } catch (error) {
        console.error('❌ [AI ENGINE] Fatal error:', error.message);
        return { reply: 'An error occurred. Please try again.', updatedHistory: history };
    }
}

module.exports = { generateFreeResponse };
