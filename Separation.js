'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const OpenAI = require('openai');

const { getAll } = require('./Saving');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';

// Per-attempt retry: if the AI fails to extract companies, retry up
// to 4 times. There is only ONE AI call now — not one per search.
const MAX_ATTEMPTS = 4;

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given the raw search results collected from several searches.

Your only task is to separate these results into company blocks.

Rule:

- Everything that belongs to a company goes under that company.
- A company gets its own block.
- Everything about that company is written inside that company's block.
- Nothing crosses between companies.

Extracting companies:

- Extract EVERY company that is named in the search results — not only
  the company the page is about. A single page may name many companies.
  Each of those companies gets its own block.
- Extract a company if its name appears in the title, in the snippet,
  or in the URL.
- The same company may appear in many search results — across many
  different searches. All of its mentions go into one company block —
  the same company is never split into two blocks.

What counts as a company to include:

- A company that matches what the searches were looking for.
- The searches show what is being looked for — through the search
  phrases and through the target, location, and industry the results
  are about.
- If a company is not the kind of company the searches were looking
  for, do not include it.

Do not:

- invent companies that are not present in the search results
- invent mentions
- merge two different companies into one block
- mix details between different companies
- change URLs, titles, or descriptions
- add recommendations or evidence
- add confidence scores

You may only:

- identify the companies mentioned in the search results
- place every mention under the correct company
- group mentions of the same company together in that company's block

Return only valid JSON using exactly this format:

{
  "companies": [
    {
      "name": "the company name",
      "mentions": [
        {
          "search": "the search phrase that produced this mention",
          "url": "the page URL",
          "title": "the page title",
          "description": "the page snippet",
          "score": 0.0
        }
      ]
    }
  ]
}

Every mention must include the search phrase, URL, title, description,
and score exactly as they appear in the search results.

If no companies can be identified, return:

{
  "companies": []
}

Do not explain your answer.
Do not add extra fields.
Do not remove any fields.
Do not invent unnecessary details.
`;

// ────────────────────────────────────────────────────────────────
// SEPARATION REQUEST
// ────────────────────────────────────────────────────────────────

// Receives the completion notification from Free.js.
// Calls Saving.getAll() to take all accumulated search results.
// Saving.js is cleared after the take.
//
// Sends ALL search results to the AI in ONE call. The AI returns
// one separated list of companies. This replaces the old per-search
// chunking, which was making 10+ AI calls per run.
//
// Returns:
//   { collected, totalResults, results, companies }
//
// It does not search. It does not verify. It only collects and extracts.

async function separationRequest(notification) {
    console.log('[Separation] Started');
    console.log('[Separation] Received notification:', notification);

    // ── Take everything from Saving ──
    let allResults = [];

    try {
        const taken = getAll();

        allResults = Array.isArray(taken) ? taken : [];
    } catch (error) {
        console.error(
            '[Separation] Failed to collect from Saving:',
            error && error.message ? error.message : error
        );

        allResults = [];
    }

    console.log(
        '[Separation] Collected',
        allResults.length,
        'result set(s) from Saving'
    );

    // ── Compute the summary ──
    const collected = allResults.length;

    const totalResults = allResults.reduce((sum, entry) => {
        const r = entry && entry.response ? entry.response.results : null;
        return sum + (Array.isArray(r) ? r.length : 0);
    }, 0);

    // ── Extract companies in ONE AI call ──
    let companies = [];

    if (allResults.length > 0) {
        companies = await extractCompanies(allResults);
    } else {
        console.warn(
            '[Separation] No results to separate. companies will be empty.'
        );
    }

    // ── Build the result ──
    const result = {
        collected,
        totalResults,
        results: allResults,
        companies,
    };

    console.log(
        '[Separation] Final result:',
        `collected=${collected}`,
        `totalResults=${totalResults}`,
        `companies=${companies.length}`
    );

    return result;
}

// ────────────────────────────────────────────────────────────────
// EXTRACT COMPANIES — ONE AI CALL FOR ALL SEARCHES
// ────────────────────────────────────────────────────────────────

// Sends all search results to the AI in a single prompt. The AI
// returns one separated list of companies, with each company's
// mentions grouped together — across all searches.
//
// Retries up to MAX_ATTEMPTS times. Returns [] if all attempts fail.

async function extractCompanies(allResults) {
    // Build a compact representation. Each entry is:
    //   { search: <phrase>, results: [ <Tavily results> ] }
    //
    // We send the full Tavily response per search, so the AI sees
    // everything — titles, URLs, snippets, scores.
    const payload = allResults.map((entry) => ({
        search: entry && entry.search ? entry.search : '',
        results:
            entry &&
            entry.response &&
            Array.isArray(entry.response.results)
                ? entry.response.results
                : [],
    }));

    console.log(
        '[Separation] Sending',
        payload.length,
        'search result sets to the AI in one call'
    );

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(
            `[Separation] AI attempt ${attempt}/${MAX_ATTEMPTS}`
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
                        content: `Search results:\n${JSON.stringify(
                            payload,
                            null,
                            2
                        )}`,
                    },
                ],
            });

            console.log(
                '[Separation] OpenAI response received'
            );

            const content = completion.choices?.[0]?.message?.content;

            console.log(
                '[Separation] Raw model response:',
                content
            );

            if (!content) {
                console.error(
                    '[Separation] Model returned an empty response'
                );
                continue;
            }

            const parsedResult = JSON.parse(content);

            console.log(
                '[Separation] Parsed model response:',
                parsedResult
            );

            const rawCompanies = parsedResult?.companies;

            const companies = Array.isArray(rawCompanies)
                ? rawCompanies.filter(
                      (c) =>
                          c &&
                          typeof c === 'object' &&
                          typeof c.name === 'string' &&
                          c.name.trim().length > 0 &&
                          Array.isArray(c.mentions)
                  )
                : [];

            if (companies.length > 0) {
                console.log(
                    '[Separation] Valid companies from AI:',
                    companies.length
                );

                return companies;
            }

            console.warn(
                '[Separation] No valid companies returned'
            );
        } catch (error) {
            console.error(
                `[Separation] AI attempt ${attempt} failed`
            );

            console.error(
                '[Separation] Error name:',
                error.name
            );
            console.error(
                '[Separation] Error message:',
                error.message
            );
            console.error(
                '[Separation] Error status:',
                error.status
            );
            console.error(
                '[Separation] Full error:',
                error
            );
        }
    }

    console.warn(
        '[Separation] All AI attempts failed. Returning empty.'
    );

    return [];
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = separationRequest;
