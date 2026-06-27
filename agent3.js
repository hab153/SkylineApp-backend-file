'use strict';

/**
 * agent3.js – Enrichment / Verification Agent
 * 
 * The third layer in the B2B lead-generation system.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Read Agent 2 output carefully.
 * 2. For each prospect, find missing or stale public information.
 * 3. Enrich records with website, company details, identity clues, role, location, industry, and contact clues.
 * 4. Search only when needed for live public facts.
 * 5. Infer an email candidate only when supported by domain/name patterns or source clues.
 * 6. Verify email candidates when possible.
 * 7. Assign a verification status and confidence.
 * 8. Return clean structured JSON only.
 * 
 * YOU MUST NOT:
 * - Write outreach.
 * - Send emails.
 * - Pretend guessed emails are verified.
 * - Return a paragraph.
 * - Invent facts not supported by sources.
 * - Over-search when the input is already strong.
 */

const axios = require('axios');
const dns = require('dns').promises;

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const MODEL = 'gpt-4o-mini';
const MAX_OUTPUT_TOKENS = 1200;
const MAX_SEARCH_RESULTS = 5;
const MAX_QUERIES_PER_PROSPECT = 2;
const CONFIDENCE_THRESHOLD_ROUTE = 0.90;
const CONFIDENCE_THRESHOLD_CLARIFY = 0.50;

// Common email patterns for inference
const COMMON_PATTERNS = [
  '{first}@{domain}',
  '{first}.{last}@{domain}',
  '{first}{last}@{domain}',
  '{first}_{last}@{domain}',
  '{first}-{last}@{domain}',
  '{last}@{domain}',
  '{first}@mail.{domain}',
  'info@{domain}',
  'contact@{domain}',
  'hello@{domain}',
];

// ────────────────────────────────────────────────────────────────
// 2. The Agent 3 System Prompt (Updated with email rules)
// ────────────────────────────────────────────────────────────────

const AGENT3_SYSTEM_PROMPT = `You are Agent 3, the Enrichment / Verification layer in a B2B lead-generation system.

Your job is to take raw prospect records from Agent 2 and enrich them with reliable public information, especially contact data such as email candidates, then assess how trustworthy each record is.

PRIMARY RESPONSIBILITIES
1. Read Agent 2 output carefully.
2. For each prospect, find missing or stale public information.
3. Enrich records with website, company details, identity clues, role, location, industry, and contact clues.
4. Search only when needed for live public facts.
5. Infer an email candidate only when supported by domain/name patterns or source clues.
6. Verify email candidates when possible.
7. Assign a verification status and confidence.
8. Return clean structured JSON only.

YOU MUST NOT
- Write outreach.
- Send emails.
- Pretend guessed emails are verified.
- Return a paragraph.
- Invent facts not supported by sources.
- Over-search when the input is already strong.

EMAIL RULES
- If a real email is found, return it as "found".
- If only a pattern is available, create an email candidate and label it as "inferred-pattern".
- Verification status must be one of: verified, partial, unverified.
- Never mark guessed email as verified unless validation supports it.
- Use emailConfidence: "found" | "inferred-pattern" | "unknown"

SEARCH RULES
- Use targeted searches only when needed.
- Prefer official websites, about pages, team pages, and public profile pages.
- Keep searches minimal and focused.
- Do not search broadly if the record is already strong.

OUTPUT FORMAT
Return valid JSON only using this schema:
{
  "intent": string,
  "confidence": number,
  "needs_clarification": boolean,
  "clarification_question": string|null,
  "next_pipeline": string|null,
  "entities": {
    "industry": string|null,
    "location": string|null,
    "role": string|null,
    "company": string|null,
    "lead_count": number|null,
    "email": string|null,
    "domain": string|null,
    "source_type": string|null
  },
  "risk_level": "low" | "medium" | "high",
  "policy_flags": string[],
  "reason": string,
  "enriched_prospects": [
    {
      "name": string|null,
      "company": string|null,
      "domain": string|null,
      "website": string|null,
      "location": string|null,
      "role": string|null,
      "industry": string|null,
      "linkedin_url": string|null,
      "email": string|null,
      "emailCandidate": string|null,
      "emailConfidence": "found" | "inferred-pattern" | "unknown",
      "emailLabel": string|null,
      "verificationStatus": "verified" | "partial" | "unverified",
      "confidence": number|null,
      "mxValid": boolean|null,
      "smtpResult": string|null,
      "notes": string|null
    }
  ],
  "stats": {
    "checked": number,
    "enriched": number,
    "emails_found": number,
    "emails_inferred": number,
    "verified": number,
    "returned": number
  }
}

CONFIDENCE GUIDELINES
- 0.90 to 1.00 = very clear and well supported.
- 0.70 to 0.89 = mostly clear.
- 0.50 to 0.69 = incomplete, needs caution.
- below 0.50 = stop and clarify.`;

