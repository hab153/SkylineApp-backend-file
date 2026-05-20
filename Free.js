'use strict';

const axios = require('axios');
const dns   = require('dns').promises;
const net   = require('net');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const TAVILY_LIMIT       = 1000;
const CACHE_TTL_MS       = 60 * 60 * 1000;
const CURRENT_YEAR       = new Date().getFullYear();
const MAX_MESSAGE_LENGTH = 800;

// ─── QUOTA TRACKERS ────────────────────────────────────────────────────────────
const tavilyQuota = { used: 0, limit: TAVILY_LIMIT, lastReset: Date.now() };

function checkTavilyReset() {
    const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - tavilyQuota.lastReset >= ONE_MONTH) {
        tavilyQuota.used      = 0;
        tavilyQuota.lastReset = Date.now();
    }
}
function getTavilyRemaining() { checkTavilyReset(); return tavilyQuota.limit - tavilyQuota.used; }
function recordTavilyUsage()  { tavilyQuota.used += 1; }

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
            max_results:         options.maxResults || 10,
            include_answer:      false,            include_raw_content: false,
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

// ─── COLLECT STAGE: INTENT PARSING ─────────────────────────────────────────────
async function parseIntent(message, apiKey) {
    const intentPrompt = `You are an intent parser for a B2B lead generation system.
Extract structured intent from the following user request: "${message}".

Return ONLY valid JSON:
{
  "industry": "string (e.g., SaaS, Logistics, Consulting). Infer if not explicit.",
  "business_type": "string (e.g., Agency, Startup, Enterprise, Local Business). Infer if not explicit.",
  "target_role": "string (e.g., CEO, Founder, Owner, Decision Maker). Default to 'Decision Maker' if not specified.",
  "location": "string or null (City, Country, Region). Null if not mentioned.",
  "purpose": "string (Brief summary of why they are searching, e.g., 'outreach', 'partnership'). Default to 'outreach'."
}

Rules:
- If industry is vague (e.g., "companies"), infer based on context or default to "General Business".
- Target role should be specific decision-makers.
- Location must be null if not explicitly mentioned.`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: intentPrompt }],
            max_tokens:  150,
            temperature: 0.1,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:intentParse');

        if (!res) return { industry: 'General', business_type: 'Company', target_role: 'Decision Maker', location: null, purpose: 'outreach' };

        const raw    = res.data.choices[0].message.content.replace(/```json|```/g, '');
        const parsed = JSON.parse(raw);
        console.log(`🎯 [INTENT PARSED] ${JSON.stringify(parsed)}`);
        return parsed;

    } catch (e) {
        console.warn('[Intent Parse Failed]:', e.message);
        return { industry: 'General', business_type: 'Company', target_role: 'Decision Maker', location: null, purpose: 'outreach' };
    }}

// ─── COLLECT STAGE: QUERY CONSTRUCTION ─────────────────────────────────────────
function constructQueries(intent) {
    const { industry, business_type, target_role, location } = intent;
    const locClause = location ? `"${location}"` : '';
    
    const roleKeywords = target_role.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const primaryRole = roleKeywords[0] || 'founder';

    const queries = [];
    queries.push(`"${industry}" "${primaryRole}" contact page ${locClause} inurl:contact OR inurl:about`);
    queries.push(`"${industry}" "${business_type}" team page ${locClause} inurl:team OR inurl:about`);
    queries.push(`"${industry}" company "${primaryRole}" ${locClause} site:.com`);
    queries.push(`"${industry}" founder OR CEO email contact ${locClause}`);

    console.log(`🔍 [QUERIES GENERATED] ${queries.length} queries`);
    return queries;
}

