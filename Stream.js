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
// The work is done by generateAndSearch.js. This file:
//   1. Passes the onStage callback through to generateAndSearch
//   2. Lets generateAndSearch fire real stage events as the work happens
//   3. Adds "done" at the end when the whole pipeline finishes
//
// The frontend stepper shows 2 stages:
//   s1 — Understanding
//   s2 — Discovery
//
// Each stage fires "processing" the moment it starts and "completed"
// the moment it finishes — real progress, not fake progress.

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
        // ── Delegate to generateAndSearch, passing the stage callback ──
        //
        // generateAndSearch will fire:
        //   s1 processing → s1 completed
        //   s2 processing → s2 completed
        //
        // Those events reach the caller through stagePassThrough in
        // real time, not after the call returns.
        const result = await generateAndSearch(
            message,
            safeOptions,
            stagePassThrough
        );

        console.log('[Stream] generateAndSearch returned:', result);

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