// ────────────────────────────────────────────────────────────────
// 3. Utility: Retry helper
// ────────────────────────────────────────────────────────────────

async function withRetry(fn, label, retries = 2, delayMs = 800) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isLast = attempt === retries;
            if (err.response?.status && err.response.status < 500 && err.response.status !== 429) {
                console.warn(`⛔ [${label}] Non-retryable (${err.response.status}): ${err.message}`);
                return null;
            }
            console.warn(`⚠️ [${label}] attempt ${attempt + 1} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying'}`);
            if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
    }
    return null;
}

// ────────────────────────────────────────────────────────────────
// 4. Tavily Search Helper
// ────────────────────────────────────────────────────────────────

async function searchTavily(query, tavilyKey, maxResults = MAX_SEARCH_RESULTS) {
    if (!tavilyKey) {
        console.warn('⚠️ [TAVILY] No API key provided');
        return [];
    }

    try {
        const response = await withRetry(() => axios.post(
            'https://api.tavily.com/search',
            {
                api_key: tavilyKey,
                query: query,
                search_depth: 'basic',
                max_results: maxResults,
                include_answer: false,
                include_raw_content: false,
            },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            }
        ), `Tavily:${query.slice(0, 40)}`);

        if (!response) return [];

        return (response.data?.results || []).map(r => ({
            title: r.title || '',
            url: r.url || '',
            snippet: r.content || '',
            date: r.published_date || null,
        }));

    } catch (error) {
        console.error(`❌ [TAVILY] Search failed:`, error.message);
        return [];
    }
}

// ────────────────────────────────────────────────────────────────
// 5. Email Inference Functions
// ────────────────────────────────────────────────────────────────

function extractDomain(url) {
    if (!url) return null;
    try {
        const domain = new URL(url).hostname.replace('www.', '');
        return domain;
    } catch {
        return null;
    }
}

function generateEmailPatterns(firstName, lastName, domain) {
    if (!domain || !firstName) return [];
    
    const first = firstName.toLowerCase().trim();
    const last = lastName ? lastName.toLowerCase().trim() : '';
    const domainClean = domain.replace(/^www\./, '');
    
    const patterns = [];
    
    // Simple patterns
    patterns.push(`${first}@${domainClean}`);
    if (last) {
        patterns.push(`${first}.${last}@${domainClean}`);
        patterns.push(`${first}${last}@${domainClean}`);
        patterns.push(`${first}_${last}@${domainClean}`);
        patterns.push(`${first}-${last}@${domainClean}`);
        patterns.push(`${last}@${domainClean}`);
    }
    
    // Common role-based emails
    patterns.push(`info@${domainClean}`);
    patterns.push(`contact@${domainClean}`);
    patterns.push(`hello@${domainClean}`);
    patterns.push(`sales@${domainClean}`);
    patterns.push(`team@${domainClean}`);
    
    return [...new Set(patterns)];
}

async function validateMX(domain) {
    if (!domain) return false;
    try {
        const records = await dns.resolveMx(domain);
        return records && records.length > 0;
    } catch {
        return false;
    }
}

// ────────────────────────────────────────────────────────────────
// 6. Build Enrichment Queries for a Prospect
// ────────────────────────────────────────────────────────────────