// ─── COLLECT STAGE: EARLY SOURCE FILTERING ─────────────────────────────────────
function filterRawSources(results) {
    const REJECT_PATTERNS = [
        /\/blog\//i, /\/article\//i, /\/news\//i, /\/tutorial\//i,
        /\/how-to\//i, /\/guide\//i, /\/tips\//i, /\/resources\//i,
        /\/learn\//i, /\/wiki\//i, /\/forum\//i, /\/comments\//i,
        /\.pdf$/i,
        /reddit\.com/i, /medium\.com/i, /quora\.com/i, /wikipedia\.org/i,
        /stackoverflow\.com/i, /linkedin\.com\/posts/i, /facebook\.com/i,
        /twitter\.com/i, /x\.com/i, /instagram\.com/i,
        /hubspot\.com\/blog/i, /moz\.com\/blog/i, /semrush\.com\/blog/i,
        /clutch\.co/i, /yelp\.com/i, /g2\.com/i, /capterra\.com/i,
        /crunchbase\.com/i, /apollo\.io/i, /hunter\.io/i,
        /top\s+\d+/i, /best\s+\d+/i, /listicle/i
    ];

    const ACCEPT_PATTERNS = [
        /\/about/i, /\/team/i, /\/contact/i, /\/company/i,
        /\/people/i, /\/leadership/i, /\/founders/i, /\/our-story/i,
        /\/home/i, /^https?:\/\/[^\/]+\/?$/i
    ];

    const filtered = [];

    for (const result of results) {
        const url = result.url || '';
        const title = result.title || '';

        let rejected = false;
        for (const pattern of REJECT_PATTERNS) {            if (pattern.test(url) || pattern.test(title)) {
                rejected = true;
                break;
            }
        }
        if (rejected) continue;

        let accepted = false;
        for (const pattern of ACCEPT_PATTERNS) {
            if (pattern.test(url)) {
                accepted = true;
                break;
            }
        }

        const urlObj = new URL(url);
        const isRootDomain = urlObj.pathname === '/' || urlObj.pathname === '';
        
        if (accepted || isRootDomain) {
            filtered.push(result);
        } else {
            filtered.push(result); 
        }
    }
    console.log(`🧹 [FILTERING] Reduced ${results.length} results to ${filtered.length} high-quality candidates`);
    return filtered;
}

// ─── COLLECT STAGE: DOMAIN NORMALIZATION ───────────────────────────────────────
function normalizeDomains(filteredResults) {
    const domainMap = new Map();

    for (const result of filteredResults) {
        try {
            const urlObj = new URL(result.url);
            const domain = urlObj.hostname.replace(/^www\./, '');
            
            if (!domainMap.has(domain)) {
                domainMap.set(domain, {
                    domain: domain,
                    source_url: result.url,
                    title: result.title,
                    snippet: result.snippet,
                    original_results: [result]
                });
            } else {
                const existing = domainMap.get(domain);
                const currentUrlLower = result.url.toLowerCase();
                const existingUrlLower = existing.source_url.toLowerCase();
                const priorityPaths = ['/contact', '/about', '/team', '/leadership'];                
                let shouldReplace = false;
                for (const path of priorityPaths) {
                    if (currentUrlLower.includes(path) && !existingUrlLower.includes(path)) {
                        shouldReplace = true;
                        break;
                    }
                }

                if (shouldReplace) {
                    existing.source_url = result.url;
                    existing.title = result.title;
                    existing.snippet = result.snippet;
                }
                existing.original_results.push(result);
            }
        } catch (e) {
            // Invalid URL, skip
        }
    }
    return Array.from(domainMap.values());
}

// ─── COLLECT STAGE: CONFIDENCE SCORING ─────────────────────────────────────────
function calculateCollectConfidence(entity, intent) {
    let score = 0.5;

    const url = entity.source_url.toLowerCase();
    const title = (entity.title || '').toLowerCase();
    const snippet = (entity.snippet || '').toLowerCase();
    const industry = (intent.industry || '').toLowerCase();
    const role = (intent.target_role || '').toLowerCase();

    if (url.includes('/contact')) score += 0.2;
    if (url.includes('/about')) score += 0.15;
    if (url.includes('/team')) score += 0.15;
    if (url.includes('/leadership')) score += 0.2;

    if (title.includes(industry) || snippet.includes(industry)) score += 0.1;
    if (title.includes(role) || snippet.includes(role)) score += 0.15;
    
    if (title.includes('home') && url.split('/').length <= 4) score -= 0.1;

    return Math.min(Math.max(score, 0.1), 1.0);
}

