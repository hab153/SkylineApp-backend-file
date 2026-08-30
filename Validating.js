// ──────────────────────────────────────────────────────────────
// VALIDATING.JS — Layer 4: Validation & Lead Classification
//
// RESPONSIBILITIES:
// - Take raw candidates from Layer 3
// - Use AI to examine each candidate
// - Compare against user requirements
// - Classify as High / Medium / Low / Incomplete
// - Output structured leads with Email + Information + Evidence
// - NEVER search the web
// - NEVER use Tavily
// ──────────────────────────────────────────────────────────────

const OpenAI = require('openai');

// ──────────────────────────────────────────────────────────────
// 1. CONFIGURATION
// ──────────────────────────────────────────────────────────────

const CONFIG = {
    AI_MODEL: 'gpt-4o-mini',
    AI_TEMPERATURE: 0.3,
    AI_MAX_TOKENS: 2000,
    AI_BATCH_SIZE: 10,
};

// ──────────────────────────────────────────────────────────────
// 2. MAIN VALIDATION FUNCTION
// ──────────────────────────────────────────────────────────────

/**
 * Validate and classify raw candidates from Layer 3
 * @param {Object} searchResults - Raw output from Layer 3 (Searching.js)
 * @param {Object} plan - The search plan from Layer 2
 * @returns {Object} Validated and classified leads
 */
async function validate(searchResults, plan) {
    console.log('[VALIDATING] Starting Layer 4 validation...');

    try {
        // ── Check if we have candidates ──
        const candidates = searchResults?.candidates || [];
        if (candidates.length === 0) {
            return {
                status: 'completed',
                message: 'No candidates to validate',
                high: [],
                medium: [],
                low: [],
                incomplete: [],
                statistics: {
                    total: 0,
                    high: 0,
                    medium: 0,
                    low: 0,
                    incomplete: 0,
                },
            };
        }

        // ── Extract requirements from plan ──
        const requirements = extractRequirements(plan);
        console.log('[VALIDATING] Requirements:', JSON.stringify(requirements, null, 2));

        // ── Check if OpenAI is configured ──
        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });

        // ── Process candidates in batches ──
        const allResults = [];
        for (let i = 0; i < candidates.length; i += CONFIG.AI_BATCH_SIZE) {
            const batch = candidates.slice(i, i + CONFIG.AI_BATCH_SIZE);
            const batchResults = await processBatch(batch, requirements, openai);
            allResults.push(...batchResults);
        }

        // ── Separate into categories ──
        const classified = {
            high: [],
            medium: [],
            low: [],
            incomplete: [],
        };

        for (const result of allResults) {
            if (result.rank === 'high') classified.high.push(result);
            else if (result.rank === 'medium') classified.medium.push(result);
            else if (result.rank === 'low') classified.low.push(result);
            else classified.incomplete.push(result);
        }

        // ── Build response ──
        return {
            status: 'completed',
            high: classified.high,
            medium: classified.medium,
            low: classified.low,
            incomplete: classified.incomplete,
            statistics: {
                total: allResults.length,
                high: classified.high.length,
                medium: classified.medium.length,
                low: classified.low.length,
                incomplete: classified.incomplete.length,
            },
        };

    } catch (error) {
        console.error('[VALIDATING] Error:', error.message);
        return {
            status: 'failed',
            error: { code: 'VALIDATION_ERROR', message: error.message },
            high: [],
            medium: [],
            low: [],
            incomplete: [],
            statistics: {
                total: 0,
                high: 0,
                medium: 0,
                low: 0,
                incomplete: 0,
            },
        };
    }
}

// ──────────────────────────────────────────────────────────────
// 3. EXTRACT REQUIREMENTS FROM PLAN
// ──────────────────────────────────────────────────────────────

function extractRequirements(plan) {
    const objective = plan?.objective || {};
    const requirements = plan?.requirements || {};

    return {
        role: objective.role || null,
        industries: objective.industries || [],
        location: {
            city: objective.location?.city || null,
            country: objective.location?.country || null,
            countryCode: objective.location?.countryCode || null,
        },
        companySize: objective.companySize?.value || null,
        companySizeRestricted: objective.companySize?.restricted || false,
        hardRequirements: requirements.hard || [],
        softRequirements: requirements.soft || [],
        targetType: objective.targetType || 'contact',
    };
}

// ──────────────────────────────────────────────────────────────
// 4. PROCESS A BATCH OF CANDIDATES
// ──────────────────────────────────────────────────────────────

