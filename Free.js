'use strict';

// ────────────────────────────────────────────────────────────────
// 1. IMPORTS – All 9 Agents
// ────────────────────────────────────────────────────────────────

const agent1 = require('./agent1');  // Router - Intent Classification
const agent2 = require('./agent2');  // Prospector - Search & Discovery
const agent3 = require('./agent3');  // Enrichment - Company Intelligence
const agent4 = require('./agent4');  // Qualification - Lead Scoring
const agent5 = require('./agent5');  // Formatter - Email Generation
const agent6 = require('./agent6');  // (Reserved for future)
const agent7 = require('./agent7');  // (Reserved for future)
const agent8 = require('./agent8');  // (Reserved for future)
const agent9 = require('./agent9');  // Knowledge Repository - Storage & Retrieval

// ────────────────────────────────────────────────────────────────
// 2. CONFIG & CONSTANTS
// ────────────────────────────────────────────────────────────────

const MAX_LEADS_RETURNED = 5;
const MAX_MESSAGE_LENGTH = 800;
const CURRENT_YEAR = new Date().getFullYear();

// Output quantity control
const QUANTITY_RULE_HARD_MIN = 2;
const QUANTITY_RULE_DEFAULT_MAX = MAX_LEADS_RETURNED;

// ────────────────────────────────────────────────────────────────
// 3. UTILITIES
// ────────────────────────────────────────────────────────────────

function sanitizeUserMessage(message) {
    const injectionPatterns = [
        /ignore (all |previous |prior )?(instructions?|prompts?|rules?)/gi,
        /disregard (all |previous |prior )?(instructions?|prompts?|rules?)/gi,
        /forget (all |previous |prior )?(instructions?|prompts?|rules?)/gi,
        /you are now/gi,
        /act as (a |an )?(?!assistant)/gi,
        /your new (instructions?|rules?|role) (is|are)/gi,
    ];
    let safe = message;
    for (const pattern of injectionPatterns) safe = safe.replace(pattern, '[REDACTED]');
    return safe;
}

function _applyOutputQuantityRules(leads, requestedMax) {
    if (!Array.isArray(leads)) return [];
    const cap = Math.min(requestedMax || QUANTITY_RULE_DEFAULT_MAX, QUANTITY_RULE_DEFAULT_MAX);
    const sliceTo = Math.max(QUANTITY_RULE_HARD_MIN, Math.min(cap, leads.length));
    return leads.slice(0, sliceTo);
}

function buildUserProfile(userProfile) {
    return {
        senderName: userProfile?.fullName || userProfile?.senderName || 'Alex',
        usp: userProfile?.usp || userProfile?.businessType || null,
        userId: userProfile?.userId || userProfile?.id || 'anonymous',
        company: userProfile?.company || null,
        industry: userProfile?.industry || null,
    };
}

