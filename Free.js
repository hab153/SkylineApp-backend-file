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

        // ── Step 2: Check if this is a clarification response ──
        // Look for the last assistant message that requested clarification
        let clarificationContext = null;
        let originalMessage = null;

        if (history && history.length > 0) {
            // Find the last assistant message that had clarification context
            for (let i = history.length - 1; i >= 0; i--) {
                const entry = history[i];
                if (entry.role === 'assistant' && entry._meta?.needsClarification) {
                    clarificationContext = entry._meta.clarificationContext;
                    originalMessage = entry._meta.originalMessage;
                    console.log('📋 [FREE] Found clarification context:', clarificationContext);
                    console.log('📋 [FREE] Original message:', originalMessage);
                    break;
                }
            }
        }

        let finalMessage = message;

        // ── Step 3: If this is a clarification, merge with original context ──
        if (clarificationContext && originalMessage) {
            console.log('🔄 [FREE] Merging clarification with original context');

            // ── Build merged query: original message + clarification ──
            // Replace the ambiguous part with the clarification
            // For location ambiguity, we replace the location with the clarified one
            const ambiguousField = clarificationContext.ambiguousField || 'location';
            const ambiguousValue = clarificationContext.ambiguousValue || '';

            // Build the merged message
            // Example: "Find me CEOs in SaaS, located in Londom" + "London, UK"
            // → "Find me CEOs in SaaS, located in London, UK"
            let mergedMessage = originalMessage;

            // Replace the ambiguous value with the clarification
            if (ambiguousValue && message) {
                // Case-insensitive replacement
                const regex = new RegExp(ambiguousValue, 'gi');
                mergedMessage = mergedMessage.replace(regex, message.trim());
                console.log('📋 [FREE] Merged message:', mergedMessage);
            }

            // If the ambiguous value wasn't found, append the clarification
            if (mergedMessage === originalMessage) {
                mergedMessage = originalMessage + ' ' + message.trim();
                console.log('📋 [FREE] Appended clarification:', mergedMessage);
            }

            finalMessage = mergedMessage;
        }

        // ── Step 4: Understand the request (with merged context if applicable) ──
        const understanding = await Understanding.understand(
            finalMessage,
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

        // ── Step 5: Check if understanding is valid ──
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

        // ── Step 6: Check if clarification is needed ──
        const hasAmbiguities = understanding.ambiguities && understanding.ambiguities.length > 0;

        if (hasAmbiguities) {
            console.log('ℹ️ [FREE] Request needs clarification due to ambiguities');

            // ── Store the original context for later ──
            const clarificationContextData = {
                originalMessage: finalMessage,
                ambiguousField: 'location',
                ambiguousValue: extractAmbiguousValue(understanding)
            };

            // ── Build a user-friendly clarification message ──
            const clarificationMessage = buildClarificationMessage(understanding);

            return {
                reply: clarificationMessage,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: message },
                    { 
                        role: 'assistant', 
                        content: clarificationMessage,
                        _meta: {
                            needsClarification: true,
                            clarificationContext: clarificationContextData,
                            originalMessage: finalMessage,
                            ambiguities: understanding.ambiguities
                        }
                    }
                ],
                _meta: {
                    tier: 'free',
                    understanding: understanding,
                    status: 'needs_clarification',
                    ambiguities: understanding.ambiguities,
                    clarificationContext: clarificationContextData,
                    originalMessage: finalMessage
                }
            };
        }

        // ── Step 7: Check if understanding has parser failure ──
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

        // ── Step 8: Return the understanding result (normal, valid path) ──
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
// 4. HELPER: Extract Ambiguous Value
// ──────────────────────────────────────────────────────────────

function extractAmbiguousValue(understanding) {
    // Try to extract what the ambiguous value was
    // For location, look for the original location string
    if (understanding.originalRequest) {
        // Look for location patterns in the original request
        const locationMatch = understanding.originalRequest.match(/located in\s+([^,.]+)/i);
        if (locationMatch) {
            return locationMatch[1].trim();
        }
        // Look for "in [location]" pattern
        const inMatch = understanding.originalRequest.match(/in\s+([^,.]+)(?:\s|$)/i);
        if (inMatch && !inMatch[1].match(/saas|company|ceo|founder|cto|any/i)) {
            return inMatch[1].trim();
        }
    }
    return null;
}

// ──────────────────────────────────────────────────────────────
// 5. EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
};
