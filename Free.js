'use strict';

const understandRequest = require('./UnderstandRequest');

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

        let reply;
        if (!result || !result.targetEntity) {
            reply = '⚠️ Could not determine a target entity from your message.';
        } else {
            const lines = [`🎯 Target entity: ${result.targetEntity}`];

            if (result.problem) {
                lines.push(`📌 Problem: ${result.problem}`);
            }
            if (result.intent) {
                lines.push(`💡 Intent: ${result.intent}`);
            }
            if (result.location && (result.location.city || result.location.country)) {
                const city = result.location.city || '—';
                const country = result.location.country || '—';
                lines.push(`📍 Location: ${city}, ${country}`);
            }
            if (result.industry) {
                lines.push(`🏭 Industry: ${result.industry}`);
            }
            if (result.qualification) {
                lines.push(`✅ Qualification: ${result.qualification}`);
            }

            reply = lines.join('\n');
        }

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

module.exports = {
    generateFreeResponse,
};
