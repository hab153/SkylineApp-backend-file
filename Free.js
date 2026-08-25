'use strict';

// ────────────────────────────────────────────────────────────────
// 1. IMPORTS
// ────────────────────────────────────────────────────────────────

const axios = require('axios');
const Understanding = require('./Understanding');

// ────────────────────────────────────────────────────────────────
// 2. MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🚀 [FREE] Generating response for:', message);

        // ── Step 1: Understand the request ──
        // Understanding.js handles its own OpenAI client internally
        const understanding = await Understanding.understand(message);
        console.log('📋 [FREE] Understanding result:', understanding);

        // ── Step 2: Return the understanding result AS-IS ──
        // No modification - send the raw specification
        return {
            reply: understanding,  // ← Returns the full spec object
            updatedHistory: [
                ...(history || []),
                { role: 'user', content: message },
                { role: 'assistant', content: JSON.stringify(understanding, null, 2) }
            ],
            _meta: {
                tier: 'free',
                understanding: understanding,
                status: understanding.status
            }
        };

    } catch (error) {
        console.error('❌ [FREE] Error:', error.message);
        return {
            reply: { 
                status: 'invalid', 
                error: error.message,
                message: 'Sorry, something went wrong. Please try again.'
            },
            updatedHistory: history || [],
            _meta: { error: error.message }
        };
    }
}

// ────────────────────────────────────────────────────────────────
// 3. EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
};
