'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const { keeping } = require('./Keeping');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const TAVILY_MAP_ENDPOINT = 'https://api.tavily.com/map';
const TAVILY_EXTRACT_ENDPOINT = 'https://api.tavily.com/extract';

// How many URLs from the Map result are sent to Extract per company.
const MAX_URLS_FOR_EXTRACT = 5;

// Map discovery parameters.
const MAP_PARAMS = {
    instructions: 'Find the about and contact pages',
    max_depth: 2,
    limit: 20,
};

// Extract parameters.
const EXTRACT_PARAMS = {
    format: 'markdown',
    extract_depth: 'basic',
};

// ────────────────────────────────────────────────────────────────
// READ TAVILY API KEY
// ────────────────────────────────────────────────────────────────

function readApiKey() {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        throw new Error(
            '[SearchingCompany] TAVILY_API_KEY is not set in the environment'
        );
    }

    return apiKey;
}

// ────────────────────────────────────────────────────────────────
// MAP A DOMAIN
// ────────────────────────────────────────────────────────────────

// Calls Tavily Map on the given domain, asking for the about and
// contact pages. Returns the raw response on success, or null on
// failure.

async function mapDomain(domain, apiKey) {
    console.log('[SearchingCompany] Map request for domain:', domain);

    try {
        const response = await fetch(TAVILY_MAP_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                url: domain,
                ...MAP_PARAMS,
            }),
        });

        console.log(
            '[SearchingCompany] Map HTTP status:',
            response.status
        );

        if (!response.ok) {
            let errorBody = '';

            try {
                errorBody = await response.text();
            } catch (_) {
                errorBody = '(unable to read error body)';
            }

            console.error(
                `[SearchingCompany] Map request failed with status ${response.status}: ${errorBody}`
            );

            return null;
        }

        const tavilyResponse = await response.json();

        console.log(
            '[SearchingCompany] Map response received. URLs:',
            Array.isArray(tavilyResponse && tavilyResponse.results)
                ? tavilyResponse.results.length
                : 0
        );

        return tavilyResponse;
    } catch (err) {
        console.error(
            '[SearchingCompany] Map request error:',
            err && err.message ? err.message : err
        );

        return null;
    }
}

// ────────────────────────────────────────────────────────────────
// EXTRACT PAGES
// ────────────────────────────────────────────────────────────────

// Calls Tavily Extract on the given URLs. Returns the raw response on
// success, or null on failure.

async function extractPages(urls, apiKey) {
    if (!Array.isArray(urls) || urls.length === 0) {
        return null;
    }

    console.log(
        '[SearchingCompany] Extract request for URLs:',
        urls.length
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
                ...EXTRACT_PARAMS,
            }),
        });

        console.log(
            '[SearchingCompany] Extract HTTP status:',
            response.status
        );

        if (!response.ok) {
            let errorBody = '';

            try {
                errorBody = await response.text();
            } catch (_) {
                errorBody = '(unable to read error body)';
            }

            console.error(
                `[SearchingCompany] Extract request failed with status ${response.status}: ${errorBody}`
            );

            return null;
        }

        const tavilyResponse = await response.json();

        console.log(
            '[SearchingCompany] Extract response received. Pages:',
            Array.isArray(tavilyResponse && tavilyResponse.results)
                ? tavilyResponse.results.length
                : 0
        );

        return tavilyResponse;
    } catch (err) {
        console.error(
            '[SearchingCompany] Extract request error:',
            err && err.message ? err.message : err
        );

        return null;
    }
}

// ────────────────────────────────────────────────────────────────
// PROCESS ONE COMPANY
// ────────────────────────────────────────────────────────────────

// Takes one company from the DomainExtraction output and runs the
// full Path B flow:
//
//   1. If domain is null → skip
//   2. Map the domain → get URLs
//   3. Take the top N URLs → Extract their content
//   4. Save the entry via keeping(...)
//
// Returns a status object:
//   { status: 'skipped' | 'mapFailed' | 'extractFailed' | 'searched' }

async function processCompany(company, apiKey) {
    const name =
        company && typeof company.name === 'string' ? company.name : '';

    const domain =
        company && typeof company.domain === 'string' ? company.domain : '';

    // ── Skip if no domain ──
    if (!domain) {
        console.log(
            `[SearchingCompany] Skipping "${name}" — no domain`
        );

        keeping({
            name,
            domain: null,
            map: null,
            extract: null,
            skipped: true,
            mapFailed: false,
            extractFailed: false,
        });

        return { status: 'skipped' };
    }

    // ── Step 1: Map ──
    const mapResult = await mapDomain(domain, apiKey);

    if (!mapResult) {
        console.warn(
            `[SearchingCompany] Map failed for "${name}" (${domain})`
        );

        keeping({
            name,
            domain,
            map: null,
            extract: null,
            skipped: false,
            mapFailed: true,
            extractFailed: false,
        });

        return { status: 'mapFailed' };
    }

    // ── Step 2: Extract top N URLs ──
    const urls = Array.isArray(mapResult.results)
        ? mapResult.results.slice(0, MAX_URLS_FOR_EXTRACT)
        : [];

    const extractResult = await extractPages(urls, apiKey);

    if (!extractResult) {
        console.warn(
            `[SearchingCompany] Extract failed for "${name}" (${domain})`
        );

        keeping({
            name,
            domain,
            map: mapResult,
            extract: null,
            skipped: false,
            mapFailed: false,
            extractFailed: true,
        });

        return { status: 'extractFailed' };
    }

    // ── Step 3: Save success ──
    keeping({
        name,
        domain,
        map: mapResult,
        extract: extractResult,
        skipped: false,
        mapFailed: false,
        extractFailed: false,
    });

    console.log(
        `[SearchingCompany] Search completed for "${name}" (${domain})`
    );

    return { status: 'searched' };
}