// ─── COLLECT STAGE: MAIN EXECUTION ─────────────────────────────────────────────
async function runCollectStage(message, apiKey, tavilyKey, onProgress) {
    try {
        onProgress?.('🧠 Parsing intent...');        const intent = await parseIntent(message, apiKey);

        onProgress?.('🔍 Constructing search queries...');
        const queries = constructQueries(intent);

        let allRawResults = [];
        
        for (const query of queries) {
            if (getTavilyRemaining() <= 0) break;
            onProgress?.(`🔎 Searching: ${query.slice(0, 50)}...`);
            const results = await searchWithTavily(query, tavilyKey, { maxResults: 5 });
            allRawResults = [...allRawResults, ...results];
        }
        if (allRawResults.length === 0) {
            return [];
        }

        onProgress?.('🧹 Filtering low-quality sources...');
        const filteredResults = filterRawSources(allRawResults);

        onProgress?.('🗂️ Normalizing domains...');
        const normalizedEntities = normalizeDomains(filteredResults);

        const output = normalizedEntities.map(entity => {
            const confidence = calculateCollectConfidence(entity, intent);
            
            const reasons = [];
            if (entity.source_url.toLowerCase().includes('/contact')) reasons.push('Contact page found');
            if (entity.source_url.toLowerCase().includes('/about')) reasons.push('About page found');
            if ((entity.title + entity.snippet).toLowerCase().includes(intent.industry.toLowerCase())) reasons.push('Matches industry');
            if ((entity.title + entity.snippet).toLowerCase().includes(intent.target_role.toLowerCase())) reasons.push('Matches target role');
            
            const reason = reasons.length > 0 ? reasons.join(', ') : 'Relevant business domain identified';

            return {
                domain: entity.domain,
                source_url: entity.source_url,
                title: entity.title,
                snippet: entity.snippet,
                reason: reason,
                initial_confidence: parseFloat(confidence.toFixed(2))
            };
        });

        output.sort((a, b) => b.initial_confidence - a.initial_confidence);

        console.log(`✅ [COLLECT STAGE] Completed. Found ${output.length} candidates.`);
        return output;

    } catch (error) {        console.error('❌ [COLLECT STAGE] Error:', error.message);
        return [];
    }
}

// ─── INFER STAGE: INTELLIGENCE EXTRACTION ──────────────────────────────────────
async function runInferStage(collectedCandidates, apiKey, onProgress) {
    if (!collectedCandidates || collectedCandidates.length === 0) {
        return [];
    }

    console.log(`🧠 [INFER STAGE] Starting intelligence extraction for ${collectedCandidates.length} companies...`);
    onProgress?.('🧠 Analyzing company intelligence...');

    const inferredResults = [];

    for (const candidate of collectedCandidates) {
        try {
            const inferPrompt = `You are a B2B Intelligence Analyst. 
Analyze the following company data to extract meaningful intelligence for outreach.
DO NOT search the internet. Use ONLY the provided data.

INPUT DATA:
- Domain: ${candidate.domain}
- Source URL: ${candidate.source_url}
- Page Title: ${candidate.title}
- Snippet/Content: ${candidate.snippet}

TASK:
1. Company Understanding: What do they actually do? What industry? What stage (startup/growth/enterprise)?
2. Decision-Maker Identification: Who is the best person to contact? (e.g., SaaS->Founder, Logistics->Ops Manager).
3. Pain Point Inference: What are 2-5 likely business problems they face based on their industry/type?
4. Outreach Strategy: What is the best angle and tone?
5. Confidence: How confident are you in this analysis (0.0-1.0)?

Return ONLY valid JSON:
{
  "domain": "${candidate.domain}",
  "industry": "string (Specific industry category)",
  "company_stage": "string (startup | growth | enterprise | local_small_business)",
  "decision_maker": {
    "primary": "string (e.g., Founder, CEO, Ops Manager)",
    "secondary": "string (e.g., Head of Growth, Director)"
  },
  "pain_points": [
    "string (Pain point 1)",
    "string (Pain point 2)"
  ],
  "outreach_strategy": {
    "angle": "string (e.g., ROI-focused, Efficiency-focused, Partnership)",    "tone": "string (e.g., Direct, Professional, Casual)"
  },
  "confidence": 0.0-1.0
}

RULES:
- NEVER guess specific facts like revenue or employee count.
- ALWAYS base inference on stored data signals.
- If data is weak, lower confidence and keep pain points generic to the industry.`;

            const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
                model:       'gpt-4o-mini',
                messages:    [{ role: 'user', content: inferPrompt }],
                max_tokens:  400,
                temperature: 0.2,
            }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), `OpenAI:Infer:${candidate.domain}`);

            if (res) {
                const raw = res.data.choices[0].message.content.replace(/```json|```/g, '');
                const parsed = JSON.parse(raw);
                
                inferredResults.push({
                    ...candidate,
                    intelligence: parsed
                });
                console.log(`✅ [INFER] Completed for ${candidate.domain}`);
            }

        } catch (err) {
            console.warn(`⚠️ [INFER] Failed for ${candidate.domain}: ${err.message}`);
            inferredResults.push({
                ...candidate,
                intelligence: {
                    domain: candidate.domain,
                    industry: "Unknown",
                    company_stage: "unknown",
                    decision_maker: { primary: "Owner", secondary: "Manager" },
                    pain_points: ["General operational efficiency"],
                    outreach_strategy: { angle: "General value prop", tone: "Professional" },
                    confidence: 0.3
                }
            });
        }
    }

    console.log(`✅ [INFER STAGE] Completed. Analyzed ${inferredResults.length} companies.`);
    return inferredResults;
}

