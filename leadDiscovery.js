'use strict';

const axios = require('axios');
const dns   = require('dns').promises;

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 60 * 1000;
const researchCache = new Map();

const SKIP_DOMAINS = [
    'linkedin.com','crunchbase.com','apollo.io','hunter.io',
    'yelp.com','clutch.co','g2.com','trustpilot.com',
    'bark.com','bark.london','upwork.com','fiverr.com','peopleperhour.com',
    'yell.com','thomsonlocal.com','checkatrade.com',
    'directory.com','yellowpages.com','manta.com',
    'rocketreach.co','signalhire.com','contactout.com',
    'zoominfo.com','lead411.com','lusha.com',
];

const FREE_EMAIL_PROVIDERS = new Set([
    'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com',
    'protonmail.com','aol.com','mail.com','yandex.com','zoho.com',
    'mailinator.com','guerrillamail.com','tempmail.com','throwam.com',
]);

const GENERIC_PREFIXES = [
    'contact','info','hello','sales','team','support',
    'enquiries','enquiry','admin','office','mail',
    'general','press','media',
];

const ROLE_PRIORITY = {
    'founder':           100,
    'ceo':               100,
    'co-founder':         95,
    'cofounder':          95,
    'head of growth':     90,
    'owner':              88,
    'sales director':     85,
    'marketing director': 80,
    'marketing lead':     80,
    'vp':                 75,
    'director':           70,
    'manager':            60,
};

const REASONING_FILTER = `
⚠️ REASONING FILTER — NON-NEGOTIABLE:
1. You are a strict fact extractor. Use ONLY facts explicitly stated in SNIPPETS.
2. IGNORE all training data. If a fact is not in the snippets, return null.
3. NEVER invent names, emails, roles, or company details.
4. Current year is 2026.
`;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getRolePriority(role) {
    if (!role) return 0;
    const r = role.toLowerCase();
    for (const [key, val] of Object.entries(ROLE_PRIORITY)) {
        if (r.includes(key)) return val;
    }
    return 40;
}