// ────────────────────────────────────────────────────────────────
// SEARCHING COMPANY REQUEST
// ────────────────────────────────────────────────────────────────

// Receives the DomainExtraction output.
// For each company with a domain, runs the Path B flow:
//   Map the domain → Extract the about/contact pages → save to Keeping
//
// Returns a completion signal with counts.

async function searchingCompanyRequest(domainExtraction) {
    console.log('[SearchingCompany] Started');
    console.log(
        '[SearchingCompany] Received domainExtraction:',
        domainExtraction
    );

    // ── Guard: no domainExtraction output ──
    if (!domainExtraction || typeof domainExtraction !== 'object') {
        console.warn(
            '[SearchingCompany] No domainExtraction output received'
        );

        return {
            completed: false,
            companiesProcessed: 0,
            companiesSearched: 0,
            companiesSkipped: 0,
            companiesFailed: 0,
            reason: 'no domainExtraction output',
        };
    }

    // ── Handle the friendly message shape from DomainExtraction ──
    if (
        typeof domainExtraction.message === 'string' &&
        domainExtraction.message.trim()
    ) {
        console.warn(
            '[SearchingCompany] DomainExtraction returned a message:',
            domainExtraction.message
        );

        return {
            completed: false,
            companiesProcessed: 0,
            companiesSearched: 0,
            companiesSkipped: 0,
            companiesFailed: 0,
            reason: domainExtraction.message.trim(),
        };
    }

    // ── Read the companies array ──
    const companies = Array.isArray(domainExtraction.companies)
        ? domainExtraction.companies.filter(
              (c) =>
                  c &&
                  typeof c === 'object' &&
                  typeof c.name === 'string' &&
                  c.name.trim().length > 0
          )
        : [];

    console.log(
        '[SearchingCompany] Companies to process:',
        companies.length
    );

    if (companies.length === 0) {
        return {
            completed: true,
            companiesProcessed: 0,
            companiesSearched: 0,
            companiesSkipped: 0,
            companiesFailed: 0,
        };
    }

    // ── Read the Tavily API key once ──
    let apiKey = '';

    try {
        apiKey = readApiKey();
    } catch (err) {
        console.error(
            '[SearchingCompany] Cannot read Tavily API key:',
            err && err.message ? err.message : err
        );

        return {
            completed: false,
            companiesProcessed: 0,
            companiesSearched: 0,
            companiesSkipped: 0,
            companiesFailed: 0,
            reason: 'missing TAVILY_API_KEY',
        };
    }

    // ── Counts ──
    let companiesSearched = 0;
    let companiesSkipped = 0;
    let companiesFailed = 0;

    // ── Process each company sequentially ──
    for (let i = 0; i < companies.length; i++) {
        const company = companies[i];

        console.log(
            `[SearchingCompany] Company ${i + 1}/${companies.length}: ${company.name}`
        );

        try {
            const result = await processCompany(company, apiKey);

            if (result.status === 'skipped') {
                companiesSkipped++;
            } else if (result.status === 'mapFailed') {
                companiesFailed++;
            } else if (result.status === 'extractFailed') {
                companiesSearched++; // Map succeeded
            } else if (result.status === 'searched') {
                companiesSearched++;
            }
        } catch (err) {
            console.error(
                `[SearchingCompany] Company ${i + 1} failed:`,
                err && err.message ? err.message : err
            );

            // Ensure the company is still saved in Keeping so downstream
            // has a record.
            keeping({
                name: company.name,
                domain:
                    typeof company.domain === 'string'
                        ? company.domain
                        : null,
                map: null,
                extract: null,
                skipped: false,
                mapFailed: true,
                extractFailed: false,
            });

            companiesFailed++;
        }
    }

    console.log(
        '[SearchingCompany] Completed.',
        `Searched: ${companiesSearched}`,
        `Skipped: ${companiesSkipped}`,
        `Failed: ${companiesFailed}`
    );

    return {
        completed: true,
        companiesProcessed: companies.length,
        companiesSearched,
        companiesSkipped,
        companiesFailed,
    };
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = searchingCompanyRequest;