// ─── VERIFY STAGE: TRUST ENGINE ────────────────────────────────────────────────
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

const FREE_EMAIL_PROVIDERS = new Set([
    'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com',
    'protonmail.com','aol.com','mail.com','yandex.com','zoho.com',
]);

function isValidEmailFormat(email) {
    if (!email || typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

async function validateMX(domain) {
    try {
        const records = await dns.resolveMx(domain);
        return records && records.length > 0;
    } catch { return false; }
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
                resolve('timeout');
            }, 5000);

            const socket = net.createConnection(25, mxHost);
            let   buffer = '';
            let   stage  = 0;

            socket.on('error', (err) => {
                clearTimeout(timeout);                resolve('error');
            });

            socket.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\r\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line) continue;
                    const code = parseInt(line.slice(0, 3), 10);

                    if (stage === 0 && code === 220) {
                        socket.write(`EHLO verify.local\r\n`);
                        stage = 1;
                    } else if (stage === 1 && (code === 250 || code === 220)) {
                        socket.write(`MAIL FROM:<verify@verify.local>\r\n`);
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
        return 'error';
    }
}

async function runVerifyStage(enrichedLeads, userIntent, apiKey, onProgress) {
    if (!enrichedLeads || enrichedLeads.length === 0) return [];
    console.log(`🛡️ [VERIFY STAGE] Starting verification for ${enrichedLeads.length} leads...`);
    onProgress?.('🛡️ Verifying trust and reachability...');

    const verifiedLeads = [];

    for (const lead of enrichedLeads) {
        try {
            const domain = lead.domain;
            const intelligence = lead.intelligence || {};
            const inferredRole = intelligence.decision_maker?.primary || 'Owner';
            
            // Check if snippet had an email
            const snippetEmailMatch = lead.snippet.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            const foundEmail = snippetEmailMatch ? snippetEmailMatch[0] : null;

            const emailToVerify = foundEmail || `contact@${domain}`;
            const syntaxValid = isValidEmailFormat(emailToVerify);
            const isDisposable = DISPOSABLE_DOMAINS.has(domain);
            const isFreeProvider = FREE_EMAIL_PROVIDERS.has(domain);

            // Domain & MX Validation
            const mxValid = await validateMX(domain);

            // SMTP Probe
            let smtpStatus = 'skipped';
            if (mxValid && !isFreeProvider && !isDisposable && foundEmail) {
                smtpStatus = await smtpProbeEmail(foundEmail, domain);
            } else if (mxValid && !isFreeProvider && !isDisposable) {
                 // Probe the generic contact if no specific email found
                 smtpStatus = await smtpProbeEmail(`contact@${domain}`, domain);
            }

            // Role Validation
            const requestedRole = (userIntent.target_role || 'Decision Maker').toLowerCase();
            const inferredRoleLower = inferredRole.toLowerCase();
            const roleKeywords = requestedRole.split(/\s+/).filter(w => w.length > 2);
            const roleMatch = roleKeywords.some(kw => inferredRoleLower.includes(kw)) || 
                              inferredRoleLower.includes('founder') || 
                              inferredRoleLower.includes('ceo') || 
                              inferredRoleLower.includes('owner');

            // Business Legitimacy
            const businessLegitimacy = (intelligence.confidence > 0.5) && (lead.initial_confidence > 0.5);

            const verification = {
                email_syntax: syntaxValid,
                mx_valid: mxValid,
                smtp_status: smtpStatus,
                is_disposable: isDisposable,
                is_free_provider: isFreeProvider,                role_match: roleMatch,
                source_confidence: lead.initial_confidence,
                business_legitimacy: businessLegitimacy,
                has_specific_email: !!foundEmail
            };

            verifiedLeads.push({
                company: domain,
                contact: {
                    name: intelligence.decision_maker?.primary || 'Decision Maker',
                    role: inferredRole,
                    email: foundEmail || null
                },
                verification: verification,
                intelligence: intelligence,
                source_url: lead.source_url
            });

        } catch (err) {
            console.warn(`⚠️ [VERIFY] Error for ${lead.domain}: ${err.message}`);
        }
    }

    console.log(`✅ [VERIFY STAGE] Completed. ${verifiedLeads.length} leads passed technical checks.`);
    return verifiedLeads;
}

