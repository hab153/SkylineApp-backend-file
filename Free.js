'use strict';

// ────────────────────────────────────────────────────────────────
// 1. IMPORTS
// ────────────────────────────────────────────────────────────────

const axios = require('axios');

// ────────────────────────────────────────────────────────────────
// 2. CONFIG
// ────────────────────────────────────────────────────────────────

const MAX_LEADS_RETURNED = 5;

// ────────────────────────────────────────────────────────────────
// 3. MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🚀 [FREE] Generating response for:', message);

        // ── Simple response ──
        const reply = `I received your message: "${message}". This is the free tier response. For lead generation, please upgrade to Go or Pro.`;

        // ── Return simple result ──
        return {
            reply: reply,
            updatedHistory: [
                ...(history || []),
                { role: 'user', content: message },
                { role: 'assistant', content: reply }
            ],
            _meta: {
                tier: 'free',
                maxLeads: MAX_LEADS_RETURNED
            }
        };

    } catch (error) {
        console.error('❌ [FREE] Error:', error.message);
        return {
            reply: 'Sorry, something went wrong. Please try again.',
            updatedHistory: history || [],
            _meta: { error: error.message }
        };
    }
}

// ────────────────────────────────────────────────────────────────
// 4. EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
};