// ────────────────────────────────────────────────────────────────
// 4. MAIN ORCHESTRATOR
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚀 [FREE ENGINE] Orchestrator started');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const apiKey = process.env.OPENAI_API_KEY;
        const tavilyKey = process.env.TAVILY_API_KEY;
        const userId = userProfile?.userId || userProfile?.id || 'anonymous';
        const profile = buildUserProfile(userProfile);

        // ── Sanitize input ──
        const rawMessage = typeof message === 'string' ? message.slice(0, MAX_MESSAGE_LENGTH) : '';
        const safeMessage = sanitizeUserMessage(rawMessage);

        if (!safeMessage.trim()) {
            return {
                reply: 'How can I help you today? I can find leads, draft emails, answer business questions, or just chat.',
                updatedHistory: history || [],
            };
        }

        // ── STEP 1: Check Agent9 (Knowledge Repository) FIRST ──
        console.log('📦 [AGENT9] Checking knowledge repository...');
        onProgress?.('🔍 Checking existing knowledge...');

        const cachedResult = await agent9.checkExisting(safeMessage);

        if (cachedResult.exists && !cachedResult.blocked) {
            // ✅ FOUND! Return cached data
            console.log(`✅ [AGENT9] Cache HIT! Package: ${cachedResult.packageId}`);
            onProgress?.('📦 Retrieving cached results...');

            // Retrieve the full package
            const retrievalResult = await agent9.retrievePackage(safeMessage, QUANTITY_RULE_DEFAULT_MAX);

            if (retrievalResult.found) {
                const finalLeads = _applyOutputQuantityRules(
                    retrievalResult.leads || [],
                    QUANTITY_RULE_DEFAULT_MAX
                );

                console.log(`✅ [FREE ENGINE] Returning ${finalLeads.length} leads from cache`);
                console.log(`   📦 Package: ${retrievalResult.packageId}`);
                console.log(`   📊 Age: ${retrievalResult.age?.toFixed(1) || 'Unknown'} days`);
                console.log(`   🔄 Stale: ${retrievalResult.isStale ? 'Yes' : 'No'}`);

                return {
                    reply: JSON.stringify(finalLeads),
                    updatedHistory: [
                        ...(history || []),
                        { role: 'user', content: safeMessage },
                        { role: 'assistant', content: `[Retrieved ${finalLeads.length} leads from knowledge repository]` },
                    ],
                    _meta: {
                        source: 'cache',
                        packageId: retrievalResult.packageId,
                        age: retrievalResult.age,
                        isStale: retrievalResult.isStale,
                        totalAvailable: retrievalResult.totalAvailable,
                        returned: finalLeads.length,
                    }
                };
            }
        }

        if (cachedResult.blocked) {
            // ⛔ Blocked due to excessive access
            console.log(`⛔ [AGENT9] Package blocked: ${cachedResult.packageId}`);
            return {
                reply: cachedResult.message || 'This search has been accessed too many times. Please try again in 24 hours.',
                updatedHistory: history || [],
                _meta: {
                    blocked: true,
                    packageId: cachedResult.packageId,
                }
            };
        }

        // ── STEP 2: No cache found - Run Full Pipeline ──
        console.log('🔄 [AGENT9] Cache MISS. Starting full pipeline...');
        onProgress?.('🧠 No cache found. Building fresh results...');

        // ─── Agent1: Router (Intent Classification) ───
        console.log('🔁 [AGENT1] Routing request...');
        onProgress?.('🧠 Understanding your request...');

        const routerResult = await agent1.routeRequest({
            message: safeMessage,
            apiKey: apiKey,
            history: history,
            userId: userId,
            onProgress: onProgress,
        });

        console.log(`📋 [AGENT1] Intent: ${routerResult.intent}, Confidence: ${routerResult.confidence}`);

        // ── Handle non-lead intents ──
        if (routerResult.intent !== 'lead_generation') {
            console.log(`📋 [AGENT1] Non-lead intent: ${routerResult.intent}`);
            return {
                reply: `I understood you want "${routerResult.intent}". This feature is being built. For now, try asking for leads or business advice.`,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: `I understood you want ${routerResult.intent}. This feature is coming soon.` }
                ],
                _meta: {
                    intent: routerResult.intent,
                    confidence: routerResult.confidence,
                }
            };
        }

        if (routerResult.needs_clarification) {
            return {
                reply: routerResult.clarification_question || 'Could you be more specific about what you\'re looking for?',
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: routerResult.clarification_question || 'Could you be more specific?' }
                ],
                _meta: { needsClarification: true }
            };
        }

        // ── Extract lead intent ──
        const entities = routerResult.entities || {};
        const leadIntent = {
            industry: entities.industry || 'general',
            location: entities.location || null,
            target: entities.company || entities.industry || 'businesses',
            preferredContact: entities.role || 'Any',
            lead_count: entities.lead_count || QUANTITY_RULE_DEFAULT_MAX,
            entities: entities,
        };

        console.log(`🎯 [ORCHESTRATOR] Lead Intent:`, leadIntent);

        // ─── Agent2: Prospector ───
        console.log('🔁 [AGENT2] Discovering prospects...');
        onProgress?.('🔎 Searching for matching prospects...');

        const agent2Result = await agent2.discoverProspects({
            intent: leadIntent,
            apiKey: apiKey,
            tavilyKey: tavilyKey,
            userId: userId,
            onProgress: onProgress,
        });

        if (agent2Result.needs_clarification) {
            return {
                reply: agent2Result.clarification_question || 'I need more information to find the right prospects.',
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: agent2Result.clarification_question }
                ],
                _meta: { needsClarification: true }
            };
        }

        if (!agent2Result.prospects || agent2Result.prospects.length === 0) {
            const msg = `I couldn't find any matching prospects for ${leadIntent.industry || 'your industry'}${leadIntent.location ? ' in ' + leadIntent.location : ''}. Try a different industry or location.`;
            return {
                reply: msg,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No matching prospects found.' }
                ],
                _meta: { found: 0 }
            };
        }

        // ─── Agent3: Enrichment ───
        console.log('🔁 [AGENT3] Enriching prospects...');
        onProgress?.('🔬 Enriching and verifying prospects...');

        const agent3Result = await agent3.enrichProspects({
            prospects: agent2Result.prospects,
            intent: leadIntent,
            apiKey: apiKey,
            tavilyKey: tavilyKey,
            userId: userId,
            onProgress: onProgress,
        });

        if (agent3Result.needs_clarification) {
            return {
                reply: agent3Result.clarification_question || 'I enriched the prospects but many records are incomplete.',
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: agent3Result.clarification_question }
                ],
                _meta: { needsClarification: true }
            };
        }

        if (!agent3Result.enriched_prospects || agent3Result.enriched_prospects.length === 0) {
            return {
                reply: `I found prospects but couldn't verify any of them. Try a different industry or location.`,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No verified prospects found.' }
                ],
                _meta: { found: 0 }
            };
        }

        // ─── Agent4: Qualification ───
        console.log('🔁 [AGENT4] Qualifying prospects...');
        onProgress?.('🏆 Evaluating and prioritizing leads...');

        const agent4Result = await agent4.qualifyProspects({
            enriched_prospects: agent3Result.enriched_prospects,
            intent: leadIntent,
            apiKey: apiKey,
            tavilyKey: tavilyKey,
            userId: userId,
            onProgress: onProgress,
        });

        if (agent4Result.needs_clarification) {
            return {
                reply: agent4Result.clarification_question || 'I found some leads but the qualification is uncertain.',
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: agent4Result.clarification_question }
                ],
                _meta: { needsClarification: true }
            };
        }

        const qualifiedProspects = agent4Result.qualified_prospects || [];
        const qualified = qualifiedProspects.filter(p => p.qualification_status === 'qualified');

        if (qualified.length === 0) {
            return {
                reply: `I reviewed ${agent4Result.stats?.reviewed || 0} prospects but none met the qualification criteria. Try broadening your search.`,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No qualified leads found.' }
                ],
                _meta: { found: 0 }
            };
        }

        // ─── Agent5: Formatter ───
        console.log('🔁 [AGENT5] Formatting final leads...');
        onProgress?.('📦 Packaging final leads...');

        const agent5Result = await agent5.formatFinalLeads({
            qualified_prospects: qualified,
            intent: leadIntent,
            userProfile: profile,
            apiKey: apiKey,
            tavilyKey: tavilyKey,
            userId: userId,
            onProgress: onProgress,
        });

        if (agent5Result.needs_clarification) {
            return {
                reply: agent5Result.clarification_question || 'I formatted the leads but some fields are missing. Please check the output.',
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: agent5Result.clarification_question }
                ],
                _meta: { needsClarification: true }
            };
        }

        const finalLeads = agent5Result.leads || [];

        if (finalLeads.length === 0) {
            return {
                reply: `I processed ${qualified.length} qualified prospects but couldn't generate final leads. Please try again.`,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No final leads generated.' }
                ],
                _meta: { found: 0 }
            };
        }

        // ─── Apply quantity rules ───
        const finalLeadsSliced = _applyOutputQuantityRules(finalLeads, QUANTITY_RULE_DEFAULT_MAX);

        // ─── STEP 9: Agent9 - Store the complete package ───
        console.log('📦 [AGENT9] Storing knowledge package...');
        onProgress?.('💾 Saving to knowledge repository...');

        try {
            await agent9.storePackage({
                request: {
                    original: safeMessage,
                    normalized: safeMessage.toLowerCase(),
                },
                searchParams: {
                    industry: leadIntent.industry,
                    region: leadIntent.location,
                    jobTitle: leadIntent.preferredContact,
                    leadCount: finalLeadsSliced.length,
                },
                leads: finalLeadsSliced,
                companies: finalLeadsSliced.map(l => l.company || ''),
                emails: finalLeadsSliced.map(l => l.email || ''),
                messages: finalLeadsSliced.map(l => l.messages || []),
                performance: {
                    searchTime: 0,
                    aiCalls: 1,
                    apiCalls: 2,
                    costEstimate: 0.05,
                }
            });
            console.log('✅ [AGENT9] Package stored successfully');
        } catch (storeError) {
            console.error('⚠️ [AGENT9] Failed to store package:', storeError.message);
            // Non-fatal - continue to return results
        }

        // ─── Return final results ───
        console.log(`✅ [FREE ENGINE] Returning ${finalLeadsSliced.length} fresh leads`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        return {
            reply: JSON.stringify(finalLeadsSliced),
            updatedHistory: [
                ...(history || []),
                { role: 'user', content: safeMessage },
                { role: 'assistant', content: `[Generated ${finalLeadsSliced.length} fresh leads]` },
            ],
            _meta: {
                source: 'fresh',
                totalGenerated: finalLeadsSliced.length,
                agent2Stats: agent2Result.stats,
                agent3Stats: agent3Result.stats,
                agent4Stats: agent4Result.stats,
                agent5Stats: agent5Result.stats,
                storedInRepository: true,
            }
        };

    } catch (error) {
        console.error('❌ [FREE ENGINE] Fatal error:', error.message);
        console.error('❌ Stack:', error.stack);

        return {
            reply: 'An error occurred while processing your request. Please try again.',
            updatedHistory: history || [],
            _meta: {
                error: error.message,
            }
        };
    }
}

// ────────────────────────────────────────────────────────────────
// 5. PUBLIC EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
};