function buildEnrichmentQueries(prospect) {
    const queries = [];
    const company = prospect.company || prospect.name || '';
    const domain = prospect.domain || '';

    // If we have a domain, search the site directly
    if (domain) {
        queries.push(`site:${domain} about team contact`);
        queries.push(`site:${domain} email "@${domain}"`);
    }
    
    // Search for company info
    if (company) {
        queries.push(`"${company}" about team leadership contact`);
        queries.push(`"${company}" email contact`);
    }
    
    // If we have a name, search for them specifically
    if (prospect.name && company) {
        queries.push(`"${prospect.name}" "${company}" email`);
    }

    // Limit queries
    return queries.slice(0, MAX_QUERIES_PER_PROSPECT);
}

// ────────────────────────────────────────────────────────────────
// 7. Enrich a Single Prospect (FIXED: Finds/Infers Emails)
// ────────────────────────────────────────────────────────────────

async function enrichSingleProspect(prospect, tavilyKey, apiKey) {
    console.log(`🔍 [AGENT3] Enriching: ${prospect.company || prospect.name || 'Unknown'}`);
    console.log(`📧 [AGENT3] Input email_candidates: ${JSON.stringify(prospect.email_candidates || [])}`);
    console.log(`📧 [AGENT3] Input email: ${prospect.email || 'null'}`);

    // Extract domain from prospect
    let domain = prospect.domain || null;
    if (!domain && prospect.source_url) {
        domain = extractDomain(prospect.source_url);
    }

    // Check if we already have a high-confidence email
    const hasEmail = prospect.email_candidates && prospect.email_candidates.length > 0;
    const hasStrongEmail = hasEmail && prospect.fit_score >= 0.85;

    if (hasStrongEmail && domain) {
        console.log(`⏭️ [AGENT3] Skipping enrichment - already has email and domain`);
        return {
            ...prospect,
            domain: domain || prospect.domain,
            confidence: prospect.fit_score || 0.7,
            verification_status: 'partial',
            email: prospect.email_candidates[0] || null,
            emailCandidate: prospect.email_candidates[0] || null,
            emailConfidence: 'found',
            emailLabel: '✓ Email found from source',
            mxValid: await validateMX(domain),
            smtpResult: 'unknown',
            notes: prospect.notes || 'Email already found from source.',
            // Preserve all existing fields
            email_candidates: prospect.email_candidates || [],
        };
    }

    // Build and execute search queries
    const queries = buildEnrichmentQueries(prospect);
    if (queries.length === 0) {
        return createFallbackEnrichment(prospect, domain);
    }

    let allResults = [];
    for (const query of queries) {
        const results = await searchTavily(query, tavilyKey, 3);
        if (results && results.length > 0) {
            allResults = allResults.concat(results);
        }
    }

    // Build snippets for GPT
    const snippets = allResults.length > 0 
        ? allResults.map((r, i) => 
            `[${i + 1}] TITLE: ${r.title}\nURL: ${r.url}\nSNIPPET: ${r.snippet}`
          ).join('\n\n---\n\n')
        : 'No search results found.';

    // Extract emails from snippets using regex
    const allText = allResults.map(r => `${r.title} ${r.snippet} ${r.url}`).join(' ');
    const regexEmails = extractEmailsWithRegex(allText);
    console.log(`📧 [AGENT3] Regex found emails: ${JSON.stringify(regexEmails)}`);

    // Build the enrichment prompt with email focus
    const enrichmentPrompt = `
You are an enrichment and email discovery specialist. Enrich this prospect with public information from the search results.

PROSPECT TO ENRICH:
- Name: ${prospect.name || 'Unknown'}
- Company: ${prospect.company || 'Unknown'}
- Domain: ${domain || 'Unknown'}
- Location: ${prospect.location || 'Unknown'}
- Role: ${prospect.role || 'Unknown'}

SEARCH RESULTS:
${snippets}

EXTRACTED EMAILS FROM SOURCES (USE THESE IF VALID):
${JSON.stringify(regexEmails)}

EMAIL DISCOVERY RULES:
1. If an email is found in the search results, use it and set emailConfidence to "found".
2. If no email is found, infer a likely email pattern using the domain and name.
3. For inferred emails, set emailConfidence to "inferred-pattern" and label it clearly.
4. Common patterns: first@domain, first.last@domain, firstlast@domain, info@domain, contact@domain

Extract and return ONLY valid JSON with these fields:
{
  "name": "Full name if found, otherwise keep original",
  "company": "Company name if found, otherwise keep original",
  "domain": "Domain if found, otherwise keep original",
  "website": "Official website URL if found, otherwise null",
  "location": "City/Country if found, otherwise keep original",
  "role": "Role/title if found, otherwise keep original",
  "industry": "Industry if found, otherwise null",
  "linkedin_url": "LinkedIn URL if found, otherwise null",
  "email": "Best email candidate (found or inferred), null if none",
  "emailCandidate": "The email candidate (same as email or inferred)",
  "emailConfidence": "found" | "inferred-pattern" | "unknown",
  "emailLabel": "Description of email source (e.g., 'Found in source', 'Inferred from domain pattern')",
  "verificationStatus": "verified" | "partial" | "unverified",
  "confidence": 0.0 to 1.0,
  "notes": "Brief notes on what was found and any discrepancies"
}

Be conservative. Only mark as verified if you have clear evidence.`;

    try {
        const response = await withRetry(() => axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: MODEL,
                messages: [
                    { role: 'system', content: 'You extract structured enrichment data from search results. Return only valid JSON.' },
                    { role: 'user', content: enrichmentPrompt }
                ],
                max_tokens: 400,
                temperature: 0.0,
                response_format: { type: 'json_object' }
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        ), 'GPT:enrichProspect');

        if (!response) {
            return createFallbackEnrichment(prospect, domain);
        }

        const rawContent = response.data.choices[0].message.content.trim();
        const enriched = JSON.parse(rawContent);

        // Determine final domain
        const finalDomain = enriched.domain || domain || prospect.domain || null;
        
        // Determine email
        let email = enriched.email || null;
        let emailCandidate = enriched.emailCandidate || null;
        let emailConfidence = enriched.emailConfidence || 'unknown';
        let emailLabel = enriched.emailLabel || null;

        // If GPT didn't find an email but we have regex emails, use the first one
        if (!email && regexEmails.length > 0) {
            email = regexEmails[0];
            emailCandidate = regexEmails[0];
            emailConfidence = 'found';
            emailLabel = '📧 Found in search results';
            console.log(`📧 [AGENT3] Using regex email: ${email}`);
        }

        // If still no email, try to infer one
        if (!email && finalDomain && prospect.name) {
            const nameParts = prospect.name.split(' ');
            const firstName = nameParts[0] || '';
            const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
            const inferredPatterns = generateEmailPatterns(firstName, lastName, finalDomain);
            if (inferredPatterns.length > 0) {
                email = inferredPatterns[0];
                emailCandidate = inferredPatterns[0];
                emailConfidence = 'inferred-pattern';
                emailLabel = `⚠ Inferred from domain pattern (${firstName}@${finalDomain})`;
                console.log(`📧 [AGENT3] Inferred email: ${email}`);
            }
        }

        // Validate MX if we have a domain
        const mxValid = finalDomain ? await validateMX(finalDomain) : false;

        const merged = {
            ...prospect,
            name: enriched.name || prospect.name,
            company: enriched.company || prospect.company,
            domain: finalDomain,
            website: enriched.website || null,
            location: enriched.location || prospect.location,
            role: enriched.role || prospect.role,
            industry: enriched.industry || null,
            linkedin_url: enriched.linkedin_url || null,
            email: email,
            emailCandidate: emailCandidate,
            emailConfidence: emailConfidence,
            emailLabel: emailLabel,
            confidence: enriched.confidence || prospect.fit_score || 0.5,
            verificationStatus: enriched.verificationStatus || (email ? 'partial' : 'unverified'),
            mxValid: mxValid,
            smtpResult: 'unknown',
            notes: enriched.notes || (email ? `Email ${emailConfidence}.` : 'No email found.'),
            // Preserve original email_candidates
            email_candidates: regexEmails.length > 0 ? regexEmails : (prospect.email_candidates || []),
        };

        console.log(`✅ [AGENT3] Enriched: ${merged.company} → confidence: ${merged.confidence}`);
        console.log(`📧 [AGENT3] Email: ${merged.email || 'null'} (${merged.emailConfidence})`);
        console.log(`📧 [AGENT3] Output email_candidates: ${JSON.stringify(merged.email_candidates || [])}`);
        
        return merged;

    } catch (error) {
        console.error(`❌ [AGENT3] Enrichment failed:`, error.message);
        return createFallbackEnrichment(prospect, domain);
    }
}

