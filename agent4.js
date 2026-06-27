'use strict';

/**
 * agent4.js – Qualification / Personalization Agent
 * 
 * The fourth layer in the B2B lead-generation system.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Read Agent 3 output carefully.
 * 2. Evaluate each prospect against ICP, role, location, industry, and available public signals.
 * 3. Determine qualification status: qualified, unqualified, or review.
 * 4. Assign fit score and priority.
 * 5. Choose the best outreach/personalization angle for qualified leads.
 * 6. Return clean structured JSON only.
 * 
 * YOU MUST NOT:
 * - Send outreach.
 * - Write full emails unless the output schema explicitly asks for an angle only.
 * - Invent facts that are not supported by the input or sources.
 * - Over-search when the input is already strong.
 * - Return a paragraph.
 */

const axios = require('axios');

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const MODEL = 'gpt-4o-mini';
const MAX_OUTPUT_TOKENS = 900;
const MAX_SEARCH_RESULTS = 5;
const MAX_QUERIES = 2;
const CONFIDENCE_THRESHOLD_ROUTE = 0.90;
const CONFIDENCE_THRESHOLD_CLARIFY = 0.50;

// ────────────────────────────────────────────────────────────────
// 2. The Agent 4 System Prompt (locked, production-grade)
// ────────────────────────────────────────────────────────────────

