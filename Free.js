'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const understandRequest = require('./UnderstandRequest');

// ────────────────────────────────────────────────────────────────
// RECEIVER / ORCHESTRATOR
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(
    message,
    history,
    userProfile,
    onProgress,
    options = {}
) {
    // Pass the request to the understanding system.
    // The message is forwarded exactly as it was received.
    return await understandRequest(message, {
        history,
        userProfile,
        onProgress,
        options,
    });
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
};
