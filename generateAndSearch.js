'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const OpenAI = require('openai');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';

// 4 attempts per AI call.
const MAX_ATTEMPTS = 4;

// Tavily configuration.
const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const TAVILY_PARAMS = {
    search_depth: 'basic',
    max_results: 20,
    topic: 'general',
    include_answer: false,
    include_raw_content: false,
    include_favicon: false,
};

// Default Understanding fallback — used only if all 4 AI attempts fail.
const FALLBACK_UNDERSTANDING = {
    targetEntity: 'company',
    problem: 'customer',
    intent: 'potential_customers',
    location: { city: 'New York City', country: 'USA' },
    industry: 'Software',
    qualification: '20 or more employees',
    signal: 'hiring employees',
    quantity: '5 companies',
    information: [
        'companyName',
        'companyEmail',
        'phoneNumber',
        'shortCompanyInformation',
    ],
    exclusions: 'freelancers',
    constraints: 'companies founded after 2020',
};

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS — UNDERSTANDING
// ────────────────────────────────────────────────────────────────

const UNDERSTANDING_INSTRUCTIONS = `
You are given a raw user request.

Your only task is to understand the complete meaning of the request
and extract the following fields.

1. targetEntity — the type of thing the user is looking for (company,
   school, restaurant, hotel, agency, hospital, software, product,
   person, location, or any other suitable entity).

2. problem — the main problem, need, service, product, industry, or
   area of interest connected to the target entity.

3. intent — the actual purpose behind the user's request. What is the
   user trying to accomplish with the search, and what relationship
   does the target entity have with the problem?

4. location — where the user wants the entities to be. Must contain
   exactly two fields: city and country.

5. industry — the business category of the entities.

6. qualification — the rule, requirement, condition, or criteria the
   entities must meet.

7. signal — the evidence that should be looked for to determine
   whether an entity really matches the problem. The signal is not the
   need itself.

8. quantity — how many leads or results the user wants.

9. information — the data fields to collect for each entity. Default:
   ["companyName", "companyEmail", "phoneNumber", "shortCompanyInformation"].

10. exclusions — what the user does NOT want included. Only set this
    when the user clearly states it.

11. constraints — special rules or limits that must be followed.
    Only set this when the user clearly states it.

Decide each field yourself from the complete meaning of the request.
Do not use keyword matching.
Do not follow predefined lists.
Do not invent information the user did not provide.

Location instructions:

If both city and country are clear → use them.
If only country is clear → choose a suitable city in that country.
If only city is clear → identify the country that contains that city.
If no location is clear → use:
{ "city": "New York City", "country": "USA" }

Return only valid JSON using exactly this format:

{
  "targetEntity": "the identified target or null",
  "problem": "the identified problem or need",
  "intent": "the actual purpose of the search",
  "location": {
    "city": "the identified city",
    "country": "the identified country"
  },
  "industry": "the identified industry",
  "qualification": "the identified qualification",
  "signal": "the identified signal",
  "quantity": "the identified quantity",
  "information": ["the identified information fields"],
  "exclusions": "the identified exclusions",
  "constraints": "the identified constraints"
}

If the target entity cannot be clearly identified, return null for
targetEntity. The other fields must still be filled where possible.

Do not explain your answer.
Do not add extra fields.
Do not remove any fields.
`;

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS — SEARCH GENERATION
// ────────────────────────────────────────────────────────────────

