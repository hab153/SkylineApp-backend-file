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

// Tavily Extract accepts up to 20 URLs per batch. We cap the merged
// URL list at 20 so the downstream stage can extract them in one call.
const MAX_EXTRACT_URLS = 20;

const TAVILY_MAP_ENDPOINT = 'https://api.tavily.com/map';
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';

// Mandatory instruction — never omitted, never rewritten.
const MAP_INSTRUCTIONS =
    'Find the contact page, about page, locations page, and careers page. Return only page URLs, not blog posts.';

// Tuned Map parameters.
//
// max_depth: 2 — allows the crawler to go one level deeper, which
//   recovers companies whose contact/about pages aren't linked
//   directly from the homepage.
// limit: 25 — enough URLs to cover contact/about/locations/careers
//   without over-crawling large sites.
// select_paths — focuses the crawler on the exact path patterns
//   that contain contact data.
const TAVILY_MAP_PARAMS = {
    max_depth: 2,
    max_breadth: 5,
    limit: 25,
    timeout: 25,
    allow_external: false,
    include_usage: true,
    select_paths: [
        '/contact.*',
        '/contact-us.*',
        '/about.*',
        '/about-us.*',
        '/locations.*',
        '/location.*',
        '/careers.*',
        '/career.*',
    ],
};

// Search fallback parameters — used only when Map fails or returns 0.
const TAVILY_SEARCH_PARAMS = {
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

function normalizeDomain(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
        return null;
    }

    let input = rawUrl.trim();

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
// EXPECTED CONTACT URLS
// ────────────────────────────────────────────────────────────────

// Standard contact-related paths that exist on the vast majority of
// company websites. These are ALWAYS included in the extraction list,
// regardless of what Tavily Map returns — because even if the crawler
// missed them, the pages still exist.
//
// Privacy, Terms, and Legal pages are included because they almost
// always contain a real contact email (legal@, dpo@, or privacy@)
// — a high-yield source for email discovery.
function buildExpectedContactUrls(domain) {
    const base = domain.replace(/\/$/, '');

    return [
        base,                     // homepage (footer usually has contact)
        `${base}/contact`,
        `${base}/contact-us`,
        `${base}/about`,
        `${base}/about-us`,
        `${base}/locations`,
        `${base}/careers`,
        `${base}/privacy`,        // often contains legal@ or dpo@
        `${base}/terms`,          // often contains legal@
        `${base}/legal`,          // often contains legal@ or privacy@
    ];
}

// Merges the standard expected URLs with whatever Map / Search
// returned. Dedupes and caps at MAX_EXTRACT_URLS.
// Priority: expected standard paths first (most likely to contain
// contact data), then Map / Search results.
function mergeContactUrls(domain, extraUrls) {
    const expected = buildExpectedContactUrls(domain);
    const seen = new Set();
    const result = [];

    // Priority 1: standard contact paths
    for (const url of expected) {
        if (result.length >= MAX_EXTRACT_URLS) break;
        if (!seen.has(url)) {
            seen.add(url);
            result.push(url);
        }
    }

    // Priority 2: Map / Search URLs
    for (const url of extraUrls) {
        if (result.length >= MAX_EXTRACT_URLS) break;
        if (typeof url !== 'string' || url.trim().length === 0) continue;

        const normalized = url.trim();

        if (!seen.has(normalized)) {
            seen.add(normalized);
            result.push(normalized);
        }
    }

    return result;
}

// ────────────────────────────────────────────────────────────────
// TAVILY MAP REQUEST — WITH RETRIES AND TUNED PARAMETERS
// ────────────────────────────────────────────────────────────────

async function runTavilyMap(domain) {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
        console.error('[ContactPages] TAVILY_API_KEY is not set');
        return null;
    }

    for (let attempt = 1; attempt <= MAX_MAP_ATTEMPTS; attempt++) {
        const startMs = Date.now();

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
                    ...TAVILY_MAP_PARAMS,
                }),
            });

            const elapsedMs = Date.now() - startMs;

            console.log(
                `[ContactPages] Map HTTP status: ${response.status} (${elapsedMs}ms)`
            );

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '');
                console.error(
                    `[ContactPages] Map failed with status ${response.status}: ${errorBody}`
                );
                continue;
            }

            const mapResponse = await response.json();

            const urlCount = Array.isArray(mapResponse && mapResponse.results)
                ? mapResponse.results.length
                : 0;

            console.log(
                '[ContactPages] Map response received. URLs found:',
                urlCount
            );

            return mapResponse;
        } catch (error) {
            const elapsedMs = Date.now() - startMs;
            console.error(
                `[ContactPages] Map attempt ${attempt} failed (${elapsedMs}ms):`,
                error && error.message ? error.message : error
            );
        }
    }

    console.warn('[ContactPages] All Map attempts failed for:', domain);
    return null;
}

// ────────────────────────────────────────────────────────────────
// TAVILY SEARCH FALLBACK — WHEN MAP RETURNS 0 URLS
// ────────────────────────────────────────────────────────────────

