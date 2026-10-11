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

// V1 exception: this layer retries up to 4 times, not 2.
const MAX_ATTEMPTS = 4;

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given the raw search results collected from several web searches.

Your only task is to separate these results into company blocks.

Rule:

- Everything that belongs to a company goes under that company.
- A company gets its own block.
- Everything about that company is written inside that company's block.
- Nothing crosses between companies.

Extracting companies:

- Extract EVERY company that is named in the search results — not only
  the company the page is about. A single directory page may name twenty
  companies. Each of those companies gets its own block.
- Extract a company if its name appears in the title, in the snippet, or
  in the URL.
- The same company may appear in many search results. All of its mentions
  go into one company block — the same company is never split into two
  blocks.

What counts as a company to include:

- Fintech companies, financial technology companies, digital banks,
  payment companies, lending platforms, financial software companies,
  and similar companies that are part of the financial technology
  industry.
- Only companies that are relevant to what the user asked for.

What does NOT count as a company to include:

- Recruitment agencies and staffing companies
- Cybersecurity vendors or cybersecurity service providers
- Consulting firms and professional services companies
- News websites, media companies, industry publications
- Job boards and job listing platforms
- Directory websites and list aggregators
- Technology vendors whose main business is not financial technology
- Any company whose main business is not financial technology

Examples of companies to exclude (do not create blocks for them):

- Recruitment agencies: Morgan McKinley, Barclay Simpson, Selby Jennings,
  Harrington Starr, Rutherford, Hunter Bond, EC1 Partners, Robert Walters
- Cybersecurity vendors: Cyber Alchemy, PeoplActive, FoxTech, Intersys,
  Cynance, Astra Security, Eden Data, Infosec K2K, Resilience & Cyber
- Consulting firms: Capco, Deloitte, KPMG, Accenture
- News sites: FinTech Weekly, FinTech Futures, FinTech Magazine
- Job boards: Indeed, LinkedIn Jobs, Built In London, Fintech Careers

If a company's main business is not financial technology, do not create
a block for it — even if it appears on a fintech page.

Do not:

- invent companies that are not present in the search results
- invent mentions
- merge two companies into one block
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

Every mention must include the search phrase, URL, title, description, and
score exactly as they appear in the search results.

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
// Computes a small summary:
//   - collected    — number of result sets taken
//   - totalResults — total individual results across all sets
//
// Then sends the raw results to the AI, which separates them into
// company blocks. The AI is retried up to 4 times. If all attempts fail,
// the companies array is empty — no fallback is invented.
//
// Returns:
//   { collected, totalResults, results, companies }
//
// It does not search. It does not verify. It does not decide meaning.
// It collects and separates.

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

    // ── Separate via AI ──
    let companies = [];

    if (totalResults > 0) {
        companies = await separateCompanies(allResults);
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
// SEPARATE COMPANIES — AI CALL WITH RETRIES
// ────────────────────────────────────────────────────────────────

// Sends the raw search results to the AI and asks it to separate them
// into company blocks. Retries up to MAX_ATTEMPTS times.
// On total failure, returns an empty array — no fallback is invented.

async function separateCompanies(allResults) {
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
                            allResults,
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
        '[Separation] All AI attempts failed. companies will be empty.'
    );

    return [];
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = separationRequest;
