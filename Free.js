'use strict';

// ────────────────────────────────────────────────────────────────
// 1. IMPORTS
// ────────────────────────────────────────────────────────────────

const Understanding = require('./Understanding');

// ────────────────────────────────────────────────────────────────
// 2. MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🚀 [FREE] Generating response for:', message);

        // ── Step 1: Understand the request ──
        const understanding = await Understanding.understand(message);
        console.log('📋 [FREE] Understanding result:', JSON.stringify(understanding, null, 2));

        // ── Step 2: Check if understanding is valid ──
        if (!understanding) {
            console.error('❌ [FREE] Understanding returned null/undefined');
            return {
                reply: JSON.stringify({
                    status: 'error',
                    message: 'Could not understand your request. Please try again.',
                }, null, 2),
                updatedHistory: history || [],
                _meta: { error: 'Understanding returned null' }
            };
        }

        // ── Step 3: Distinguish a SYSTEM failure (AI parser broke) from a ──
        // ── genuinely vague user request. These used to look identical    ──
        // ── (needsClarification: true, everything else null) and got the  ──
        // ── same generic message — that's misleading when the real cause  ──
        // ── was an API/model failure, not the user's phrasing.            ──
        if (understanding.parserFailed) {
            console.error('❌ [FREE] Stage 1 parser failed:', understanding.parserErrorDetail);
            return {
                reply: JSON.stringify({
                    status: 'error',
                    message: "Sorry, we had trouble processing your request just now. Please try again in a moment.",
                }, null, 2),
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: message },
                ],
                _meta: {
                    tier: 'free',
                    error: 'parser_failed',
                    parserErrorDetail: understanding.parserErrorDetail,
                    requestId: understanding.requestId,
                }
            };
        }

        // ── Step 4: Genuine "needs more detail from the user" case ──
        if (understanding.needsClarification) {
            console.log('ℹ️ [FREE] Request needs clarification (not a system error)');
            const resultsString = JSON.stringify(understanding, null, 2);

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
                    status: 'needs_clarification'
                }
            };
        }

        // ── Step 5: Return the understanding result (normal, valid path) ──
        const resultsString = JSON.stringify(understanding, null, 2);

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
                status: understanding.status || 'ready'
            }
        };

    } catch (error) {
        console.error('❌ [FREE] Error:', error.message);
        console.error('❌ [FREE] Stack:', error.stack);
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

// ──────────────────────────────────────────────────────────────
// 3. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
};
