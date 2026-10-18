'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const streamPipeline = require('./stream').streamPipeline;
const domainFinder   = require('./domainFinder');

// ────────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ────────────────────────────────────────────────────────────────

// Free.js is a thin orchestrator.
//
// Its job:
//
//   1. Hand the user request to stream.js → streamPipeline()
//      → streamPipeline passes the onStage callback through to
//        generateAndSearch, so real stage events (s1, s2) reach
//        the caller as the work happens
//      → returns the final result (searches + tavilyResults)
//
//   2. Extract the companies and the city from that output
//      → pass them to domainFinder.js
//
//   3. Merge both results into one response
//      → return to the caller (frontend)
//
// Free.js adds nothing else — no formatting, no transformation
// beyond extraction and merging.

async function generateFreeResponse(
    message,
    history,
    userProfile,
    onProgress,
    options = {}
) {
    console.log('[Orchestrator] Request received');
    console.log('[Orchestrator] Message:', message);

    try {
        // ── Resolve the stage callback ──
        //
        // The caller may pass an onStage function via options.
        // If they do, stage events will reach them in real time.
        // If they don't, we pass a no-op so streamPipeline has a
        // valid function to call.
        const onStage =
            options && typeof options.onStage === 'function'
                ? options.onStage
                : () => {};

        // ── STEP 1: streamPipeline ──
        //
        // streamPipeline wires the onStage callback through to
        // generateAndSearch so s1 and s2 fire at the real moment
        // each stage starts and finishes.
        const result = await streamPipeline(
            message,
            {
                history,
                userProfile,
                onProgress,
                options,
            },
            onStage
        );

        console.log('[Orchestrator] streamPipeline result:', result);

        // ── STEP 2: extract companies + city ──
        const companies = Array.isArray(result?.companies)
            ? result.companies
            : [];

        const city =
            (result?.understanding &&
                result.understanding.location &&
                result.understanding.location.city) ||
            '';

        console.log(
            '[Orchestrator] Extracted companies:',
            companies.length
        );
        console.log('[Orchestrator] Extracted city:', city);

        // ── STEP 3: domainFinder ──
        let domainResults = null;

        try {
            domainResults = await domainFinder(companies, city);

            console.log(
                '[Orchestrator] domainFinder result:',
                domainResults
            );
        } catch (domainErr) {
            console.error(
                '[Orchestrator] domainFinder failed:',
                domainErr && domainErr.message
                    ? domainErr.message
                    : domainErr
            );

            domainResults = {
                searches: [],
            };
        }

        // ── STEP 4: merge and return ──
        const finalResult = {
            ...result,
            domainResults,
        };

        console.log('[Orchestrator] Final result ready');

        return finalResult;
    } catch (error) {
        console.error('[Orchestrator] Request failed');
        console.error('[Orchestrator] Error name:', error.name);
        console.error('[Orchestrator] Error message:', error.message);
        console.error('[Orchestrator] Full error:', error);
        throw error;
    }
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
};