const AGENT4_SYSTEM_PROMPT = `You are Agent 4, the Qualification / Personalization layer in a B2B lead-generation system.

Your job is to take enriched prospect records from Agent 3 and decide which ones are worth pursuing now. You must score fit, prioritize leads, determine the best personalization angle, and return a structured JSON object for the next step.

PRIMARY RESPONSIBILITIES
1. Read Agent 3 output carefully.
2. Evaluate each prospect against ICP, role, location, industry, and available public signals.
3. Determine qualification status: qualified, unqualified, or review.
4. Assign fit score and priority.
5. Choose the best outreach/personalization angle for qualified leads.
6. Return clean structured JSON only.

YOU MUST NOT
- Send outreach.
- Write full emails unless the output schema explicitly asks for an angle only.
- Invent facts that are not supported by the input or sources.
- Over-search when the input is already strong.
- Return a paragraph.

QUALIFICATION RULES
- Use explicit ICP fit first.
- Favor prospects with clear public identity and business relevance.
- Penalize incomplete, conflicting, or weak records.
- If a lead is not strong enough, mark it unqualified or review.
- If a lead is qualified, set next_pipeline to outreach_drafting.

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
  "qualified_prospects": [
    {
      "name": string|null,
      "company": string|null,
      "domain": string|null,
      "website": string|null,
      "location": string|null,
      "role": string|null,
      "fit_score": number|null,
      "priority": "high" | "medium" | "low",
      "qualification_status": "qualified" | "unqualified" | "review",
      "personalization_angle": string|null,
      "notes": string|null,
      "email_candidates": string[],
      "email": string|null
    }
  ],
  "stats": {
    "reviewed": number,
    "qualified": number,
    "rejected": number,
    "returned": number
  }
}

CONFIDENCE GUIDELINES
- 0.90 to 1.00 = very clear, strong fit.
- 0.70 to 0.89 = mostly clear.
- 0.50 to 0.69 = mixed, needs caution.
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
// 5. Build Qualification Queries for a Prospect
// ────────────────────────────────────────────────────────────────

function buildQualificationQueries(prospect) {
    const queries = [];
    const company = prospect.company || prospect.name || '';
    const domain = prospect.domain || '';

    // Only search if the prospect is uncertain or missing key signals
    const needsRecentNews = !prospect.notes || prospect.notes.includes('No recent');
    const needsFundingSignal = prospect.confidence < 0.7;

    if (needsRecentNews && company) {
        queries.push(`"${company}" news funding expansion`);
    }

    if (needsFundingSignal && company) {
        queries.push(`"${company}" funding round investment`);
    }

    // If we have domain, check for recent activity
    if (domain && (needsRecentNews || needsFundingSignal)) {
        queries.push(`site:${domain} news funding`);
    }

    return queries.slice(0, MAX_QUERIES);
}

// ────────────────────────────────────────────────────────────────
// 6. Search for Additional Qualification Signals
// ────────────────────────────────────────────────────────────────

async function searchQualificationSignals(prospect, tavilyKey) {
    const queries = buildQualificationQueries(prospect);
    if (queries.length === 0) {
        return { signals: [], searched: 0 };
    }

    let allResults = [];
    for (const query of queries) {
        const results = await searchTavily(query, tavilyKey, 3);
        if (results && results.length > 0) {
            allResults = allResults.concat(results);
        }
    }

    return { signals: allResults, searched: queries.length };
}

// ────────────────────────────────────────────────────────────────
// 7. FIX: Safe JSON Parsing with Auto-Fix
// ────────────────────────────────────────────────────────────────

function safeJsonParse(jsonString) {
    // Try normal parse first
    try {
        return { success: true, data: JSON.parse(jsonString) };
    } catch (error) {
        console.warn(`⚠️ [JSON] Parse error: ${error.message}`);
        console.warn(`⚠️ [JSON] Attempting to auto-fix...`);
        
        let fixed = jsonString;
        
        // Fix 1: Incomplete numbers (0. → 0.0, 1. → 1.0)
        fixed = fixed.replace(/(\d+)\.\s*([,\}\]])/g, '$1.0$2');
        fixed = fixed.replace(/(\d+)\.\s*$/g, '$1.0');
        fixed = fixed.replace(/(\d+)\.\s*\n/g, '$1.0\n');
        
        // Fix 2: Trailing commas before } or ]
        fixed = fixed.replace(/,\s*}/g, '}');
        fixed = fixed.replace(/,\s*\]/g, ']');
        
        // Fix 3: Unterminated strings - find strings that don't have closing quotes
        // Look for a quote that starts a string but doesn't have a closing quote before } or ]
        const lines = fixed.split('\n');
        let fixedLines = [];
        let inString = false;
        let stringStartLine = -1;
        
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            
            // Count quotes in this line (ignoring escaped quotes)
            const quotes = (line.match(/"/g) || []).length;
            const escapedQuotes = (line.match(/\\"/g) || []).length;
            const effectiveQuotes = quotes - escapedQuotes;
            
            if (inString) {
                // We're inside a string - check if this line closes it
                if (effectiveQuotes % 2 === 1) {
                    // Odd quotes means the string closes in this line
                    inString = false;
                    fixedLines.push(line);
                } else {
                    // String continues - add line as-is
                    fixedLines.push(line);
                }
            } else {
                // We're not in a string - check if this line starts one
                if (effectiveQuotes % 2 === 1) {
                    // Odd quotes means a string starts and ends in this line? Or just starts?
                    // Check if the line ends with a quote that would close it
                    const trimmedLine = line.trim();
                    if (trimmedLine.endsWith('"') || trimmedLine.endsWith('",') || trimmedLine.endsWith('":')) {
                        // Likely the string is closed in this line
                        fixedLines.push(line);
                    } else {
                        // String starts in this line but doesn't close
                        inString = true;
                        stringStartLine = i;
                        // Add a closing quote at the end of the line
                        if (!line.endsWith('"') && !line.endsWith('",') && !line.endsWith('":')) {
                            line = line + '"';
                        }
                        fixedLines.push(line);
                    }
                } else {
                    fixedLines.push(line);
                }
            }
        }
        
        // If we finished the file and we're still in a string, add a closing quote
        if (inString) {
            fixedLines[fixedLines.length - 1] = fixedLines[fixedLines.length - 1] + '"';
            console.log(`🔧 [JSON] Added closing quote for unterminated string at line ${stringStartLine + 1}`);
        }
        
        fixed = fixedLines.join('\n');
        
        // Fix 4: Missing closing brackets (add if unbalanced)
        const openBraces = (fixed.match(/\{/g) || []).length;
        const closeBraces = (fixed.match(/\}/g) || []).length;
        const openBrackets = (fixed.match(/\[/g) || []).length;
        const closeBrackets = (fixed.match(/\]/g) || []).length;
        
        if (openBraces > closeBraces) {
            fixed += '}'.repeat(openBraces - closeBraces);
        }
        if (openBrackets > closeBrackets) {
            fixed += ']'.repeat(openBrackets - closeBrackets);
        }
        
        // Fix 5: Remove anything after the last complete JSON structure
        const lastBrace = fixed.lastIndexOf('}');
        const lastBracket = fixed.lastIndexOf(']');
        const lastEnd = Math.max(lastBrace, lastBracket);
        if (lastEnd > 0 && lastEnd < fixed.length - 1) {
            const trailing = fixed.substring(lastEnd + 1).trim();
            if (trailing && !trailing.startsWith(',') && !trailing.startsWith(']') && !trailing.startsWith('}')) {
                fixed = fixed.substring(0, lastEnd + 1);
            }
        }
        
        try {
            const data = JSON.parse(fixed);
            console.log(`✅ [JSON] Auto-fix successful`);
            return { success: true, data };
        } catch (retryError) {
            console.error(`❌ [JSON] Auto-fix failed: ${retryError.message}`);
            return { success: false, error: retryError };
        }
    }
}

// ────────────────────────────────────────────────────────────────
// 8. FIX: Main Agent 4 Function with Retry & Safe Parsing
// ────────────────────────────────────────────────────────────────

async function qualifyProspects({ enriched_prospects, intent, apiKey, tavilyKey, userId = 'anonymous', onProgress = null }) {
    console.log(`🏆 [AGENT4] Starting qualification for user ${userId}...`);
    onProgress?.('🏆 Evaluating and prioritizing leads...');

    // Validate input
    if (!enriched_prospects || enriched_prospects.length === 0) {
        return {
            intent: 'lead_qualification',
            confidence: 0.0,
            needs_clarification: true,
            clarification_question: 'No prospects were provided to qualify. Please run enrichment first.',
            next_pipeline: null,
            entities: intent?.entities || {},
            risk_level: 'low',
            policy_flags: ['no_prospects'],
            reason: 'No prospects provided to Agent 4.',
            qualified_prospects: [],
            stats: { reviewed: 0, qualified: 0, rejected: 0, returned: 0 }
        };
    }

    // ─── LOG: What Agent 4 received ───
    console.log(`📥 [AGENT4] RECEIVED ${enriched_prospects.length} prospects from Agent 3`);
    enriched_prospects.forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.company || 'Unknown'} → email_candidates: ${JSON.stringify(p.email_candidates || [])}, email: ${p.email || 'null'}`);
    });

    // ─── Step 1: Gather qualification signals for each prospect ───
    const prospectsWithSignals = [];
    for (const prospect of enriched_prospects) {
        let signals = [];
        let searched = 0;

        // Only search if the prospect needs it (low confidence or missing signals)
        if (prospect.confidence < 0.7) {
            const result = await searchQualificationSignals(prospect, tavilyKey);
            signals = result.signals;
            searched = result.searched;
        }

        prospectsWithSignals.push({
            prospect,
            signals,
            searched,
        });
    }

    // ─── Step 2: Build input for GPT qualification ───
    const prospectsForGPT = prospectsWithSignals.map(({ prospect, signals }) => {
        const signalText = signals.length > 0 
            ? signals.map(s => `- ${s.title}: ${s.snippet}`).join('\n')
            : 'No additional signals found.';

        return {
            prospect: {
                name: prospect.name || 'Unknown',
                company: prospect.company || 'Unknown',
                domain: prospect.domain || 'Unknown',
                website: prospect.website || null,
                location: prospect.location || 'Unknown',
                role: prospect.role || 'Unknown',
                industry: prospect.industry || 'Unknown',
                confidence: prospect.confidence || 0.5,
                verification_status: prospect.verification_status || 'unverified',
                notes: prospect.notes || 'No notes.',
                linkedin_url: prospect.linkedin_url || null,
                // --- PRESERVE EMAIL FROM AGENT 3 ---
                email_candidates: prospect.email_candidates || [],
                email: prospect.email || null,
            },
            signals: signalText,
        };
    });

    const qualificationPrompt = `
You are a lead qualification specialist. Evaluate each prospect and decide if they are worth pursuing.

USER'S INTENT:
- Industry: ${intent?.industry || 'Any'}
- Location: ${intent?.location || 'Any'}
- Role: ${intent?.role || 'Any'}
- Target: ${intent?.target || 'Any'}

PROSPECTS TO EVALUATE:
${prospectsForGPT.map((p, i) => `
PROSPECT ${i + 1}:
- Name: ${p.prospect.name}
- Company: ${p.prospect.company}
- Domain: ${p.prospect.domain}
- Location: ${p.prospect.location}
- Role: ${p.prospect.role}
- Industry: ${p.prospect.industry}
- Confidence: ${p.prospect.confidence}
- Verification Status: ${p.prospect.verification_status}
- Notes: ${p.prospect.notes}
- LinkedIn: ${p.prospect.linkedin_url || 'Not found'}
- Email Candidates: ${JSON.stringify(p.prospect.email_candidates || [])}
- Email: ${p.prospect.email || 'null'}
- Additional Signals:
${p.signals}
`).join('\n---\n')}

QUALIFICATION RULES:
1. A prospect is QUALIFIED if:
   - Industry matches the user's intent OR is clearly related
   - Location matches OR is reasonably close
   - Role is relevant (founder, CEO, director, owner, VP, head of)
   - Verification status is "verified" OR "partial" with good signals
   - Confidence is at least 0.6

2. A prospect is UNQUALIFIED if:
   - Industry is completely wrong
   - Role is irrelevant
   - Verification status is "unverified" with no supporting signals
   - Confidence is below 0.4

3. A prospect is REVIEW if:
   - Some things match but key signals are missing
   - Confidence is between 0.4 and 0.6
   - Industry or location is ambiguous

4. Priority levels:
   - HIGH: Perfect match on all key criteria + verified + high confidence
   - MEDIUM: Good match but some gaps
   - LOW: Weak match or unclear fit

5. Personalization angle:
   - Choose ONE specific angle for outreach based on the prospect's business
   - Examples: growth, operational efficiency, customer acquisition, market expansion, innovation, etc.
   - Must be specific to their industry and role

Return ONLY valid JSON with this schema:
{
  "qualified_prospects": [
    {
      "name": string|null,
      "company": string|null,
      "domain": string|null,
      "website": string|null,
      "location": string|null,
      "role": string|null,
      "fit_score": number (0-1),
      "priority": "high" | "medium" | "low",
      "qualification_status": "qualified" | "unqualified" | "review",
      "personalization_angle": string|null,
      "notes": string|null,
      "email_candidates": string[],
      "email": string|null
    }
  ],
  "stats": {
    "reviewed": number,
    "qualified": number,
    "rejected": number,
    "returned": number
  },
  "reason": string,
  "confidence": number,
  "needs_clarification": boolean
}
`;

    // ─── Step 3: Try qualification with retries and safe parsing ───
    let lastError = null;
    
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            console.log(`🏆 [AGENT4] Qualification attempt ${attempt}/3...`);
            
            const response = await withRetry(() => axios.post(
                'https://api.openai.com/v1/chat/completions',
                {
                    model: MODEL,
                    messages: [
                        { role: 'system', content: AGENT4_SYSTEM_PROMPT },
                        { role: 'user', content: qualificationPrompt }
                    ],
                    max_tokens: MAX_OUTPUT_TOKENS,
                    temperature: 0.0,
                    response_format: { type: 'json_object' }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 20000
                }
            ), 'GPT:qualifyProspects');

            if (!response) {
                console.warn(`⚠️ [AGENT4] Qualification attempt ${attempt} returned null`);
                if (attempt === 3) break;
                continue;
            }

            const rawContent = response.data.choices[0].message.content.trim();
            
            // ─── SAFE JSON PARSE with auto-fix ───
            const parseResult = safeJsonParse(rawContent);
            
            if (!parseResult.success) {
                console.warn(`⚠️ [AGENT4] JSON parse failed on attempt ${attempt}`);
                if (attempt === 3) break;
                continue;
            }

            const parsed = parseResult.data;

            // ─── Step 4: Extract and validate the result ───
            const qualifiedProspects = parsed.qualified_prospects || [];
            const stats = parsed.stats || {
                reviewed: enriched_prospects.length,
                qualified: 0,
                rejected: 0,
                returned: 0
            };

            // Calculate confidence
            const totalQualified = qualifiedProspects.filter(p => p.qualification_status === 'qualified').length;
            const confidence = parsed.confidence || (totalQualified / enriched_prospects.length);
            const needsClarification = parsed.needs_clarification || confidence < CONFIDENCE_THRESHOLD_CLARIFY;

            // --- FIX: Ensure we preserve email_candidates and email from the original prospects ---
            const result = {
                intent: 'lead_qualification',
                confidence: Math.round(confidence * 100) / 100,
                needs_clarification: needsClarification,
                clarification_question: needsClarification 
                    ? 'I found some leads but the qualification is uncertain. Could you confirm your ICP or provide more specific criteria?'
                    : null,
                next_pipeline: totalQualified > 0 ? 'outreach_drafting' : null,
                entities: intent?.entities || {
                    industry: intent?.industry || null,
                    location: intent?.location || null,
                    role: intent?.role || null,
                    company: intent?.company || null,
                    lead_count: totalQualified,
                    email: null,
                    domain: null,
                    source_type: 'web_search'
                },
                risk_level: totalQualified / enriched_prospects.length < 0.3 ? 'medium' : 'low',
                policy_flags: totalQualified === 0 ? ['no_qualified_leads'] : [],
                reason: parsed.reason || `Qualified ${totalQualified} out of ${enriched_prospects.length} prospects.`,
                qualified_prospects: qualifiedProspects.map((p, index) => {
                    // Find the original prospect to preserve email data
                    const originalProspect = enriched_prospects[index] || {};
                    return {
                        name: p.name || null,
                        company: p.company || null,
                        domain: p.domain || null,
                        website: p.website || null,
                        location: p.location || null,
                        role: p.role || null,
                        fit_score: p.fit_score || 0.5,
                        priority: p.priority || 'medium',
                        qualification_status: p.qualification_status || 'review',
                        personalization_angle: p.personalization_angle || null,
                        notes: p.notes || null,
                        // --- CRITICAL FIX: Preserve email from original prospect ---
                        email_candidates: originalProspect.email_candidates || p.email_candidates || [],
                        email: originalProspect.email || p.email || null,
                    };
                }),
                stats: {
                    reviewed: stats.reviewed || enriched_prospects.length,
                    qualified: stats.qualified || totalQualified,
                    rejected: stats.rejected || 0,
                    returned: stats.returned || qualifiedProspects.length,
                }
            };

            // --- LOG: What Agent 4 is returning ---
            console.log(`📤 [AGENT4] Returning ${result.qualified_prospects.length} qualified prospects`);
            result.qualified_prospects.forEach((p, i) => {
                console.log(`   ${i + 1}. ${p.company || 'Unknown'} → email_candidates: ${JSON.stringify(p.email_candidates || [])}, email: ${p.email || 'null'}`);
            });

            console.log(`✅ [AGENT4] Qualification complete: ${totalQualified} qualified, ${result.stats.rejected} rejected (attempt ${attempt})`);
            return result;

        } catch (error) {
            lastError = error;
            console.error(`❌ [AGENT4] Qualification attempt ${attempt} failed:`, error.message);
            if (attempt === 3) break;
        }
    }

    // ─── Step 5: All attempts failed – return a graceful error ───
    console.error(`❌ [AGENT4] All qualification attempts failed. Last error: ${lastError?.message || 'Unknown error'}`);
    
    return {
        intent: 'lead_qualification',
        confidence: 0.0,
        needs_clarification: true,
        clarification_question: 'Qualification failed. Please try again or provide more specific criteria.',
        next_pipeline: null,
        entities: intent?.entities || {},
        risk_level: 'medium',
        policy_flags: ['qualification_failure'],
        reason: `Qualification failed after 3 attempts: ${lastError?.message || 'Unknown error'}`,
        qualified_prospects: [],
        stats: { reviewed: enriched_prospects.length, qualified: 0, rejected: 0, returned: 0 }
    };
}

// ────────────────────────────────────────────────────────────────
// 9. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
    qualifyProspects,
    buildQualificationQueries,
    searchQualificationSignals,
    searchTavily,
    safeJsonParse,
    CONFIDENCE_THRESHOLD_ROUTE,
    CONFIDENCE_THRESHOLD_CLARIFY,
};
