// ────────────────────────────────────────────────────────────────
// Seeker.js — Request Understanding, Search Generation, Execution
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
    max_results: 20,
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
You are given a raw user request.

Your only task is to generate EXACTLY 2 search queries.

The 2 search queries will be sent to a real search engine to find as
many matching companies as possible. Because only 2 searches are
available, each search must be very wide and high-yield.

First, understand the complete request. Identify the target entity,
location, need, signal, qualification, exclusions, constraints, and
any other requirement. Then write 2 search queries.

Query rules:

1. Generate exactly 2 search queries. Never more, never fewer.
2. Both queries must be relevant to the target, location, and
   requirements.
3. Give the 2 queries different but complementary angles.
4. Use observable information that can be found online. Do not search
   for an unobservable assumption about a company's needs.
5. Do not generate 2 queries that are essentially identical.
6. Do not use generic queries when more specific queries can produce
   better results.
7. Each query must be phrased so that a real web page could contain
   that phrase.

A high-yield search hits pages where many companies are listed or
mentioned at once, such as:

- Business directories (e.g., "fintech companies London directory")
- Company databases (e.g., "site:crunchbase.com fintech companies London")
- Professional profiles (e.g., "fintech companies London linkedin")
- Broad discovery searches (e.g., "fintech companies London")
- Industry listings (e.g., "list of fintech companies London")
- News and reports that mention many companies

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

Example:

If the request is for fintech companies in London, a suitable pair of
searches would be:

1. "site:crunchbase.com fintech companies London"
2. "fintech companies London directory"

Return only valid JSON using exactly this format:

{
  "searches": [
    "the first search query",
    "the second search query"
  ]
}

The searches array must contain exactly 2 non-empty strings.

Do not explain your answer.
Do not add extra fields.
Do not remove any fields.
`;

// ────────────────────────────────────────────────────────────────
// AI QUERY GENERATION — WITH RETRIES
// ────────────────────────────────────────────────────────────────

async function generateQueries(message) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(`[Seeker] AI attempt ${attempt}/${MAX_ATTEMPTS}`);

        try {
            const completion = await openai.chat.completions.create({
                model: MODEL,
                temperature: 0,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: SYSTEM_INSTRUCTIONS },
                    { role: 'user', content: `User request:\n${message}` },
                ],
            });

            const content = completion.choices?.[0]?.message?.content;

            console.log('[Seeker] AI raw response:', content);

            if (!content) {
                console.error('[Seeker] AI returned empty content');
                continue;
            }

            const parsed = JSON.parse(content);
            const rawSearches = parsed?.searches;

            if (!Array.isArray(rawSearches)) {
                console.warn('[Seeker] AI did not return an array of searches');
                continue;
            }

            const searches = rawSearches
                .filter((s) => typeof s === 'string' && s.trim().length > 0)
                .map((s) => s.trim());

            if (searches.length >= 2) {
                console.log('[Seeker] AI generated queries:', searches.slice(0, 2));
                return searches.slice(0, 2);
            }

            console.warn(
                `[Seeker] AI returned ${searches.length} valid queries — need at least 2`
            );
        } catch (error) {
            console.error(
                `[Seeker] AI attempt ${attempt} failed:`,
                error && error.message ? error.message : error
            );
        }
    }

    console.warn('[Seeker] All AI attempts failed');
    return null;
}

// ────────────────────────────────────────────────────────────────
// TAVILY SEARCH — SINGLE QUERY
// ────────────────────────────────────────────────────────────────

async function runTavilySearch(query) {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
        console.error('[Seeker] TAVILY_API_KEY is not set');
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
                `[Seeker] Tavily failed with status ${response.status}: ${errorBody}`
            );
            return null;
        }

        return await response.json();
    } catch (error) {
        console.error('[Seeker] Tavily network error:', error.message);
        return null;
    }
}

// ────────────────────────────────────────────────────────────────
// SEEKER REQUEST — MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function seekerRequest(message) {
    const startedAt = Date.now();
    console.log('[Seeker] Started');
    console.log('[Seeker] Message:', message);

    // ── Guard ──
    if (typeof message !== 'string' || message.trim().length === 0) {
        throw new Error('[Seeker] message must be a non-empty string');
    }

    // ── Step 1: Generate 2 queries via AI ──
    const searches = await generateQueries(message);

    if (!searches) {
        const elapsed = Date.now() - startedAt;
        console.warn(
            `[Seeker] Query generation failed — returning fallback message (${elapsed}ms)`
        );

        return {
            message: FALLBACK_MESSAGE,
        };
    }

    console.log('[Seeker] Using queries:', searches);

    // ── Step 2: Run search 1 (sequential) ──
    const results = [];

    const search1Start = Date.now();
    const response1 = await runTavilySearch(searches[0]);
    const search1Ms = Date.now() - search1Start;

    if (response1) {
        results.push({ search: searches[0], response: response1 });
        console.log(`[Seeker] Search 1 succeeded (${search1Ms}ms)`);
    } else {
        console.warn(`[Seeker] Search 1 failed (${search1Ms}ms)`);
    }

    // ── Step 3: Run search 2 (sequential — only after search 1 finishes) ──
    const search2Start = Date.now();
    const response2 = await runTavilySearch(searches[1]);
    const search2Ms = Date.now() - search2Start;

    if (response2) {
        results.push({ search: searches[1], response: response2 });
        console.log(`[Seeker] Search 2 succeeded (${search2Ms}ms)`);
    } else {
        console.warn(`[Seeker] Search 2 failed (${search2Ms}ms)`);
    }

    // ── Step 4: Combine and return ──
    const elapsed = Date.now() - startedAt;

    const output = {
        searches,
        results,
    };

    console.log(
        `[Seeker] Finished — ${results.length}/2 searches succeeded in ${elapsed}ms`
    );

    return output;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = seekerRequest;
