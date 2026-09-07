'use strict';

// ────────────────────────────────────────────────────────────────
// 1. IMPORTS
// ────────────────────────────────────────────────────────────────

const Understanding = require('./Understanding');

// ────────────────────────────────────────────────────────────────
// 2. MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress, options = {}) {
    try {
        console.log('🚀 [FREE] Generating response for:', message);
        console.log('📋 [FREE] Options:', JSON.stringify(options, null, 2));

        // ── Step 1: Get tenantId and userId from userProfile ──
        const tenantId = userProfile?.tenantId || userProfile?.tenant_id || 'skyline-default';
        const userId = userProfile?.userId || userProfile?.id || userProfile?._id || 'anonymous';

        console.log('📋 [FREE] Tenant ID:', tenantId);
        console.log('📋 [FREE] User ID:', userId);

        // ── Step 2: Check if clarification context was passed from chatController ──
        let finalMessage = message;
        let clarificationContext = null;
        let originalMessage = null;

        // Check if options has clarificationInfo from chatController
        if (options && options.clarificationInfo) {
            console.log('🔄 [FREE] Clarification context received from chatController');
            clarificationContext = options.clarificationInfo;
            originalMessage = options.clarificationInfo.originalMessage;
            
            console.log('📋 [FREE] Original message:', originalMessage);
            console.log('📋 [FREE] Clarification context:', clarificationContext);
            
            // ── Build merged query ──
            if (originalMessage) {
                // Find the ambiguous value in the original message
                // For location ambiguity, we need to replace the ambiguous location
                const ambiguousValue = clarificationContext.clarificationContext?.ambiguousValue || '';
                const ambiguousField = clarificationContext.clarificationContext?.ambiguousField || 'location';
                
                let mergedMessage = originalMessage;
                
                // If we have an ambiguous value, replace it with the clarification
                if (ambiguousValue && message) {
                    // Case-insensitive replacement
                    const regex = new RegExp(ambiguousValue, 'gi');
                    mergedMessage = mergedMessage.replace(regex, message.trim());
                    console.log('📋 [FREE] Replaced ambiguous value:', ambiguousValue, '→', message.trim());
                }
                
                // If no replacement happened, append the clarification
                if (mergedMessage === originalMessage) {
                    mergedMessage = originalMessage + ' ' + message.trim();
                    console.log('📋 [FREE] Appended clarification');
                }
                
                finalMessage = mergedMessage;
                console.log('📋 [FREE] Final merged message:', finalMessage);
            }
        } else {
            // ── Check history for clarification context ──
            // (Fallback if chatController didn't pass it)
            if (history && history.length > 0) {
                for (let i = history.length - 1; i >= 0; i--) {
                    const entry = history[i];
                    if (entry.role === 'assistant' && entry._meta?.needsClarification) {
                        console.log('🔄 [FREE] Found clarification context in history');
                        clarificationContext = entry._meta.clarificationContext;
                        originalMessage = entry._meta.originalMessage;
                        break;
                    }
                }
                
                if (clarificationContext && originalMessage) {
                    console.log('📋 [FREE] Original message from history:', originalMessage);
                    
                    const ambiguousValue = clarificationContext?.ambiguousValue || '';
                    
                    let mergedMessage = originalMessage;
                    if (ambiguousValue && message) {
                        const regex = new RegExp(ambiguousValue, 'gi');
                        mergedMessage = mergedMessage.replace(regex, message.trim());
                    }
                    if (mergedMessage === originalMessage) {
                        mergedMessage = originalMessage + ' ' + message.trim();
                    }
                    finalMessage = mergedMessage;
                    console.log('📋 [FREE] Final merged message from history:', finalMessage);
                }
            }
        }

        // ── Step 3: Understand the request (with merged context if applicable) ──
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

        // ── Step 4: Check if understanding is valid ──
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

        // ── Step 5: Check if clarification is needed ──
        const hasAmbiguities = understanding.ambiguities && understanding.ambiguities.length > 0;

        if (hasAmbiguities) {
            console.log('ℹ️ [FREE] Request needs clarification due to ambiguities');

            // ── Extract the ambiguous value from the original message ──
            const ambiguousValue = extractAmbiguousValue(understanding, finalMessage);

            // ── Store the original context for later ──
            const clarificationContextData = {
                originalMessage: finalMessage,
                ambiguousField: 'location',
                ambiguousValue: ambiguousValue
            };

            // ── Build a user-friendly clarification message ──
            const clarificationMessage = buildClarificationMessage(understanding);

            // ── Create history entry with clarification context ──
            const assistantEntry = {
                role: 'assistant',
                content: clarificationMessage,
                _meta: {
                    needsClarification: true,
                    clarificationContext: clarificationContextData,
                    originalMessage: finalMessage,
                    ambiguities: understanding.ambiguities
                }
            };

            return {
                reply: clarificationMessage,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: message },
                    assistantEntry
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

        // ── Step 6: Check if understanding has parser failure ──
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

        // ── Step 7: Return the understanding result (normal, valid path) ──
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

function extractAmbiguousValue(understanding, originalMessage) {
    if (!originalMessage) return null;
    
    // Look for location patterns in the original request
    const locationPatterns = [
        /located in\s+([^,.]+)/i,
        /in\s+([^,.]+)(?:\s|$)/i,
        /at\s+([^,.]+)(?:\s|$)/i,
    ];
    
    for (const pattern of locationPatterns) {
        const match = originalMessage.match(pattern);
        if (match) {
            const value = match[1].trim();
            // Make sure it's not a common word like "SaaS", "CEO", etc.
            if (!value.match(/^(saas|ceo|founder|cto|cfo|any|company|industry)$/i)) {
                return value;
            }
        }
    }
    
    // If no pattern matches, return the first word that might be a location
    const words = originalMessage.split(' ');
    for (const word of words) {
        if (word.length > 2 && word[0] === word[0].toUpperCase()) {
            return word;
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
