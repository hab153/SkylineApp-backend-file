'use strict';

const OpenAI = require('openai');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';

// V1 exception: retries up to 4 times per Tavily search call.
const MAX_ATTEMPTS = 4;

// Only process the first N companies.
const MAX_COMPANIES = 2;

// Fixed Tavily parameters for each search.
const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

const TAVILY_PARAMS = {
    search_depth: 'basic',
    max_results: 10,
    topic: 'general',
    include_answer: false,
    include_raw_content: false,
    include_favicon: false,
};

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given a company name and a city.

Your only task is to return exactly one search phrase, in this exact
format:

"{Company Name}" {City} official website

Rules:

- The company name must be wrapped in double quotes, exactly as given.
- The city must follow the closing quote, exactly as given.
- The phrase must end with: official website
- Return the phrase as a plain string. No explanation. No alternatives.
- Do not change the company name.
- Do not change the city.
- Do not add extra words.
- Do not remove any words.

Example:

If the company name is "Blockchain.com" and the city is "London", the
search phrase must be:

"Blockchain.com" London official website

Return only valid JSON using exactly this format:

{
  "query": "the search phrase"
}

Do not explain your answer.
Do not add extra fields.
`;

// ────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────

// Builds the canonical search phrase for a company and city.
// Used as a fallback if the AI drifts from the template.

function buildTemplateQuery(companyName, city) {
    const name = String(companyName || '').trim();
    const cityText = String(city || '').trim();

    return `"${name}" ${cityText} official website`;
}

// Checks whether a candidate phrase matches the expected template.
// The company name must be wrapped in double quotes, the city must
// follow, and the phrase must end with "official website".

function matchesTemplate(candidate, companyName, city) {
    if (typeof candidate !== 'string') return false;

    const expected = buildTemplateQuery(companyName, city);

    return candidate.trim().toLowerCase() === expected.toLowerCase();
}

// ────────────────────────────────────────────────────────────────
// AI PHRASE GENERATION
// ────────────────────────────────────────────────────────────────

// Asks the AI to produce the search phrase for one company.
// Validates the output against the template. If the AI drifts,
// falls back to the template-filled phrase.

async function generatePhrase(companyName, city) {
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
                    content: `Company name: ${companyName}\nCity: ${city}`,
                },
            ],
        });

        const content = completion.choices?.[0]?.message?.content;

        if (!content) {
            console.warn(
                '[DomainFinder] AI returned empty content. Using template.'
            );
            return buildTemplateQuery(companyName, city);
        }

        const parsed = JSON.parse(content);
        const candidate = parsed?.query;

        if (matchesTemplate(candidate, companyName, city)) {
            return candidate.trim();
        }

        console.warn(
            '[DomainFinder] AI phrase did not match template. Using template. AI said:',
            candidate
        );

        return buildTemplateQuery(companyName, city);
    } catch (error) {
        console.error(
            '[DomainFinder] AI phrase generation failed:',
            error && error.message ? error.message : error
        );

        return buildTemplateQuery(companyName, city);
    }
}

// ────────────────────────────────────────────────────────────────
// TAVILY SEARCH
// ────────────────────────────────────────────────────────────────

// Sends one search phrase to Tavily. Retries up to MAX_ATTEMPTS times.
// On total failure, returns null — the caller skips this company.

async function runTavilySearch(query) {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        throw new Error(
            '[DomainFinder] TAVILY_API_KEY is not set in the environment'
        );
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(
            `[DomainFinder] Tavily attempt ${attempt}/${MAX_ATTEMPTS}:`,
            query
        );

        try {
            const response = await fetch(TAVILY_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    query,
                    ...TAVILY_PARAMS,
                }),
            });

            console.log(
                '[DomainFinder] Tavily HTTP status:',
                response.status
            );

            if (!response.ok) {
                let errorBody = '';

                try {
                    errorBody = await response.text();
                } catch (_) {
                    errorBody = '(unable to read error body)';
                }

                console.error(
                    `[DomainFinder] Tavily request failed with status ${response.status}: ${errorBody}`
                );

                continue;
            }

            const tavilyResponse = await response.json();

            console.log(
                '[DomainFinder] Tavily response received. Results:',
                Array.isArray(tavilyResponse && tavilyResponse.results)
                    ? tavilyResponse.results.length
                    : 0
            );

            return tavilyResponse;
        } catch (error) {
            console.error(
                `[DomainFinder] Tavily attempt ${attempt} failed:`,
                error && error.message ? error.message : error
            );
        }
    }

    console.warn(
        '[DomainFinder] All Tavily attempts failed for query:',
        query
    );

    return null;
}

// ────────────────────────────────────────────────────────────────
// DOMAIN FINDER
// ────────────────────────────────────────────────────────────────

// Receives companies and the city from Free.js.
// Takes up to MAX_COMPANIES companies, generates a search phrase
// for each via the AI (with template fallback), runs a Tavily search
// for each phrase sequentially, and returns the collected results.
//
// Returns:
//   { searches: [ { company, query, results } , ... ] }

async function domainFinder(companies, city) {
    console.log('[DomainFinder] Started');
    console.log('[DomainFinder] Received city:', city);
    console.log(
        '[DomainFinder] Received companies:',
        Array.isArray(companies) ? companies.length : 0
    );

    // ── Guard: companies must be a non-empty array ──
    const safeCompanies = Array.isArray(companies)
        ? companies.filter(
              (c) =>
                  c &&
                  typeof c === 'object' &&
                  typeof c.name === 'string' &&
                  c.name.trim().length > 0
          )
        : [];

    if (safeCompanies.length === 0) {
        console.warn('[DomainFinder] No companies to process.');

        return {
            searches: [],
        };
    }

    // ── Guard: city must be a non-empty string ──
    const safeCity =
        typeof city === 'string' && city.trim().length > 0
            ? city.trim()
            : '';

    if (!safeCity) {
        console.warn(
            '[DomainFinder] No city provided. Using empty city.'
        );
    }

    // ── Take up to MAX_COMPANIES ──
    const picked = safeCompanies.slice(0, MAX_COMPANIES);

    console.log(
        `[DomainFinder] Processing ${picked.length} of ${safeCompanies.length} compan(ies)`
    );

    // ── Process each company sequentially ──
    const searches = [];

    for (let i = 0; i < picked.length; i++) {
        const company = picked[i];
        const companyName = company.name.trim();

        console.log(
            `[DomainFinder] Company ${i + 1}/${picked.length}: ${companyName}`
        );

        // ── Step 1: generate the search phrase (AI + template fallback) ──
        const query = await generatePhrase(companyName, safeCity);

        console.log(
            '[DomainFinder] Generated query:',
            query
        );

        // ── Step 2: run the Tavily search ──
        const results = await runTavilySearch(query);

        // ── Step 3: skip if search failed on all attempts ──
        if (results === null) {
            console.warn(
                `[DomainFinder] Skipping ${companyName} — Tavily failed.`
            );

            continue;
        }

        // ── Step 4: collect ──
        searches.push({
            company: companyName,
            query,
            results,
        });

        console.log(
            `[DomainFinder] Company ${i + 1} completed.`
        );
    }

    // ── Return ──
    const result = {
        searches,
    };

    console.log(
        '[DomainFinder] Final result:',
        `${searches.length} search(es) completed`
    );

    return result;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = domainFinder;