function isValidEmailFormat(email) {
    if (!email || typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

function isFreeEmailDomain(domain) {
    return FREE_EMAIL_PROVIDERS.has(domain.toLowerCase());
}

function isSkippedDomain(domain) {
    return SKIP_DOMAINS.some(d => domain.includes(d));
}

function cleanCompanyName(rawTitle) {
    let name = rawTitle.split(/[|\-–]/)[0].trim();
    name = name.replace(
        /\b(Office|Offices|Ltd|LLC|Inc|Limited|PLC|Group|Agency|London|UK|US|USA|International|Global)\s*$/gi,
        ''
    ).trim();
    if (name.length > 40) name = name.substring(0, 40).trim();
    const REJECT = ['home','about','contact','services','welcome','index'];
    if (!name || REJECT.includes(name.toLowerCase())) return null;
    return name;
}

// ─── CACHE ────────────────────────────────────────────────────────────────────
function getCachedResearch(domain) {
    const hit = researchCache.get(domain);
    if (!hit) return null;
    if (Date.now() - hit.timestamp > CACHE_TTL_MS) {
        researchCache.delete(domain);
        return null;
    }
    console.log(`💾 [CACHE HIT] ${domain}`);
    return hit.data;
}

function setCachedResearch(domain, data) {
    researchCache.set(domain, { data, timestamp: Date.now() });
}

// ─── VALIDATION ───────────────────────────────────────────────────────────────
async function validateMX(domain) {
    try {
        const records = await dns.resolveMx(domain);
        return records && records.length > 0;
    } catch { return false; }
}

// ─── EMAIL EXTRACTION ─────────────────────────────────────────────────────────
function extractEmailsFromText(text, companyDomain) {
    if (!text || !companyDomain) return { companyEmails: [], allEmails: [] };
    const emailRegex    = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const allFound      = [...new Set(text.match(emailRegex) || [])];
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

// ─── EMAIL CLASSIFICATION ─────────────────────────────────────────────────────
function classifyEmail(email, domain) {
    if (!email) return { type: 'none', label: 'Not found', trustLevel: 0, sourceType: 'none' };
    const localPart     = email.split('@')[0].toLowerCase();
    const emailDomain   = email.split('@')[1]?.toLowerCase();
    const domainRoot    = domain.split('.')[0].toLowerCase();
    const domainMatches = emailDomain === domain || emailDomain?.includes(domainRoot);

    if (!domainMatches) {
        return { type: 'unrelated-domain', label: 'Wrong domain', trustLevel: 0, sourceType: 'invalid' };
    }
    if (GENERIC_PREFIXES.some(p => localPart === p || localPart.startsWith(p + '.'))) {
        return { type: 'confirmed-generic', label: '✓ Generic inbox (real)', trustLevel: 60, sourceType: 'generic' };
    }
    if (localPart.includes('.') || /^[a-z]{2,}[a-z]{2,}$/.test(localPart)) {
        return { type: 'confirmed-personal', label: '✓ Personal email (real)', trustLevel: 90, sourceType: 'personal' };
    }
    return { type: 'confirmed-other', label: '✓ Email (real)', trustLevel: 75, sourceType: 'other' };
}

// ─── PATTERN GENERATION — STRICTLY CONTROLLED ────────────────────────────────
function canUsePatternGeneration(employee, mxValid) {
    if (!mxValid)        return false;
    if (!employee?.name) return false;
    const priority = getRolePriority(employee?.role);
    return priority >= 88; // CEO / Founder / Owner only
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
            'helping businesses','empowering companies',
            'world-class','innovative solutions','cutting-edge',
        ];
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

// ─── TAVILY SEARCH ────────────────────────────────────────────────────────────
async function searchWithTavily(query, tavilyKey, tavilyQuota, options = {}) {
    if (tavilyQuota.remaining() <= 0) throw new Error('Tavily quota exhausted');
    try {
        const response = await axios.post('https://api.tavily.com/search', {
            api_key:            tavilyKey,
            query,
            search_depth:       'advanced',
            max_results:        options.maxResults || 5,
            include_answer:     false,
            include_raw_content:false,
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 12000 });
        tavilyQuota.record();
        return (response.data?.results || []).map(r => ({
            title:   r.title   || '',
            url:     r.url     || '',
            snippet: r.content || '',
            date:    r.published_date || null,
        }));
    } catch (err) {
        console.warn(`[Tavily Error] ${err.message}`);
        return [];
    }
}

// ─── EMAIL HUNT ───────────────────────────────────────────────────────────────
async function huntRealEmails(companyName, domain, tavilyKey, tavilyQuota) {
    if (tavilyQuota.remaining() <= 0) return { companyEmails: [], allEmails: [] };
    console.log(`🎯 [EMAIL HUNT] ${companyName} @ ${domain}`);

    const contactResults = await searchWithTavily(
        `"${companyName}" "@${domain}" OR "contact" OR "email us" site:${domain}`,
        tavilyKey, tavilyQuota, { maxResults: 3 }
    );

    const directoryResults = tavilyQuota.remaining() > 0
        ? await searchWithTavily(
            `"${companyName}" email "@${domain}" contact site:hunter.io OR site:rocketreach.co OR site:signalhire.com`,
            tavilyKey, tavilyQuota, { maxResults: 3 }
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

// ─── COMPANY RESEARCH ─────────────────────────────────────────────────────────
async function researchCompany(companyName, domain, tavilyKey, openAiKey, tavilyQuota, openAiTracker, onProgress) {
    const cached = getCachedResearch(domain);
    if (cached) return cached;
    if (tavilyQuota.remaining() <= 1) return null;

    try {
        onProgress?.(`🔍 Researching ${companyName}...`);

        const generalResults = await searchWithTavily(
            `"${companyName}" contact email site:${domain} OR site:linkedin.com OR site:crunchbase.com mission about team 2025 2026`,
            tavilyKey, tavilyQuota, { maxResults: 5 }
        );

        const generalText  = generalResults.map(r => `${r.title} ${r.snippet} ${r.url}`).join(' ');
        const regexGeneral = extractEmailsFromText(generalText, domain);

        const hasEmailSignal      = regexGeneral.companyEmails.length > 0;
        const needsEmployeeSearch = generalResults.length < 3 || !hasEmailSignal;

        let employeeResults = [];
        if (needsEmployeeSearch && tavilyQuota.remaining() > 0) {
            onProgress?.(`👤 Finding decision-makers at ${companyName}...`);
            employeeResults = await searchWithTavily(
                `"${companyName}" CEO OR founder OR "head of" OR "director" OR owner email LinkedIn`,
                tavilyKey, tavilyQuota, { maxResults: 4 }
            );
        }

        const allResults  = [...generalResults, ...employeeResults];
        const allText     = allResults.map(r => `${r.title} ${r.snippet} ${r.url}`).join(' ');
        const regexAll    = extractEmailsFromText(allText, domain);
        const allSnippets = allResults
            .map(r => `SOURCE: ${r.url}\nTITLE: ${r.title}\n${r.snippet}`)
            .join('\n\n---\n\n');

        if (!allSnippets.trim()) return null;

        const extractPrompt = `${REASONING_FILTER}
Extract company intelligence for "${companyName}" (domain: ${domain}).
Return ONLY valid JSON — no markdown, no explanation:
{
  "mission":      "one sentence company mission or null",
  "hq":           "City, Country or null",
  "size":         "1-10 | 11-50 | 51-200 | 200+ | unknown",
  "model":        "B2B | B2C | SaaS | Services | E-commerce | Agency | unknown",
  "recentNews":   "one sentence most recent news or null",
  "sourcePage":   "team | about | contact | footer | linkedin | unknown",
  "contactEmails":["role-based emails literally found in text only. Max 3. Empty array if none."],
  "employees": [
    {
      "name":     "Full Name ONLY if explicitly in snippets. null otherwise.",
      "role":     "CEO | Founder | Co-Founder | Director | VP | Owner | Manager | Head of X",
      "email":    "Email ONLY if literally in snippets. null otherwise. NEVER construct.",
      "linkedIn": "LinkedIn URL if found. null otherwise."
    }
  ]
}
CRITICAL: Never construct any email. Never guess. If not in snippets: null.
SNIPPETS:
${allSnippets}`;

        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: extractPrompt }],
            max_tokens:  600,
            temperature: 0.0,
        }, { headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' } });

        openAiTracker.record(res.data?.usage?.total_tokens || 0);

        const raw    = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        const parsed = JSON.parse(raw);
        parsed._domain = domain;

        // ── Merge regex-found real emails into contactEmails ──────────────────
        const allRealEmails = [...new Set([
            ...regexAll.companyEmails,
            ...(parsed.contactEmails || []),
        ])].filter(isValidEmailFormat).filter(e => {
            const ed = e.split('@')[1]?.toLowerCase();
            return ed === domain || ed?.includes(domain.split('.')[0]);
        });
        parsed.contactEmails = allRealEmails;

        // ── Reality-check GPT employee emails ────────────────────────────────
        if (Array.isArray(parsed.employees)) {
            parsed.employees = parsed.employees.map(emp => {
                if (emp.email) {
                    const actuallyExists = allText.toLowerCase().includes(emp.email.toLowerCase());
                    if (!actuallyExists) {
                        console.warn(`🗑️ [REALITY CHECK] GPT invented email: ${emp.email} — removing`);
                        emp.email = null;
                    }
                }
                return emp;
            });
        }

        // ── Hallucination filtering ───────────────────────────────────────────
        const hallucinationFlags = detectHallucinations(companyName, parsed);
        if (hallucinationFlags.length > 0) {
            console.warn(`⚠️ [HALLUCINATION] ${companyName}:`, hallucinationFlags);
            parsed._hallucinationFlags = hallucinationFlags;
            if (Array.isArray(parsed.employees)) {
                parsed.employees = parsed.employees.filter(emp => {
                    const suspect = hallucinationFlags.some(f => emp.name && f.includes(emp.name));
                    if (suspect) console.warn(`🗑️ Removed suspect employee: ${emp.name}`);
                    return !suspect;
                });
            }
        }

        parsed._regexEmails = regexAll.companyEmails;
        setCachedResearch(domain, parsed);
        return parsed;

    } catch (err) {
        console.warn(`[Research Error] ${err.message}`);
        return null;
    }
}

// ─── DATA COMPLETENESS SCORE ──────────────────────────────────────────────────
function scoreDataCompleteness(extracted) {
    if (!extracted) return 0;
    let score = 0;
    if (extracted.mission      && extracted.mission      !== 'unknown') score += 15;
    if (extracted.hq           && extracted.hq           !== 'unknown') score += 10;
    if (extracted.size         && extracted.size         !== 'unknown') score += 10;
    if (extracted.model        && extracted.model        !== 'unknown') score += 10;
    if (extracted.recentNews)                                            score += 15;
    if (extracted.contactEmails?.length > 0)                            score += 15;
    if (extracted.employees?.length > 0)                                score += 15;
    if (extracted.employees?.some(e => e.email))                        score += 10;
    return Math.min(score, 100);
}

// ─── RESOLVE BEST CONTACT ─────────────────────────────────────────────────────
function resolveBestContact(employees, preferredContact) {
    if (!employees || employees.length === 0) return null;
    const preferred = preferredContact?.toLowerCase();

    // Try preferred role first
    if (preferred && preferred !== 'any') {
        const match = employees.find(e =>
            e.role && e.role.toLowerCase().includes(preferred)
        );
        if (match) return match;
    }

    // Sort by role priority and return best
    return [...employees].sort((a, b) =>
        getRolePriority(b.role) - getRolePriority(a.role)
    )[0];
}

// ─── EMAIL RESOLUTION PIPELINE ────────────────────────────────────────────────
// Priority: Tier1 regex → Tier2 GPT confirmed → Tier3 email hunt →
//           Tier4 pattern-generated (controlled) → Tier5 no result
async function resolveEmail(companyData, bestContact, domain, mxValid, tavilyKey, tavilyQuota, companyName, onProgress) {
    const regexEmails = companyData?._regexEmails || [];
    const allText     = JSON.stringify(companyData);

    // TIER 1 — Real emails found by regex on page
    if (regexEmails.length > 0) {
        const classified = classifyEmail(regexEmails[0], domain);
        if (classified.trustLevel > 0) {
            console.log(`✅ [TIER 1] Regex email: ${regexEmails[0]}`);
            return {
                email:           regexEmails[0],
                emailType:       'regex-real',
                emailLabel:      classified.label,
                verification:    'found-on-page',
                confidenceLevel: classified.trustLevel,
                allOptions:      regexEmails,
                sourcePage:      companyData?.sourcePage || 'unknown',
            };
        }
    }

    // TIER 2 — GPT confirmed real email from snippets
    if (bestContact?.email && isValidEmailFormat(bestContact.email)) {
        const classified = classifyEmail(bestContact.email, domain);
        if (classified.trustLevel > 0) {
            console.log(`✅ [TIER 2] GPT-confirmed email: ${bestContact.email}`);
            return {
                email:           bestContact.email,
                emailType:       'confirmed-personal',
                emailLabel:      classified.label,
                verification:    'found-in-snippets',
                confidenceLevel: classified.trustLevel,
                allOptions:      [bestContact.email],
                sourcePage:      companyData?.sourcePage || 'unknown',
            };
        }
    }

    // TIER 3 — Active email hunt via Tavily
    if (tavilyQuota.remaining() > 0) {
        onProgress?.(`🎯 Hunting real email for ${companyName}...`);
        const huntResult = await huntRealEmails(companyName, domain, tavilyKey, tavilyQuota);
        if (huntResult.companyEmails.length > 0) {
            const classified = classifyEmail(huntResult.companyEmails[0], domain);
            if (classified.trustLevel > 0) {
                console.log(`✅ [TIER 3] Email hunt: ${huntResult.companyEmails[0]}`);
                return {
                    email:           huntResult.companyEmails[0],
                    emailType:       'hunted-real',
                    emailLabel:      classified.label,
                    verification:    'found-via-hunt',
                    confidenceLevel: classified.trustLevel,
                    allOptions:      huntResult.companyEmails,
                    sourcePage:      'email-hunt',
                };
            }
        }
    }

    // TIER 4 — Pattern generation — STRICTLY CONTROLLED
    // Only: CEO/Founder/Owner + MX valid + name confirmed
    if (canUsePatternGeneration(bestContact, mxValid)) {
        const guesses = guessEmailPatterns(bestContact.name, domain);
        if (guesses.length > 0) {
            console.log(`⚠️ [TIER 4] Pattern-generated: ${guesses[0]} — marked unverified`);
            return {
                email:           guesses[0],
                emailType:       'pattern-generated',
                emailLabel:      '⚠️ Pattern guess (not verified)',
                verification:    'pattern-generated',
                confidenceLevel: 45,
                allOptions:      guesses,
                sourcePage:      'pattern-inference',
            };
        }
    }

    // TIER 5 — No result. Return null. NO contact@ fallback. Trust > quantity.
    console.log(`🚫 [TIER 5] No reliable email found for ${domain}`);
    return null;
}

function canUsePatternGeneration(employee, mxValid) {
    if (!mxValid)        return false;
    if (!employee?.name) return false;
    return getRolePriority(employee?.role) >= 88;
}

// ─── SEARCH INTENT EXTRACTION ─────────────────────────────────────────────────
async function extractIntent(message, openAiKey, openAiTracker) {
    const intentPrompt = `Extract lead generation parameters from: "${message}".
Return ONLY valid JSON:
{
  "target":           "description of ideal customer or company type",
  "industry":         "specific industry or niche — be precise e.g. 'plumbing', 'SaaS', 'digital marketing agency'",
  "location":         "city, country, region — null if not mentioned",
  "preferredContact": "CEO | Founder | Marketing | Sales | Owner | Any"
}
Never return null for target or industry. Infer from context.`;

    try {
        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: intentPrompt }],
            max_tokens:  150,
            temperature: 0.1,
        }, { headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' } });
        openAiTracker.record(res.data?.usage?.total_tokens || 0);
        const raw = res.data.choices[0].message.content.replace(/```json|```/g, '');
        return JSON.parse(raw);
    } catch (e) {
        console.warn('[Intent Parse Failed]:', e.message);
        return { target: 'small businesses', industry: 'general', location: null, preferredContact: 'Any' };
    }
}

// ─── COMPANY SEARCH ───────────────────────────────────────────────────────────
async function searchCompanies(intent, tavilyKey, tavilyQuota) {
    const locationClause = intent.location ? `"${intent.location}"` : '';
    const query = [
        `"${intent.target}"`, intent.industry, locationClause,
        'contact email CEO founder',
        'inurl:about OR inurl:team OR inurl:contact OR inurl:contact-us',
    ].filter(Boolean).join(' ');

    console.log(`🔍 Query: ${query}`);
    const rawResults = await searchWithTavily(query, tavilyKey, tavilyQuota, { maxResults: 10 });
    console.log(`🔎 RAW RESULTS (${rawResults.length}):`, rawResults.map(r => r.url));

    const seenDomains  = new Set();
    const cleanResults = [];

    for (const result of rawResults) {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
        if (!domain || seenDomains.has(domain))  continue;
        if (isSkippedDomain(domain))              continue;
        if (isFreeEmailDomain(domain))            continue;
        seenDomains.add(domain);
        cleanResults.push({ ...result, _domain: domain });
        if (cleanResults.length >= 8) break;
    }

    console.log(`✅ Clean results after filter: ${cleanResults.length}`);
    return cleanResults;
}

module.exports = {
    searchCompanies,
    researchCompany,
    resolveEmail,
    resolveBestContact,
    validateMX,
    scoreDataCompleteness,
    cleanCompanyName,
    extractIntent,
    isValidEmailFormat,
    isFreeEmailDomain,
    isSkippedDomain,
};
