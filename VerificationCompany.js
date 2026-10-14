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

// V1 exception: this layer retries up to 4 times, not 2.
const MAX_ATTEMPTS_PER_CHUNK = 4;

// Number of companies verified per AI call. Small enough that the
// AI reads the full prompt without skimming.
const CHUNK_SIZE = 10;

// Minimum rating a company must have to be considered qualified
// for the next stage. Companies rated below this are still verified
// and returned in the "verified" array, but they do not appear in
// the "qualified" array.
const MIN_QUALIFIED_RATING = 5;

const FALLBACK_MESSAGE =
    'Our server is currently experiencing high traffic. Please try again shortly.';

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given two things:

1. The original user request, already understood — it contains the target
   entity, problem, intent, location, industry, qualification, signal,
   quantity, information, exclusions, and constraints.

2. A batch of companies, each with its name and the search results where
   it was mentioned.

Your only task is to verify each company in the batch against the
original user request.

For each company, decide:

- rating — an integer from 1 to 10, where 10 is the strongest match and
  1 is the weakest. The rating reflects how well the company matches
  the user request.
- status — either "valid" or "invalid".
    - "valid" means the company matches what the user is looking for.
    - "invalid" means the company does not match.
- reason — a short plain-text explanation of the rating and status.

Verification rules:

- A company is valid if it is a real company that matches the target,
  location, industry, and qualification described in the request, and
  does not violate any exclusion or constraint.
- A company is invalid if it is not the kind of company the user is
  looking for. For example: a recruitment agency when the user is
  looking for companies, a vendor when the user is looking for buyers,
  a consulting firm, an industry body, a news website, a job board,
  a directory, or any company in the wrong location or industry.
- A company is invalid if its name is a generic category label rather
  than a specific, real company name. Examples of invalid names:
  "Fintech Company", "Company", "Agency", "Firm", "Startup",
  "Business", "Organization", "Enterprise". If the name is a generic
  label that could refer to any company in the industry, the company
  is invalid.
- A company is invalid if its primary business is not the type of
  entity the user is looking for, even if it has a division, team,
  or department that operates in the requested industry. The company
  must be the type of entity the user is looking for as its primary
  business, not as a secondary function. Example: if the user asks
  for restaurants, a hotel with a restaurant is invalid — the hotel
  is not a restaurant.
- A company must have at least one mention from a page that focuses
  on that specific company. If the only mentions of the company come
  from pages that list many companies at once — such as directory
  pages, list articles, feed posts, "top N" articles, news roundups,
  or industry overview pages — the company is invalid, unless
  additional evidence from a single-company page also exists.
  A single-company page is a page whose primary subject is that
  company: the company's own website, a job posting about a role at
  that company, a news article about that company, a company profile
  page, or any other page dedicated to that one company.
  A list page is a page whose subject is a category, and the company
  is only one of many named inside it.
- If two entries in the batch refer to the same underlying company
  under different names — a company and its subsidiary, its legal
  entity name, or its brand name — only the primary entry is valid.
  The duplicate must be marked invalid.
- If the user request includes a signal, a company is only valid if
  at least one of its mentions contains direct evidence of that
  signal. A page that merely lists the company, describes its
  services, or refers to it in passing is not direct evidence. If
  no direct evidence of the signal exists, the company is invalid.
  Example: if the signal is hiring for a role, the company must have
  a mention showing hiring for that role. A directory entry is not
  proof. Example: if the signal is expanding locations, the company
  must have a mention showing expansion. A profile page is not proof.
  Example: if the signal is recently raised funding, the company must
  have a mention showing funding. A list of funded companies is not
  proof unless the company itself is the subject.
- A company is invalid if its primary business is in a different
  industry than the one the user asked for, even if it operates in
  multiple industries or is mentioned in a context related to the
  requested industry. The company must be primarily known for the
  industry the user is looking for.
- Consider the original user request carefully. Use the complete
  meaning of the request, not keyword matching.

Do not:

- invent companies that are not in the batch
- change company names
- invent mentions
- add recommendations or evidence
- add confidence scores
- invent unnecessary details

