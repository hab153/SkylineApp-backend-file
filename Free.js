'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const generateAndSearch = require('./generateAndSearch');
const domainFinder      = require('./domainFinder');

// ────────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ────────────────────────────────────────────────────────────────

// Free.js is a thin orchestrator.
//
// Its job:
//
//   1. Hand the user request to generateAndSearch.js
//      → produces companies + understanding
//
//   2. Extract the companies and the city from that output
//      → pass them to domainFinder.js
//
//   3. Merge both results into one response
//      → return to the caller (frontend)
//
// Free.js adds nothing else — no formatting, no transformation
// beyond extraction and merging.

async function generateFreeResponse(message, history, userProfile, onProgress, options = {}) {
    console.log('[Orchestrator] Request received');
    console.log('[Orchestrator] Message:', message);

    try {
        // ── STEP 1: generateAndSearch ──
        const result = await generateAndSearch(message, {
            history,
            userProfile,
            onProgress,
            options,
        });

        console.log('[Orchestrator] generateAndSearch result:', result);

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
                domainErr && domainErr.message ? domainErr.message : domainErr
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
