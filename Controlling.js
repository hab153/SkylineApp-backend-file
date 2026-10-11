'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const { saveAllocation } = require('./Rule');
const searchSystem       = require('./SearchSystem');

// ────────────────────────────────────────────────────────────────
// CONTROLLING REQUEST
// ────────────────────────────────────────────────────────────────

// Controlling.js receives the Generation output, saves the allocation into
// Rule.js, then sends each search phrase one at a time to SearchSystem.js.
//
// It does not perform any search itself. It does not talk to Tavily. It does
// not store results. It only coordinates the dispatch of searches.

async function controllingRequest(generation) {
    console.log('[Controlling] Started');
    console.log('[Controlling] Received generation output:', generation);

    // ── Guard: no generation output ──
    if (!generation || typeof generation !== 'object') {
        console.warn('[Controlling] No generation output received');
        return {
            completed: false,
            searchesProcessed: 0,
            reason: 'no generation output',
        };
    }

    // ── Guard: fallback shape (friendly message) ──
    // When Generation.js fails after 4 attempts, it returns { message: "..." }
    // There is nothing to loop over in that case.
    const searches = Array.isArray(generation.searches)
        ? generation.searches.filter(
              (s) => typeof s === 'string' && s.trim().length > 0
          )
        : [];

    if (searches.length === 0) {
        const message =
            typeof generation.message === 'string'
                ? generation.message
                : 'no searches available';

        console.warn('[Controlling] No searches to process:', message);

        return {
            completed: false,
            searchesProcessed: 0,
            reason: message,
        };
    }

    // ── Save the allocation into Rule.js ──
    const allocation =
        generation.allocation && typeof generation.allocation === 'object'
            ? generation.allocation
            : null;

    if (allocation) {
        saveAllocation(allocation);

        console.log('[Controlling] Allocation saved into Rule.js:', allocation);
    } else {
        console.warn(
            '[Controlling] No allocation present in generation output'
        );
    }

    // ── Determine the loop limit ──
    // The loop must never exceed the allocation ceiling (maxSearchCalls).
    // If the allocation is missing or malformed, no ceiling is applied.
    let loopLimit = searches.length;

    if (
        allocation &&
        Number.isInteger(allocation.maxSearchCalls) &&
        allocation.maxSearchCalls > 0
    ) {
        loopLimit = Math.min(searches.length, allocation.maxSearchCalls);
    }

    console.log(
        `[Controlling] Processing ${loopLimit} of ${searches.length} searches`
    );

    // ── Sequential dispatch ──
    let searchesProcessed = 0;

    for (let i = 0; i < loopLimit; i++) {
        const searchPhrase = searches[i];

        console.log(
            `[Controlling] Sending search ${i + 1}/${loopLimit}:`,
            searchPhrase
        );

        try {
            await searchSystem(searchPhrase);

            searchesProcessed += 1;

            console.log(
                `[Controlling] Search ${i + 1} completed`
            );
        } catch (err) {
            console.error(
                `[Controlling] Search ${i + 1} failed:`,
                err && err.message ? err.message : err
            );
            // Skip the failed search and continue with the next one.
        }
    }

    console.log(
        `[Controlling] Completed. ${searchesProcessed}/${loopLimit} searches processed`
    );

    return {
        completed: true,
        searchesProcessed,
    };
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = controllingRequest;
