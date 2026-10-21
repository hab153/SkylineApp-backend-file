// ────────────────────────────────────────────────────────────────
// Searching.js — Company Data Extraction and Lead Generation
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
const MAX_AI_ATTEMPTS = 4;
const MAX_EXTRACT_ATTEMPTS = 4;
const MAX_SEARCH_FALLBACK_ATTEMPTS = 4;

const TAVILY_EXTRACT_ENDPOINT = 'https://api.tavily.com/extract';
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';

// Extract params — Improvement 3:
//   chunks_per_source: 5 (max) — more chunks, higher chance of contact data
//   timeout: 60 (max) — slow pages get more time
const TAVILY_EXTRACT_PARAMS = {
    extract_depth: 'advanced',
    format: 'markdown',
    timeout: 60,
    include_usage: true,
    query: 'contact email phone number address company information',
    chunks_per_source: 5,
};

// Search fallback params — Improvement 1:
//   include_raw_content: true — returns page content in one call
//   max_results: 5 — top 5 pages only
const TAVILY_SEARCH_FALLBACK_PARAMS = {
    search_depth: 'advanced',
    max_results: 5,
    include_raw_content: true,
    include_answer: false,
    include_favicon: false,
    topic: 'general',
};

const FALLBACK_MESSAGE =
    'Our server is currently experiencing high traffic. Please try again shortly.';

// ────────────────────────────────────────────────────────────────
// AI INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given the extracted content from several pages of a single
company's official website.

Your task is to identify four pieces of information about the company:

1. Company name
2. Company email address
3. Company information (a short description)
4. Company phone number

Read all the extracted content carefully. The pages belong to one
company. Do not mix in information about any other company.

Rules:

Company name:
- Return the official name of the company as it appears on its own
  website.
- If the name cannot be identified, return null.

Company email:
- If a real email address is found in the content, return it, and set
  emailStatus to "verified".
- If no email is found but the company's domain and any naming patterns
  in the content make a reasonable prediction possible, return the
  predicted email, and set emailStatus to "predicted".
- If no email is found and no reasonable prediction is possible,
  return null, and set emailStatus to "not_found".
- Never present a prediction as if it were a confirmed email.

Company information:
- If the content describes the company, write a short description
  based only on that content, and set informationStatus to "verified".
- If the content does not describe the company but a tentative summary
  is reasonable, write a short tentative description, and set
  informationStatus to "estimated".
- Do not invent specific facts.

Company phone number:
- If a phone number is found in the content, return it.
- If no phone number is found, return "Not found".
- Never guess or invent a phone number.

Return only valid JSON using exactly this format:

{
  "companyName": "the official company name or null",
  "email": "the email address or null",
  "emailStatus": "verified" | "predicted" | "not_found",
  "companyInformation": "short description",
  "informationStatus": "verified" | "estimated",
  "phoneNumber": "the phone number or Not found"
}

