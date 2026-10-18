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
    generateSearchGeneration,
    generateSearchController,
    generateDomainExtraction,
    generateSearchingCompany,
} = require('./Free');

// ────────────────────────────────────────────────────────────────
// STAGE IDs
// ────────────────────────────────────────────────────────────────

// Neutral stage identifiers. The wire only carries these IDs —
// no internal names ever leave the server.
//
//   s1  — Understand
//   s2  — Planning
//   s3  — Summary
//   s4  — Generation
//   s5  — Controlling
//   s6  — Search System
//   s7  — Verification
//   s8  — Search Generation
//   s9  — Search Controller
//   s10 — Domain Extraction
//   s11 — Searching Company
//
// The frontend maps these IDs to display labels.

const STAGE_IDS = {
    UNDERSTAND:         's1',
    PLANNING:           's2',
    SUMMARY:            's3',
    GENERATION:         's4',
    CONTROLLING:        's5',
    SEARCH_SYSTEM:      's6',
    VERIFICATION:       's7',
    SEARCH_GENERATION:  's8',
    SEARCH_CONTROLLER:  's9',
    DOMAIN_EXTRACTION:  's10',
    SEARCHING_COMPANY:  's11',
    DONE:               'done',
    ERROR:              'error',
};

// ────────────────────────────────────────────────────────────────
// STREAM PIPELINE
// ────────────────────────────────────────────────────────────────

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
    onStage(STAGE_IDS.CONTROLLING, { status: 'processing' });

    onStage(STAGE_IDS.SEARCH_SYSTEM, { status: 'processing' });

    const controlling = await generateControlling(generation, safeOptions);

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

    // ── s7 — Verification ──
    onStage(STAGE_IDS.VERIFICATION, { status: 'processing' });

    const separation = await generateSeparation(controlling, safeOptions);

    // Separation runs silently between Controlling and Verification.

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

    // ── s8 — Search Generation ──
    onStage(STAGE_IDS.SEARCH_GENERATION, { status: 'processing' });

    const searchGeneration = await generateSearchGeneration(
        verification,
        understanding,
        safeOptions
    );

    onStage(STAGE_IDS.SEARCH_GENERATION, {
        status: 'completed',
        data: searchGeneration,
    });

    console.log('[Stream] s8 complete — Search Generation');

    // ── s9 — Search Controller ──
    //
    // Takes the generated searches and runs each one via SearchHandler.
    // Results are accumulated in Handling.js.

    onStage(STAGE_IDS.SEARCH_CONTROLLER, { status: 'processing' });

    const searchController = await generateSearchController(
        searchGeneration,
        safeOptions
    );

    onStage(STAGE_IDS.SEARCH_CONTROLLER, {
        status: 'completed',
        data: searchController,
    });

    console.log('[Stream] s9 complete — Search Controller');

    // ── s10 — Domain Extraction ──
    //
    // Takes the accumulated Tavily results from Handling and asks the AI
    // to identify each company's official domain.

    onStage(STAGE_IDS.DOMAIN_EXTRACTION, { status: 'processing' });

    const domainExtraction = await generateDomainExtraction(
        searchController,
        understanding,
        safeOptions
    );

    onStage(STAGE_IDS.DOMAIN_EXTRACTION, {
        status: 'completed',
        data: domainExtraction,
    });

    console.log('[Stream] s10 complete — Domain Extraction');

    // ── s11 — Searching Company ──
    //
    // For each company with a domain, runs the Path B flow:
    // Map the domain → Extract the about/contact pages → save to Keeping.
    // A future layer will parse email, phone, and description from the
    // extracted content.

    onStage(STAGE_IDS.SEARCHING_COMPANY, { status: 'processing' });

    const searchingCompany = await generateSearchingCompany(
        domainExtraction,
        safeOptions
    );

    onStage(STAGE_IDS.SEARCHING_COMPANY, {
        status: 'completed',
        data: searchingCompany,
    });

    console.log('[Stream] s11 complete — Searching Company');

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
        searchGeneration,
        searchController,
        domainExtraction,
        searchingCompany,
    };
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    streamPipeline,
    STAGE_IDS,
};
