'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const searchHandler = require('./SearchHandler');

// ────────────────────────────────────────────────────────────────
// SEARCH CONTROLLER
// ────────────────────────────────────────────────────────────────

// Receives the SearchGeneration output — { searches: [...] }.
// Sends each search phrase, one at a time, to SearchHandler.
// SearchHandler performs the actual search and saves the result
// to Handling.js.
//
// This file does not perform the search. It does not talk to Tavily.
// It does not save results. It only loops and dispatches.
//
// Returns a completion signal:
//   { completed: true, searchesProcessed: N } on success
//   { completed: false, searchesProcessed: 0, reason: '...' } if no searches

async function searchController(searchGeneration) {
    console.log('[SearchController] Started');
    console.log(
        '[SearchController] Received searchGeneration:',
        searchGeneration
    );

    // ── Guard: no generation output ──
    if (!searchGeneration || typeof searchGeneration !== 'object') {
        console.warn('[SearchController] No searchGeneration output received');

        return {
            completed: false,
            searchesProcessed: 0,
            reason: 'no searchGeneration output',
        };
    }

    // ── Read the searches ──
    const searches = Array.isArray(searchGeneration.searches)
        ? searchGeneration.searches.filter(
              (s) => typeof s === 'string' && s.trim().length > 0
          )
        : [];

    // ── Guard: no searches ──
    if (searches.length === 0) {
        const reason =
            typeof searchGeneration.message === 'string' &&
            searchGeneration.message.trim()
                ? searchGeneration.message.trim()
                : 'no searches available';

        console.warn('[SearchController] No searches to process:', reason);

        return {
            completed: false,
            searchesProcessed: 0,
            reason,
        };
    }

    console.log(
        `[SearchController] Processing ${searches.length} search(es)`
    );

    // ── Sequential dispatch ──
    let searchesProcessed = 0;

    for (let i = 0; i < searches.length; i++) {
        const searchPhrase = searches[i];

        console.log(
            `[SearchController] Sending search ${i + 1}/${searches.length}:`,
            searchPhrase
        );

        try {
            await searchHandler(searchPhrase);

            searchesProcessed += 1;

            console.log(
                `[SearchController] Search ${i + 1} completed`
            );
        } catch (err) {
            console.error(
                `[SearchController] Search ${i + 1} failed:`,
                err && err.message ? err.message : err
            );
            // Skip the failed search and continue with the next one.
        }
    }

    console.log(
        `[SearchController] Completed. ${searchesProcessed}/${searches.length} searches processed`
    );

    return {
        completed: true,
        searchesProcessed,
    };
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = searchController;