const SEARCH_GENERATION_INSTRUCTIONS = `
You are given the Understanding output for a user request.

Your only task is to generate EXACTLY 2 search phrases.

The 2 search phrases will be sent to a real search engine to find as
many matching companies as possible. Because only 2 searches are
available, each search must be very wide and high-yield.

A high-yield search hits pages where many companies are listed or
mentioned at once, such as:

- Business directories (e.g., "fintech companies London directory")
- Company databases (e.g., "site:crunchbase.com fintech companies London")
- Professional profiles (e.g., "fintech companies London linkedin")
- Broad discovery searches (e.g., "fintech companies London")
- Industry listings (e.g., "list of fintech companies London")
- News and reports that mention many companies

A search must be phrased so that a real web page could contain that
phrase. If no real page contains the phrase, the search will return
nothing useful.

Forbidden phrasing — never use these:

- requiring
- seeking
- employing
- needing
- that need
- that require
- with websites
- with a website
- organizations requiring
- firms seeking
- companies needing
- companies requiring
- looking for

Preferred phrasing — use these where they fit:

- directory
- list of
- linkedin
- crunchbase
- news
- companies in
- site:

The 2 searches must be different from each other. Each search must
open a different corner of the web.

Example:

If the request is for fintech companies in London, a suitable pair of
searches would be:

1. "site:crunchbase.com fintech companies London"
2. "fintech companies London directory"

Return only valid JSON using exactly this format:

{
  "searches": [
    "the first search phrase",
    "the second search phrase"
  ]
}

The searches array must contain exactly 2 non-empty strings.

Do not explain your answer.
Do not add extra fields.
Do not remove any fields.
`;

// ────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────

// Calls the AI with the given system prompt and user content.
// Retries up to MAX_ATTEMPTS times. Returns the parsed JSON object on
// success, or null on total failure.

async function callAI(systemInstructions, userContent, label) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(`[generateAndSearch] ${label} — attempt ${attempt}/${MAX_ATTEMPTS}`);

        try {
            const completion = await openai.chat.completions.create({
                model: MODEL,
                temperature: 0,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: systemInstructions },
                    { role: 'user', content: userContent },
                ],
            });

            const content = completion.choices?.[0]?.message?.content;

            console.log(`[generateAndSearch] ${label} — raw response:`, content);

            if (!content) {
                console.error(`[generateAndSearch] ${label} — empty response`);
                continue;
            }

            const parsed = JSON.parse(content);

            console.log(`[generateAndSearch] ${label} — parsed:`, parsed);

            return parsed;
        } catch (error) {
            console.error(`[generateAndSearch] ${label} — attempt ${attempt} failed:`, error.message);
        }
    }

    console.warn(`[generateAndSearch] ${label} — all attempts failed`);
    return null;
}

// Normalizes the AI understanding response. Returns a valid 11-field
// object, filling any missing fields from the fallback.

function normalizeUnderstanding(raw) {
    if (!raw || typeof raw !== 'object') {
        return { ...FALLBACK_UNDERSTANDING };
    }

    const hasTarget =
        typeof raw.targetEntity === 'string' && raw.targetEntity.trim().length > 0;

    if (!hasTarget) {
        return { ...FALLBACK_UNDERSTANDING };
    }

    const location =
        raw.location &&
        typeof raw.location === 'object' &&
        typeof raw.location.city === 'string' &&
        raw.location.city.trim().length > 0 &&
        typeof raw.location.country === 'string' &&
        raw.location.country.trim().length > 0
            ? { city: raw.location.city.trim(), country: raw.location.country.trim() }
            : { ...FALLBACK_UNDERSTANDING.location };

    return {
        targetEntity: raw.targetEntity.trim(),
        problem:
            typeof raw.problem === 'string' && raw.problem.trim().length > 0
                ? raw.problem.trim()
                : FALLBACK_UNDERSTANDING.problem,
        intent:
            typeof raw.intent === 'string' && raw.intent.trim().length > 0
                ? raw.intent.trim()
                : FALLBACK_UNDERSTANDING.intent,
        location,
        industry:
            typeof raw.industry === 'string' && raw.industry.trim().length > 0
                ? raw.industry.trim()
                : FALLBACK_UNDERSTANDING.industry,
        qualification:
            typeof raw.qualification === 'string' && raw.qualification.trim().length > 0
                ? raw.qualification.trim()
                : FALLBACK_UNDERSTANDING.qualification,
        signal:
            typeof raw.signal === 'string' && raw.signal.trim().length > 0
                ? raw.signal.trim()
                : FALLBACK_UNDERSTANDING.signal,
        quantity:
            typeof raw.quantity === 'string' && raw.quantity.trim().length > 0
                ? raw.quantity.trim()
                : FALLBACK_UNDERSTANDING.quantity,
        information:
            Array.isArray(raw.information) && raw.information.length > 0
                ? raw.information
                      .filter((s) => typeof s === 'string' && s.trim().length > 0)
                      .map((s) => s.trim())
                : [...FALLBACK_UNDERSTANDING.information],
        exclusions:
            typeof raw.exclusions === 'string' && raw.exclusions.trim().length > 0
                ? raw.exclusions.trim()
                : FALLBACK_UNDERSTANDING.exclusions,
        constraints:
            typeof raw.constraints === 'string' && raw.constraints.trim().length > 0
                ? raw.constraints.trim()
                : FALLBACK_UNDERSTANDING.constraints,
    };
}