// ─── CONFIDENCE / SCORING STAGE ────────────────────────────────────────────────

function calculateCompanyConfidence(lead) {
    let score = 0.5; // Base
    const reasons = [];

    // Domain Quality & Legitimacy
    if (lead.verification.business_legitimacy) {
        score += 0.25;
        reasons.push("Business legitimacy confirmed via inference");
    } else {
        reasons.push("Low business legitimacy signals");
    }

    // Source Authority (from Collect Stage)
    if (lead.verification.source_confidence > 0.8) {
        score += 0.15;
        reasons.push("High authority source URL");
    } else if (lead.verification.source_confidence > 0.5) {
        score += 0.10;
        reasons.push("Moderate authority source URL");
    }
    // Penalties
    if (lead.verification.is_free_provider) score -= 0.20;

    return { score: Math.min(Math.max(score, 0), 1), reasons };
}

function calculateHumanConfidence(lead) {
    let score = 0.3; // Base low because we rarely have perfect human ID without enrichment
    const reasons = [];

    const name = lead.contact.name;
    const role = lead.contact.role;

    // Specific Name Identified?
    if (name && name !== 'Decision Maker' && name !== 'Owner' && name !== 'CEO') {
        score += 0.40;
        reasons.push("Specific human name identified");
    } else {
        reasons.push("Generic role identifier only");
    }

    // Role Specificity
    if (role && role !== 'Decision Maker') {
        score += 0.20;
        reasons.push("Specific job role identified");
    }

    return { score: Math.min(Math.max(score, 0), 1), reasons };
}

function calculateEmailConfidence(lead) {
    let score = 0.2; // Base low
    const reasons = [];

    // Syntax
    if (lead.verification.email_syntax) {
        score += 0.10;
        reasons.push("Valid email syntax");
    } else {
        return { score: 0, reasons: ["Invalid email syntax"] };
    }

    // MX Records
    if (lead.verification.mx_valid) {
        score += 0.20;
        reasons.push("MX records valid");
    } else {
        return { score: 0, reasons: ["Invalid MX records"] };
    }
    // SMTP Status    
    if (lead.verification.smtp_status === 'valid') {
        score += 0.30;
        reasons.push("SMTP server accepted recipient");
    } else if (lead.verification.smtp_status === 'invalid') {
        return { score: 0, reasons: ["SMTP server rejected recipient"] };
    } else if (lead.verification.smtp_status === 'unknown' || lead.verification.smtp_status === 'skipped') {
        score += 0.10; // Neutral
        reasons.push("SMTP status inconclusive");
    }

    // Disposable/Free Checks
    if (lead.verification.is_disposable) {
        return { score: 0, reasons: ["Disposable email domain"] };
    }
    if (lead.verification.is_free_provider) {
        score -= 0.10;
        reasons.push("Free email provider (lower B2B trust)");
    }

    // Has Specific Email?
    if (lead.verification.has_specific_email) {
        score += 0.10;
        reasons.push("Specific email found in source");
    } else {
        score -= 0.10;
        reasons.push("Using generic/constructed email");
    }

    return { score: Math.min(Math.max(score, 0), 1), reasons };
}