// ────────────────────────────────────────────────────────────────
// 8. Helper: Extract Emails with Regex
// ────────────────────────────────────────────────────────────────

function extractEmailsWithRegex(text) {
    if (!text) return [];
    const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const matches = text.match(emailRegex) || [];
    return [...new Set(matches)];
}

// ────────────────────────────────────────────────────────────────
// 9. Helper: Create Fallback Enrichment
// ────────────────────────────────────────────────────────────────

function createFallbackEnrichment(prospect, domain) {
    // Try to infer email from domain and name
    let email = null;
    let emailConfidence = 'unknown';
    let emailLabel = null;
    
    if (domain && prospect.name) {
        const nameParts = prospect.name.split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
        const patterns = generateEmailPatterns(firstName, lastName, domain);
        if (patterns.length > 0) {
            email = patterns[0];
            emailConfidence = 'inferred-pattern';
            emailLabel = `⚠ Inferred from domain pattern`;
        }
    }

    return {
        ...prospect,
        domain: domain || prospect.domain || null,
        email: email,
        emailCandidate: email,
        emailConfidence: emailConfidence,
        emailLabel: emailLabel,
        confidence: prospect.fit_score || 0.4,
        verificationStatus: 'unverified',
        mxValid: false,
        smtpResult: 'unknown',
        notes: email ? `Email inferred from domain pattern.` : 'No email could be found or inferred.',
        email_candidates: prospect.email_candidates || [],
    };
}

