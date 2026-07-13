'use strict';

// ────────────────────────────────────────────────────────────────
// 1. IMPORTS – All 9 Agents
// ────────────────────────────────────────────────────────────────

const agent1 = require('./agent1');  // ✅ understandRequest()
const agent2 = require('./agent2');  // ✅ generateHypotheses()
const agent3 = require('./agent3');  // ✅ multiSourceSearch()
const agent4 = require('./agent4');  // ✅ normalizeAndDeduplicate()
const agent5 = require('./agent5');  // ✅ enrichCompanies()
const agent6 = require('./agent6');  // ✅ scoreCompanies()
const agent7 = require('./agent7');  // ✅ rankCompanies()
const agent8 = require('./agent8');  // ✅ prepareOutreach()
const agent9 = require('./agent9');  // ✅ Knowledge Repository

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────────────────────────────────
// 2. CONFIG & CONSTANTS
// ────────────────────────────────────────────────────────────────

const MAX_LEADS_RETURNED = 5;
const MAX_MESSAGE_LENGTH = 800;
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
        
        // Truncate large arrays
        if (sanitized.companies && Array.isArray(sanitized.companies)) {
            sanitized.companies = sanitized.companies.slice(0, 3).map(c => ({
                name: c.name || c.company || 'Unknown',
                domain: c.domain || 'N/A',
                score: c.score?.overall || c.confidence || 'N/A'
            }));
            sanitized._companyCount = data.companies?.length || 0;
        }
        
        if (sanitized.candidates && Array.isArray(sanitized.candidates)) {
            sanitized.candidates = sanitized.candidates.slice(0, 3);
            sanitized._candidateCount = data.candidates?.length || 0;
        }
        
        if (sanitized.hypotheses && Array.isArray(sanitized.hypotheses)) {
            sanitized.hypotheses = sanitized.hypotheses.slice(0, 5);
            sanitized._hypothesisCount = data.hypotheses?.length || 0;
        }
        
        if (sanitized.prospects && Array.isArray(sanitized.prospects)) {
            sanitized.prospects = sanitized.prospects.slice(0, 3).map(p => ({
                company_name: p.company_name || 'Unknown',
                contact_email: p.contact_email || 'N/A',
                quality_passed: p.quality_passed || false
            }));
            sanitized._prospectCount = data.prospects?.length || 0;
        }
        
        if (sanitized.leads && Array.isArray(sanitized.leads)) {
            sanitized.leads = sanitized.leads.slice(0, 3).map(l => ({
                name: l.name || l.company || 'Unknown',
                company: l.company || 'Unknown',
                email: l.email || 'N/A',
            }));
            sanitized._leadCount = data.leads?.length || 0;
        }
        
        // Truncate long strings
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
    const logger = new AgentLogger();
    const userId = userProfile?.userId || userProfile?.id || 'anonymous';
    logger.startSession(userId, message);

    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚀 [FREE ENGINE] Orchestrator started');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const apiKey = process.env.OPENAI_API_KEY;
        const profile = buildUserProfile(userProfile);

        if (!apiKey) {
            throw new Error('OPENAI_API_KEY is not set in environment variables');
        }

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

        const cachedResult = await agent9.checkExisting(safeMessage);
        logger.logCacheCheck('AGENT9', cachedResult);

        if (cachedResult.exists && !cachedResult.blocked) {
            // ✅ FOUND! Return cached data
            console.log(`✅ [AGENT9] Cache HIT! Package: ${cachedResult.packageId}`);
            onProgress?.('📦 Retrieving cached results...');

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

        // ─── Agent1: Router (Query Understanding) ───
        console.log('🔁 [AGENT1] Routing request...');
        onProgress?.('🧠 Understanding your request...');

        const agent1Start = Date.now();
        logger.logAgentStart('AGENT1', { message: safeMessage, historyLength: history?.length || 0 });

        let routerResult;
        try {
            routerResult = await agent1.understandRequest({
                message: safeMessage,
                apiKey: apiKey,
                history: history,
                userId: userId,
                onProgress: onProgress,
                autoClarify: true
            });
            logger.logAgentComplete('AGENT1', routerResult, Date.now() - agent1Start);
        } catch (error) {
            logger.logAgentError('AGENT1', error);
            throw error;
        }

        console.log(`📋 [AGENT1] Intent: ${routerResult.intent}, Confidence: ${routerResult.confidence}`);

        // ── Handle non-lead intents ──
        if (routerResult.intent !== 'find_companies' && routerResult.intent !== 'find_startups' && routerResult.intent !== 'find_decision_makers') {
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

        // ── Extract search package ──
        const searchPackage = routerResult.search_package;
        if (!searchPackage) {
            const result = {
                reply: 'I couldn\'t understand your request properly. Could you please provide more details about what you\'re looking for?',
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'Please provide more details about your search.' }
                ],
                _meta: { error: 'No search_package generated' }
            };
            await logger.saveSessionLog();
            return result;
        }

        console.log(`📦 [ORCHESTRATOR] Search Package:`, JSON.stringify(searchPackage, null, 2));

        // ─── Agent2: Generate Hypotheses ───
        console.log('🔁 [AGENT2] Generating search hypotheses...');
        onProgress?.('🧠 Generating search strategies...');

        const agent2Start = Date.now();
        logger.logAgentStart('AGENT2', { searchPackage: searchPackage });

        let agent2Result;
        try {
            agent2Result = await agent2.generateHypotheses({
                searchPackage: searchPackage,
                apiKey: apiKey,
                userId: userId,
                onProgress: onProgress,
                historicalData: null
            });
            logger.logAgentComplete('AGENT2', agent2Result, Date.now() - agent2Start);
        } catch (error) {
            logger.logAgentError('AGENT2', error);
            throw error;
        }

        if (!agent2Result.success || !agent2Result.hypotheses || agent2Result.hypotheses.length === 0) {
            const msg = `I couldn't generate any search hypotheses for ${searchPackage.service_needed || 'your request'}. Please try a different service or industry.`;
            const result = {
                reply: msg,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No search hypotheses generated.' }
                ],
                _meta: { found: 0, error: agent2Result.error }
            };
            logger.log('FINAL_RESPONSE', { source: 'no_hypotheses' });
            await logger.saveSessionLog();
            return result;
        }

        console.log(`✅ [AGENT2] Generated ${agent2Result.hypotheses.length} hypotheses`);
        console.log(`   📊 Primary: ${agent2Result.search_strategy?.primary_hypotheses?.join(', ') || 'N/A'}`);

        // ─── Agent3: Multi-Source Search ───
        console.log('🔁 [AGENT3] Executing multi-source search...');
        onProgress?.('🔎 Searching multiple sources...');

        const agent3Start = Date.now();
        logger.logAgentStart('AGENT3', {
            hypotheses: agent2Result.hypotheses.map(h => h.industry),
            hypothesisCount: agent2Result.hypotheses.length
        });

        let agent3Result;
        try {
            agent3Result = await agent3.multiSourceSearch({
                hypotheses: agent2Result.hypotheses,
                searchPackage: searchPackage,
                userId: userId,
                onProgress: onProgress,
                sources: ['tavily']
            });
            logger.logAgentComplete('AGENT3', agent3Result, Date.now() - agent3Start);
        } catch (error) {
            logger.logAgentError('AGENT3', error);
            throw error;
        }

        if (!agent3Result.success || !agent3Result.candidates || agent3Result.candidates.length === 0) {
            const msg = `I searched for ${searchPackage.service_needed || 'your request'} but couldn't find any matching companies. Try a different service or industry.`;
            const result = {
                reply: msg,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No candidates found.' }
                ],
                _meta: { found: 0, stats: agent3Result.stats }
            };
            logger.log('FINAL_RESPONSE', { source: 'no_candidates' });
            await logger.saveSessionLog();
            return result;
        }

        console.log(`✅ [AGENT3] Found ${agent3Result.candidates.length} candidates from ${agent3Result.stats?.hypotheses || 0} hypotheses`);

        // ─── Agent4: Normalize & Deduplicate ───
        console.log('🔁 [AGENT4] Normalizing and deduplicating...');
        onProgress?.('📋 Normalizing company data...');

        const agent4Start = Date.now();
        logger.logAgentStart('AGENT4', { candidatesCount: agent3Result.candidates.length });

        let agent4Result;
        try {
            agent4Result = await agent4.normalizeAndDeduplicate({
                candidates: agent3Result.candidates,
                searchPackage: searchPackage,
                userId: userId,
                onProgress: onProgress
            });
            logger.logAgentComplete('AGENT4', agent4Result, Date.now() - agent4Start);
        } catch (error) {
            logger.logAgentError('AGENT4', error);
            throw error;
        }

        if (!agent4Result.success || !agent4Result.companies || agent4Result.companies.length === 0) {
            const result = {
                reply: `I found candidates but couldn't normalize them into clean company profiles. Please try again.`,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No valid companies after deduplication.' }
                ],
                _meta: { found: 0, stats: agent4Result.stats }
            };
            logger.log('FINAL_RESPONSE', { source: 'no_companies_after_dedupe' });
            await logger.saveSessionLog();
            return result;
        }

        console.log(`✅ [AGENT4] Normalized ${agent4Result.companies.length} unique companies`);

        // ─── Agent5: Enrich Companies ───
        console.log('🔁 [AGENT5] Enriching company intelligence...');
        onProgress?.('📊 Enriching company data...');

        const agent5Start = Date.now();
        logger.logAgentStart('AGENT5', { companiesCount: agent4Result.companies.length });

        let agent5Result;
        try {
            agent5Result = await agent5.enrichCompanies({
                companies: agent4Result.companies,
                searchPackage: searchPackage,
                userId: userId,
                onProgress: onProgress
            });
            logger.logAgentComplete('AGENT5', agent5Result, Date.now() - agent5Start);
        } catch (error) {
            logger.logAgentError('AGENT5', error);
            throw error;
        }

        if (!agent5Result.success || !agent5Result.companies || agent5Result.companies.length === 0) {
            const result = {
                reply: `I found ${agent4Result.companies.length} companies but couldn't enrich them. Please try again.`,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'Enrichment failed.' }
                ],
                _meta: { found: 0, stats: agent5Result.stats }
            };
            logger.log('FINAL_RESPONSE', { source: 'enrichment_failed' });
            await logger.saveSessionLog();
            return result;
        }

        console.log(`✅ [AGENT5] Enriched ${agent5Result.companies.length} companies`);

        // ─── Agent6: Skyline Intelligence (Scoring) ───
        console.log('🔁 [AGENT6] Running Skyline Intelligence...');
        onProgress?.('🧠 Analyzing company intelligence...');

        const agent6Start = Date.now();
        logger.logAgentStart('AGENT6', { companiesCount: agent5Result.companies.length });

        let agent6Result;
        try {
            agent6Result = await agent6.scoreCompanies({
                companies: agent5Result.companies,
                searchPackage: searchPackage,
                userId: userId,
                onProgress: onProgress
            });
            logger.logAgentComplete('AGENT6', agent6Result, Date.now() - agent6Start);
        } catch (error) {
            logger.logAgentError('AGENT6', error);
            throw error;
        }

        if (!agent6Result.success || !agent6Result.companies || agent6Result.companies.length === 0) {
            const result = {
                reply: `I enriched ${agent5Result.companies.length} companies but couldn't score them. Please try again.`,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'Scoring failed.' }
                ],
                _meta: { found: 0, stats: agent6Result.stats }
            };
            logger.log('FINAL_RESPONSE', { source: 'scoring_failed' });
            await logger.saveSessionLog();
            return result;
        }

        console.log(`✅ [AGENT6] Scored ${agent6Result.companies.length} companies`);
        console.log(`   📊 High: ${agent6Result.stats?.high_confidence || 0}`);
        console.log(`   📊 Medium: ${agent6Result.stats?.medium_confidence || 0}`);
        console.log(`   📊 Low: ${agent6Result.stats?.low_confidence || 0}`);

        // ─── Agent7: Ranking & Recommendation ───
        console.log('🔁 [AGENT7] Ranking companies...');
        onProgress?.('🏆 Ranking and prioritizing...');

        const agent7Start = Date.now();
        logger.logAgentStart('AGENT7', { companiesCount: agent6Result.companies.length });

        let agent7Result;
        try {
            agent7Result = await agent7.rankCompanies({
                companies: agent6Result.companies,
                searchPackage: searchPackage,
                userId: userId,
                onProgress: onProgress,
                limit: MAX_LEADS_RETURNED * 2,
                diversify: true
            });
            logger.logAgentComplete('AGENT7', agent7Result, Date.now() - agent7Start);
        } catch (error) {
            logger.logAgentError('AGENT7', error);
            throw error;
        }

        if (!agent7Result.success || !agent7Result.companies || agent7Result.companies.length === 0) {
            const result = {
                reply: `I scored ${agent6Result.companies.length} companies but couldn't rank them. Please try again.`,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'Ranking failed.' }
                ],
                _meta: { found: 0, stats: agent7Result.stats }
            };
            logger.log('FINAL_RESPONSE', { source: 'ranking_failed' });
            await logger.saveSessionLog();
            return result;
        }

        console.log(`✅ [AGENT7] Ranked ${agent7Result.companies.length} companies`);

        // ─── Agent8: Outreach Preparation ───
        console.log('🔁 [AGENT8] Preparing outreach...');
        onProgress?.('📝 Generating personalized outreach...');

        const agent8Start = Date.now();
        logger.logAgentStart('AGENT8', { companiesCount: agent7Result.companies.length });

        let agent8Result;
        try {
            agent8Result = await agent8.prepareOutreach({
                companies: agent7Result.companies,
                searchPackage: searchPackage,
                userProfile: profile,
                apiKey: apiKey,
                userId: userId,
                onProgress: onProgress,
                limit: MAX_LEADS_RETURNED * 2
            });
            logger.logAgentComplete('AGENT8', agent8Result, Date.now() - agent8Start);
        } catch (error) {
            logger.logAgentError('AGENT8', error);
            throw error;
        }

        if (!agent8Result.success || !agent8Result.prospects || agent8Result.prospects.length === 0) {
            const result = {
                reply: `I ranked ${agent7Result.companies.length} companies but couldn't prepare outreach. Please try again.`,
                updatedHistory: [
                    ...(history || []),
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'Outreach preparation failed.' }
                ],
                _meta: { found: 0, stats: agent8Result.stats }
            };
            logger.log('FINAL_RESPONSE', { source: 'outreach_failed' });
            await logger.saveSessionLog();
            return result;
        }

        console.log(`✅ [AGENT8] Prepared outreach for ${agent8Result.prospects.length} companies`);
        console.log(`   📊 With email: ${agent8Result.stats?.with_email || 0}`);
        console.log(`   📊 Quality passed: ${agent8Result.stats?.quality_passed || 0}`);

        // ─── Convert prepared prospects to final leads format ───
        const finalLeads = agent8Result.prospects.map(prospect => {
            return {
                name: prospect.company_name || 'Unknown',
                company: prospect.company_name || 'Unknown',
                domain: prospect.company_domain || null,
                website: prospect.company_domain ? `https://${prospect.company_domain}` : null,
                email: prospect.contact_email || null,
                emailConfidence: prospect.contact_confidence || 'none',
                emailLabel: prospect.contact_source === 'none' ? 'No email found' : `Email from ${prospect.contact_source}`,
                role: searchPackage.filters?.job_titles?.[0] || 'Decision Maker',
                industry: prospect.company_industry || searchPackage.industries?.[0] || 'general',
                hq: prospect.company_location || searchPackage.countries?.[0] || null,
                employees: prospect.company_employees || null,
                leadScore: prospect.confidence || 0.5,
                rank: prospect.rank || null,
                rank_label: prospect.rank_label || null,
                quality_score: prospect.quality_score || 0,
                quality_passed: prospect.quality_passed || false,
                quality_issues: prospect.quality_issues || [],
                quality_warnings: prospect.quality_warnings || [],
                outreach: {
                    subject: prospect.outreach_subject || '',
                    body: prospect.outreach_body || '',
                    personalization_used: prospect.personalization_used || [],
                    evidence_summary: prospect.evidence_summary || [],
                },
                reason_selected: prospect.reason_selected || [],
                messages: [
                    {
                        type: 'initial',
                        subject: prospect.outreach_subject || `Introduction: ${prospect.company_name}`,
                        body: prospect.outreach_body || `Hi,\n\nI came across ${prospect.company_name} and wanted to reach out.\n\nBest,\n${profile.senderName}`
                    },
                    {
                        type: 'followup',
                        subject: `Re: ${prospect.outreach_subject || `Introduction: ${prospect.company_name}`}`,
                        body: `Hi,\n\nJust following up on my previous message.\n\nBest,\n${profile.senderName}`
                    },
                    {
                        type: 'breakup',
                        subject: `Closing the loop`,
                        body: `Hi,\n\nAssuming timing isn't right, I'll stop following up. Reach out whenever it makes sense.\n\nBest,\n${profile.senderName}`
                    }
                ],
                _prospect_data: prospect // Keep original data for reference
            };
        });

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
                    industry: searchPackage.industries?.[0] || 'general',
                    region: searchPackage.countries?.[0] || null,
                    jobTitle: searchPackage.filters?.job_titles?.[0] || 'Any',
                    leadCount: finalLeadsSliced.length,
                },
                leads: finalLeadsSliced,
                companies: finalLeadsSliced.map(l => l.company || ''),
                emails: finalLeadsSliced.map(l => l.email || ''),
                messages: finalLeadsSliced.map(l => l.messages || []),
                performance: {
                    searchTime: Date.now() - logger.startTime,
                    aiCalls: 8,
                    apiCalls: 4,
                    costEstimate: 0.15,
                }
            });
            logger.logStorage('AGENT9', storageResult);
            console.log('✅ [AGENT9] Package stored successfully');
        } catch (storeError) {
            logger.logAgentError('AGENT9_STORAGE', storeError);
            console.error('⚠️ [AGENT9] Failed to store package:', storeError.message);
        }

        // ─── Return final results ───
        console.log(`✅ [FREE ENGINE] Returning ${finalLeadsSliced.length} final leads`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const result = {
            reply: JSON.stringify(finalLeadsSliced),
            updatedHistory: [
                ...(history || []),
                { role: 'user', content: safeMessage },
                { role: 'assistant', content: `[Generated ${finalLeadsSliced.length} final leads]` },
            ],
            _meta: {
                source: 'fresh',
                totalGenerated: finalLeadsSliced.length,
                agent1Stats: {
                    intent: routerResult.intent,
                    confidence: routerResult.confidence
                },
                agent2Stats: {
                    hypotheses: agent2Result.hypotheses?.length || 0,
                    confidence: agent2Result.confidence
                },
                agent3Stats: agent3Result.stats,
                agent4Stats: agent4Result.stats,
                agent5Stats: agent5Result.stats,
                agent6Stats: agent6Result.stats,
                agent7Stats: agent7Result.stats,
                agent8Stats: agent8Result.stats,
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
