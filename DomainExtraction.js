'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const OpenAI = require('openai');

const { getAll } = require('./Handling');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';

// V1 exception: this layer retries up to 4 times per chunk.
const MAX_ATTEMPTS = 4;

// Number of companies processed per AI call.
const CHUNK_SIZE = 5;

const FALLBACK_MESSAGE =
    'Our server is currently experiencing high traffic. Please try again shortly.';

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given:

1. The Understanding output — the original user request, already
   understood. It contains the target entity, problem, intent, location,
   industry, qualification, signal, quantity, information, exclusions,
   and constraints.

2. A batch of companies. Each company has a search phrase and the raw
   search results that were returned for that phrase.

Your only task is to identify, for each company, its OFFICIAL WEBSITE
DOMAIN from the search results.

For each company you must produce one block with exactly two fields:

- name — the company name exactly as it appears in the search phrase
- domain — the company's official website domain (for example:
  "chicagomedicalexchange.com"). Do NOT include the protocol
  ("https://"), any path, or a trailing slash.

Rules for identifying the official domain:

- Read all the search results for the company. The official domain is
  the one that belongs to the company itself — the company's own
  website, not a third party that mentions the company.
- A result whose URL contains a well-known third-party host is NOT the
  official domain. For example, results from any of the following
  hosts must never be used as the official domain:
    linkedin.com, facebook.com, twitter.com, x.com, instagram.com,
    youtube.com, wikipedia.org, crunchbase.com, wellfound.com,
    indeed.com, glassdoor.com, builtin.com, builtinlondon.uk,
    fintechcareers.com, fintechjobsuk.com, jobleads.com,
    studysmarter.co.uk, big-picture.com, grow.london, reddit.com,
    medium.com, techcrunch.com, time.com, bloomberg.com, reuters.com,
    ft.com, revenuebase.ai, yelp.com, mapquest.com, bbb.org,
    healthgrades.com, zocdoc.com, vitals.com, webmd.com,
    manta.com, zoominfo.com, apollo.io, signalhire.com,
    pitchbook.com, owler.com, dnb.com, bizapedia.com.

- Prefer a result whose domain matches the company name closely
  (for example, "Chicago Medical Exchange" → a domain containing
  "chicagomedicalexchange").
- Ignore the protocol, path, query, and fragment when reading a URL.
- If you cannot clearly identify an official domain for a company,
  set domain to null.

Example of a good output:

{
  "companies": [
    {
      "name": "Chicago Medical Exchange",
      "domain": "chicagomedicalexchange.com"
    },
    {
      "name": "Unknown Company",
      "domain": null
    }
  ]
}

Rules:

- Return one block per company in the batch.
- Return the blocks in the same order as the companies in the batch.
- Do not invent companies that are not in the batch.
- Do not skip any company in the batch.
- Do not invent a domain that does not appear in the search results.
- If a company's domain cannot be identified, use null as shown.

Return only valid JSON using exactly this format:

{
  "companies": [
    {
      "name": "the company name",
      "domain": "the identified domain or null"
    }
  ]
}

