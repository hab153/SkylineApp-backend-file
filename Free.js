'use strict';

// ────────────────────────────────────────────────────────────────
// 1. IMPORTS
// ────────────────────────────────────────────────────────────────

const Understanding = require('./Understanding');
const Session = require('./Session');

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
        const sessionId = options?.sessionId || null;

        console.log('📋 [FREE] Tenant ID:', tenantId);
        console.log('📋 [FREE] User ID:', userId);
        console.log('📋 [FREE] Session ID:', sessionId);

        // ── Step 2: Check if there's a pending clarification state in the database ──
        let pendingClarification = null;
        let originalMessage = null;
        let parsedRequest = null;

        if (sessionId) {
            const session = await Session.findOne({ 
                userId: userId, 
                sessionId: sessionId 
            });

            if (session && session.clarificationState && session.clarificationState.status === 'awaiting_clarification') {
                pendingClarification = session.clarificationState;
                originalMessage = pendingClarification.originalMessage;
                parsedRequest = pendingClarification.parsedRequest;
                
                console.log('🔄 [FREE] Found pending clarification state');
                console.log('   Original message:', originalMessage);
                console.log('   Pending field:', pendingClarification.pendingField);
                console.log('   Ambiguities:', JSON.stringify(pendingClarification.ambiguities, null, 2));
            }
        }

        // ── Step 3: If there's a pending clarification, patch the original request ──
        let finalMessage = message;

        if (pendingClarification && originalMessage) {
            console.log('🔄 [FREE] Applying clarification patch');

            const ambiguousValue = pendingClarification.ambiguousValue || '';
            const pendingField = pendingClarification.pendingField || 'location';

            let patchedMessage = originalMessage;

            if (ambiguousValue && message) {
                const regex = new RegExp(ambiguousValue, 'gi');
                patchedMessage = patchedMessage.replace(regex, message.trim());
                console.log(`📋 [FREE] Replaced "${ambiguousValue}" → "${message.trim()}"`);
            }

            if (patchedMessage === originalMessage) {
                patchedMessage = originalMessage + ' ' + message.trim();
                console.log('📋 [FREE] Appended clarification');
            }

            finalMessage = patchedMessage;
            console.log('📋 [FREE] Patched message:', finalMessage);

            if (sessionId) {
                await Session.findOneAndUpdate(
                    { userId: userId, sessionId: sessionId },
                    { clarificationState: null }
                );
                console.log('✅ [FREE] Clarification state cleared');
            }
        } else {
            if (history && history.length > 0) {
                for (let i = history.length - 1; i >= 0; i--) {
                    const entry = history[i];
                    if (entry.role === 'assistant' && entry._meta?.needsClarification) {
                        console.log('🔄 [FREE] Found clarification context in history');
                        const ctx = entry._meta.clarificationContext;
                        const origMsg = entry._meta.originalMessage;
                        
                        if (ctx && origMsg) {
                            const ambiguousValue = ctx.ambiguousValue || '';
                            let mergedMessage = origMsg;
                            
                            if (ambiguousValue && message) {
                                const regex = new RegExp(ambiguousValue, 'gi');
                                mergedMessage = mergedMessage.replace(regex, message.trim());
                            }
                            if (mergedMessage === origMsg) {
                                mergedMessage = origMsg + ' ' + message.trim();
                            }
                            finalMessage = mergedMessage;
                            console.log('📋 [FREE] Patched message from history:', finalMessage);
                        }
                        break;
                    }
                }
            }
        }

        // ── Step 4: Understand the request ──
        console.log('📋 [FREE] Sending to Understanding.understand() with:', finalMessage);
        
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

            const ambiguousValue = extractAmbiguousValue(understanding, finalMessage);

            const clarificationState = {
                originalMessage: finalMessage,
                parsedRequest: {
                    intent: understanding.intent,
                    entities: understanding.entities,
                    normalized_query: understanding.normalized_query
                },
                ambiguousValue: ambiguousValue,
                pendingField: 'location',
                ambiguities: understanding.ambiguities,
                status: 'awaiting_clarification',
                createdAt: new Date().toISOString()
            };

            if (sessionId) {
                try {
                    await Session.findOneAndUpdate(
                        { userId: userId, sessionId: sessionId },
                        { clarificationState: clarificationState }
                    );
                    console.log('✅ [FREE] Clarification state saved to database');
                } catch (dbError) {
                    console.error('⚠️ [FREE] Failed to save clarification state:', dbError.message);
                }
            }

            const clarificationMessage = buildClarificationMessage(understanding);

            const assistantEntry = {
                role: 'assistant',
                content: clarificationMessage,
                _meta: {
                    needsClarification: true,
                    clarificationContext: {
                        originalMessage: finalMessage,
                        ambiguousValue: ambiguousValue,
                        ambiguousField: 'location'
                    },
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
                    clarificationContext: {
                        originalMessage: finalMessage,
                        ambiguousValue: ambiguousValue,
                        ambiguousField: 'location'
                    },
                    originalMessage: finalMessage,
                    clarificationState: clarificationState
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

        // ── Step 7: Return the understanding result ──
        const resultsString = JSON.stringify(understanding, null, 2);
        
        // ✅ DEBUG: Log the reply being sent
        console.log('📋 [FREE] Returning reply length:', resultsString ? resultsString.length : 0);
        console.log('📋 [FREE] Reply preview:', resultsString ? resultsString.substring(0, 200) : 'null');
        console.log('📋 [FREE] Understanding intent:', understanding.intent);
        console.log('📋 [FREE] Understanding status:', understanding.status);

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
    
    const locationPatterns = [
        /located in\s+([^,.]+)/i,
        /in\s+([^,.]+)(?:\s|$)/i,
        /at\s+([^,.]+)(?:\s|$)/i,
    ];
    
    for (const pattern of locationPatterns) {
        const match = originalMessage.match(pattern);
        if (match) {
            const value = match[1].trim();
            if (!value.match(/^(saas|ceo|founder|cto|cfo|any|company|industry)$/i)) {
                return value;
            }
        }
    }
    
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
