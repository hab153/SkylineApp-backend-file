'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const seekerRequest = require('./Seeker');

// ────────────────────────────────────────────────────────────────
// STAGE IDs
// ────────────────────────────────────────────────────────────────

// Neutral stage identifiers. The wire only carries these IDs —
// no internal names ever leave the server.
//
//   s1 — Understanding
//   s2 — Discovery
//
// The frontend maps these IDs to display labels.

const STAGE_IDS = {
    UNDERSTANDING: 's1',
    DISCOVERY:     's2',
    DONE:          'done',
    ERROR:         'error',
};

// ────────────────────────────────────────────────────────────────
// STREAM PIPELINE
// ────────────────────────────────────────────────────────────────

// Runs the pipeline.
//
// The work is done by Seeker.js. This file:
//   1. Fires "s1 processing" before Seeker starts (Understanding)
//   2. Calls Seeker (which internally understands, generates 2
//      queries, runs search 1, runs search 2)
//   3. Fires "s1 completed" and "s2 processing" as Seeker's work
//      hits those boundaries
//   4. Fires "s2 completed" with the search results
//   5. Fires "done" when the whole pipeline finishes
//
// The frontend stepper shows 2 stages:
//   s1 — Understanding
//   s2 — Discovery

async function streamPipeline(message, options, onStage) {
    console.log('[Stream] Pipeline started');
    console.log('[Stream] Message:', message);

    // ── Guard: onStage must be a function ──
    if (typeof onStage !== 'function') {
        throw new Error('[Stream] onStage callback must be a function');
    }

    // ── Guard: message must be a non-empty string ──
    if (typeof message !== 'string' || message.trim().length === 0) {
        throw new Error('[Stream] message must be a non-empty string');
    }

    const safeOptions = options && typeof options === 'object' ? options : {};

    // ── Wrap the caller's onStage so we can log locally as well ──
    const stagePassThrough = (stageId, payload) => {
        try {
            console.log(`[Stream] Stage event — ${stageId}:`, payload);

            onStage(stageId, payload);
        } catch (callbackError) {
            console.error(
                '[Stream] onStage callback threw:',
                callbackError && callbackError.message
                    ? callbackError.message
                    : callbackError
            );
        }
    };

    try {
        // ── s1 — Understanding starts ──
        stagePassThrough(STAGE_IDS.UNDERSTANDING, {
            status: 'processing',
        });

        // ── s1 completed — s2 starts ──
        // Seeker internally handles understanding → query generation,
        // then runs both searches. We mark s1 as done and s2 as
        // processing before the actual search calls begin.
        stagePassThrough(STAGE_IDS.UNDERSTANDING, {
            status: 'completed',
            data: { message },
        });

        stagePassThrough(STAGE_IDS.DISCOVERY, {
            status: 'processing',
        });

        // ── Delegate to Seeker ──
        const result = await seekerRequest(message);

        console.log('[Stream] Seeker returned:', result);

        // ── s2 completed — with the search results ──
        stagePassThrough(STAGE_IDS.DISCOVERY, {
            status: 'completed',
            data: {
                searches: Array.isArray(result?.searches)
                    ? result.searches
                    : [],
                results: Array.isArray(result?.results)
                    ? result.results
                    : [],
            },
        });

        // ── Fire the final "done" event ──
        stagePassThrough(STAGE_IDS.DONE, { completed: true });

        console.log('[Stream] Pipeline finished');

        return result;
    } catch (error) {
        console.error(
            '[Stream] Pipeline failed:',
            error && error.message ? error.message : error
        );

        // ── Fire an error event so the frontend can show it ──
        stagePassThrough(STAGE_IDS.ERROR, {
            message:
                error && error.message
                    ? error.message
                    : 'Pipeline failed',
        });

        throw error;
    }
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    streamPipeline,
    STAGE_IDS,
};
