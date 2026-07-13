'use strict';

// ────────────────────────────────────────────────────────────────
// 1. IMPORTS – All 9 Agents
// ────────────────────────────────────────────────────────────────

const agent1 = require('./agent1');
const agent2 = require('./agent2');
const agent3 = require('./agent3');
const agent4 = require('./agent4');
const agent5 = require('./agent5');
const agent6 = require('./agent6');
const agent7 = require('./agent7');
const agent8 = require('./agent8');

// ── Agent9 with safety wrapper ──
let agent9 = require('./agent9');

// ✅ Ensure agent9 has all required methods
if (typeof agent9.checkExisting !== 'function') {
    console.warn('⚠️ [FREE] agent9 methods missing, creating wrapper...');
    
    const originalAgent9 = agent9;
    agent9 = {
        checkExisting: async (request) => {
            if (typeof originalAgent9.checkExisting === 'function') {
                return originalAgent9.checkExisting(request);
            }
            try {
                const KnowledgePackage = require('./KnowledgePackage');
                const normalized = request.toLowerCase().trim();
                const pkg = await KnowledgePackage.findOne({ 
                    'request.normalized': normalized 
                });
                if (pkg) {
                    return { exists: true, packageId: pkg.packageId, blocked: false };
                }
                return { exists: false, message: 'No data found' };
            } catch (err) {
                return { exists: false, message: 'No data found' };
            }
        },
        retrievePackage: async (request, count) => {
            if (typeof originalAgent9.retrievePackage === 'function') {
                return originalAgent9.retrievePackage(request, count);
            }
            try {
                const KnowledgePackage = require('./KnowledgePackage');
                const normalized = request.toLowerCase().trim();
                const pkg = await KnowledgePackage.findOne({ 
                    'request.normalized': normalized 
                });
                if (pkg) {
                    const leads = pkg.results?.leads || [];
                    return {
                        found: true,
                        packageId: pkg.packageId,
                        totalAvailable: leads.length,
                        leads: leads.slice(0, count || leads.length),
                        companies: pkg.results?.companies || [],
                        emails: pkg.results?.emails || [],
                        messages: pkg.results?.messages || [],
                        metadata: pkg.metadata || {},
                        isStale: false,
                        age: 0,
                    };
                }
                return { found: false, message: 'No data found' };
            } catch (err) {
                return { found: false, message: 'No data found' };
            }
        },
        storePackage: async (data) => {
            if (typeof originalAgent9.storePackage === 'function') {
                return originalAgent9.storePackage(data);
            }
            try {
                const KnowledgePackage = require('./KnowledgePackage');
                const packageId = `pkg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
                const pkg = new KnowledgePackage({
                    packageId,
                    request: data.request || {},
                    searchParams: data.searchParams || {},
                    results: {
                        total: data.leads?.length || 0,
                        leads: data.leads || [],
                        companies: data.companies || [],
                        emails: data.emails || [],
                        messages: data.messages || [],
                    },
                    metadata: {
                        createdAt: new Date(),
                        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
                    },
                    performance: data.performance || {},
                });
                await pkg.save();
                return pkg;
            } catch (err) {
                console.error('❌ [AGENT9] Store fallback failed:', err.message);
                return null;
            }
        },
        cleanupExpired: async () => {
            if (typeof originalAgent9.cleanupExpired === 'function') {
                return originalAgent9.cleanupExpired();
            }
            try {
                const KnowledgePackage = require('./KnowledgePackage');
                const result = await KnowledgePackage.deleteMany({
                    'metadata.expiresAt': { $lt: new Date() }
                });
                return result.deletedCount;
            } catch (err) {
                return 0;
            }
        },
        getStatistics: async () => {
            if (typeof originalAgent9.getStatistics === 'function') {
                return originalAgent9.getStatistics();
            }
            try {
                const KnowledgePackage = require('./KnowledgePackage');
                const total = await KnowledgePackage.countDocuments();
                return { totalPackages: total, expiredPackages: 0, totalLeads: 0 };
            } catch (err) {
                return { totalPackages: 0, expiredPackages: 0, totalLeads: 0 };
            }
        }
    };
    console.log('✅ [FREE] agent9 wrapper created with fallback methods');
}

const fs = require('fs');
const path = require('path');

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
// 3. LOGGING SYSTEM
// ────────────────────────────────────────────────────────────────

class AgentLogger {
    constructor() {
        this.sessionId = null;
        this.startTime = null;
        this.logs = [];
        this.logDir = path.join(__dirname, 'logs', 'agents');
        
        // Create log directory if it doesn't exist
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    startSession(userId, message) {
        this.sessionId = `${Date.now()}-${userId.substring(0, 8)}`;
        this.startTime = Date.now();
        this.logs = [];
        
        this.log('SESSION_START', {
            userId,
            message: message.substring(0, 200),
            timestamp: new Date().toISOString(),
            sessionId: this.sessionId,
        });
        
        console.log(`\n${'═'.repeat(80)}`);
        console.log(`📋 [LOGGER] Session Started: ${this.sessionId}`);
        console.log(`📋 [LOGGER] User: ${userId}`);
        console.log(`📋 [LOGGER] Message: ${message.substring(0, 100)}...`);
        console.log(`${'═'.repeat(80)}\n`);
        
        return this.sessionId;
    }

    log(agent, data) {
        const entry = {
            agent,
            timestamp: new Date().toISOString(),
            elapsed: Date.now() - this.startTime,
            data: this._sanitizeData(data),
        };
        this.logs.push(entry);
        return entry;
    }

    logAgentStart(agent, input) {
        const entry = this.log(`${agent}_START`, {
            status: 'started',
            input: this._sanitizeData(input),
        });
        
        console.log(`🔄 [${agent}] Started at ${new Date().toISOString()}`);
        console.log(`   📥 Input: ${JSON.stringify(this._sanitizeData(input)).substring(0, 150)}...`);
        
        return entry;
    }

    logAgentComplete(agent, output, duration) {
        const entry = this.log(`${agent}_COMPLETE`, {
            status: 'completed',
            duration: duration,
            output: this._sanitizeData(output),
        });
        
        console.log(`✅ [${agent}] Completed in ${duration}ms`);
        console.log(`   📤 Output: ${JSON.stringify(this._sanitizeData(output)).substring(0, 150)}...`);
        
        return entry;
    }

    logAgentError(agent, error) {
        const entry = this.log(`${agent}_ERROR`, {
            status: 'error',
            error: error.message,
            stack: error.stack,
        });
        
        console.error(`❌ [${agent}] Error: ${error.message}`);
        
        return entry;
    }

    logCacheCheck(agent, result) {
        const entry = this.log(`${agent}_CACHE_CHECK`, {
            status: 'cache_check',
            found: result.exists || false,
            blocked: result.blocked || false,
            packageId: result.packageId || null,
        });
        
        console.log(`📦 [${agent}] Cache check: ${result.exists ? 'HIT ✅' : 'MISS ❌'}`);
        if (result.exists) {
            console.log(`   📦 Package: ${result.packageId}`);
            console.log(`   ⛔ Blocked: ${result.blocked ? 'YES' : 'NO'}`);
        }
        
        return entry;
    }

    logCacheRetrieval(agent, result) {
        const entry = this.log(`${agent}_CACHE_RETRIEVAL`, {
            status: 'cache_retrieval',
            found: result.found || false,
            totalAvailable: result.totalAvailable || 0,
            returned: result.leads?.length || 0,
            age: result.age || null,
            isStale: result.isStale || false,
        });
        
        console.log(`📦 [${agent}] Cache retrieval: ${result.found ? 'SUCCESS ✅' : 'FAILED ❌'}`);
        if (result.found) {
            console.log(`   📊 Total available: ${result.totalAvailable}`);
            console.log(`   📊 Returned: ${result.leads?.length || 0}`);
            console.log(`   📅 Age: ${result.age?.toFixed(1) || 'Unknown'} days`);
        }
        
        return entry;
    }

    logStorage(agent, result) {
        const entry = this.log(`${agent}_STORAGE`, {
            status: 'storage',
            success: !!result,
            packageId: result?.packageId || null,
            totalLeads: result?.results?.total || 0,
        });
        
        console.log(`💾 [${agent}] Storage: ${result ? 'SUCCESS ✅' : 'FAILED ❌'}`);
        if (result) {
            console.log(`   📦 Package: ${result.packageId}`);
            console.log(`   📊 Leads stored: ${result.results?.total || 0}`);
        }
        
        return entry;
    }

    _sanitizeData(data) {
        if (!data) return null;
        
        const sanitized = JSON.parse(JSON.stringify(data));
        
        if (sanitized.leads && Array.isArray(sanitized.leads)) {
            sanitized.leads = sanitized.leads.slice(0, 3).map(l => ({
                name: l.name || l.company || 'Unknown',
                company: l.company || 'Unknown',
                email: l.email || 'N/A',
                score: l.leadScore || l.fit_score || 'N/A',
            }));
            sanitized._leadCount = data.leads?.length || 0;
        }
        
        if (sanitized.prospects && Array.isArray(sanitized.prospects)) {
            sanitized.prospects = sanitized.prospects.slice(0, 3).map(p => ({
                name: p.name || p.company || 'Unknown',
                company: p.company || 'Unknown',
                domain: p.domain || 'N/A',
            }));
            sanitized._prospectCount = data.prospects?.length || 0;
        }
        
        if (sanitized.enriched_prospects && Array.isArray(sanitized.enriched_prospects)) {
            sanitized.enriched_prospects = sanitized.enriched_prospects.slice(0, 3).map(p => ({
                name: p.name || p.company || 'Unknown',
                company: p.company || 'Unknown',
                email: p.email || 'N/A',
                confidence: p.confidence || 'N/A',
            }));
            sanitized._enrichedCount = data.enriched_prospects?.length || 0;
        }
        
        if (sanitized.qualified_prospects && Array.isArray(sanitized.qualified_prospects)) {
            sanitized.qualified_prospects = sanitized.qualified_prospects.slice(0, 3).map(p => ({
                name: p.name || 'Unknown',
                company: p.company || 'Unknown',
                score: p.fit_score || p.leadScore || 'N/A',
                status: p.qualification_status || 'N/A',
            }));
            sanitized._qualifiedCount = data.qualified_prospects?.length || 0;
        }
        
        for (const key in sanitized) {
            if (typeof sanitized[key] === 'string' && sanitized[key].length > 500) {
                sanitized[key] = sanitized[key].substring(0, 500) + '... [TRUNCATED]';
            }
        }
        
        return sanitized;
    }

    async saveSessionLog() {
        try {
            const logFile = path.join(this.logDir, `session-${this.sessionId}.json`);
            const summary = {
                sessionId: this.sessionId,
                startTime: new Date(this.startTime).toISOString(),
                endTime: new Date().toISOString(),
                totalDuration: Date.now() - this.startTime,
                totalLogs: this.logs.length,
                agents: [...new Set(this.logs.map(l => l.agent.replace(/_.*$/, '')))],
                logs: this.logs,
            };
            
            fs.writeFileSync(logFile, JSON.stringify(summary, null, 2));
            
            console.log(`\n${'═'.repeat(80)}`);
            console.log(`📋 [LOGGER] Session saved: ${logFile}`);
            console.log(`📋 [LOGGER] Total duration: ${summary.totalDuration}ms`);
            console.log(`📋 [LOGGER] Total logs: ${summary.totalLogs}`);
            console.log(`${'═'.repeat(80)}\n`);
            
            return logFile;
        } catch (error) {
            console.error('❌ [LOGGER] Failed to save session log:', error.message);
            return null;
        }
    }
}

// ────────────────────────────────────────────────────────────────
// 4. UTILITIES
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
// 5. MAIN ORCHESTRATOR
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress) {
    // ── Initialize logger ──
    const logger = new AgentLogger();
    const userId = userProfile?.userId || userProfile?.id || 'anonymous';
    logger.startSession(userId, message);

    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚀 [FREE ENGINE] Orchestrator started');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const apiKey = process.env.OPENAI_API_KEY;
        const tavilyKey = process.env.TAVILY_API_KEY;
        const profile = buildUserProfile(userProfile);

        // ── Sanitize input ──
        const rawMessage = typeof message === 'string' ? message.slice(0, MAX_MESSAGE_LENGTH) : '';
        const safeMessage = sanitizeUserMessage(rawMessage);

        if (!safeMessage.trim()) {
            const result = {
                reply: 'How can I help you today? I can find leads, draft emails, answer business questions, or just chat.',
                updatedHistory: history || [],
            };
            await logger.saveSessionLog();
            return result;
        }

        // ── STEP 1: Check Agent9 (Knowledge Repository) FIRST ──
        console.log('📦 [AGENT9] Checking knowledge repository...');
        onProgress?.('🔍 Checking existing knowledge...');

        const cacheCheckStart = Date.now();
        const cachedResult = await agent9.checkExisting(safeMessage);
        logger.logCacheCheck('AGENT9', cachedResult);

        if (cachedResult.exists && !cachedResult.blocked) {
            // ✅ FOUND! Return cached data
            console.log(`✅ [AGENT9] Cache HIT! Package: ${cachedResult.packageId}`);
            onProgress?.('📦 Retrieving cached results...');

            const retrievalStart = Date.now();
            const retrievalResult = await agent9.retrievePackage(safeMessage, QUANTITY_RULE_DEFAULT_MAX);
            logger.logCacheRetrieval('AGENT9', retrievalResult);

            if (retrievalResult.found) {
                const finalLeads = _applyOutputQuantityRules(
                    retrievalResult.leads || [],
                    QUANTITY_RULE_DEFAULT_MAX
                );

                console.log(`✅ [FREE ENGINE] Returning ${finalLeads.length} leads from cache`);
                console.log(`   📦 Package: ${retrievalResult.packageId}`);
                console.log(`   📊 Age: ${retrievalResult.age?.toFixed(1) || 'Unknown'} days`);
                console.log(`   🔄 Stale: ${retrievalResult.isStale ? 'Yes' : 'No'}`);

                const result = {
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

                logger.log('FINAL_RESPONSE', {
                    source: 'cache',
                    leadsReturned: finalLeads.length,
                    packageId: retrievalResult.packageId,
                });

                await logger.saveSessionLog();
                return result;
            }
        }

        if (cachedResult.blocked) {
            // ⛔ Blocked due to excessive access
            console.log(`⛔ [AGENT9] Package blocked: ${cachedResult.packageId}`);
            
            const result = {
                reply: cachedResult.message || 'This search has been accessed too many times. Please try again in 24 hours.',
                updatedHistory: history || [],
                _meta: {
                    blocked: true,
                    packageId: cachedResult.packageId,
                }
            };

            logger.log('FINAL_RESPONSE', {
                source: 'blocked',
                packageId: cachedResult.packageId,
            });

            await logger.saveSessionLog();
            return result;
        }

        // ── STEP 2: No cache found - Run Full Pipeline ──
        console.log('🔄 [AGENT9] Cache MISS. Starting full pipeline...');
        onProgress?.('🧠 No cache found. Building fresh results...');

        // ─── Agent1: Router ───
        console.log('🔁 [AGENT1] Routing request...');
        onProgress?.('🧠 Understanding your request...');

        const agent1Start = Date.now();
        logger.logAgentStart('AGENT1', { message: safeMessage, historyLength: history?.length || 0 });

        let routerResult;
        try {
            routerResult = await agent1.routeRequest({
                message: safeMessage,
                apiKey: apiKey,
                history: history,
                userId: userId,
                onProgress: onProgress,
            });
            logger.logAgentComplete('AGENT1', routerResult, Date.now() - agent1Start);
        } catch (error) {
            logger.logAgentError('AGENT1', error);
            throw error;
        }

        console.log(`📋 [AGENT1] Intent: ${routerResult.intent}, Confidence: ${routerResult.confidence}`);

        // ── Handle non-lead intents ──
        if (routerResult.intent !== 'lead_generation') {
            console.log(`📋 [AGENT1] Non-lead intent: ${routerResult.intent}`);
            
            const result = {
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

            logger.log('FINAL_RESPONSE', {
                source: 'non_lead_intent',
                intent: routerResult.intent,
            });

            await logger.saveSessionLog();
            return result;
        }

        if (routerResult.needs_clarification) {
            const result = {
                reply: routerResult.clarification_question || 'Could you be more specific about what you\'re looking for?',
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: routerResult.clarification_question || 'Could you be more specific?' }
                ],
                _meta: { needsClarification: true }
            };

            logger.log('FINAL_RESPONSE', {
                source: 'needs_clarification',
                question: routerResult.clarification_question,
            });

            await logger.saveSessionLog();
            return result;
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

        const agent2Start = Date.now();
        logger.logAgentStart('AGENT2', { intent: leadIntent });

        let agent2Result;
        try {
            agent2Result = await agent2.discoverProspects({
                intent: leadIntent,
                apiKey: apiKey,
                tavilyKey: tavilyKey,
                userId: userId,
                onProgress: onProgress,
            });
            logger.logAgentComplete('AGENT2', agent2Result, Date.now() - agent2Start);
        } catch (error) {
            logger.logAgentError('AGENT2', error);
            throw error;
        }

        if (agent2Result.needs_clarification) {
            const result = {
                reply: agent2Result.clarification_question || 'I need more information to find the right prospects.',
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: agent2Result.clarification_question }
                ],
                _meta: { needsClarification: true }
            };
            await logger.saveSessionLog();
            return result;
        }

        if (!agent2Result.prospects || agent2Result.prospects.length === 0) {
            const msg = `I couldn't find any matching prospects for ${leadIntent.industry || 'your industry'}${leadIntent.location ? ' in ' + leadIntent.location : ''}. Try a different industry or location.`;
            const result = {
                reply: msg,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No matching prospects found.' }
                ],
                _meta: { found: 0 }
            };
            logger.log('FINAL_RESPONSE', { source: 'no_prospects' });
            await logger.saveSessionLog();
            return result;
        }

        // ─── Agent3: Enrichment ───
        console.log('🔁 [AGENT3] Enriching prospects...');
        onProgress?.('🔬 Enriching and verifying prospects...');

        const agent3Start = Date.now();
        logger.logAgentStart('AGENT3', { prospectsCount: agent2Result.prospects?.length || 0 });

        let agent3Result;
        try {
            agent3Result = await agent3.enrichProspects({
                prospects: agent2Result.prospects,
                intent: leadIntent,
                apiKey: apiKey,
                tavilyKey: tavilyKey,
                userId: userId,
                onProgress: onProgress,
            });
            logger.logAgentComplete('AGENT3', agent3Result, Date.now() - agent3Start);
        } catch (error) {
            logger.logAgentError('AGENT3', error);
            throw error;
        }

        if (agent3Result.needs_clarification) {
            const result = {
                reply: agent3Result.clarification_question || 'I enriched the prospects but many records are incomplete.',
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: agent3Result.clarification_question }
                ],
                _meta: { needsClarification: true }
            };
            await logger.saveSessionLog();
            return result;
        }

        if (!agent3Result.enriched_prospects || agent3Result.enriched_prospects.length === 0) {
            const result = {
                reply: `I found prospects but couldn't verify any of them. Try a different industry or location.`,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No verified prospects found.' }
                ],
                _meta: { found: 0 }
            };
            logger.log('FINAL_RESPONSE', { source: 'no_enriched' });
            await logger.saveSessionLog();
            return result;
        }

        // ─── Agent4: Qualification ───
        console.log('🔁 [AGENT4] Qualifying prospects...');
        onProgress?.('🏆 Evaluating and prioritizing leads...');

        const agent4Start = Date.now();
        logger.logAgentStart('AGENT4', { enrichedCount: agent3Result.enriched_prospects?.length || 0 });

        let agent4Result;
        try {
            agent4Result = await agent4.qualifyProspects({
                enriched_prospects: agent3Result.enriched_prospects,
                intent: leadIntent,
                apiKey: apiKey,
                tavilyKey: tavilyKey,
                userId: userId,
                onProgress: onProgress,
            });
            logger.logAgentComplete('AGENT4', agent4Result, Date.now() - agent4Start);
        } catch (error) {
            logger.logAgentError('AGENT4', error);
            throw error;
        }

        if (agent4Result.needs_clarification) {
            const result = {
                reply: agent4Result.clarification_question || 'I found some leads but the qualification is uncertain.',
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: agent4Result.clarification_question }
                ],
                _meta: { needsClarification: true }
            };
            await logger.saveSessionLog();
            return result;
        }

        const qualifiedProspects = agent4Result.qualified_prospects || [];
        const qualified = qualifiedProspects.filter(p => p.qualification_status === 'qualified');

        if (qualified.length === 0) {
            const result = {
                reply: `I reviewed ${agent4Result.stats?.reviewed || 0} prospects but none met the qualification criteria. Try broadening your search.`,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No qualified leads found.' }
                ],
                _meta: { found: 0 }
            };
            logger.log('FINAL_RESPONSE', { source: 'no_qualified' });
            await logger.saveSessionLog();
            return result;
        }

        // ─── Agent5: Formatter ───
        console.log('🔁 [AGENT5] Formatting final leads...');
        onProgress?.('📦 Packaging final leads...');

        const agent5Start = Date.now();
        logger.logAgentStart('AGENT5', { qualifiedCount: qualified.length });

        let agent5Result;
        try {
            agent5Result = await agent5.formatFinalLeads({
                qualified_prospects: qualified,
                intent: leadIntent,
                userProfile: profile,
                apiKey: apiKey,
                tavilyKey: tavilyKey,
                userId: userId,
                onProgress: onProgress,
            });
            logger.logAgentComplete('AGENT5', agent5Result, Date.now() - agent5Start);
        } catch (error) {
            logger.logAgentError('AGENT5', error);
            throw error;
        }

        if (agent5Result.needs_clarification) {
            const result = {
                reply: agent5Result.clarification_question || 'I formatted the leads but some fields are missing. Please check the output.',
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: agent5Result.clarification_question }
                ],
                _meta: { needsClarification: true }
            };
            await logger.saveSessionLog();
            return result;
        }

        const finalLeads = agent5Result.leads || [];

        if (finalLeads.length === 0) {
            const result = {
                reply: `I processed ${qualified.length} qualified prospects but couldn't generate final leads. Please try again.`,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No final leads generated.' }
                ],
                _meta: { found: 0 }
            };
            logger.log('FINAL_RESPONSE', { source: 'no_final_leads' });
            await logger.saveSessionLog();
            return result;
        }

        // ─── Apply quantity rules ───
        const finalLeadsSliced = _applyOutputQuantityRules(finalLeads, QUANTITY_RULE_DEFAULT_MAX);

        // ─── STEP 9: Agent9 - Store the complete package ───
        console.log('📦 [AGENT9] Storing knowledge package...');
        onProgress?.('💾 Saving to knowledge repository...');

        let storageResult = null;
        try {
            storageResult = await agent9.storePackage({
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
                    searchTime: Date.now() - logger.startTime,
                    aiCalls: 5,
                    apiCalls: 3,
                    costEstimate: 0.08,
                }
            });
            logger.logStorage('AGENT9', storageResult);
            console.log('✅ [AGENT9] Package stored successfully');
        } catch (storeError) {
            logger.logAgentError('AGENT9_STORAGE', storeError);
            console.error('⚠️ [AGENT9] Failed to store package:', storeError.message);
        }

        // ─── Return final results ───
        console.log(`✅ [FREE ENGINE] Returning ${finalLeadsSliced.length} fresh leads`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const result = {
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
                storedInRepository: !!storageResult,
            }
        };

        logger.log('FINAL_RESPONSE', {
            source: 'fresh',
            leadsReturned: finalLeadsSliced.length,
            storedInRepository: !!storageResult,
        });

        await logger.saveSessionLog();
        return result;

    } catch (error) {
        console.error('❌ [FREE ENGINE] Fatal error:', error.message);
        console.error('❌ Stack:', error.stack);
        
        logger.logAgentError('FREE_ENGINE', error);
        await logger.saveSessionLog();

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
// 6. PUBLIC EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
};
