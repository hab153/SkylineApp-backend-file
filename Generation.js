'use strict';

const OpenAI = require('openai');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';

// V1 exception: this layer retries up to 4 times, not 2.
const MAX_ATTEMPTS = 4;

const FALLBACK_MESSAGE =
    'Our server is currently experiencing high traffic. Please try again shortly.';

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given the output of the Summary layer.

The Summary layer output contains:

- summary    — a plain-text summary of everything in the Understanding
               and Planning outputs.
- allocation — the maximum number of search calls allowed for this request.
               It contains requestedQuantity and maxSearchCalls.

Your only task is to generate a set of search phrases that will be sent to
the search system to find leads about companies.

The search phrases you generate will be sent to a real search engine. The
search engine does not have a database of companies. It returns web pages.
The pages it returns are pages where companies are mentioned or listed:
company websites, job postings, business directories, news articles,
professional profiles, and industry listings.

For a search phrase to find companies, it must be phrased so that a real
web page could contain that phrase. If no real page contains the phrase,
the search will return nothing useful.

The number of search phrases you must generate is calculated as:

searchCount = min(requestedQuantity, 10)

Where requestedQuantity is read from allocation.requestedQuantity.

Examples:

- If requestedQuantity is 5, generate exactly 5 search phrases.
- If requestedQuantity is 8, generate exactly 8 search phrases.
- If requestedQuantity is 10, generate exactly 10 search phrases.
- If requestedQuantity is 40, generate exactly 10 search phrases.
- If requestedQuantity is 300, generate exactly 10 search phrases.

Every search phrase must pass these tests:

1. Could a real web page contain this exact phrase?
   If no page says it, the search will return nothing useful.

2. Does it use natural page language?
   Real pages say: hiring, jobs, careers, directory, news, services,
   about, team, linkedin, crunchbase.
   Real pages never say: requiring, seeking, employing, needing,
   that need, that require, with websites.

3. Does it target a specific source type?
   Each search must aim at one type of page: a job board, a company
   directory, a news article, a company website, a professional
   profile, or an industry listing.

4. Is it different from the other searches?
   Do not generate ten variations of the same idea. Each search must
   open a different corner of the web. Do not repeat the same wording
   with small changes.

The search phrases must be grounded in the summary. Do not invent
information that is not present in the summary. Do not change the
target, location, industry, qualification, signal, exclusions,
constraints, or any other requirement. Do not weaken or remove any
requirement.

Forbidden phrasing — never use these. They describe ideas rather than
pages, and no real page contains them:

- requiring
- seeking
- employing
- needing
- that need
- that require
- with websites
- with a website
- that have websites
- organizations requiring
- firms seeking
- companies needing
- companies requiring
- looking for

Preferred phrasing — use these where they fit, because they appear on
real pages:

- hiring, jobs, careers, job openings, recruiting
- directory, business directory, companies in, list of companies
- news, announcement, funding, expansion
- services, solutions, products, about, team
- linkedin, crunchbase, professional profile

When the location is non-English-speaking, include 1 or 2 search
phrases in the local language. For example, if the location is Berlin,
Germany, include a phrase such as:

- "Berlin Gesundheitsunternehmen IT"
- "Berlin Gesundheitswesen Software"

This helps reach local pages that English searches miss.

The signal tells us what evidence to look for. Use the signal to
choose the right source type:

- If the signal is about hiring, target job boards and careers pages.
- If the signal is about expansion, target news and press pages.
- If the signal is about incidents, target news and reports.
- If the signal is about compliance, target regulatory filings.
- If the signal is about adoption, target case studies and product pages.

Use forward-looking and investigative language. The search phrases
describe what to search for, not the results of any search.

Do not use language that suggests the work is already complete, such as:
found, identified, confirmed, verified, ensured, located.

Do not:

- invent information that is not present in the summary
- guess missing information
- change any value
- add recommendations or evidence
- add confidence scores
- invent unnecessary details

Return only valid JSON using exactly this format:

{
  "searches": ["the first search phrase", "the second search phrase"]
}

Do not explain your answer.
Do not add extra fields.
Do not remove any fields.
`;

// ────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────

// Reads requestedQuantity from the summary allocation, if present.
// Returns null when the value is missing or not a positive integer.

function readRequestedQuantity(summary) {
    if (!summary || typeof summary !== 'object') return null;

    const allocation = summary.allocation;

    if (!allocation || typeof allocation !== 'object') return null;

    const q = allocation.requestedQuantity;

    if (!Number.isInteger(q) || q <= 0) return null;

    return q;
}

// ────────────────────────────────────────────────────────────────
// GENERATION REQUEST
// ────────────────────────────────────────────────────────────────

async function generationRequest(summary, options = {}) {
    console.log('[GenerationRequest] Started');
    console.log('[GenerationRequest] Received summary:', summary);

    const requestedQuantity = readRequestedQuantity(summary);

    console.log(
        '[GenerationRequest] Requested quantity:',
        requestedQuantity
    );

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(
            `[GenerationRequest] Attempt ${attempt}/${MAX_ATTEMPTS}`
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
                        content: `Summary output:\n${JSON.stringify(
                            summary,
                            null,
                            2
                        )}`,
                    },
                ],
            });

            console.log(
                '[GenerationRequest] OpenAI response received'
            );

            const content = completion.choices?.[0]?.message?.content;

            console.log(
                '[GenerationRequest] Raw model response:',
                content
            );

            if (!content) {
                console.error(
                    '[GenerationRequest] Model returned an empty response'
                );
                continue;
            }

            const parsedResult = JSON.parse(content);

            console.log(
                '[GenerationRequest] Parsed model response:',
                parsedResult
            );

            const rawSearches = parsedResult?.searches;

            const searches =
                Array.isArray(rawSearches)
                    ? rawSearches
                          .filter(
                              (s) =>
                                  typeof s === 'string' &&
                                  s.trim().length > 0
                          )
                          .map((s) => s.trim())
                    : [];

            if (searches.length > 0) {
                const result = {
                    searches,

                    allocation:
                        summary && typeof summary === 'object'
                            ? summary.allocation
                            : null,
                };

                console.log(
                    '[GenerationRequest] Final result:',
                    result
                );

                return result;
            }

            console.warn(
                '[GenerationRequest] No valid searches returned'
            );
        } catch (error) {
            console.error(
                `[GenerationRequest] Attempt ${attempt} failed`
            );

            console.error(
                '[GenerationRequest] Error name:',
                error.name
            );
            console.error(
                '[GenerationRequest] Error message:',
                error.message
            );
            console.error(
                '[GenerationRequest] Error status:',
                error.status
            );
            console.error(
                '[GenerationRequest] Full error:',
                error
            );
        }
    }

    // Fallback after all attempts fail.
    // The entire output is replaced with the friendly message.
    const fallbackResult = {
        message: FALLBACK_MESSAGE,
    };

    console.warn(
        '[GenerationRequest] All attempts failed. Using fallback:',
        fallbackResult
    );

    return fallbackResult;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = generationRequest;