// Runs a Tavily Search restricted to the company's own domain to find
// contact/about pages. Used only when Map failed or returned 0 URLs.
async function runTavilySearchFallback(domain) {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
        console.error('[ContactPages] TAVILY_API_KEY is not set');
        return null;
    }

    // Strip protocol and leading www for include_domains.
    let hostname;
    try {
        hostname = new URL(domain).hostname.replace(/^www\./i, '');
    } catch (_) {
        return null;
    }

    for (let attempt = 1; attempt <= MAX_MAP_ATTEMPTS; attempt++) {
        const startMs = Date.now();

        console.log(
            `[ContactPages] Search fallback attempt ${attempt}/${MAX_MAP_ATTEMPTS} for: ${domain}`
        );

        try {
            const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    query: 'contact about locations',
                    include_domains: [hostname],
                    ...TAVILY_SEARCH_PARAMS,
                }),
            });

            const elapsedMs = Date.now() - startMs;

            console.log(
                `[ContactPages] Search fallback HTTP status: ${response.status} (${elapsedMs}ms)`
            );

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '');
                console.error(
                    `[ContactPages] Search fallback failed with status ${response.status}: ${errorBody}`
                );
                continue;
            }

            const searchResponse = await response.json();

            const urls = Array.isArray(searchResponse && searchResponse.results)
                ? searchResponse.results
                      .map((r) => (r && typeof r.url === 'string' ? r.url : null))
                      .filter((u) => u && u.trim().length > 0)
                : [];

            console.log(
                '[ContactPages] Search fallback received URLs:',
                urls.length
            );

            if (urls.length === 0) {
                continue;
            }

            return {
                base_url: domain,
                results: urls,
            };
        } catch (error) {
            const elapsedMs = Date.now() - startMs;
            console.error(
                `[ContactPages] Search fallback attempt ${attempt} failed (${elapsedMs}ms):`,
                error && error.message ? error.message : error
            );
        }
    }

    console.warn(
        '[ContactPages] All Search fallback attempts failed for:',
        domain
    );
    return null;
}

// ────────────────────────────────────────────────────────────────
// CONTACT PAGES REQUEST — MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function contactPagesRequest(finderOutput) {
    const startedAt = Date.now();
    console.log('[ContactPages] Started');

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

    const pages = [];

    for (let i = 0; i < companies.length; i++) {
        const company = companies[i];
        const companyStart = Date.now();

        console.log(
            `[ContactPages] Processing company ${i + 1}/${companies.length}: ${company.name}`
        );

        const tavilyResults = Array.isArray(company.results?.results)
            ? company.results.results
            : [];

        if (tavilyResults.length === 0) {
            console.warn(
                `[ContactPages] No search results for ${company.name} — skipping`
            );
            continue;
        }

        const domain = await identifyDomain(company.name, tavilyResults);

        if (!domain) {
            console.warn(
                `[ContactPages] No domain identified for ${company.name} — skipping`
            );
            continue;
        }

        // ── Step 1: Try Map first ──
        const mapResponse = await runTavilyMap(domain);

        let mapUrls =
            mapResponse && Array.isArray(mapResponse.results)
                ? mapResponse.results
                : [];

        console.log(
            `[ContactPages] Map produced ${mapUrls.length} URL(s) for ${company.name}`
        );

        // ── Step 2: If Map failed or returned 0 URLs, try Search ──
        let searchFallbackUrls = [];

        if (mapUrls.length === 0) {
            console.log(
                `[ContactPages] Map returned 0 URLs for ${company.name} — trying Search fallback`
            );

            const searchFallback = await runTavilySearchFallback(domain);

            if (searchFallback && Array.isArray(searchFallback.results)) {
                searchFallbackUrls = searchFallback.results;
                console.log(
                    `[ContactPages] Search fallback produced ${searchFallbackUrls.length} URL(s) for ${company.name}`
                );
            }
        }

        // ── Step 3: Merge standard contact paths + Map + Search ──
        const mergedUrls = mergeContactUrls(domain, [
            ...mapUrls,
            ...searchFallbackUrls,
        ]);

        console.log(
            `[ContactPages] Merged URL list for ${company.name}: ${mergedUrls.length} URL(s)`
        );

        if (mergedUrls.length === 0) {
            console.warn(
                `[ContactPages] No usable URLs for ${company.name} — skipping`
            );
            continue;
        }

        pages.push({
            name: company.name,
            domain,
            mapResponse: {
                base_url: domain,
                results: mergedUrls,
            },
        });

        console.log(
            `[ContactPages] Company ${i + 1} completed (${Date.now() - companyStart}ms)`
        );
    }

    if (pages.length === 0) {
        const elapsed = Date.now() - startedAt;
        console.warn(
            `[ContactPages] No companies succeeded (${elapsed}ms). Returning friendly message.`
        );

        return {
            message: FALLBACK_MESSAGE,
        };
    }

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
