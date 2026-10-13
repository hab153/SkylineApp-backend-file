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
// STREAM PIPELINE
// ────────────────────────────────────────────────────────────────

// Runs the full pipeline stage by stage.
//
// After each stage completes, it calls onStage(label, data).
// The label is a neutral identifier — "stage 1", "stage 2", etc.
// No internal stage names are ever sent to the caller.
//
// The function returns the full pipeline result at the end, so the
// caller has everything in one object if they need it.
//
// It does not touch the SSE connection itself. It only orchestrates
// the stages and reports progress.

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

    // ── Stage 1 ──
    const understanding = await generateUnderstanding(message, safeOptions);
    onStage('stage 1', understanding);
    console.log('[Stream] Stage 1 complete');

    // ── Stage 2 ──
    const plan = await generatePlanning(understanding, message, safeOptions);
    onStage('stage 2', plan);
    console.log('[Stream] Stage 2 complete');

    // ── Stage 3 ──
    const summary = await generateSummary(understanding, plan, safeOptions);
    onStage('stage 3', summary);
    console.log('[Stream] Stage 3 complete');

    // ── Stage 4 ──
    const generation = await generateGeneration(summary, safeOptions);
    onStage('stage 4', generation);
    console.log('[Stream] Stage 4 complete');

    // ── Stage 5 ──
    const controlling = await generateControlling(generation, safeOptions);
    onStage('stage 5', controlling);
    console.log('[Stream] Stage 5 complete');

    // ── Stage 6 ──
    const separation = await generateSeparation(controlling, safeOptions);
    onStage('stage 6', separation);
    console.log('[Stream] Stage 6 complete');

    // ── Stage 7 ──
    const verification = await generateVerification(
        separation,
        understanding,
        safeOptions
    );
    onStage('stage 7', verification);
    console.log('[Stream] Stage 7 complete');

    // ── Done ──
    onStage('done', { completed: true });

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
};
