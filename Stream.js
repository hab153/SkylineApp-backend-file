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

// Neutral stage identifiers. The wire only carries these IDs —
// no internal names ever leave the server.
//
//   s1 — Understand
//   s2 — Planning
//   s3 — Summary
//   s4 — Generation
//   s5 — Controlling
//   s6 — Search System
//   s7 — Verification
//
// The frontend maps these IDs to display labels.

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
// STREAM PIPELINE
// ────────────────────────────────────────────────────────────────

// Runs the full pipeline stage by stage.
//
// After each stage completes, it calls onStage(stageId, data).
//
// The label is a neutral identifier — "s1", "s2", etc. — so the
// wire never reveals the internal stage names.
//
// The function returns the full pipeline result at the end.

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

    const understanding = await generateUnderstanding(message, safeOptions);

    onStage(STAGE_IDS.UNDERSTAND, {
        status: 'completed',
        data: understanding,
    });

    console.log('[Stream] s1 complete — Understand');

    // ── s2 — Planning ──
    onStage(STAGE_IDS.PLANNING, { status: 'processing' });

    const plan = await generatePlanning(understanding, message, safeOptions);

    onStage(STAGE_IDS.PLANNING, {
        status: 'completed',
        data: plan,
    });

    console.log('[Stream] s2 complete — Planning');

    // ── s3 — Summary ──
    onStage(STAGE_IDS.SUMMARY, { status: 'processing' });

    const summary = await generateSummary(understanding, plan, safeOptions);

    onStage(STAGE_IDS.SUMMARY, {
        status: 'completed',
        data: summary,
    });

    console.log('[Stream] s3 complete — Summary');

    // ── s4 — Generation ──
    onStage(STAGE_IDS.GENERATION, { status: 'processing' });

    const generation = await generateGeneration(summary, safeOptions);

    onStage(STAGE_IDS.GENERATION, {
        status: 'completed',
        data: generation,
    });

    console.log('[Stream] s4 complete — Generation');

    // ── s5 + s6 — Controlling (with Search System inside) ──
    //
    // Controlling contains the search loop. We signal:
    //   s5 processing  → Controlling starts
    //   s6 processing  → Search System starts (first search begins)
    //   s6 completed   → Search System finishes (all searches done)
    //   s5 completed   → Controlling finishes
    //
    // Stream.js does not know which search is running — Controlling
    // runs internally. The frontend stepper shows a single rotating
    // icon for s6 while it's active.

    onStage(STAGE_IDS.CONTROLLING, { status: 'processing' });

    // Signal that Search System is about to begin
    onStage(STAGE_IDS.SEARCH_SYSTEM, { status: 'processing' });

    const controlling = await generateControlling(generation, safeOptions);

    // Search System finished with Controlling
    onStage(STAGE_IDS.SEARCH_SYSTEM, {
        status: 'completed',
        data: controlling,
    });

    // Controlling finished too
    onStage(STAGE_IDS.CONTROLLING, {
        status: 'completed',
        data: controlling,
    });

    console.log('[Stream] s5 complete — Controlling');
    console.log('[Stream] s6 complete — Search System');

    // ── s7 — Verification ──
    onStage(STAGE_IDS.VERIFICATION, { status: 'processing' });

    const separation = await generateSeparation(controlling, safeOptions);

    // Separation is not a visible stage — it runs silently between
    // Controlling and Verification.

    const verification = await generateVerification(
        separation,
        understanding,
        safeOptions
    );

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
