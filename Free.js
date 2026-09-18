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

        // ✅ Return a string so chatController accepts it as aiReply
        if (!result || !result.targetEntity) {
            return '⚠️ Could not determine a target entity from your message.';
        }

        return `🎯 Target entity: ${result.targetEntity}`;
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
