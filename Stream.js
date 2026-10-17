'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const {
    generateUnderstanding,
    generatePlanning,
    generateSummary,
    generateGeneration,
    generateControlling,
    generateSeparation,
    generateVerification,
} = require('./Free');

// ────────────────────────────────────────────────────────────────
// STAGE IDs
// ────────────────────────────────────────────────────────────────

const STAGE_IDS = {
    UNDERSTAND:    's1',
    PLANNING:      's2',
    SUMMARY:       's3',
    GENERATION:    's4',
    CONTROLLING:   's5',
    SEARCH_SYSTEM: 's6',
    VERIFICATION:  's7',
    DONE:          'done',
    ERROR:         'error',
};

// ────────────────────────────────────────────────────────────────
// CANCELLATION
// ────────────────────────────────────────────────────────────────

// Thrown when the request has been cancelled by the user.
// The route handler recognises this and sends the 'cancelled' SSE
// event instead of the 'error' event.
function throwCancelled() {
    const err = new Error('cancelled');
    err.name = 'AbortError';
    err.code = 'CANCELLED';
    throw err;
}

// Checks the cancellation state. If cancelled, throws. Otherwise
// returns.
//
// `options.isCancelled` is a function supplied by the route handler.
// `options.signal` is an AbortSignal. Either can flag cancellation.

function ensureNotCancelled(options) {
    if (!options) return;

    if (typeof options.isCancelled === 'function' && options.isCancelled()) {
        throwCancelled();
    }

    if (options.signal && options.signal.aborted) {
        throwCancelled();
    }
}

// ────────────────────────────────────────────────────────────────
// STREAM PIPELINE
// ────────────────────────────────────────────────────────────────

// Runs the full pipeline stage by stage.
//
// After each stage completes, it calls onStage(stageId, data).
//
// The label is a neutral identifier — "s1", "s2", etc.
//
// Cancellation is checked BEFORE every stage. If the user pressed
// the stop button at any point, the pipeline throws immediately and
// no further work happens.
//
// options.signal is forwarded to every stage so in-flight fetches
// abort as well — not just at stage boundaries.

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
    ensureNotCancelled(safeOptions);
    onStage(STAGE_IDS.UNDERSTAND, { status: 'processing' });

    const understanding = await generateUnderstanding(message, safeOptions);

    ensureNotCancelled(safeOptions);
    onStage(STAGE_IDS.UNDERSTAND, {
        status: 'completed',
        data: understanding,
    });
    console.log('[Stream] s1 complete — Understand');

    // ── s2 — Planning ──
    ensureNotCancelled(safeOptions);
    onStage(STAGE_IDS.PLANNING, { status: 'processing' });

    const plan = await generatePlanning(understanding, message, safeOptions);

    ensureNotCancelled(safeOptions);
    onStage(STAGE_IDS.PLANNING, {
        status: 'completed',
        data: plan,
    });
    console.log('[Stream] s2 complete — Planning');

    // ── s3 — Summary ──
    ensureNotCancelled(safeOptions);
    onStage(STAGE_IDS.SUMMARY, { status: 'processing' });

    const summary = await generateSummary(understanding, plan, safeOptions);

    ensureNotCancelled(safeOptions);
    onStage(STAGE_IDS.SUMMARY, {
        status: 'completed',
        data: summary,
    });
    console.log('[Stream] s3 complete — Summary');

    // ── s4 — Generation ──
    ensureNotCancelled(safeOptions);
    onStage(STAGE_IDS.GENERATION, { status: 'processing' });

    const generation = await generateGeneration(summary, safeOptions);

    ensureNotCancelled(safeOptions);
    onStage(STAGE_IDS.GENERATION, {
        status: 'completed',
        data: generation,
    });
    console.log('[Stream] s4 complete — Generation');

    // ── s5 + s6 — Controlling (with Search System inside) ──
    ensureNotCancelled(safeOptions);
    onStage(STAGE_IDS.CONTROLLING, { status: 'processing' });
    onStage(STAGE_IDS.SEARCH_SYSTEM, { status: 'processing' });

    const controlling = await generateControlling(generation, safeOptions);

    ensureNotCancelled(safeOptions);
    onStage(STAGE_IDS.SEARCH_SYSTEM, {
        status: 'completed',
        data: controlling,
    });
    onStage(STAGE_IDS.CONTROLLING, {
        status: 'completed',
        data: controlling,
    });
    console.log('[Stream] s5 complete — Controlling');
    console.log('[Stream] s6 complete — Search System');

    // ── Separation (silent — not a visible stage) ──
    ensureNotCancelled(safeOptions);
    const separation = await generateSeparation(controlling, safeOptions);

    // ── s7 — Verification ──
    ensureNotCancelled(safeOptions);
    onStage(STAGE_IDS.VERIFICATION, { status: 'processing' });

    const verification = await generateVerification(
        separation,
        understanding,
        safeOptions
    );

    ensureNotCancelled(safeOptions);
    onStage(STAGE_IDS.VERIFICATION, {
        status: 'completed',
        data: verification,
    });
    console.log('[Stream] s7 complete — Verification');

    // ── Done ──
    onStage(STAGE_IDS.DONE, { completed: true });
    console.log('[Stream] Pipeline finished');

    return {
        understanding,
        plan,
        summary,
        generation,
        controlling,
        separation,
        verification,
    };
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    streamPipeline,
    STAGE_IDS,
};
