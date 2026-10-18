'use strict';

const OpenAI = require('openai');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';

// This layer retries up to 3 times (V1 exception — Generation and
// Verification use 4, but this layer uses 3 per the design).
const MAX_ATTEMPTS = 3;

// Take at most 10 companies from the verified list.
const MAX_COMPANIES = 10;

const FALLBACK_MESSAGE =
    'Our server is currently experiencing high traffic. Please try again shortly.';

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given two things:

1. The Understanding output — the original user request, already
   understood. It contains the target entity, problem, intent,
   location, industry, qualification, signal, quantity, information,
   exclusions, and constraints.

2. A batch of verified companies. Each company has a name, a rating,
   and the search results where it was mentioned.

Your only task is to generate ONE search phrase per company.

Each search phrase will be sent to a real search engine. The goal of
each search is to find that specific company's OFFICIAL WEBSITE DOMAIN.

A good search phrase has these properties:

- It contains the company name in double quotes. This tells the search
  engine to treat the name as an exact phrase. For example:
  "Advocate Health Care"

- It contains location context from the Understanding output, such as
  the city and country. This helps disambiguate companies with generic
  or common names. For example, if the company is in Chicago, add
  Chicago to the search.

- It contains industry context from the Understanding output, when it
  helps. For example, if the industry is healthcare, the word
  healthcare can be added.

- It ends with words that push the search engine toward the official
  site, such as:
    official website
    official site
    homepage

Example of a good search phrase:

  "Advocate Health Care" Chicago healthcare official website

Example of a bad search phrase:

  Advocate Health Care

(bad because the name is not quoted, there is no location context,
and there is no hint about the official site)

Rules:

- Generate exactly one search phrase per company.
- Return the same number of search phrases as the number of companies
  in the batch.
- Each search phrase must be a non-empty string.
- Each search phrase must contain the company name in double quotes.
- Do not invent companies that are not in the batch.
- Do not add extra search phrases.
- Do not skip any company in the batch.

Return only valid JSON using exactly this format:

{
  "searches": [
    "\"Company Name 1\" location industry official website",
    "\"Company Name 2\" location industry official website"
  ]
}

The searches array must be in the same order as the companies in the
batch.

Do not explain your answer.
Do not add extra fields.
Do not remove any fields.
Do not invent unnecessary details.
`;

// ────────────────────────────────────────────────────────────────
// SEARCH GENERATION REQUEST
// ────────────────────────────────────────────────────────────────

// Receives the Verification output and the Understanding output.
// Takes up to MAX_COMPANIES (10) verified companies.
// Sends them to the AI with the Understanding context.
// The AI generates one search phrase per company, each designed to
// find the company's official website domain.
//
// Retries up to MAX_ATTEMPTS (3) times.
// On total failure, returns the friendly message.
//
// Returns:
//   { searches: [...] } on success
//   { message } on total failure

async function searchGenerationRequest(verification, understanding) {
    console.log('[SearchGeneration] Started');
    console.log('[SearchGeneration] Received understanding:', understanding);

    // ── Read the verified companies ──
    const allVerified =
        verification && Array.isArray(verification.verified)
            ? verification.verified.filter(
                  (c) =>
                      c &&
                      typeof c === 'object' &&
                      typeof c.name === 'string' &&
                      c.name.trim().length > 0
              )
            : [];

    console.log(
        '[SearchGeneration] Total verified companies:',
        allVerified.length
    );

    // ── Take up to 10 — first 10 in the array (top 10 by rating) ──
    const companies = allVerified.slice(0, MAX_COMPANIES);

    console.log(
        '[SearchGeneration] Taking',
        companies.length,
        'compan(ies) for search generation'
    );

    // ── No companies — return empty searches, no AI call ──
    if (companies.length === 0) {
        console.log(
            '[SearchGeneration] No companies. Returning empty searches list.'
        );

        return {
            searches: [],
        };
    }

    // ── Generate searches via AI with retries ──
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(
            `[SearchGeneration] AI attempt ${attempt}/${MAX_ATTEMPTS}`
        );

        try {
            const userContent =
                `Understanding output:\n${JSON.stringify(
                    understanding,
                    null,
                    2
                )}\n\nCompanies to generate searches for:\n${JSON.stringify(
                    companies.map((c) => ({
                        name: c.name,
                        rating: c.rating,
                    })),
                    null,
                    2
                )}`;

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
                        content: userContent,
                    },
                ],
            });

            console.log(
                '[SearchGeneration] OpenAI response received'
            );

            const content = completion.choices?.[0]?.message?.content;

            console.log(
                '[SearchGeneration] Raw model response:',
                content
            );

            if (!content) {
                console.error(
                    '[SearchGeneration] Model returned an empty response'
                );
                continue;
            }

            const parsedResult = JSON.parse(content);

            console.log(
                '[SearchGeneration] Parsed model response:',
                parsedResult
            );

            const rawSearches = parsedResult?.searches;

            const searches = Array.isArray(rawSearches)
                ? rawSearches
                      .filter(
                          (s) =>
                              typeof s === 'string' &&
                              s.trim().length > 0
                      )
                      .map((s) => s.trim())
                : [];

            // Must have at least 1 search — ideally exactly companies.length
            if (searches.length > 0) {
                // Align to the company count. If the AI returned fewer
                // searches than companies, we accept what came back;
                // the count is what the AI produced.
                const result = {
                    searches,
                };

                console.log(
                    '[SearchGeneration] Final result. Search count:',
                    searches.length
                );

                return result;
            }

            console.warn(
                '[SearchGeneration] No valid searches returned'
            );
        } catch (error) {
            console.error(
                `[SearchGeneration] AI attempt ${attempt} failed`
            );

            console.error(
                '[SearchGeneration] Error name:',
                error.name
            );
            console.error(
                '[SearchGeneration] Error message:',
                error.message
            );
            console.error(
                '[SearchGeneration] Error status:',
                error.status
            );
            console.error(
                '[SearchGeneration] Full error:',
                error
            );
        }
    }

    // ── All attempts failed — return friendly message ──
    const fallbackResult = {
        message: FALLBACK_MESSAGE,
    };

    console.warn(
        '[SearchGeneration] All attempts failed. Using fallback:',
        fallbackResult
    );

    return fallbackResult;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = searchGenerationRequest;
