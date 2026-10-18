'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const generateAndSearch = require('./generateAndSearch');

// ────────────────────────────────────────────────────────────────
// STAGE IDs
// ────────────────────────────────────────────────────────────────

// Neutral stage identifiers. The wire only carries these IDs —
// no internal names ever leave the server.
//
//   s1 — Understand
//   s2 — Generate Searches
//   s3 — Search 1
//   s4 — Search 2
//
// The frontend maps these IDs to display labels.

const STAGE_IDS = {
    UNDERSTAND:        's1',
    GENERATE_SEARCHES: 's2',
    SEARCH_1:          's3',
    SEARCH_2:          's4',
    DONE:              'done',
    ERROR:             'error',
};

// ────────────────────────────────────────────────────────────────
// STREAM PIPELINE
// ────────────────────────────────────────────────────────────────

// Runs the full pipeline.
//
// The work is done by generateAndSearch.js — this file only:
//   1. Emits "processing" before the call
//   2. Calls generateAndSearch
//   3. Emits "completed" with the result
//
// The frontend stepper shows 4 stages:
//   s1 — Understand
//   s2 — Generate Searches
//   s3 — Search 1
//   s4 — Search 2
//
// All 4 stages are actually performed inside generateAndSearch.js as
// part of one call. This file marks each stage as completed in sequence
// after the call returns, so the user sees them tick off.

async function streamPipeline(message, options, onStage) {
    console.log('[Stream] Pipeline started');
    console.log('[Stream] Message:', message);

    if (typeof onStage !== 'function') {
        throw new Error('[Stream] onStage callback must be a function');
    }

    if (typeof message !== 'string' || message.trim().length === 0) {
        throw new Error('[Stream] message must be a non-empty string');
    }

    const safeOptions = options && typeof options === 'object' ? options : {};

    // ── s1 — Understand ──
    onStage(STAGE_IDS.UNDERSTAND, { status: 'processing' });

    // The work is done inside generateAndSearch. We mark this stage
    // as processing before the call, then complete all stages after
    // it returns so the user sees a coherent progress sequence.
    //
    // s2, s3, s4 also emit "processing" briefly after this call so the
    // stepper can show them ticking off in order.

    const result = await generateAndSearch(message, safeOptions);

    console.log('[Stream] generateAndSearch returned:', result);

    // ── s1 completed ──
    onStage(STAGE_IDS.UNDERSTAND, {
        status: 'completed',
    });
    console.log('[Stream] s1 complete — Understand');

    // ── s2 completed ──
    onStage(STAGE_IDS.GENERATE_SEARCHES, {
        status: 'completed',
        data: { searches: result.searches || [] },
    });
    console.log('[Stream] s2 complete — Generate Searches');

    // ── s3 completed ──
    const search1Result =
        Array.isArray(result.tavilyResults) && result.tavilyResults.length > 0
            ? result.tavilyResults[0]
            : null;

    onStage(STAGE_IDS.SEARCH_1, {
        status: 'completed',
        data: search1Result,
    });
    console.log('[Stream] s3 complete — Search 1');

    // ── s4 completed ──
    const search2Result =
        Array.isArray(result.tavilyResults) && result.tavilyResults.length > 1
            ? result.tavilyResults[1]
            : null;

    onStage(STAGE_IDS.SEARCH_2, {
        status: 'completed',
        data: search2Result,
    });
    console.log('[Stream] s4 complete — Search 2');

    // ── Done ──
    onStage(STAGE_IDS.DONE, { completed: true });

    console.log('[Stream] Pipeline finished');

    return result;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    streamPipeline,
    STAGE_IDS,
};
