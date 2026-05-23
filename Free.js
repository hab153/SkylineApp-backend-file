'use strict';

const axios = require('axios');
const dns   = require('dns').promises;
const net   = require('net');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const MAX_COMPANIES_RETURNED     = 10;
const TAVILY_LIMIT               = 1000;
const CURRENT_YEAR               = new Date().getFullYear();
const EMAIL_CONFIDENCE_THRESHOLD = 28;

// ─── CONTENT QUALITY FILTER — LOW-VALUE PAGE SIGNALS ─────────────────────────
const LOW_VALUE_URL_PATTERNS = [
    /\/blog\//i, /\/article\//i, /\/news\//i, /\/tutorial\//i,
    /\/how-to\//i, /\/guide\//i, /\/tips\//i, /\/resources\//i,
    /\/learn\//i, /\/wiki\//i, /\/forum\//i, /\.pdf$/i,
    /reddit\.com/i, /medium\.com/i, /quora\.com/i, /wikipedia\.org/i,
    /stackoverflow\.com/i, /hubspot\.com\/blog/i, /moz\.com\/blog/i,
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
async function withRetry(fn, label, retries = 2, delayMs = 800) {    for (let attempt = 0; attempt <= retries; attempt++) {
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

// ─── PAGE BUSINESS RELEVANCE SCORER ──────────────────────────────────────────
function _scorePageBusinessRelevance(result) {
    const url     = (result.url     || '').toLowerCase();
    const title   = (result.title   || '').toLowerCase();
    const snippet = (result.snippet || '').toLowerCase();

    let score = 50;

    for (const pattern of LOW_VALUE_URL_PATTERNS) {
        if (pattern.test(url)) { score -= 35; break; }
    }

    if (/\/about/i.test(url) || /\/team/i.test(url) || /\/contact/i.test(url) || /\/company/i.test(url)) {
        score += 15;
    }

    for (const signal of HIGH_VALUE_TITLE_SIGNALS) {
        if (title.includes(signal)) { score += 12; break; }
    }
    for (const signal of LOW_VALUE_TITLE_SIGNALS) {
        if (title.includes(signal)) { score -= 20; break; }
    }

    if (snippet.includes('@'))                              score += 10;
    if (snippet.includes('contact'))                        score += 5;
    if (/ceo|founder|owner|director/.test(snippet))        score += 10;
    if (/agency|studio|solutions|services/.test(snippet))  score += 8;
    if (/how to|what is|tutorial|step.by.step/.test(snippet)) score -= 15;
    if (/read more|subscribe|newsletter|download free/.test(snippet)) score -= 10;

    return Math.max(0, Math.min(100, score));
}

// ─── TAVILY SEARCH ─────────────────────────────────────────────────────────────
async function searchWithTavily(query, tavilyKey, options = {}) {
    if (getTavilyRemaining() <= 0) throw new Error('Tavily quota exhausted');

    return withRetry(async () => {        const response = await axios.post('https://api.tavily.com/search', {
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

// ─── DISCOVERY LAYER (STEP 1) ──────────────────────────────────────────────────
async function _runDiscovery(intentParams, tavilyKey, requestedCount) {
    console.log(`🔎 [DISCOVERY] Starting discovery for: ${intentParams.industry} in ${intentParams.location || 'Global'}`);

    const industry = intentParams.industry || '';
    const location = intentParams.location ? `"${intentParams.location}"` : '';

    const queries = [
        `${industry} companies ${location}`,
        `${industry} businesses ${location}`,
        `top ${industry} firms ${location}`,
        `${industry} agencies ${location}`,
        `${industry} startups ${location}`,
    ].filter(q => q.trim().length > 5);

    const seenDomains = new Set();
    const candidates  = [];
    const maxQueries  = 6;

    for (const query of queries.slice(0, maxQueries)) {
        if (candidates.length >= requestedCount * 3) break;

        try {
            const results = await searchWithTavily(query, tavilyKey, { maxResults: 5 });

            for (const res of results) {
                let domain = '';
                try {
                    const urlObj = new URL(res.url);
                    domain = urlObj.hostname.replace('www.', '');
                } catch (e) { continue; }
                if (seenDomains.has(domain)) continue;

                const SKIP_DISCOVERY_DOMAINS = [
                    'linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com',
                    'crunchbase.com', 'apollo.io', 'hunter.io', 'zoominfo.com',
                    'yelp.com', 'yellowpages.com', 'trustpilot.com', 'glassdoor.com',
                    'medium.com', 'reddit.com', 'quora.com', 'wikipedia.org',
                    'youtube.com', 'vimeo.com', 'tiktok.com', 'pinterest.com',
                    'github.com', 'gitlab.com', 'stackoverflow.com',
                    'indeed.com', 'monster.com', 'careerbuilder.com',
                    'amazon.com', 'ebay.com', 'etsy.com', 'shopify.com',
                    'wordpress.com', 'wix.com', 'squarespace.com',
                    'google.com', 'bing.com', 'yahoo.com',
                    'bbc.com', 'cnn.com', 'reuters.com', 'bloomberg.com',
                    'forbes.com', 'entrepreneur.com', 'inc.com', 'techcrunch.com',
                ];

                if (SKIP_DISCOVERY_DOMAINS.some(d => domain.includes(d))) continue;
                if (LOW_VALUE_URL_PATTERNS.some(p => p.test(res.url))) continue;

                seenDomains.add(domain);
                candidates.push({
                    company:    res.title || domain,
                    domain:     domain,
                    source_url: res.url,
                    snippet:    res.snippet || ''
                });
            }
        } catch (err) {
            console.warn(`⚠️ [DISCOVERY] Query failed: ${query} - ${err.message}`);
        }
    }

    console.log(`✅ [DISCOVERY] Found ${candidates.length} raw candidates.`);
    return candidates;
}

// ─── FILTERING LAYER (STEP 2) ──────────────────────────────────────────────────
async function _runFiltering(rawCandidates) {
    console.log(`🧹 [FILTERING] Starting filtering for ${rawCandidates.length} candidates...`);

    const filtered    = [];
    const seenDomains = new Set();

    for (const candidate of rawCandidates) {
        const domain = candidate.domain.toLowerCase();
        if (seenDomains.has(domain)) continue;

        const isLowValueUrl   = LOW_VALUE_URL_PATTERNS.some(p => p.test(candidate.source_url));        const isLowValueTitle = LOW_VALUE_TITLE_SIGNALS.some(s => (candidate.company || '').toLowerCase().includes(s));
        if (isLowValueUrl || isLowValueTitle) continue;

        const relevanceScore = _scorePageBusinessRelevance({
            url:     candidate.source_url,
            title:   candidate.company,
            snippet: candidate.snippet
        });
        if (relevanceScore < 40) continue;

        seenDomains.add(domain);
        filtered.push({ ...candidate, domain, relevance_score: relevanceScore });
    }

    console.log(`✅ [FILTERING] ${filtered.length} candidates passed filtering.`);
    return filtered;
}

// ─── DECISION MAKER FINDER (STEP 3) ──────────────────────────────────────────
async function _findDecisionMakers(companies, jobTitle, tavilyKey) {
    console.log(`🕵️ [STEP 3] Finding ${jobTitle}s for ${companies.length} companies...`);

    const enrichedCompanies = [];

    for (const company of companies) {
        try {
            const query   = `"${company.company}" "${jobTitle}" email OR LinkedIn site:linkedin.com`;
            const results = await searchWithTavily(query, tavilyKey, { maxResults: 3 });

            let bestPerson = null;

            for (const res of results) {
                const snippet = res.snippet.toLowerCase();
                const title   = res.title.toLowerCase();

                if (
                    (snippet.includes(jobTitle.toLowerCase()) || title.includes(jobTitle.toLowerCase())) &&
                    snippet.includes(company.company.toLowerCase())
                ) {
                    const nameMatch    = res.title.match(/^([A-Z][a-z]+ [A-Z][a-z]+)/);
                    const extractedName = nameMatch ? nameMatch[1] : `${jobTitle} at ${company.company}`;

                    bestPerson = { name: extractedName, role: jobTitle, source: res.url, confidence: 0.8 };
                    break;
                }
            }

            enrichedCompanies.push({
                ...company,
                contact: bestPerson || { name: 'Unknown', role: jobTitle, confidence: 0.5 }            });

        } catch (err) {
            console.warn(`⚠️ [STEP 3] Failed for ${company.company}: ${err.message}`);
            enrichedCompanies.push({ ...company, contact: { name: 'Unknown', role: jobTitle, confidence: 0.5 } });
        }
    }

    console.log(`✅ [STEP 3] Enriched ${enrichedCompanies.length} companies.`);
    return enrichedCompanies;
}

// ─── EMAIL VALIDATION HELPERS ─────────────────────────────────────────────────
const DISPOSABLE_DOMAINS = new Set([
    'mailinator.com','guerrillamail.com','tempmail.com','throwam.com',
    'yopmail.com','trashmail.com','fakeinbox.com','sharklasers.com',
]);
const FREE_EMAIL_PROVIDERS = new Set([
    'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com',
    'protonmail.com','aol.com','mail.com','yandex.com','zoho.com',
]);

function isValidEmailFormat(email) {
    if (!email || typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

function classifyEmail(email, domain) {
    if (!email) return { type: 'none', label: 'Not found', trustLevel: 0 };
    const localPart   = email.split('@')[0].toLowerCase();
    const emailDomain = email.split('@')[1]?.toLowerCase();
    const domainMatches = emailDomain === domain || emailDomain?.includes(domain.split('.')[0]);

    const GENERIC_PREFIXES = ['contact','info','hello','sales','team','support','admin'];
    const isGeneric = GENERIC_PREFIXES.some(p => localPart === p || localPart.startsWith(p + '.'));

    if (!domainMatches)  return { type: 'unrelated-domain',   label: 'Wrong domain',    trustLevel: 0  };
    if (isGeneric)       return { type: 'confirmed-generic',  label: 'Contact email',   trustLevel: 70 };
    if (localPart.includes('.') || /[a-z]{2,}[a-z]{2,}/.test(localPart)) {
        return           { type: 'confirmed-personal', label: 'Personal email',  trustLevel: 90 };
    }
    return               { type: 'confirmed-other',   label: 'Email found',     trustLevel: 75 };
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
        const mxHost = mxRecords.sort((a, b) => a.priority - b.priority)[0].exchange;

        return new Promise((resolve) => {
            const socket  = net.createConnection(25, mxHost);
            let stage     = 0;
            const timeout = setTimeout(() => { socket.destroy(); resolve('unknown'); }, 5000);

            socket.on('connect', () => socket.write(`EHLO verify.local\r\n`));
            socket.on('data', (chunk) => {
                const lines = chunk.toString().split('\r\n');
                for (const line of lines) {
                    const code = parseInt(line.slice(0, 3), 10);
                    if (stage === 0 && code === 250) { socket.write(`MAIL FROM:<test@verify.local>\r\n`); stage = 1; }
                    else if (stage === 1 && code === 250) { socket.write(`RCPT TO:<${email}>\r\n`); stage = 2; }
                    else if (stage === 2) {
                        clearTimeout(timeout);
                        socket.write('QUIT\r\n');
                        socket.destroy();
                        resolve(code === 250 || code === 251 ? 'valid' : 'invalid');
                    }
                }
            });
            socket.on('error', () => { clearTimeout(timeout); resolve('unknown'); });
        });
    } catch { return 'unknown'; }
}

async function validateEmailFull(email, domain) {
    const result = { email, verdict: 'rejected', confidenceScore: 0, smtpResult: null, mxValid: false };
    if (!isValidEmailFormat(email)) return result;

    const emailDomain = email.split('@')[1]?.toLowerCase();
    if (DISPOSABLE_DOMAINS.has(emailDomain) || FREE_EMAIL_PROVIDERS.has(emailDomain)) return result;

    result.mxValid = await validateMX(emailDomain);
    if (!result.mxValid) return result;

    const classification  = classifyEmail(email, domain);
    result.smtpResult     = await smtpProbeEmail(email, emailDomain);

    if (result.smtpResult === 'valid') {
        result.verdict         = 'verified';
        result.confidenceScore = classification.trustLevel;
    } else if (result.smtpResult === 'unknown' && classification.trustLevel > 50) {
        result.verdict         = 'probable';        result.confidenceScore = classification.trustLevel - 10;
    }

    return result;
}

// ─── 🟡 NEW: EMAIL PATTERN GENERATOR ─────────────────────────────────────────
function _generateEmailPatterns(fullName, domain) {
    const parts     = fullName.trim().toLowerCase().split(/\s+/);
    const first     = parts[0]     || '';
    const last      = parts[1]     || '';
    const firstInit = first[0]     || '';
    const lastInit  = last[0]      || '';

    if (!first || !domain) return [];

    const patterns = [
        `${first}@${domain}`,
        `${last}@${domain}`,
        `${first}.${last}@${domain}`,
        `${first}${last}@${domain}`,
        `${firstInit}${last}@${domain}`,
        `${firstInit}.${last}@${domain}`,
        `${first}.${lastInit}@${domain}`,
        `${first}${lastInit}@${domain}`,
        `${last}.${first}@${domain}`,
        `${last}${first}@${domain}`,
        `${firstInit}${lastInit}@${domain}`,
    ].filter(e => isValidEmailFormat(e) && !e.startsWith('@') && !e.includes('@@'));

    return [...new Set(patterns)];
}

// ─── 🟡 NEW: PATTERN EMAIL VERIFIER ──────────────────────────────────────────
async function _verifyPatternEmails(patterns, domain) {
    console.log(`🔬 [PATTERN] Testing ${patterns.length} email patterns for ${domain}...`);

    for (const email of patterns) {
        try {
            const result = await validateEmailFull(email, domain);
            if (result.verdict === 'verified' || result.verdict === 'probable') {
                console.log(`✅ [PATTERN] Found valid pattern: ${email} (${result.verdict})`);
                return { email, ...result, source: 'pattern_generated' };
            }
        } catch (err) {
            console.warn(`⚠️ [PATTERN] Error testing ${email}: ${err.message}`);
        }
    }

    return null;}

// ─── 🟡 NEW: HUNTER.IO EMAIL FINDER ──────────────────────────────────────────
async function _searchHunterIO(firstName, lastName, domain) {
    const hunterKey = process.env.HUNTER_API_KEY;
    if (!hunterKey) {
        console.log(`ℹ️ [HUNTER] No HUNTER_API_KEY set — skipping Hunter.io lookup.`);
        return null;
    }

    try {
        console.log(`🔍 [HUNTER] Looking up ${firstName} ${lastName} @ ${domain}...`);
        const response = await axios.get('https://api.hunter.io/v2/email-finder', {
            params: {
                domain,
                first_name: firstName,
                last_name:  lastName,
                api_key:    hunterKey,
            },
            timeout: 8000,
        });

        const data = response.data?.data;
        if (data?.email) {
            const score = data.score || 50;
            console.log(`✅ [HUNTER] Found: ${data.email} (score: ${score})`);
            return {
                email:          data.email,
                verdict:        score >= 70 ? 'verified' : 'probable',
                confidenceScore: score,
                source:         'hunter.io',
            };
        }
    } catch (err) {
        console.warn(`⚠️ [HUNTER] Lookup failed: ${err.message}`);
    }

    return null;
}

// ─── 🟡 NEW: CONTACT PAGE SCRAPER ────────────────────────────────────────────
async function _scrapeContactPage(domain, tavilyKey) {
    const contactUrls = [
        `https://${domain}/contact`,
        `https://${domain}/contact-us`,
        `https://${domain}/about`,
        `https://${domain}/team`,
        `https://www.${domain}/contact`,
    ];
    console.log(`🌐 [CONTACT PAGE] Scraping contact pages for ${domain}...`);

    for (const url of contactUrls) {
        try {
            const query   = `site:${domain} contact email`;
            const results = await searchWithTavily(query, tavilyKey, { maxResults: 3 });

            for (const res of results) {
                const emailMatch = res.snippet.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
                if (emailMatch) {
                    for (const email of emailMatch) {
                        const emailDomain = email.split('@')[1]?.toLowerCase();
                        if (emailDomain && domain.includes(emailDomain.split('.')[0])) {
                            const validation = await validateEmailFull(email, domain);
                            if (validation.verdict !== 'rejected') {
                                console.log(`✅ [CONTACT PAGE] Found email on contact page: ${email}`);
                                return { email, ...validation, source: 'contact_page' };
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.warn(`⚠️ [CONTACT PAGE] Failed for ${domain}: ${err.message}`);
        }
    }

    return null;
}

// ─── 🟡 NEW: ZEROBOUNCE VERIFIER ─────────────────────────────────────────────
async function _verifyWithZeroBounce(email) {
    const zbKey = process.env.ZEROBOUNCE_API_KEY;
    if (!zbKey) {
        console.log(`ℹ️ [ZEROBOUNCE] No ZEROBOUNCE_API_KEY set — skipping ZeroBounce check.`);
        return null;
    }

    try {
        console.log(`✉️ [ZEROBOUNCE] Verifying ${email}...`);
        const response = await axios.get('https://api.zerobounce.net/v2/validate', {
            params: { api_key: zbKey, email },
            timeout: 8000,
        });

        const status = response.data?.status;

        console.log(`✅ [ZEROBOUNCE] Result for ${email}: ${status}`);

        if (status === 'valid') {            return { valid: true, verdict: 'verified', confidenceScore: 95, source: 'zerobounce' };
        } else if (status === 'catch-all') {
            return { valid: true, verdict: 'probable', confidenceScore: 65, source: 'zerobounce' };
        } else {
            return { valid: false, verdict: 'rejected', confidenceScore: 0, source: 'zerobounce' };
        }
    } catch (err) {
        console.warn(`⚠️ [ZEROBOUNCE] Verification failed: ${err.message}`);
        return null;
    }
}

// ─── 🟠 UPGRADED: EMAIL VERIFIER (STEP 4) ────────────────────────────────────
async function _verifyEmails(enrichedLeads, tavilyKey) {
    console.log(`📧 [STEP 4] Finding & Verifying emails for ${enrichedLeads.length} contacts...`);

    const verifiedLeads = [];

    for (const lead of enrichedLeads) {
        try {
            if (!lead.contact || lead.contact.name === 'Unknown') {
                verifiedLeads.push({ ...lead, email: null, emailStatus: 'No Contact Found', emailSource: null });
                continue;
            }

            const nameParts = lead.contact.name.split(' ');
            const firstName = nameParts[0] || '';
            const lastName  = nameParts[1] || '';

            let foundResult = null;

            // ── LAYER 1: Tavily Direct Search ────────────────────────────────
            console.log(`🔎 [LAYER 1] Tavily search for ${lead.contact.name} @ ${lead.domain}`);
            const query   = `"${lead.contact.name}" "${lead.company}" email address`;
            const results = await searchWithTavily(query, tavilyKey, { maxResults: 3 });

            for (const res of results) {
                const emailMatch = res.snippet.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                if (emailMatch) {
                    const validation = await validateEmailFull(emailMatch[0], lead.domain);
                    if (validation.verdict === 'verified' || validation.verdict === 'probable') {
                        foundResult = { email: emailMatch[0], ...validation, source: 'tavily' };
                        break;
                    }
                }
            }

            // ── LAYER 2: Hunter.io API ────────────────────────────────────────
            if (!foundResult && firstName && lastName) {
                console.log(`🔎 [LAYER 2] Hunter.io for ${firstName} ${lastName} @ ${lead.domain}`);                foundResult = await _searchHunterIO(firstName, lastName, lead.domain);
            }

            // ── LAYER 3: Contact Page Scrape ──────────────────────────────────
            if (!foundResult) {
                console.log(`🔎 [LAYER 3] Contact page scrape for ${lead.domain}`);
                foundResult = await _scrapeContactPage(lead.domain, tavilyKey);
            }

            // ── LAYER 4: Pattern Generation + SMTP ───────────────────────────
            if (!foundResult && firstName) {
                console.log(`🔎 [LAYER 4] Pattern generation for ${lead.contact.name} @ ${lead.domain}`);
                const patterns    = _generateEmailPatterns(lead.contact.name, lead.domain);
                const patternResult = await _verifyPatternEmails(patterns, lead.domain);
                if (patternResult) foundResult = patternResult;
            }

            // ── FINAL: ZeroBounce Confirmation ────────────────────────────────
            if (foundResult?.email) {
                const zbResult = await _verifyWithZeroBounce(foundResult.email);
                if (zbResult) {
                    foundResult.verdict        = zbResult.verdict;
                    foundResult.confidenceScore = zbResult.confidenceScore;
                    if (!zbResult.valid) foundResult = null; 
                }
            }

            if (foundResult?.email) {
                verifiedLeads.push({
                    ...lead,
                    email:       foundResult.email,
                    emailStatus: foundResult.verdict,
                    emailScore:  foundResult.confidenceScore,
                    emailSource: foundResult.source,
                });
            } else {
                verifiedLeads.push({ ...lead, email: null, emailStatus: 'Not Found', emailSource: null });
            }

        } catch (err) {
            console.warn(`⚠️ [STEP 4] Failed for ${lead.contact?.name}: ${err.message}`);
            verifiedLeads.push({ ...lead, email: null, emailStatus: 'Error', emailSource: null });
        }
    }

    const found = verifiedLeads.filter(l => l.email).length;
    console.log(`✅ [STEP 4] Result: ${found}/${verifiedLeads.length} emails found.`);
    return verifiedLeads;
}
// ─── 🟡 NEW: CONFIDENCE SCORER (STEP 5) ──────────────────────────────────────
function _scoreLeadConfidence(lead) {
    let score = 0;

    if (lead.email) {
        if (lead.emailStatus === 'verified') score += 40;
        else if (lead.emailStatus === 'probable') score += 25;
        else score += 5;
    }

    if (lead.emailSource === 'hunter.io')        score += 15;
    else if (lead.emailSource === 'zerobounce')  score += 15;
    else if (lead.emailSource === 'tavily')      score += 10;
    else if (lead.emailSource === 'contact_page') score += 8;
    else if (lead.emailSource === 'pattern_generated') score += 5;

    if (lead.contact?.name && lead.contact.name !== 'Unknown') score += 15;

    if (lead.contact?.confidence >= 0.8) score += 10;
    else if (lead.contact?.confidence >= 0.5) score += 5;

    if (lead.relevance_score >= 80) score += 15;
    else if (lead.relevance_score >= 60) score += 10;
    else if (lead.relevance_score >= 40) score += 5;

    if (lead.emailScore >= 80) score += 5;

    score = Math.min(100, Math.max(0, score));

    let tier, tierLabel;
    if (score >= 75) { tier = 'high';   tierLabel = '🟢 Outreach Ready'; }
    else if (score >= 45) { tier = 'medium'; tierLabel = '🟡 Needs Review'; }
    else { tier = 'low'; tierLabel = '🔴 Low Confidence'; }

    return { confidenceScore: score, tier, tierLabel };
}

// ─── ✉️ NEW: PERSONALIZED EMAIL GENERATOR (STEP 6) ───────────────────────────
function _generatePersonalizedEmail(lead) {
    const firstName = lead.contact.name.split(' ')[0];
    const company = lead.company;
    const industry = lead.industry || 'your industry';
    const role = lead.contact.role;

    const subject = `Quick question for ${firstName} at ${company}`;
    
    const body = `Hi ${firstName},

I came across ${company} while researching top ${industry} firms and was impressed by your work.
As a ${role}, you likely face challenges with scaling outreach efficiently. We help companies like yours streamline this process and achieve better results.

Would you be open to a brief 15-minute chat next week to see if we can help?

Best regards,
[Your Name]`;

    return {
        subject: subject,
        body: body
    };
}

// ─── MAIN: generateFreeResponse (FULL PIPELINE) ──────────────────────────────
async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🟢 [AI ENGINE] Full Pipeline started...');
        onProgress?.('AI Searching...');

        const tavilyKey = process.env.TAVILY_API_KEY;
        if (!tavilyKey) throw new Error('Missing TAVILY_API_KEY');

        const intentParams = {
            industry:    message,
            location:    'Global',
            target_role: 'CEO'
        };

        // ── STEP 1: Discovery ─────────────────────────────────────────────────
        const rawCandidates = await _runDiscovery(intentParams, tavilyKey, MAX_COMPANIES_RETURNED);
        if (rawCandidates.length === 0) {
            return {
                reply: 'No companies found.',
                updatedHistory: [...history,
                    { role: 'user', content: message },
                    { role: 'assistant', content: 'No companies found.' }
                ]
            };
        }

        onProgress?.('Filtering Results...');
        // ── STEP 2: Filtering ─────────────────────────────────────────────────
        const filteredCompanies = await _runFiltering(rawCandidates);
        if (filteredCompanies.length === 0) {
            return {
                reply: 'No valid businesses found.',
                updatedHistory: [...history,
                    { role: 'user', content: message },
                    { role: 'assistant', content: 'No valid businesses found.' }
                ]            };
        }

        onProgress?.('Finding Decision Makers...');
        // ── STEP 3: Find People ───────────────────────────────────────────────
        const targetRole    = intentParams.target_role || 'CEO';
        const enrichedLeads = await _findDecisionMakers(filteredCompanies, targetRole, tavilyKey);

        onProgress?.('Verifying Emails...');
        // ── STEP 4: Multi-Layer Email Finding + Verification ──────────────────
        const verifiedLeads = await _verifyEmails(enrichedLeads, tavilyKey);

        onProgress?.('Scoring Leads...');
        // ── STEP 5: Confidence Scoring ────────────────────────────────────────
        const scoredLeads = verifiedLeads.map(lead => {
            const { confidenceScore, tier, tierLabel } = _scoreLeadConfidence(lead);
            return { ...lead, confidenceScore, tier, tierLabel };
        });

        // Sort by confidence score descending
        scoredLeads.sort((a, b) => b.confidenceScore - a.confidenceScore);

        onProgress?.('Finalizing...');

        // ── STEP 6: Generate Personalized Emails ──────────────────────────────
        const finalLeads = scoredLeads.map(lead => {
            const emailContent = _generatePersonalizedEmail(lead);
            return {
                ...lead,
                messages: [emailContent] // Format matches frontend expectation
            };
        });

        // ── FORMAT OUTPUT ─────────────────────────────────────────────────────
        const leadList = finalLeads.map(c => ({
            company:        c.company,
            domain:         c.domain,
            contactName:    c.contact.name,
            contactRole:    c.contact.role,
            email:          c.email,
            emailStatus:    c.emailStatus,
            emailSource:    c.emailSource,
            emailScore:     c.emailScore,
            confidenceScore: c.confidenceScore,
            tier:           c.tier,
            tierLabel:      c.tierLabel,
            messages:       c.messages // Include the generated email
        }));

        const verifiedCount = leadList.filter(l => l.email && l.emailStatus !== 'Invalid/Unverified').length;        const highTier      = leadList.filter(l => l.tier === 'high').length;
        const medTier       = leadList.filter(l => l.tier === 'medium').length;

        const replyText =
            `Found ${leadList.length} leads. ${verifiedCount} have verified emails.\n` +
            `🟢 ${highTier} Outreach Ready  |  🟡 ${medTier} Needs Review\n\n` +
            leadList.map(l =>
                `${l.tierLabel} — **${l.company}**\n` +
                `  👤 ${l.contactName} (${l.contactRole})\n` +
                `  📧 ${l.email || 'No Email Found'} ${l.emailStatus ? `[${l.emailStatus}]` : ''}\n` +
                `  📊 Confidence: ${l.confidenceScore}/100`
            ).join('\n\n');

        return {
            reply: replyText,
            leads: leadList,
            summary: {
                total:    leadList.length,
                verified: verifiedCount,
                high:     highTier,
                medium:   medTier,
                low:      leadList.filter(l => l.tier === 'low').length,
            },
            updatedHistory: [
                ...history,
                { role: 'user', content: message },
                { role: 'assistant', content: `[Found ${verifiedCount} verified leads across ${leadList.length} companies]` }
            ],
        };

    } catch (error) {
        console.error('❌ [AI ENGINE] Fatal error:', error.message);
        return { reply: 'An error occurred during search.', updatedHistory: history };
    }
}

module.exports = { generateFreeResponse };
