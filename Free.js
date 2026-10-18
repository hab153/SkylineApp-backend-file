'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const generateAndSearch = require('./generateAndSearch');

// ────────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ────────────────────────────────────────────────────────────────

// Free.js is now a thin orchestrator.
//
// Its only job is to receive the user request and hand it to
// generateAndSearch.js, which does the actual work:
//
//   1. Understand the request (AI)
//   2. Generate exactly 2 high-yield searches (AI)
//   3. Run Tavily search 1
//   4. Run Tavily search 2
//   5. Return the full result
//
// Free.js adds nothing else — no formatting, no transformation,
// no extra stages. It simply delegates.

async function generateFreeResponse(message, history, userProfile, onProgress, options = {}) {
    console.log('[Orchestrator] Request received');
    console.log('[Orchestrator] Message:', message);

    try {
        const result = await generateAndSearch(message, {
            history,
            userProfile,
            onProgress,
            options,
        });

        console.log('[Orchestrator] generateAndSearch result:', result);

        return result;
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
