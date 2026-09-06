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

        // ── Step 1: Get tenantId and userId from userProfile ──
        const tenantId = userProfile?.tenantId || userProfile?.tenant_id || 'skyline-default';
        const userId = userProfile?.userId || userProfile?.id || userProfile?._id || 'anonymous';

        console.log('📋 [FREE] Tenant ID:', tenantId);
        console.log('📋 [FREE] User ID:', userId);

        // ── Step 2: Understand the request with required fields ──
        const understanding = await Understanding.understand(
            message,
            tenantId,
            userId,
            {
                conversationId: userProfile?.conversationId || null,
                locale: userProfile?.locale || 'en-US',
                timezone: userProfile?.timezone || 'Africa/Lagos',
                onProgress: onProgress
            }
        );

        console.log('📋 [FREE] Understanding result:', JSON.stringify(understanding, null, 2));

        // ── Step 3: Check if understanding is valid ──
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

        // ── Step 4: Check if clarification is needed ──
        // If ambiguities exist, we need to ask the user for clarification
        const hasAmbiguities = understanding.ambiguities && understanding.ambiguities.length > 0;

        if (hasAmbiguities) {
            console.log('ℹ️ [FREE] Request needs clarification due to ambiguities');
            
            // ── Build a user-friendly clarification message ──
            const clarificationMessage = buildClarificationMessage(understanding);
            
            return {
                reply: clarificationMessage,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: message },
                    { role: 'assistant', content: clarificationMessage }
                ],
                _meta: {
                    tier: 'free',
                    understanding: understanding,
                    status: 'needs_clarification',
                    ambiguities: understanding.ambiguities
                }
            };
        }

        // ── Step 5: Check if understanding has parser failure ──
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

        // ── Step 6: Return the understanding result (normal, valid path) ──
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
// 3. HELPER: Build Clarification Message
// ──────────────────────────────────────────────────────────────

function buildClarificationMessage(understanding) {
    if (!understanding.ambiguities || understanding.ambiguities.length === 0) {
        return 'I understood your request. What would you like me to do?';
    }

    let message = '⚠️ **I need a bit more clarity:**\n\n';

    understanding.ambiguities.forEach(function(amb) {
        message += `• **${amb.field}**: ${amb.issue}\n`;
        if (amb.candidates && amb.candidates.length > 0) {
            message += `  → Options: ${amb.candidates.join(' | ')}\n`;
        }
        message += '\n';
    });

    message += 'Please provide more details so I can help you better.';

    return message;
}

// ──────────────────────────────────────────────────────────────
// 4. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
};