Return only valid JSON using exactly this format:

{
  "verified": [
    {
      "name": "the company name",
      "rating": 0,
      "status": "valid",
      "reason": "the explanation"
    }
  ]
}

Every company in the batch must appear in the returned "verified" array,
in the same order as the batch.

If the batch is empty, return:

{
  "verified": []
}

Do not explain your answer.
Do not add extra fields.
Do not remove any fields.
Do not invent unnecessary details.
`;

// ────────────────────────────────────────────────────────────────
// VERIFICATION REQUEST
// ────────────────────────────────────────────────────────────────

// Receives the Separation output and the Understanding output.
// Verifies each company against the original request.
// Chunks the companies into batches of CHUNK_SIZE and calls the AI
// separately for each batch. Each chunk is retried up to
// MAX_ATTEMPTS_PER_CHUNK times. If a chunk fails on all attempts, the
// companies in that chunk are marked as unverified.
//
// If every chunk fails, the entire output becomes a friendly message.
//
// Returns:
//   { verified, qualified, summary } on success
//   { message } on total failure

async function verificationRequest(separation, understanding) {
    console.log('[Verification] Started');
    console.log('[Verification] Received understanding:', understanding);

    const companies =
        separation && Array.isArray(separation.companies)
            ? separation.companies.filter(
                  (c) =>
                      c &&
                      typeof c === 'object' &&
                      typeof c.name === 'string' &&
                      c.name.trim().length > 0
              )
            : [];

    console.log(
        '[Verification] Received',
        companies.length,
        'compan(ies) to verify'
    );

    // ── No companies — return empty lists, no AI call ──
    if (companies.length === 0) {
        console.log(
            '[Verification] No companies to verify. Returning empty lists.'
        );

        return {
            verified: [],
            qualified: [],
            summary: {
                total: 0,
                valid: 0,
                invalid: 0,
                qualified: 0,
            },
        };
    }

    // ── Chunk the companies ──
    const chunks = [];

    for (let i = 0; i < companies.length; i += CHUNK_SIZE) {
        chunks.push(companies.slice(i, i + CHUNK_SIZE));
    }

    console.log(
        `[Verification] Split into ${chunks.length} chunk(s) of up to ${CHUNK_SIZE} companies`
    );

    // ── Verify each chunk ──
    const verified = [];
    let successfulChunks = 0;

    for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];

        console.log(
            `[Verification] Chunk ${c + 1}/${chunks.length} — ${chunk.length} compan(ies)`
        );

        const chunkResult = await verifyChunk(chunk, understanding);

        if (chunkResult) {
            successfulChunks++;

            for (let i = 0; i < chunkResult.length; i++) {
                const verifiedCompany = chunkResult[i];
                const original = chunk[i];

                verified.push({
                    name:
                        typeof verifiedCompany.name === 'string' &&
                        verifiedCompany.name.trim().length > 0
                            ? verifiedCompany.name.trim()
                            : original.name,

                    rating:
                        Number.isInteger(verifiedCompany.rating) &&
                        verifiedCompany.rating >= 1 &&
                        verifiedCompany.rating <= 10
                            ? verifiedCompany.rating
                            : null,

                    status:
                        verifiedCompany.status === 'valid' ||
                        verifiedCompany.status === 'invalid'
                            ? verifiedCompany.status
                            : 'unverified',

                    reason:
                        typeof verifiedCompany.reason === 'string' &&
                        verifiedCompany.reason.trim().length > 0
                            ? verifiedCompany.reason.trim()
                            : '',

                    mentions: Array.isArray(original.mentions)
                        ? original.mentions
                        : [],
                });
            }
        } else {
            console.warn(
                `[Verification] Chunk ${c + 1} failed. Marking ${chunk.length} compan(ies) as unverified.`
            );

            for (const original of chunk) {
                verified.push({
                    name: original.name,
                    rating: null,
                    status: 'unverified',
                    reason: 'AI verification failed for this batch',
                    mentions: Array.isArray(original.mentions)
                        ? original.mentions
                        : [],
                });
            }
        }
    }

    // ── If every chunk failed, return the friendly message ──
    if (successfulChunks === 0) {
        console.warn(
            '[Verification] All chunks failed. Using fallback message.'
        );

        return {
            message: FALLBACK_MESSAGE,
        };
    }

    // ── Sort verified by rating descending, then name alphabetically ──
    verified.sort((a, b) => {
        const aRating = typeof a.rating === 'number' ? a.rating : -Infinity;
        const bRating = typeof b.rating === 'number' ? b.rating : -Infinity;

        if (aRating !== bRating) return bRating - aRating;

        return a.name.localeCompare(b.name);
    });

    // ── Build the qualified list ──
    //    Only companies whose rating is a number >= MIN_QUALIFIED_RATING
    //    AND whose status is "valid" appear in the qualified list.
    //    Unverified companies (rating === null) are excluded.
    //    Invalid companies are excluded even if their rating is high.
    const qualified = verified.filter(
        (c) =>
            typeof c.rating === 'number' &&
            c.rating >= MIN_QUALIFIED_RATING &&
            c.status === 'valid'
    );

    // ── Compute summary ──
    let valid = 0;
    let invalid = 0;

    for (const c of verified) {
        if (c.status === 'valid') valid++;
        else if (c.status === 'invalid') invalid++;
    }

    const result = {
        verified,
        qualified,
        summary: {
            total: verified.length,
            valid,
            invalid,
            qualified: qualified.length,
        },
    };

    console.log(
        '[Verification] Final result:',
        `total=${result.summary.total}`,
        `valid=${result.summary.valid}`,
        `invalid=${result.summary.invalid}`,
        `qualified=${result.summary.qualified}`
    );

    return result;
}

// ────────────────────────────────────────────────────────────────
// VERIFY ONE CHUNK — AI CALL WITH RETRIES
// ────────────────────────────────────────────────────────────────

async function verifyChunk(chunk, understanding) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_CHUNK; attempt++) {
        console.log(
            `[Verification] AI attempt ${attempt}/${MAX_ATTEMPTS_PER_CHUNK}`
        );

        try {
            const userContent =
                `Understanding output:\n${JSON.stringify(
                    understanding,
                    null,
                    2
                )}\n\nCompanies to verify:\n${JSON.stringify(
                    chunk.map((c) => ({
                        name: c.name,
                        mentions: c.mentions,
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
                '[Verification] OpenAI response received'
            );

            const content = completion.choices?.[0]?.message?.content;

            console.log(
                '[Verification] Raw model response:',
                content
            );

            if (!content) {
                console.error(
                    '[Verification] Model returned an empty response'
                );
                continue;
            }

            const parsedResult = JSON.parse(content);

            console.log(
                '[Verification] Parsed model response:',
                parsedResult
            );

            const rawVerified = parsedResult?.verified;

            const verifiedList = Array.isArray(rawVerified)
                ? rawVerified.filter(
                      (v) =>
                          v &&
                          typeof v === 'object' &&
                          typeof v.name === 'string' &&
                          v.name.trim().length > 0
                  )
                : [];

            if (verifiedList.length > 0) {
                const aligned = chunk.map((original, i) => {
                    const match = verifiedList[i];

                    return match && typeof match === 'object'
                        ? match
                        : {
                              name: original.name,
                              rating: null,
                              status: 'unverified',
                              reason:
                                  'AI did not return a verification for this company',
                          };
                });

                console.log(
                    '[Verification] Valid results from AI:',
                    aligned.length
                );

                return aligned;
            }

            console.warn(
                '[Verification] No valid results returned from chunk'
            );
        } catch (error) {
            console.error(
                `[Verification] AI attempt ${attempt} failed`
            );

            console.error(
                '[Verification] Error name:',
                error.name
            );
            console.error(
                '[Verification] Error message:',
                error.message
            );
            console.error(
                '[Verification] Error status:',
                error.status
            );
            console.error(
                '[Verification] Full error:',
                error
            );
        }
    }

    console.warn(
        '[Verification] All AI attempts failed for this chunk.'
    );

    return null;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = verificationRequest;