Do not explain your answer.
Do not add extra fields.
Do not remove any fields.
Do not invent unnecessary details.
`;

// ────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────

// Extracts the company name from a search phrase.
// Search phrases are built by SearchGeneration.js using the template
// `"<Company Name>" <City> official website`, so the name is the
// content between the first pair of double quotes.
function extractCompanyNameFromSearch(searchPhrase) {
    if (typeof searchPhrase !== 'string') return '';

    const match = searchPhrase.match(/"([^"]+)"/);

    return match ? match[1].trim() : '';
}

// Extracts the domain from a URL string. Strips the protocol,
// any path/query/fragment, and a leading "www." if present.
function extractDomainFromUrl(url) {
    if (typeof url !== 'string' || url.trim().length === 0) return '';

    try {
        const parsed = new URL(url);

        let host = parsed.hostname.toLowerCase();

        if (host.startsWith('www.')) {
            host = host.slice(4);
        }

        return host;
    } catch (_) {
        return '';
    }
}

// ────────────────────────────────────────────────────────────────
// FALLBACK BLOCK
// ────────────────────────────────────────────────────────────────

// Builds a fallback per-company block used when the AI fails for a
// chunk, or when the AI returns a malformed result for a company.
function buildFallbackBlock(name) {
    return {
        name: typeof name === 'string' ? name : '',
        domain: null,
    };
}

// ────────────────────────────────────────────────────────────────
// NORMALIZE ONE COMPANY RESULT
// ────────────────────────────────────────────────────────────────

// Takes a raw company result from the AI (or from the chunk's
// original data if the AI dropped the entry) and returns a normalized
// block with the name and domain only.

function normalizeCompanyBlock(raw, fallbackName) {
    const name =
        raw && typeof raw.name === 'string' && raw.name.trim().length > 0
            ? raw.name.trim()
            : typeof fallbackName === 'string'
            ? fallbackName.trim()
            : '';

    const rawDomain =
        raw && typeof raw.domain === 'string' ? raw.domain.trim() : '';

    // Clean the domain: strip any protocol, path, or trailing slash
    // if the AI returned a full URL by mistake.
    let domain = '';

    if (rawDomain.length > 0) {
        if (rawDomain.includes('://')) {
            domain = extractDomainFromUrl(rawDomain);
        } else if (rawDomain.includes('/')) {
            domain = rawDomain.split('/')[0].toLowerCase();
            if (domain.startsWith('www.')) domain = domain.slice(4);
        } else {
            domain = rawDomain.toLowerCase();
            if (domain.startsWith('www.')) domain = domain.slice(4);
        }
    }

    if (domain.length === 0) {
        return buildFallbackBlock(name);
    }

    return {
        name,
        domain,
    };
}

// ────────────────────────────────────────────────────────────────
// EXTRACT ONE CHUNK — AI CALL WITH RETRIES
// ────────────────────────────────────────────────────────────────

// Sends one chunk of companies to the AI along with the Understanding
// output. Retries up to MAX_ATTEMPTS times. On total failure, returns
// null — the caller uses fallback blocks for that chunk.

async function extractChunk(chunk, understanding) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(
            `[DomainExtraction] AI attempt ${attempt}/${MAX_ATTEMPTS}`
        );

        try {
            const userContent =
                `Understanding output:\n${JSON.stringify(
                    understanding,
                    null,
                    2
                )}\n\nCompanies to process:\n${JSON.stringify(
                    chunk.map((c) => ({
                        name: c.name,
                        search: c.search,
                        results: c.response && Array.isArray(c.response.results)
                            ? c.response.results
                            : [],
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
                '[DomainExtraction] OpenAI response received'
            );

            const content = completion.choices?.[0]?.message?.content;

            console.log(
                '[DomainExtraction] Raw model response:',
                content
            );

            if (!content) {
                console.error(
                    '[DomainExtraction] Model returned an empty response'
                );
                continue;
            }

            const parsedResult = JSON.parse(content);

            console.log(
                '[DomainExtraction] Parsed model response:',
                parsedResult
            );

            const rawCompanies = parsedResult?.companies;

            const companiesList = Array.isArray(rawCompanies)
                ? rawCompanies
                : [];

            if (companiesList.length > 0) {
                // Align the AI's output back to the chunk in order.
                // If the AI dropped a company, fill it with a fallback.
                const aligned = chunk.map((original, i) => {
                    const match = companiesList[i];

                    return normalizeCompanyBlock(
                        match && typeof match === 'object' ? match : null,
                        original.name
                    );
                });

                console.log(
                    '[DomainExtraction] Valid results from AI:',
                    aligned.length
                );

                return aligned;
            }

            console.warn(
                '[DomainExtraction] No valid companies returned from chunk'
            );
        } catch (error) {
            console.error(
                `[DomainExtraction] AI attempt ${attempt} failed`
            );

            console.error(
                '[DomainExtraction] Error name:',
                error.name
            );
            console.error(
                '[DomainExtraction] Error message:',
                error.message
            );
            console.error(
                '[DomainExtraction] Error status:',
                error.status
            );
            console.error(
                '[DomainExtraction] Full error:',
                error
            );
        }
    }

    console.warn(
        '[DomainExtraction] All AI attempts failed for this chunk.'
    );

    return null;
}

// ────────────────────────────────────────────────────────────────
// DOMAIN EXTRACTION REQUEST
// ────────────────────────────────────────────────────────────────

// Receives the SearchController output and the Understanding output.
// Calls Handling.getAll() to take all accumulated Tavily results.
// Chunks them (CHUNK_SIZE per call), sends each chunk to the AI,
// and returns one block per company with the official domain.
//
// Retries up to MAX_ATTEMPTS per chunk. On total failure for a chunk,
// the companies in that chunk are returned with domain: null.
// On total failure for all chunks, returns the friendly message.
//
// Returns:
//   { companies, summary } on success
//   { message } on total failure

async function domainExtractionRequest(searchController, understanding) {
    console.log('[DomainExtraction] Started');
    console.log('[DomainExtraction] Received understanding:', understanding);

    // ── Take all accumulated results from Handling ──
    let allResults = [];

    try {
        const taken = getAll();
        allResults = Array.isArray(taken) ? taken : [];
    } catch (error) {
        console.error(
            '[DomainExtraction] Failed to collect from Handling:',
            error && error.message ? error.message : error
        );

        allResults = [];
    }

    console.log(
        '[DomainExtraction] Collected',
        allResults.length,
        'result set(s) from Handling'
    );

    // ── No results — return empty companies list ──
    if (allResults.length === 0) {
        return {
            companies: [],
            summary: {
                total: 0,
                withDomain: 0,
                withoutDomain: 0,
            },
        };
    }

    // ── Normalize each entry: extract name from the search phrase ──
    const entries = [];

    for (const entry of allResults) {
        if (!entry || typeof entry !== 'object') continue;

        const searchPhrase =
            typeof entry.search === 'string' ? entry.search : '';

        const name = extractCompanyNameFromSearch(searchPhrase);

        if (name.length === 0) continue;

        entries.push({
            name,
            search: searchPhrase,
            response: entry.response,
        });
    }

    console.log(
        '[DomainExtraction] Normalized entries:',
        entries.length
    );

    if (entries.length === 0) {
        return {
            companies: [],
            summary: {
                total: 0,
                withDomain: 0,
                withoutDomain: 0,
            },
        };
    }

    // ── Chunk the entries ──
    const chunks = [];

    for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
        chunks.push(entries.slice(i, i + CHUNK_SIZE));
    }

    console.log(
        `[DomainExtraction] Split into ${chunks.length} chunk(s) of up to ${CHUNK_SIZE} companies`
    );

    // ── Process each chunk ──
    const companies = [];
    let successfulChunks = 0;

    for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];

        console.log(
            `[DomainExtraction] Chunk ${c + 1}/${chunks.length} — ${chunk.length} compan(ies)`
        );

        const chunkResult = await extractChunk(chunk, understanding);

        if (chunkResult) {
            successfulChunks++;

            for (const block of chunkResult) {
                companies.push(block);
            }
        } else {
            // Chunk failed on all attempts — mark every company as
            // domain: null.
            console.warn(
                `[DomainExtraction] Chunk ${c + 1} failed. Marking ${chunk.length} compan(ies) as domain: null.`
            );

            for (const original of chunk) {
                companies.push(buildFallbackBlock(original.name));
            }
        }
    }

    // ── If every chunk failed, return the friendly message ──
    if (successfulChunks === 0) {
        console.warn(
            '[DomainExtraction] All chunks failed. Using fallback message.'
        );

        return {
            message: FALLBACK_MESSAGE,
        };
    }

    // ── Compute summary ──
    let withDomain = 0;
    let withoutDomain = 0;

    for (const c of companies) {
        if (typeof c.domain === 'string' && c.domain.length > 0) {
            withDomain++;
        } else {
            withoutDomain++;
        }
    }

    const result = {
        companies,
        summary: {
            total: companies.length,
            withDomain,
            withoutDomain,
        },
    };

    console.log(
        '[DomainExtraction] Final result:',
        `total=${result.summary.total}`,
        `withDomain=${result.summary.withDomain}`,
        `withoutDomain=${result.summary.withoutDomain}`
    );

    return result;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = domainExtractionRequest;
