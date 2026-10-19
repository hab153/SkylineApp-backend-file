// ────────────────────────────────────────────────────────────────
// ContactPages.js — Company Page URL Discovery
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
const MAX_MAP_ATTEMPTS = 4;

const TAVILY_MAP_ENDPOINT = 'https://api.tavily.com/map';

// Mandatory instruction — never omitted, never rewritten.
const MAP_INSTRUCTIONS =
    'Find the contact page, about page, locations page, and careers page. Return only page URLs, not blog posts.';

const FALLBACK_MESSAGE =
    'Our server is currently experiencing high traffic. Please try again shortly.';

// ────────────────────────────────────────────────────────────────
// AI INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given a company name and the raw search results that were
collected for that company.

Your only task is to identify the company's official domain.

The raw search results are a list of pages. Some of them belong to the
company's own website. Others belong to third-party sites such as
Wikipedia, LinkedIn, X, Facebook, news sites, directories, job boards,
or review platforms.

Your job is to find the URL that belongs to the company's own website.

Rules:

1. Return only the base domain — the scheme and hostname. Strip any
   path, query string, or fragment.

   Example:
   Input URL:  https://www.maximhealthcare.com/about-us/
   Output:     https://www.maximhealthcare.com

2. The domain must belong to the company itself, not to a third-party
   site. Do not return Wikipedia, LinkedIn, X, Facebook, news sites,
   directories, job boards, or review platforms.

3. If you cannot identify the company's own domain from the results,
   return null for the domain.

4. Do not invent a domain. Only use URLs that appear in the results.

Return only valid JSON using exactly this format:

{
  "domain": "https://www.example.com"
}

If no domain can be identified, return:

{
  "domain": null
}

Do not explain your answer.
Do not add extra fields.
`;

// ────────────────────────────────────────────────────────────────
// AI DOMAIN IDENTIFICATION — WITH RETRIES
// ────────────────────────────────────────────────────────────────

async function identifyDomain(companyName, tavilyResults) {
    for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
        console.log(
            `[ContactPages] AI attempt ${attempt}/${MAX_AI_ATTEMPTS} for: ${companyName}`
        );

        try {
            // Build a compact list of the search results for the AI.
            const resultsForAI = (tavilyResults || []).map((item) => ({
                title: item.title || '',
                url: item.url || '',
                content: (item.content || '').slice(0, 300),
            }));

            const completion = await openai.chat.completions.create({
                model: MODEL,
                temperature: 0,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: SYSTEM_INSTRUCTIONS },
                    {
                        role: 'user',
                        content: `Company name: ${companyName}\n\nRaw search results:\n${JSON.stringify(resultsForAI, null, 2)}`,
                    },
                ],
            });

            const content = completion.choices?.[0]?.message?.content;
            console.log('[ContactPages] AI raw response:', content);

            if (!content) {
                console.error('[ContactPages] AI returned empty content');
                continue;
            }

            const parsed = JSON.parse(content);
            const rawDomain = parsed?.domain;

            if (rawDomain === null) {
                console.warn(
                    `[ContactPages] AI returned null domain for: ${companyName}`
                );
                return null;
            }

            if (typeof rawDomain !== 'string' || rawDomain.trim().length === 0) {
                console.warn('[ContactPages] AI returned invalid domain');
                continue;
            }

            const domain = normalizeDomain(rawDomain);

            if (!domain) {
                console.warn(
                    '[ContactPages] AI domain could not be normalized:',
                    rawDomain
                );
                continue;
            }

            console.log(`[ContactPages] AI identified domain: ${domain}`);
            return domain;
        } catch (error) {
            console.error(
                `[ContactPages] AI attempt ${attempt} failed:`,
                error && error.message ? error.message : error
            );
        }
    }

    console.warn('[ContactPages] All AI attempts failed for:', companyName);
    return null;
}

// ────────────────────────────────────────────────────────────────
// DOMAIN NORMALIZATION
// ────────────────────────────────────────────────────────────────

// Normalizes a URL to its base origin — scheme + hostname only.
// Returns null if the input cannot be parsed as a URL.

function normalizeDomain(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
        return null;
    }

    let input = rawUrl.trim();

    // If no scheme, assume https
    if (!/^https?:\/\//i.test(input)) {
        input = 'https://' + input;
    }

    try {
        const parsed = new URL(input);
        return `${parsed.protocol}//${parsed.hostname}`;
    } catch (_) {
        return null;
    }
}

