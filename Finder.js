// ────────────────────────────────────────────────────────────────
// Finder.js — Official Domain Discovery
// ────────────────────────────────────────────────────────────────
'use strict';

const OpenAI = require('openai');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';
const MAX_ATTEMPTS = 4;

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const TAVILY_PARAMS = {
    search_depth: 'basic',
    max_results: 10,
    topic: 'general',
    include_answer: false,
    include_raw_content: false,
    include_favicon: false,
};

const FALLBACK_MESSAGE =
    'Our server is currently experiencing high traffic. Please try again shortly.';

// ────────────────────────────────────────────────────────────────
// AI INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given the raw search results from a previous stage of a
lead-generation pipeline, plus the original user request.

Your only task is to:

1. Read the raw search results carefully.
2. Identify exactly 2 real companies mentioned in those results.
3. For each company, write ONE search query designed to find that
   company's official website.

Company selection rules:

- The 2 companies must come from the raw search results you were
  given. Do not invent company names.
- The 2 companies must be different from each other.
- If you can find fewer than 2 real companies, return only the ones
  you found.

Query format — follow exactly:

"{Company Name}" {City} official website

Rules for the query:

- Wrap the company name in double quotes.
- Follow with the city from the user's request.
- End with the exact phrase: official website
- Do not add extra words.
- Do not remove any words.
- One query per company.

Forbidden phrasing — never include these in a query:

- linkedin
- requiring
- seeking
- employing
- needing
- looking for

Return only valid JSON using exactly this format:

{
  "companies": [
    {
      "name": "the company name",
      "query": "\"the company name\" the city official website"
    }
  ]
}

The companies array must contain 1 or 2 entries.

Do not explain your answer.
Do not add extra fields.
Do not remove any fields.
`;

// ────────────────────────────────────────────────────────────────
// AI COMPANY + QUERY GENERATION — WITH RETRIES
// ────────────────────────────────────────────────────────────────

async function generateCompanies(seekerOutput, message) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(`[Finder] AI attempt ${attempt}/${MAX_ATTEMPTS}`);

        try {
            const rawResultsJson = JSON.stringify(
                {
                    searches: seekerOutput.searches || [],
                    results: (seekerOutput.results || []).map((entry) => ({
                        search: entry.search,
                        results: entry.response?.results || [],
                    })),
                },
                null,
                2
            );

            const completion = await openai.chat.completions.create({
                model: MODEL,
                temperature: 0,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: SYSTEM_INSTRUCTIONS },
                    {
                        role: 'user',
                        content: `User request:\n${message}\n\nRaw search results from previous stage:\n${rawResultsJson}`,
                    },
                ],
            });

            const content = completion.choices?.[0]?.message?.content;
            console.log('[Finder] AI raw response:', content);

            if (!content) {
                console.error('[Finder] AI returned empty content');
                continue;
            }

            const parsed = JSON.parse(content);
            const rawCompanies = parsed?.companies;

            if (!Array.isArray(rawCompanies)) {
                console.warn('[Finder] AI did not return a companies array');
                continue;
            }

            const companies = rawCompanies
                .filter(
                    (c) =>
                        c &&
                        typeof c === 'object' &&
                        typeof c.name === 'string' &&
                        c.name.trim().length > 0 &&
                        typeof c.query === 'string' &&
                        c.query.trim().length > 0
                )
                .map((c) => ({
                    name: c.name.trim(),
                    query: c.query.trim(),
                }))
                .slice(0, 2);

            if (companies.length === 0) {
                console.warn('[Finder] AI returned 0 valid companies');
                continue;
            }

            console.log(
                `[Finder] AI returned ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`
            );
            return companies;
        } catch (error) {
            console.error(
                `[Finder] AI attempt ${attempt} failed:`,
                error && error.message ? error.message : error
            );
        }
    }

    console.warn('[Finder] All AI attempts failed');
    return null;
}

// ────────────────────────────────────────────────────────────────
// TAVILY SEARCH — SINGLE QUERY
// ────────────────────────────────────────────────────────────────

async function runTavilySearch(query) {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
        console.error('[Finder] TAVILY_API_KEY is not set');
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
                query,
                ...TAVILY_PARAMS,
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            console.error(
                `[Finder] Tavily failed with status ${response.status}: ${errorBody}`
            );
            return null;
        }

        return await response.json();
    } catch (error) {
        console.error('[Finder] Tavily network error:', error.message);
        return null;
    }
}

// ────────────────────────────────────────────────────────────────
// FINDER REQUEST — MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function finderRequest(seekerOutput, message) {
    const startedAt = Date.now();
    console.log('[Finder] Started');

    // ── Guard: message must be a non-empty string ──
    if (typeof message !== 'string' || message.trim().length === 0) {
        throw new Error('[Finder] message must be a non-empty string');
    }

    // ── Guard: Seeker failed → return the same friendly message ──
    if (
        !seekerOutput ||
        typeof seekerOutput !== 'object' ||
        typeof seekerOutput.message === 'string'
    ) {
        console.warn(
            '[Finder] Seeker output is a fallback message. Returning it.'
        );

        return {
            message:
                (seekerOutput && seekerOutput.message) || FALLBACK_MESSAGE,
        };
    }

    // ── Guard: Seeker must have results to work from ──
    const seekerResults = Array.isArray(seekerOutput.results)
        ? seekerOutput.results
        : [];

    if (seekerResults.length === 0) {
        console.warn(
            '[Finder] Seeker output has no results. Returning friendly message.'
        );

        return {
            message: FALLBACK_MESSAGE,
        };
    }

    // ── Step 1: AI extracts 2 companies + queries ──
    const companies = await generateCompanies(seekerOutput, message);

    if (!companies) {
        const elapsed = Date.now() - startedAt;
        console.warn(
            `[Finder] Company generation failed — returning fallback message (${elapsed}ms)`
        );

        return {
            message: FALLBACK_MESSAGE,
        };
    }

    // ── Step 2: Run the searches sequentially ──
    const results = [];

    for (let i = 0; i < companies.length; i++) {
        const company = companies[i];
        const searchStart = Date.now();

        console.log(
            `[Finder] Running search ${i + 1}/${companies.length} for: ${company.name}`
        );

        const response = await runTavilySearch(company.query);
        const searchMs = Date.now() - searchStart;

        if (response) {
            results.push({
                name: company.name,
                query: company.query,
                results: response,
            });
            console.log(
                `[Finder] Search ${i + 1} succeeded (${searchMs}ms)`
            );
        } else {
            console.warn(
                `[Finder] Search ${i + 1} failed (${searchMs}ms)`
            );
        }
    }

    // ── Step 3: If no searches succeeded, fallback ──
    if (results.length === 0) {
        const elapsed = Date.now() - startedAt;
        console.warn(
            `[Finder] All searches failed (${elapsed}ms). Returning fallback message.`
        );

        return {
            message: FALLBACK_MESSAGE,
        };
    }

    // ── Step 4: Return ──
    const elapsed = Date.now() - startedAt;

    const output = {
        companies: results,
    };

    console.log(
        `[Finder] Finished — ${results.length}/${companies.length} searches succeeded in ${elapsed}ms`
    );

    return output;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = finderRequest;
