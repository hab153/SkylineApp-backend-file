'use strict';

const OpenAI = require('openai');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';
const MAX_ATTEMPTS = 2;

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given two completed outputs:

1. The Understanding output — what the user wants.
2. The Planning output — how the search should be approached.

Your only task is to combine them into one structured Discovery Context.

The Discovery Context is the official working folder for one discovery job.
It is the source of truth that the rest of the Discovery system will read
from. It tells Discovery what it is trying to discover, what qualifies, what
must be excluded, what evidence matters, and what search plan and limits it
must follow.

You organize the information. You do not decide it.

You must not:

- invent information that is not present in the Understanding or Planning output
- guess missing information
- change the location
- change the qualification
- change the quantity
- remove or weaken exclusions
- weaken constraints
- create new queries
- create new evidence searches
- search the internet
- verify any company
- reinterpret the user's requirements

You may only take the values that are already present in the Understanding
and Planning outputs and place them into the corresponding fields of the
Discovery Context.

Use exactly these field names in the Discovery Context.

From the Understanding output:

- understanding.targetEntity  → discoveryContext.target
- understanding.problem       → discoveryContext.need
- understanding.intent        → discoveryContext.intent
- understanding.location      → discoveryContext.location
- understanding.industry      → discoveryContext.industry
- understanding.qualification → discoveryContext.qualification
- understanding.signal        → discoveryContext.signal
- understanding.quantity      → discoveryContext.quantity
- understanding.information   → discoveryContext.requiredInformation
- understanding.exclusions    → discoveryContext.exclusions
- understanding.constraints   → discoveryContext.constraints

From the Planning output:

- planning.strategy       → discoveryContext.strategy
- planning.source         → discoveryContext.source
- planning.query          → discoveryContext.query
- planning.evidenceSearch → discoveryContext.evidenceSearch
- planning.allocation     → discoveryContext.allocation
- planning.searchExpansion → discoveryContext.searchExpansion

Preserve the values exactly as they appear in the source fields.

Do not transform any value. Do not flatten objects. Do not convert strings
to numbers. Do not split strings into arrays. Do not merge or split fields.

If a field is missing in the source, leave it missing or empty. Do not invent
a value.

Return only valid JSON using exactly this format:

{
  "target": "the target entity",
  "need": "the problem or need",
  "intent": "the intent",
  "location": {
    "city": "the city",
    "country": "the country"
  },
  "industry": "the industry",
  "qualification": "the qualification",
  "signal": "the signal",
  "quantity": "the quantity",
  "requiredInformation": ["the required information fields"],
  "exclusions": "the exclusions",
  "constraints": "the constraints",
  "strategy": "the strategy",
  "source": "the source",
  "query": ["the search queries"],
  "evidenceSearch": ["the evidence searches"],
  "allocation": {
    "totalSearches": 0,
    "distribution": {}
  },
  "searchExpansion": "the search expansion plan"
}

