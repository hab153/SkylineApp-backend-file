'use strict';

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

// Take at most 10 companies from the verified list.
const MAX_COMPANIES = 10;

// ────────────────────────────────────────────────────────────────
// SEARCH GENERATION REQUEST
// ────────────────────────────────────────────────────────────────

// Receives the Verification output and the Understanding output.
// Takes up to MAX_COMPANIES (10) verified companies.
// For each company, builds a search phrase using a fixed template:
//
//   "<Company Name>" <City> official website
//
// The city is read from understanding.location.city.
// No AI is used — the template is applied deterministically.
//
// Returns:
//   { searches: [...] } on success
//   { searches: [] } if there are no companies to process

function searchGenerationRequest(verification, understanding) {
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

    // ── No companies — return empty searches ──
    if (companies.length === 0) {
        console.log(
            '[SearchGeneration] No companies. Returning empty searches list.'
        );

        return {
            searches: [],
        };
    }

    // ── Read the city from the Understanding output ──
    const city =
        understanding &&
        understanding.location &&
        typeof understanding.location.city === 'string'
            ? understanding.location.city.trim()
            : '';

    // ── Build one search per company using the fixed template ──
    const searches = [];

    for (const company of companies) {
        const name = company.name.trim();

        // Template: "<Company Name>" <City> official website
        // If the city is empty, fall back to just the name + official website
        const searchText = city
            ? `"${name}" ${city} official website`
            : `"${name}" official website`;

        searches.push(searchText);
    }

    console.log(
        '[SearchGeneration] Generated',
        searches.length,
        'search(es)'
    );
    console.log('[SearchGeneration] Searches:', searches);

    return {
        searches,
    };
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = searchGenerationRequest;