// ────────────────────────────────────────────────────────────────
// 10. Main Agent 3 Function (FIXED: No unnecessary clarification)
// ────────────────────────────────────────────────────────────────

async function enrichProspects({ prospects, intent, apiKey, tavilyKey, userId = 'anonymous', onProgress = null }) {
    console.log(`🔍 [AGENT3] Starting enrichment for user ${userId}...`);
    onProgress?.('🔬 Enriching and verifying prospects...');

    if (!prospects || prospects.length === 0) {
        return {
            intent: 'lead_enrichment',
            confidence: 0.0,
            needs_clarification: true,
            clarification_question: 'No prospects were provided to enrich. Please run discovery first.',
            next_pipeline: null,
            entities: intent?.entities || {},
            risk_level: 'low',
            policy_flags: ['no_prospects'],
            reason: 'No prospects provided to Agent 3.',
            enriched_prospects: [],
            stats: { checked: 0, enriched: 0, emails_found: 0, emails_inferred: 0, verified: 0, returned: 0 }
        };
    }

    console.log(`📥 [AGENT3] RECEIVED ${prospects.length} prospects from Agent 2`);
    prospects.forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.company || 'Unknown'} → email_candidates: ${JSON.stringify(p.email_candidates || [])}, email: ${p.email || 'null'}`);
    });

    const enriched = [];
    let enrichedCount = 0;
    let verifiedCount = 0;
    let emailsFound = 0;
    let emailsInferred = 0;

    for (let i = 0; i < prospects.length; i++) {
        const prospect = prospects[i];
        onProgress?.(`🔍 Enriching ${i + 1}/${prospects.length}: ${prospect.company || prospect.name || 'Unknown'}...`);

        const enrichedProspect = await enrichSingleProspect(prospect, tavilyKey, apiKey);
        enriched.push(enrichedProspect);

        if (enrichedProspect.verificationStatus === 'verified') verifiedCount++;
        if (enrichedProspect.confidence >= 0.5) enrichedCount++;
        if (enrichedProspect.emailConfidence === 'found') emailsFound++;
        if (enrichedProspect.emailConfidence === 'inferred-pattern') emailsInferred++;
    }

    const avgConfidence = enriched.reduce((sum, p) => sum + (p.confidence || 0), 0) / enriched.length;
    const verifiedRatio = verifiedCount / enriched.length;
    let confidence = 0.7 + (verifiedRatio * 0.2);
    if (avgConfidence > 0.7) confidence += 0.1;
    confidence = Math.min(confidence, 0.98);

    // --- FIX: Only check confidence, NOT verifiedCount ---
    // Even if no prospects are "verified", we still have enriched data to return
    const needsClarification = confidence < CONFIDENCE_THRESHOLD_CLARIFY;

    const result = {
        intent: 'lead_enrichment',
        confidence: Math.round(confidence * 100) / 100,
        needs_clarification: needsClarification,
        clarification_question: needsClarification 
            ? 'I enriched the prospects but many records are incomplete. Could you provide more specific details about your ideal customer profile?'
            : null,
        // --- FIX: Always send to qualification if we have enriched prospects ---
        next_pipeline: enriched.length > 0 ? 'lead_qualification' : null,
        entities: intent?.entities || {
            industry: intent?.industry || null,
            location: intent?.location || null,
            role: intent?.role || null,
            company: intent?.company || null,
            lead_count: enriched.length,
            email: null,
            domain: null,
            source_type: 'web_search'
        },
        risk_level: verifiedCount / enriched.length < 0.5 ? 'medium' : 'low',
        policy_flags: verifiedCount / enriched.length < 0.3 ? ['low_verification_rate'] : [],
        reason: `Enriched ${enriched.length} prospects. ${verifiedCount} verified, ${enrichedCount} partially verified. Found ${emailsFound} emails, inferred ${emailsInferred}.`,
        enriched_prospects: enriched.map(p => ({
            name: p.name || null,
            company: p.company || null,
            domain: p.domain || null,
            website: p.website || null,
            location: p.location || null,
            role: p.role || null,
            industry: p.industry || null,
            linkedin_url: p.linkedin_url || null,
            email: p.email || null,
            emailCandidate: p.emailCandidate || null,
            emailConfidence: p.emailConfidence || 'unknown',
            emailLabel: p.emailLabel || null,
            verificationStatus: p.verificationStatus || 'unverified',
            confidence: p.confidence || 0.5,
            mxValid: p.mxValid || false,
            smtpResult: p.smtpResult || 'unknown',
            notes: p.notes || null,
            email_candidates: p.email_candidates || [],
        })),
        stats: {
            checked: prospects.length,
            enriched: enrichedCount,
            emails_found: emailsFound,
            emails_inferred: emailsInferred,
            verified: verifiedCount,
            returned: enriched.length,
        }
    };

    console.log(`📤 [AGENT3] Returning ${result.enriched_prospects.length} enriched prospects`);
    result.enriched_prospects.forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.company || 'Unknown'} → email: ${p.email || 'null'} (${p.emailConfidence})`);
    });

    console.log(`✅ [AGENT3] Enrichment complete: ${verifiedCount} verified, ${enrichedCount} enriched`);
    console.log(`📧 [AGENT3] Emails: ${emailsFound} found, ${emailsInferred} inferred`);
    return result;
}

// ────────────────────────────────────────────────────────────────
// 11. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
    enrichProspects,
    enrichSingleProspect,
    buildEnrichmentQueries,
    searchTavily,
    generateEmailPatterns,
    validateMX,
    extractEmailsWithRegex,
    CONFIDENCE_THRESHOLD_ROUTE,
    CONFIDENCE_THRESHOLD_CLARIFY,
};
