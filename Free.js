'use strict';

// ────────────────────────────────────────────────────────────────
// 1. IMPORTS
// ────────────────────────────────────────────────────────────────

const axios = require('axios');
const Understanding = require('./Understanding');
const Planning = require('./Planning');

// ────────────────────────────────────────────────────────────────
// 2. MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🚀 [FREE] Generating response for:', message);

        // ── Step 1: Understand the request ──
        // ✅ FIX: Pass tenantId and userId
        const tenantId = userProfile?.tenantId || 'skyline-default';
        const userId = userProfile?.userId || userProfile?.id || 'anonymous';

        const understanding = await Understanding.understand(
            message,
            tenantId,
            userId,
            {
                conversationId: userProfile?.conversationId || null,
                locale: 'en-US',
                timezone: 'Africa/Lagos',
                onProgress: onProgress
            }
        );

        console.log('📋 [FREE] Understanding result:', JSON.stringify(understanding, null, 2));

        // ── Step 2: Plan the search ──
        const plan = await Planning.plan(understanding);
        console.log('📋 [FREE] Planning result:', JSON.stringify(plan, null, 2));

        // ── Step 3: Return the result ──
        const result = JSON.stringify({
            understanding: understanding,
            plan: plan
        }, null, 2);

        return {
            reply: result,
            updatedHistory: [
                ...(history || []),
                { role: 'user', content: message },
                { role: 'assistant', content: result }
            ],
            _meta: {
                tier: 'free',
                understanding: understanding,
                plan: plan,
                status: understanding.status || 'unknown'
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
