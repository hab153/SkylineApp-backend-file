'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const { getAll } = require('./Saving');

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
// Returns the summary and the full accumulated array as-is.
//
// It does not search. It does not verify. It does not decide meaning.
// It does not run AI. It only collects the raw data from Saving and
// hands it through.

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

    // ── Build the result ──
    // No AI. No separation. No company extraction.
    // The raw search results are passed through unchanged.
    const result = {
        collected,
        totalResults,
        results: allResults,
        companies: [],
    };

    console.log(
        '[Separation] Final result:',
        `collected=${collected}`,
        `totalResults=${totalResults}`
    );

    return result;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = separationRequest;