Do not explain your answer.
Do not add extra fields.
`;

// ────────────────────────────────────────────────────────────────
// TAVILY EXTRACT — BATCH REQUEST WITH RETRIES
// ────────────────────────────────────────────────────────────────

async function runTavilyExtract(urls) {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
        console.error('[Searching] TAVILY_API_KEY is not set');
        return null;
    }

    if (!Array.isArray(urls) || urls.length === 0) {
        console.warn('[Searching] No URLs to extract');
        return null;
    }

    for (let attempt = 1; attempt <= MAX_EXTRACT_ATTEMPTS; attempt++) {
        const startMs = Date.now();

        console.log(
            `[Searching] Extract attempt ${attempt}/${MAX_EXTRACT_ATTEMPTS} for ${urls.length} URL(s)`
        );

        try {
            const response = await fetch(TAVILY_EXTRACT_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    urls,
                    ...TAVILY_EXTRACT_PARAMS,
                }),
            });

            const elapsedMs = Date.now() - startMs;

            console.log(
                `[Searching] Extract HTTP status: ${response.status} (${elapsedMs}ms)`
            );

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '');
                console.error(
                    `[Searching] Extract failed with status ${response.status}: ${errorBody}`
                );
                continue;
            }

            const extractResponse = await response.json();

            console.log(
                '[Searching] Extract response — successful:',
                Array.isArray(extractResponse.results)
                    ? extractResponse.results.length
                    : 0,
                'failed:',
                Array.isArray(extractResponse.failed_results)
                    ? extractResponse.failed_results.length
                    : 0
            );

            return extractResponse;
        } catch (error) {
            const elapsedMs = Date.now() - startMs;
            console.error(
                `[Searching] Extract attempt ${attempt} failed (${elapsedMs}ms):`,
                error && error.message ? error.message : error
            );
        }
    }

    console.warn('[Searching] All Extract attempts failed');
    return null;
}

// ────────────────────────────────────────────────────────────────
// TAVILY SEARCH FALLBACK — IMPROVEMENT 1
// ────────────────────────────────────────────────────────────────

// Runs a Tavily Search with include_raw_content to recover contact
// pages that Map/Extract failed to reach. The search is scoped to
// the company's own domain so the results come from the site we
// already know belongs to the company.

async function runTavilySearchFallback(domain) {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
        console.error('[Searching] TAVILY_API_KEY is not set');
        return null;
    }

    if (!domain || typeof domain !== 'string' || domain.trim().length === 0) {
        console.warn('[Searching] No domain for Search fallback');
        return null;
    }

    for (let attempt = 1; attempt <= MAX_SEARCH_FALLBACK_ATTEMPTS; attempt++) {
        const startMs = Date.now();

        console.log(
            `[Searching] Search fallback attempt ${attempt}/${MAX_SEARCH_FALLBACK_ATTEMPTS} for: ${domain}`
        );

        try {
            const query = `site:${new URL(domain).hostname} contact email phone`;

            const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    query,
                    ...TAVILY_SEARCH_FALLBACK_PARAMS,
                }),
            });

            const elapsedMs = Date.now() - startMs;

            console.log(
                `[Searching] Search fallback HTTP status: ${response.status} (${elapsedMs}ms)`
            );

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '');
                console.error(
                    `[Searching] Search fallback failed with status ${response.status}: ${errorBody}`
                );
                continue;
            }

            const searchResponse = await response.json();

            console.log(
                '[Searching] Search fallback response — results:',
                Array.isArray(searchResponse.results)
                    ? searchResponse.results.length
                    : 0
            );

            return searchResponse;
        } catch (error) {
            const elapsedMs = Date.now() - startMs;
            console.error(
                `[Searching] Search fallback attempt ${attempt} failed (${elapsedMs}ms):`,
                error && error.message ? error.message : error
            );
        }
    }

    console.warn('[Searching] All Search fallback attempts failed');
    return null;
}

// ────────────────────────────────────────────────────────────────
// AI EXTRACTION — ONE CALL PER COMPANY
// ────────────────────────────────────────────────────────────────

async function extractCompanyData(companyName, rawContent) {
    for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
        console.log(
            `[Searching] AI attempt ${attempt}/${MAX_AI_ATTEMPTS} for: ${companyName}`
        );

        try {
            const completion = await openai.chat.completions.create({
                model: MODEL,
                temperature: 0,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: SYSTEM_INSTRUCTIONS },
                    {
                        role: 'user',
                        content: `Company hint: ${companyName}\n\nExtracted content:\n${rawContent}`,
                    },
                ],
            });

            const content = completion.choices?.[0]?.message?.content;
            console.log('[Searching] AI raw response:', content);

            if (!content) {
                console.error('[Searching] AI returned empty content');
                continue;
            }

            const parsed = JSON.parse(content);

            const companyNameOut =
                typeof parsed?.companyName === 'string' &&
                parsed.companyName.trim().length > 0
                    ? parsed.companyName.trim()
                    : null;

            const email =
                typeof parsed?.email === 'string' &&
                parsed.email.trim().length > 0
                    ? parsed.email.trim()
                    : null;

            const rawStatus = parsed?.emailStatus;
            const emailStatus =
                rawStatus === 'verified' ||
                rawStatus === 'predicted' ||
                rawStatus === 'not_found'
                    ? rawStatus
                    : email
                    ? 'verified'
                    : 'not_found';

            const companyInformation =
                typeof parsed?.companyInformation === 'string'
                    ? parsed.companyInformation.trim()
                    : '';

            const rawInfoStatus = parsed?.informationStatus;
            const informationStatus =
                rawInfoStatus === 'verified' || rawInfoStatus === 'estimated'
                    ? rawInfoStatus
                    : 'verified';

            const phoneNumber =
                typeof parsed?.phoneNumber === 'string' &&
                parsed.phoneNumber.trim().length > 0
                    ? parsed.phoneNumber.trim()
                    : 'Not found';

            return {
                companyName: companyNameOut,
                email,
                emailStatus,
                companyInformation,
                informationStatus,
                phoneNumber,
            };
        } catch (error) {
            console.error(
                `[Searching] AI attempt ${attempt} failed:`,
                error && error.message ? error.message : error
            );
        }
    }

    console.warn('[Searching] All AI attempts failed for:', companyName);
    return null;
}

// ────────────────────────────────────────────────────────────────
// SEARCHING REQUEST — MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function searchingRequest(contactPagesOutput) {
    const startedAt = Date.now();
    console.log('[Searching] Started');

    if (
        !contactPagesOutput ||
        typeof contactPagesOutput !== 'object' ||
        typeof contactPagesOutput.message === 'string'
    ) {
        console.warn(
            '[Searching] ContactPages output is a fallback message. Returning it.'
        );

        return {
            message:
                (contactPagesOutput && contactPagesOutput.message) ||
                FALLBACK_MESSAGE,
        };
    }

    const pages = Array.isArray(contactPagesOutput.pages)
        ? contactPagesOutput.pages
        : [];

    if (pages.length === 0) {
        console.warn(
            '[Searching] No companies to process. Returning friendly message.'
        );

        return {
            message: FALLBACK_MESSAGE,
        };
    }

    const companies = [];

    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const companyStart = Date.now();

        const name =
            typeof page.name === 'string' && page.name.trim().length > 0
                ? page.name.trim()
                : `Company ${i + 1}`;

        console.log(
            `[Searching] Processing company ${i + 1}/${pages.length}: ${name}`
        );

        const urls = Array.isArray(page?.mapResponse?.results)
            ? page.mapResponse.results.filter(
                  (u) => typeof u === 'string' && u.trim().length > 0
              )
            : [];

        let combinedContent = '';
        let usedSearchFallback = false;

        if (urls.length > 0) {
            // ── Step 1: Extract all URLs for this company (one call) ──
            const extractResponse = await runTavilyExtract(urls);

            if (extractResponse) {
                const successfulResults = Array.isArray(extractResponse.results)
                    ? extractResponse.results
                    : [];

                // ── Improvement 1: if Extract failed on any URL,
                //    run a Search fallback with include_raw_content ──
                const failedCount = Array.isArray(
                    extractResponse.failed_results
                )
                    ? extractResponse.failed_results.length
                    : 0;

                if (failedCount > 0) {
                    console.warn(
                        `[Searching] ${failedCount} URL(s) failed to extract for ${name} — running Search fallback`
                    );

                    const searchFallback = await runTavilySearchFallback(
                        page.domain
                    );

                    if (searchFallback) {
                        usedSearchFallback = true;

                        const searchResults = Array.isArray(
                            searchFallback.results
                        )
                            ? searchFallback.results
                            : [];

                        for (const r of searchResults) {
                            const raw =
                                typeof r.raw_content === 'string'
                                    ? r.raw_content
                                    : '';
                            if (raw.trim().length > 0) {
                                combinedContent += `\n\n----- ${r.url || 'search result'} -----\n${raw}`;
                            }
                        }
                    }
                }

                // Add the content from the successful Extracts.
                for (const r of successfulResults) {
                    const raw =
                        typeof r.raw_content === 'string' ? r.raw_content : '';
                    if (raw.trim().length > 0) {
                        combinedContent += `\n\n----- ${r.url || 'page'} -----\n${raw}`;
                    }
                }
            }
        } else {
            // ── Improvement 1: no URLs from Map — go straight to Search fallback ──
            console.warn(
                `[Searching] No URLs for ${name} — running Search fallback`
            );

            const searchFallback = await runTavilySearchFallback(page.domain);

            if (searchFallback) {
                usedSearchFallback = true;

                const searchResults = Array.isArray(searchFallback.results)
                    ? searchFallback.results
                    : [];

                for (const r of searchResults) {
                    const raw =
                        typeof r.raw_content === 'string' ? r.raw_content : '';
                    if (raw.trim().length > 0) {
                        combinedContent += `\n\n----- ${r.url || 'search result'} -----\n${raw}`;
                    }
                }
            }
        }

        if (combinedContent.trim().length === 0) {
            console.warn(
                `[Searching] No usable content for ${name} — skipping`
            );
            continue;
        }

        // ── Step 2: AI extracts the 4 fields ──
        const record = await extractCompanyData(name, combinedContent);

        if (!record) {
            console.warn(
                `[Searching] AI extraction failed for ${name} — skipping`
            );
            continue;
        }

        if (!record.companyName) {
            record.companyName = name;
        }

        companies.push(record);

        console.log(
            `[Searching] Company ${i + 1} completed (${Date.now() - companyStart}ms)${usedSearchFallback ? ' [used Search fallback]' : ''}`
        );
    }

    if (companies.length === 0) {
        const elapsed = Date.now() - startedAt;
        console.warn(
            `[Searching] No companies succeeded (${elapsed}ms). Returning friendly message.`
        );

        return {
            message: FALLBACK_MESSAGE,
        };
    }

    const elapsed = Date.now() - startedAt;

    console.log(
        `[Searching] Finished — ${companies.length}/${pages.length} companies succeeded in ${elapsed}ms`
    );

    return {
        companies,
    };
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = searchingRequest;