// Builds the 2-search fallback from the Understanding output.

function buildFallbackSearches(understanding) {
    const target = understanding.targetEntity || FALLBACK_UNDERSTANDING.targetEntity;
    const city =
        understanding.location && understanding.location.city
            ? understanding.location.city
            : FALLBACK_UNDERSTANDING.location.city;

    return [
        `${target} ${city}`,
        `${target} ${city} directory`,
    ];
}

// Normalizes the AI search generation response. Ensures exactly 2
// non-empty strings, or falls back to the template.

function normalizeSearches(raw, understanding) {
    const fallback = buildFallbackSearches(understanding);

    if (!raw || !Array.isArray(raw.searches)) {
        return fallback;
    }

    const searches = raw.searches
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim());

    if (searches.length < 2) {
        return fallback;
    }

    return [searches[0], searches[1]];
}

// Runs one search through Tavily. Returns the parsed response or null.

async function runTavilySearch(searchPhrase) {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
        console.error('[generateAndSearch] TAVILY_API_KEY is not set');
        return null;
    }

    try {
        const response = await fetch(TAVILY_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                query: searchPhrase,
                ...TAVILY_PARAMS,
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            console.error(
                `[generateAndSearch] Tavily failed with status ${response.status}: ${errorBody}`
            );
            return null;
        }

        return await response.json();
    } catch (error) {
        console.error('[generateAndSearch] Tavily network error:', error.message);
        return null;
    }
}

// ────────────────────────────────────────────────────────────────
// MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function generateAndSearch(message, options = {}) {
    console.log('[generateAndSearch] Started');
    console.log('[generateAndSearch] Received message:', message);

    // ── Guard ──
    if (typeof message !== 'string' || message.trim().length === 0) {
        throw new Error('[generateAndSearch] message must be a non-empty string');
    }

    // ── AI call 1 — Understanding ──
    const rawUnderstanding = await callAI(
        UNDERSTANDING_INSTRUCTIONS,
        `User request:\n${message}`,
        'Understanding'
    );

    const understanding = normalizeUnderstanding(rawUnderstanding);

    console.log('[generateAndSearch] Understanding:', understanding);

    // ── AI call 2 — Search Generation ──
    const rawSearchGeneration = await callAI(
        SEARCH_GENERATION_INSTRUCTIONS,
        `Understanding output:\n${JSON.stringify(understanding, null, 2)}`,
        'Search Generation'
    );

    const searches = normalizeSearches(rawSearchGeneration, understanding);

    console.log('[generateAndSearch] Searches:', searches);

    // ── Tavily search 1 ──
    const tavilyResults = [];

    const response1 = await runTavilySearch(searches[0]);

    if (response1) {
        tavilyResults.push({ search: searches[0], response: response1 });
        console.log('[generateAndSearch] Search 1 succeeded');
    } else {
        console.warn('[generateAndSearch] Search 1 failed — skipping');
    }

    // ── Tavily search 2 ──
    const response2 = await runTavilySearch(searches[1]);

    if (response2) {
        tavilyResults.push({ search: searches[1], response: response2 });
        console.log('[generateAndSearch] Search 2 succeeded');
    } else {
        console.warn('[generateAndSearch] Search 2 failed — skipping');
    }

    // ── Return ──
    const result = {
        searches,
        tavilyResults,
    };

    console.log(
        '[generateAndSearch] Final result — searches:',
        searches.length,
        'tavilyResults:',
        tavilyResults.length
    );

    return result;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = generateAndSearch;
