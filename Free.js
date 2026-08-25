'use strict';

// ────────────────────────────────────────────────────────────────
// 1. IMPORTS
// ────────────────────────────────────────────────────────────────

const axios = require('axios');
const OpenAI = require('openai');
const { LeadUnderstandingEngine } = require('./Understanding');

// ────────────────────────────────────────────────────────────────
// 2. INITIALIZE UNDERSTANDING ENGINE
// ────────────────────────────────────────────────────────────────

// Initialize OpenAI client (uses OPENAI_API_KEY from environment)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Create understanding engine instance
const understandingEngine = new LeadUnderstandingEngine(openai);

// ────────────────────────────────────────────────────────────────
// 3. MAIN FUNCTION
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🚀 [FREE] Generating response for:', message);

        // ── Step 1: Understand the request using the engine ──
        const understanding = await understandingEngine.processRequest(message);
        console.log('📋 [FREE] Understanding status:', understanding.status);
        console.log('📋 [FREE] Target type:', understanding.target?.type);
        console.log('📋 [FREE] Ambiguities:', understanding.ambiguities?.length || 0);

        // ── Step 2: Build response based on understanding ──
        let reply = '';

        if (understanding.status === 'invalid') {
            reply = '❌ Sorry, I couldn\'t understand your request. Please try rephrasing it.';
        } else if (understanding.status === 'needs_clarification') {
            // Build clarification message from ambiguities
            const ambiguityReasons = understanding.ambiguities
                .map(a => `• ${a.reason}`)
                .join('\n');
            reply = `🤔 I need a bit more clarity:\n\n${ambiguityReasons}\n\nCould you please provide more details?`;
        } else {
            // Status: 'ready' - Build confirmation response
            const targetType = understanding.target?.type || 'company';
            const quantity = understanding.target?.quantity || 'as many as possible';
            const industries = understanding.company?.industries?.join(', ') || 'any industry';
            const location = understanding.location?.include?.join(', ') || 'anywhere';
            const roles = understanding.contact?.roles?.join(', ') || 'decision makers';

            reply = `✅ I understand your request:\n\n` +
                    `🎯 **Target:** ${targetType}s\n` +
                    `📊 **Quantity:** ${quantity}\n` +
                    `🏢 **Industry:** ${industries}\n` +
                    `📍 **Location:** ${location}\n` +
                    `👤 **Contacts:** ${roles}\n\n` +
                    `I'll start finding the best leads for you! 🚀`;
        }

        // ── Step 3: Return result with metadata ──
        return {
            reply: reply,
            updatedHistory: [
                ...(history || []),
                { role: 'user', content: message },
                { role: 'assistant', content: reply }
            ],
            _meta: {
                tier: 'free',
                understanding: understanding,
                status: understanding.status
            }
        };

    } catch (error) {
        console.error('❌ [FREE] Error:', error.message);
        console.error('❌ [FREE] Stack:', error.stack);
        
        return {
            reply: '⚠️ Sorry, something went wrong. Please try again.',
            updatedHistory: history || [],
            _meta: { 
                error: error.message,
                tier: 'free'
            }
        };
    }
}

// ────────────────────────────────────────────────────────────────
// 4. EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
    understandingEngine // Export for testing
};
