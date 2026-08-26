'use strict';

// ────────────────────────────────────────────────────────────────
// 1. IMPORTS
// ────────────────────────────────────────────────────────────────

const axios = require('axios');
const Understanding = require('./Understanding');
const Planning = require('./Planning');
const Searching = require('./Searching');

// ────────────────────────────────────────────────────────────────
// 2. MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🚀 [FREE] Generating response for:', message);

        // ── Step 1: Understand the request ──
        const understanding = await Understanding.understand(message);
        console.log('📋 [FREE] Understanding result:', JSON.stringify(understanding, null, 2));

        // ── Step 2: Plan the search ──
        const plan = await Planning.plan(understanding);
        console.log('📋 [FREE] Planning result:', JSON.stringify(plan, null, 2));

        // ── Step 3: Execute the search ──
        const searchResults = await Searching.execute(plan);
        console.log('📋 [FREE] Search results:', JSON.stringify(searchResults, null, 2));

        // ── Step 4: Return results as string ──
        const resultsString = JSON.stringify(searchResults, null, 2);

        return {
            reply: resultsString,
            updatedHistory: [
                ...(history || []),
                { role: 'user', content: message },
                { role: 'assistant', content: resultsString }
            ],
            _meta: {
                tier: 'free',
                understanding: understanding,
                plan: plan,
                searchResults: searchResults,
                status: understanding.status
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
// 3. EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
};