Do not explain your answer.
Do not add extra fields.
Do not remove any fields.
Do not invent unnecessary details.
`;

// ────────────────────────────────────────────────────────────────
// FALLBACK CONTEXT BUILDER
// ────────────────────────────────────────────────────────────────

// Builds the Discovery Context by copying trusted values from the
// Understanding and Planning outputs into the Discovery Context structure.
// The fallback does not understand, guess, transform, or invent anything.
// It only maps each source field to its corresponding context field.

function buildFallbackContext(understanding, planning) {
    const u = understanding ?? {};
    const p = planning ?? {};

    return {
        target: u.targetEntity,
        need: u.problem,
        intent: u.intent,
        location: u.location,
        industry: u.industry,
        qualification: u.qualification,
        signal: u.signal,
        quantity: u.quantity,
        requiredInformation: u.information,
        exclusions: u.exclusions,
        constraints: u.constraints,
        strategy: p.strategy,
        source: p.source,
        query: p.query,
        evidenceSearch: p.evidenceSearch,
        allocation: p.allocation,
        searchExpansion: p.searchExpansion,
    };
}

// ────────────────────────────────────────────────────────────────
// CONTEXT VALIDATION
// ────────────────────────────────────────────────────────────────

// Structural validation only. The validator never invents or fixes values.
// It only confirms that the context is a usable structure. If the structure
// is not usable, the caller falls through to the fallback builder.

function isValidContext(context) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
        return false;
    }

    const requiredStringFields = [
        'target',
        'need',
        'intent',
        'industry',
        'qualification',
        'signal',
        'quantity',
        'exclusions',
        'constraints',
        'strategy',
        'source',
        'searchExpansion',
    ];

    for (const field of requiredStringFields) {
        if (
            typeof context[field] !== 'string' ||
            context[field].trim().length === 0
        ) {
            return false;
        }
    }

    if (
        !context.location ||
        typeof context.location !== 'object' ||
        Array.isArray(context.location) ||
        typeof context.location.city !== 'string' ||
        context.location.city.trim().length === 0 ||
        typeof context.location.country !== 'string' ||
        context.location.country.trim().length === 0
    ) {
        return false;
    }

    if (
        !Array.isArray(context.requiredInformation) ||
        context.requiredInformation.length === 0
    ) {
        return false;
    }

    if (
        !Array.isArray(context.query) ||
        context.query.length === 0
    ) {
        return false;
    }

    if (!Array.isArray(context.evidenceSearch)) {
        return false;
    }

    if (
        !context.allocation ||
        typeof context.allocation !== 'object' ||
        Array.isArray(context.allocation)
    ) {
        return false;
    }

    return true;
}

// ────────────────────────────────────────────────────────────────
// DISCOVERY CONTEXT
// ────────────────────────────────────────────────────────────────

async function discoverySearch(understanding, planning) {
    console.log('[DiscoverySearch] Started');
    console.log(
        '[DiscoverySearch] Received understanding:',
        understanding
    );
    console.log('[DiscoverySearch] Received planning:', planning);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(
            `[DiscoverySearch] Attempt ${attempt}/${MAX_ATTEMPTS}`
        );

        try {
            const completion = await openai.chat.completions.create({
                model: MODEL,
                temperature: 0,
                response_format: {
                    type: 'json_object',
                },
                messages: [
                    {
                        role: 'system',
                        content: SYSTEM_INSTRUCTIONS,
                    },
                    {
                        role: 'user',
                        content: `Understanding output:\n${JSON.stringify(
                            understanding,
                            null,
                            2
                        )}\n\nPlanning output:\n${JSON.stringify(
                            planning,
                            null,
                            2
                        )}`,
                    },
                ],
            });

            console.log(
                '[DiscoverySearch] OpenAI response received'
            );

            const content = completion.choices?.[0]?.message?.content;

            console.log(
                '[DiscoverySearch] Raw model response:',
                content
            );

            if (!content) {
                console.error(
                    '[DiscoverySearch] Model returned an empty response'
                );
                continue;
            }

            const parsedResult = JSON.parse(content);

            console.log(
                '[DiscoverySearch] Parsed model response:',
                parsedResult
            );

            if (isValidContext(parsedResult)) {
                console.log(
                    '[DiscoverySearch] Valid context from AI'
                );

                return parsedResult;
            }

            console.warn(
                '[DiscoverySearch] AI context failed validation'
            );
        } catch (error) {
            console.error(
                `[DiscoverySearch] Attempt ${attempt} failed`
            );

            console.error(
                '[DiscoverySearch] Error name:',
                error.name
            );
            console.error(
                '[DiscoverySearch] Error message:',
                error.message
            );
            console.error(
                '[DiscoverySearch] Error status:',
                error.status
            );
            console.error('[DiscoverySearch] Full error:', error);
        }
    }

    const fallbackResult = buildFallbackContext(
        understanding,
        planning
    );

    console.warn(
        '[DiscoverySearch] All attempts failed. Using fallback:',
        fallbackResult
    );

    if (!isValidContext(fallbackResult)) {
        console.error(
            '[DiscoverySearch] Fallback context failed validation'
        );
    }

    return fallbackResult;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = discoverySearch;