function calculateRoleConfidence(lead, userIntent) {
    let score = 0.5;
    const reasons = [];

    if (lead.verification.role_match) {
        score += 0.30;
        reasons.push("Role matches user intent");
    } else {
        score -= 0.20;
        reasons.push("Role mismatch with user intent");
    }

    // Priority Bonus
    const roleLower = (lead.contact.role || '').toLowerCase();
    if (roleLower.includes('founder') || roleLower.includes('ceo') || roleLower.includes('owner')) {
        score += 0.10;
        reasons.push("High-priority decision maker role");
    }
    return { score: Math.min(Math.max(score, 0), 1), reasons };
}

function calculateSourceConfidence(lead) {
    // Directly map from initial collect confidence but normalized
    let score = lead.verification.source_confidence || 0.5;
    const reasons = [];

    if (score > 0.8) reasons.push("High-quality source URL structure");
    else if (score > 0.5) reasons.push("Standard source URL");
    else reasons.push("Weak source signals");

    return { score: score, reasons };
}

function determineStatus(overallScore) {
    if (overallScore >= 0.86) return 'VERIFIED';
    if (overallScore >= 0.66) return 'STRONG_MATCH';
    if (overallScore >= 0.46) return 'PROBABLE';
    if (overallScore >= 0.21) return 'LOW_CONFIDENCE';
    return 'REJECTED';
}

function runConfidenceStage(verifiedLeads, userIntent) {
    console.log(`📊 [CONFIDENCE STAGE] Scoring ${verifiedLeads.length} leads...`);

    const scoredLeads = [];

    for (const lead of verifiedLeads) {
        // 1. Calculate Dimensional Scores
        const companyScore = calculateCompanyConfidence(lead);
        const humanScore = calculateHumanConfidence(lead);
        const emailScore = calculateEmailConfidence(lead);
        const roleScore = calculateRoleConfidence(lead, userIntent);
        const sourceScore = calculateSourceConfidence(lead);

        // 2. Weighted Scoring Engine
        // Weights: Company 25%, Human 20%, Email 25%, Role 15%, Source 15%
        const overallScore = (
            (companyScore.score * 0.25) +
            (humanScore.score * 0.20) +
            (emailScore.score * 0.25) +
            (roleScore.score * 0.15) +
            (sourceScore.score * 0.15)
        );

        // 3. Determine Status
        const status = determineStatus(overallScore);
        // 4. Evidence Traceability
        const allReasons = [            ...companyScore.reasons,
            ...humanScore.reasons,
            ...emailScore.reasons,
            ...roleScore.reasons,
            ...sourceScore.reasons
        ];

        // Aggressive Rejection: If status is REJECTED, skip it
        if (status === 'REJECTED') {
            console.log(`🗑️ [CONFIDENCE] Rejected ${lead.company}: Score ${overallScore.toFixed(2)}`);
            continue;
        }

        scoredLeads.push({
            company: lead.company,
            contact: lead.contact,
            source_url: lead.source_url,
            intelligence: lead.intelligence,
            confidence: {
                company_confidence: parseFloat(companyScore.score.toFixed(2)),
                human_confidence: parseFloat(humanScore.score.toFixed(2)),
                email_confidence: parseFloat(emailScore.score.toFixed(2)),
                role_confidence: parseFloat(roleScore.score.toFixed(2)),
                source_confidence: parseFloat(sourceScore.score.toFixed(2)),
                overall_confidence: parseFloat(overallScore.toFixed(2)),
                status: status,
                reasoning: allReasons
            }
        });
    }

    // Sort by overall confidence descending
    scoredLeads.sort((a, b) => b.confidence.overall_confidence - a.confidence.overall_confidence);

    console.log(`✅ [CONFIDENCE STAGE] Completed. ${scoredLeads.length} high-trust leads remaining.`);
    return scoredLeads;
}