async function processBatch(candidates, requirements, openai) {
    const prompt = buildValidationPrompt(candidates, requirements);

    try {
        const response = await openai.chat.completions.create({
            model: CONFIG.AI_MODEL,
            temperature: CONFIG.AI_TEMPERATURE,
            max_tokens: CONFIG.AI_MAX_TOKENS,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: `You are Skyline AA-1 Layer 4 Validation Assistant.

Your job is to examine raw candidate data and classify each candidate into one of four categories:

1. HIGH — Strongest leads with complete information.
   Must have: Email + Information (useful context) + Evidence (source proof).

2. MEDIUM — Good leads with useful supporting data but not as complete as High.
   Must have: Email + Information + Evidence.

3. LOW — Weaker leads where information is limited.
   Must have: Email + Information + Evidence.

4. INCOMPLETE — Cannot produce enough useful information to classify properly.
   Include: Available data + clearly state what is missing.

RULES:
- NEVER search the web or use external knowledge.
- Use ONLY what is provided in the candidate data.
- Compare against the user's requirements.
- Email is required for High/Medium/Low. If no email, classify as Incomplete.
- Provide clear reasoning for each classification.

Required output format:
{
  "results": [
    {
      "candidateId": "...",
      "rank": "high|medium|low|incomplete",
      "email": "email or null",
      "information": "Why this lead matches the request and useful context",
      "evidence": "Source evidence supporting this lead",
      "reasoning": "Why this classification was chosen"
    }
  ]
}`
                },
                {
                    role: 'user',
                    content: prompt,
                }
            ],
        });

        const content = response.choices[0].message.content;
        const parsed = JSON.parse(content || '{"results": []}');
        return parsed.results || [];

    } catch (error) {
        console.error('[VALIDATING] Batch processing error:', error.message);
        // Return incomplete for all candidates in the batch
        return candidates.map((c) => ({
            candidateId: c.candidateId || 'unknown',
            rank: 'incomplete',
            email: null,
            information: 'Processing failed',
            evidence: 'Unable to validate',
            reasoning: `AI processing error: ${error.message}`,
        }));
    }
}

// ──────────────────────────────────────────────────────────────
// 5. BUILD VALIDATION PROMPT
// ──────────────────────────────────────────────────────────────

function buildValidationPrompt(candidates, requirements) {
    const candidatesText = candidates.map((c, index) => {
        return `
Candidate ${index + 1}:
candidateId: ${c.candidateId || 'unknown'}
Company: ${c.company?.name || 'Unknown'}
Company Industry: ${c.company?.industry || 'Unknown'}
Company Location: ${JSON.stringify(c.company?.location || {})}
Contact Person: ${c.contact?.name || 'Unknown'}
Contact Role: ${c.contact?.role || 'Unknown'}
Email: ${c.contact?.email || 'Not found'}
LinkedIn: ${c.contact?.linkedinUrl || 'Not found'}
Discovery Source: ${c.discovery?.sourceUrl || 'Unknown'}
Evidence: ${JSON.stringify(c.evidence || [])}
Discovery Confidence: ${c.discoveryConfidence || 0}
---`;
    }).join('\n');

    return `
You are classifying raw lead candidates based on the user's requirements.

USER REQUIREMENTS:
- Target Type: ${requirements.targetType || 'contact'}
- Role: ${requirements.role || 'Any'}
- Industries: ${requirements.industries.join(', ') || 'Any'}
- Location: ${requirements.location.city || 'Any'}${requirements.location.country ? `, ${requirements.location.country}` : ''}
- Company Size: ${requirements.companySize || 'Any'} ${requirements.companySizeRestricted ? '(hard requirement)' : '(preference)'}
- Hard Requirements: ${requirements.hardRequirements.join(', ') || 'None'}
- Soft Requirements: ${requirements.softRequirements.join(', ') || 'None'}

RAW CANDIDATES:
${candidatesText}

Classify each candidate. For each, output:
- rank: high, medium, low, or incomplete
- email: the email address found, or null
- information: why this lead matches the user's requirements, and useful context
- evidence: the source evidence supporting this lead
- reasoning: why you chose this classification

REMEMBER:
- High/Medium/Low require an email address. No email = Incomplete.
- Incomplete means you cannot produce enough useful information to classify properly.
- Be honest about missing information.`
}

// ──────────────────────────────────────────────────────────────
// 6. CONVENIENCE FUNCTION
// ──────────────────────────────────────────────────────────────

async function validate(searchResults, plan) {
    // Re-export the main function for cleaner imports
    return validate(searchResults, plan);
}

// ──────────────────────────────────────────────────────────────
// 7. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    validate,
    extractRequirements,
    processBatch,
    buildValidationPrompt,
    CONFIG,
};