// ────────────────────────────────────────────────────────────────
// TAVILY MAP REQUEST — WITH RETRIES
// ────────────────────────────────────────────────────────────────

async function runTavilyMap(domain) {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
        console.error('[ContactPages] TAVILY_API_KEY is not set');
        return null;
    }

    for (let attempt = 1; attempt <= MAX_MAP_ATTEMPTS; attempt++) {
        console.log(
            `[ContactPages] Map attempt ${attempt}/${MAX_MAP_ATTEMPTS} for: ${domain}`
        );

        try {
            const response = await fetch(TAVILY_MAP_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    url: domain,
                    instructions: MAP_INSTRUCTIONS,
                }),
            });

            console.log('[ContactPages] Map HTTP status:', response.status);

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '');
                console.error(
                    `[ContactPages] Map failed with status ${response.status}: ${errorBody}`
                );
                continue;
            }

            const mapResponse = await response.json();

            console.log(
                '[ContactPages] Map response received. URLs found:',
                Array.isArray(mapResponse && mapResponse.results)
                    ? mapResponse.results.length
                    : 0
            );

            return mapResponse;
        } catch (error) {
            console.error(
                `[ContactPages] Map attempt ${attempt} failed:`,
                error && error.message ? error.message : error
            );
        }
    }

    console.warn('[ContactPages] All Map attempts failed for:', domain);
    return null;
}

// ────────────────────────────────────────────────────────────────
// CONTACT PAGES REQUEST — MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function contactPagesRequest(finderOutput) {
    const startedAt = Date.now();
    console.log('[ContactPages] Started');

    // ── Guard: Finder failed → return the same friendly message ──
    if (
        !finderOutput ||
        typeof finderOutput !== 'object' ||
        typeof finderOutput.message === 'string'
    ) {
        console.warn(
            '[ContactPages] Finder output is a fallback message. Returning it.'
        );

        return {
            message:
                (finderOutput && finderOutput.message) || FALLBACK_MESSAGE,
        };
    }

    const companies = Array.isArray(finderOutput.companies)
        ? finderOutput.companies
        : [];

    if (companies.length === 0) {
        console.warn(
            '[ContactPages] No companies to process. Returning friendly message.'
        );

        return {
            message: FALLBACK_MESSAGE,
        };
    }

    // ── Process each company sequentially ──
    const pages = [];

    for (let i = 0; i < companies.length; i++) {
        const company = companies[i];
        const companyStart = Date.now();

        console.log(
            `[ContactPages] Processing company ${i + 1}/${companies.length}: ${company.name}`
        );

        // Extract Tavily search results for this company.
        const tavilyResults = Array.isArray(company.results?.results)
            ? company.results.results
            : [];

        if (tavilyResults.length === 0) {
            console.warn(
                `[ContactPages] No search results for ${company.name} — skipping`
            );
            continue;
        }

        // Step 1: AI identifies the domain.
        const domain = await identifyDomain(company.name, tavilyResults);

        if (!domain) {
            console.warn(
                `[ContactPages] No domain identified for ${company.name} — skipping`
            );
            continue;
        }

        // Step 2: Tavily Map request.
        const mapResponse = await runTavilyMap(domain);

        if (!mapResponse) {
            console.warn(
                `[ContactPages] Map failed for ${company.name} — skipping`
            );
            continue;
        }

        // Step 3: Collect.
        pages.push({
            name: company.name,
            domain,
            mapResponse,
        });

        console.log(
            `[ContactPages] Company ${i + 1} completed (${Date.now() - companyStart}ms)`
        );
    }

    // ── If no companies succeeded, fallback ──
    if (pages.length === 0) {
        const elapsed = Date.now() - startedAt;
        console.warn(
            `[ContactPages] No companies succeeded (${elapsed}ms). Returning friendly message.`
        );

        return {
            message: FALLBACK_MESSAGE,
        };
    }

    // ── Return ──
    const elapsed = Date.now() - startedAt;

    const output = {
        pages,
    };

    console.log(
        `[ContactPages] Finished — ${pages.length}/${companies.length} companies succeeded in ${elapsed}ms`
    );

    return output;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = contactPagesRequest;
