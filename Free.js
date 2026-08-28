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
        let searchResults;
        try {
            searchResults = await Searching.execute(plan);
            console.log('📋 [FREE] Search results:', JSON.stringify(searchResults, null, 2));
        } catch (searchError) {
            console.error('❌ [FREE] Search execution failed:', searchError.message);
            searchResults = {
                status: 'failed',
                error: { code: 'SEARCH_FAILED', message: searchError.message },
                candidates: [],
            };
        }

        // ── Step 4: Build response string ──
        let resultsString;
        
        // Check if searchResults exists and has a valid status
        if (searchResults && searchResults.status !== 'failed') {
            // Success — return the discovery results
            resultsString = JSON.stringify(searchResults, null, 2);
        } else {
            // Failed — return a friendly error message
            const errorMessage = searchResults?.error?.message || 'Search could not be completed';
            resultsString = JSON.stringify({
                status: 'failed',
                message: errorMessage,
                candidates: [],
                suggestion: 'Please check that TAVILY_API_KEY and OPENAI_API_KEY are set in the environment.',
            }, null, 2);
        }

        // ── Step 5: ALWAYS return a reply string ──
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
            reply: JSON.stringify({
                status: 'error',
                message: 'Sorry, something went wrong. Please try again.',
                error: error.message
            }, null, 2),
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
