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
    console.log('[Orchestrator] Request received');
    console.log('[Orchestrator] Message:', message);

    try {
        const result = await understandRequest(message, {
            history,
            userProfile,
            onProgress,
            options,
        });

        console.log('[Orchestrator] Understanding result:', result);

        // ✅ Build the reply string
        let reply;
        if (!result || !result.targetEntity) {
            reply = '⚠️ Could not determine a target entity from your message.';
        } else {
            reply = `🎯 Target entity: ${result.targetEntity}`;
        }

        // ✅ Return the shape chatController expects
        return {
            reply,
            updatedHistory: history || [],
            meta: result,
        };
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