// ─── CLASSIFY LEAD STAGE: REALITY ENGINE ───────────────────────────────────────

function runClassifyLeadStage(scoredLeads) {
    console.log(`🏷️ [CLASSIFY STAGE] Classifying ${scoredLeads.length} leads...`);
    
    const classifiedLeads = [];

    for (const lead of scoredLeads) {
        const c = lead.confidence;
        const contact = lead.contact;
        const verification = lead.verification;
        let classification = 'REJECTED';
        const subClassifications = [];
        const reasoning = [];

        // --- Signal Detection ---
        const hasCompany = c.company_confidence > 0.5;
        const hasSpecificHuman = c.human_confidence > 0.6 && contact.name && contact.name !== 'Decision Maker' && contact.name !== 'Owner';
        const hasRole = contact.role && contact.role !== 'Decision Maker';
        const hasEmail = verification.has_specific_email || (contact.email && isValidEmailFormat(contact.email));
        const isEmailVerified = c.email_confidence > 0.7 && verification.mx_valid && (verification.smtp_status === 'valid' || verification.smtp_status === 'unknown'); // Unknown is acceptable for strong match if MX valid
        const isOutreachReady = c.overall_confidence >= 0.66 && hasCompany && (hasSpecificHuman || hasRole) && hasEmail;

        // --- Classification Logic (Conservative / Lowest Certainty) ---

        if (!hasCompany) {
            classification = 'REJECTED';
            reasoning.push("Company legitimacy too low");
        } else if (isOutreachReady) {
            classification = 'OUTREACH_READY';
            subClassifications.push('COMPANY_VALID', 'HUMAN_OR_ROLE_IDENTIFIED', 'EMAIL_VERIFIED');
            reasoning.push("Valid company, identified contact, and verified email infrastructure");
        } else if (hasEmail && isEmailVerified && !hasSpecificHuman && !hasRole) {
            // Email exists and works, but we don't know who it belongs to specifically
            classification = 'EMAIL_VERIFIED';
            subClassifications.push('EMAIL_VERIFIED', 'NO_HUMAN_ID');
            reasoning.push("Email infrastructure verified, but no specific human or role identified");
        } else if (hasEmail && !isEmailVerified) {
            // Email found but not technically verified (no MX/SMTP check passed strongly)
            classification = 'EMAIL_FOUND';
            subClassifications.push('EMAIL_FOUND', 'NOT_VERIFIED');
            reasoning.push("Email address found in source, but technical verification incomplete");
        } else if (hasSpecificHuman && !hasEmail) {
            // We know who they are, but don't have an email
            classification = 'HUMAN_IDENTIFIED';
            subClassifications.push('HUMAN_IDENTIFIED', 'EMAIL_MISSING');
            reasoning.push(`Specific individual (${contact.name}) identified, but no email found`);
        } else if (hasRole && !hasSpecificHuman && !hasEmail) {
            // We know the role exists (e.g. "Head of Sales") but no name or email
            classification = 'ROLE_IDENTIFIED';
            subClassifications.push('ROLE_IDENTIFIED', 'NO_HUMAN', 'NO_EMAIL');
            reasoning.push(`Role (${contact.role}) identified, but no specific name or email`);
        } else if (hasCompany && !hasRole && !hasEmail && !hasSpecificHuman) {
            classification = 'COMPANY_ONLY';
            subClassifications.push('COMPANY_ONLY', 'NO_CONTACT_DATA');
            reasoning.push("Valid company discovered, but no contact details found");
        } else {
            classification = 'REJECTED';
            reasoning.push("Insufficient signals for useful classification");
        }
        // Final Filter: Only keep leads that are at least ROLE_IDENTIFIED or better for typical use
        // If you want to see Company Only leads, remove this check.
        const usableClasses = ['OUTREACH_READY', 'EMAIL_VERIFIED', 'EMAIL_FOUND', 'HUMAN_IDENTIFIED', 'ROLE_IDENTIFIED'];
        
        if (usableClasses.includes(classification)) {
            lead.classification = {
                classification: classification,
                sub_classifications: subClassifications,
                certainty: c.overall_confidence, // Mirror overall confidence as certainty
                reasoning: reasoning
            };
            classifiedLeads.push(lead);
        } else {
            console.log(`🗑️ [CLASSIFY] Rejected ${lead.company}: ${classification}`);
        }
    }

    console.log(`✅ [CLASSIFY STAGE] Completed. ${classifiedLeads.length} classified leads.`);
    return classifiedLeads;
}

