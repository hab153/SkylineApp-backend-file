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
// Rule.js, then sends all search phrases to SearchSystem.js in parallel.
//
// It does not perform any search itself. It does not talk to Tavily. It does
// not store results. It only coordinates the dispatch of searches.
//
// It accepts an optional onProgress callback. If provided, the callback is
// called once per completed search so the caller can report progress in
// real time.
//
//   onProgress(searchesProcessed, totalSearches)
//
// The callback is optional. If not provided, Controlling behaves exactly
// as before — silent dispatch.

async function controllingRequest(generation, options = {}) {
    console.log('[Controlling] Started');
    console.log('[Controlling] Received generation output:', generation);

    const onProgress =
        options && typeof options.onProgress === 'function'
            ? options.onProgress
            : null;

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

    // ── Determine the dispatch limit ──
    // The dispatch must never exceed the allocation ceiling (maxSearchCalls).
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
        `[Controlling] Processing ${loopLimit} of ${searches.length} searches in parallel`
    );

    // ── Parallel dispatch ──
    // All searches are fired at once. Each completes independently.
    // A failed search does not block the others — each has its own catch.
    //
    // The onProgress callback is called after every search completes,
    // whether it succeeded or failed. This lets the caller track real
    // progress in real time.

    const searchPhrases = searches.slice(0, loopLimit);

    let searchesProcessed = 0;

    const tasks = searchPhrases.map((searchPhrase, i) => {
        console.log(
            `[Controlling] Dispatching search ${i + 1}/${loopLimit}:`,
            searchPhrase
        );

        return searchSystem(searchPhrase)
            .then(() => {
                searchesProcessed += 1;

                console.log(
                    `[Controlling] Search ${i + 1} completed`
                );

                if (onProgress) {
                    try {
                        onProgress(searchesProcessed, loopLimit);
                    } catch (progressErr) {
                        console.error(
                            '[Controlling] onProgress callback threw:',
                            progressErr && progressErr.message
                                ? progressErr.message
                                : progressErr
                        );
                    }
                }
            })
            .catch((err) => {
                console.error(
                    `[Controlling] Search ${i + 1} failed:`,
                    err && err.message ? err.message : err
                );
                // Skip the failed search and let the others continue.

                if (onProgress) {
                    try {
                        onProgress(searchesProcessed, loopLimit);
                    } catch (progressErr) {
                        console.error(
                            '[Controlling] onProgress callback threw:',
                            progressErr && progressErr.message
                                ? progressErr.message
                                : progressErr
                        );
                    }
                }
            });
    });

    // Wait for all searches to settle (succeeded or failed).
    await Promise.all(tasks);

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