// ─── INTENT CLASSIFIER (For Routing) ────────────────────────────────────────────
const INTENT = {
    LEAD_GEN:    'lead_gen',
    CHAT:        'chat',
};

async function _classifyIntent(message, history, apiKey) {
    const recentHistory = (history || []).slice(-6)
        .map(h => `${h.role}: ${h.content}`)
        .join('\n');

    const classifyPrompt = `You are an intent classifier.
Classify the user message into EXACTLY ONE of these intents:

1. "lead_gen" — user wants to find leads, prospect companies, get contacts, find businesses to outreach
2. "chat" — anything else: greetings, small talk, general questions

RECENT CONVERSATION:
${recentHistory || 'None'}

USER MESSAGE: "${message}"

Return ONLY the intent string. No explanation. Just one of: lead_gen | chat`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: classifyPrompt }],
            max_tokens:  10,            temperature: 0.0,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:classify');

        if (!res) return INTENT.CHAT;

        const raw = res.data.choices[0].message.content.trim().toLowerCase();
        if (raw.includes('lead_gen')) return INTENT.LEAD_GEN;
        return INTENT.CHAT;

    } catch (err) {
        console.warn('[Intent Classify Failed]:', err.message);
        return INTENT.CHAT;
    }
}

// ─── CHAT HANDLER (Fallback) ───────────────────────────────────────────────────
async function _handleChat(message, history, userProfile, apiKey) {
    const senderName = userProfile?.senderName || 'there';
    
    const systemPrompt = `You are an intelligent AI assistant.
You help with conversations, answer questions, and assist with business tasks.
Keep responses concise but complete.`;
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

        return res.data.choices[0].message.content.trim();

    } catch (err) {
        console.warn('[Chat Handler Error]:', err.message);
        return 'Something went wrong. Please try again.';
    }
}
// ─── MAIN EXPORT: generateFreeResponse ─────────────────────────────────────────
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
                reply:          'How can I help you today? I can find leads or just chat.',
                updatedHistory: history,
            };
        }

        const intent = await _classifyIntent(safeMessage, history, apiKey);
        console.log(`🎯 [INTENT] ${intent}`);
        
        // Parse intent details for Verify/Confidence Stages
        const intentDetails = await parseIntent(safeMessage, apiKey);

        if (intent === INTENT.LEAD_GEN) {
            // 1. COLLECT STAGE
            onProgress?.('🚀 Starting Collect Stage...');
            const candidates = await runCollectStage(safeMessage, apiKey, tavilyKey, onProgress);
            
            if (candidates.length === 0) {
                return {
                    reply: JSON.stringify([]),
                    updatedHistory: [
                        ...history,
                        { role: 'user', content: safeMessage },
                        { role: 'assistant', content: 'No candidates found.' },
                    ],
                };
            }

            // 2. INFER STAGE
            onProgress?.('🧠 Starting Infer Stage...');
            const enrichedLeads = await runInferStage(candidates, apiKey, onProgress);
            
            // 3. VERIFY STAGE
            onProgress?.('🛡️ Starting Verify Stage...');
            const verifiedLeads = await runVerifyStage(enrichedLeads, intentDetails, apiKey, onProgress);
            // 4. CONFIDENCE STAGE
            onProgress?.('📊 Starting Confidence Scoring...');
            const scoredLeads = runConfidenceStage(verifiedLeads, intentDetails);

            // 5. CLASSIFY STAGE
            onProgress?.('🏷️ Starting Lead Classification...');
            const finalLeads = runClassifyLeadStage(scoredLeads);
            
            const reply = JSON.stringify(finalLeads);
            
            return {
                reply,
                updatedHistory: [
                    ...history,
                    { role: 'user',      content: safeMessage },
                    { role: 'assistant', content: `[Found, Verified, Scored, and Classified ${finalLeads.length} leads]` },
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
