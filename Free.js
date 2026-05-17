'use strict';

// ─── MODULE IMPORTS ───────────────────────────────────────────────────────────
const {
    searchCompanies,
    researchCompany,
    resolveEmail,
    resolveBestContact,
    validateMX,
    scoreDataCompleteness,
    cleanCompanyName,
    extractIntent,
    isValidEmailFormat,
} = require('./leadDiscovery');

const {
    scoreLeadQuality,
    shouldAcceptLead,
} = require('./leadScoring');

const {
    generateEmailSequence,
    detectLanguage,
} = require('./outreachGenerator');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const MAX_LEADS_RETURNED = 5;
const CONCURRENCY_LIMIT  = 2;

// ─── TAVILY QUOTA TRACKER ─────────────────────────────────────────────────────
const TAVILY_LIMIT = 1000;
const tavilyQuota = {
    used:      0,
    limit:     TAVILY_LIMIT,
    lastReset: Date.now(),
    _checkReset() {
        const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
        if (Date.now() - this.lastReset >= ONE_MONTH) {
            this.used = 0;
            this.lastReset = Date.now();
        }
    },
    remaining() { this._checkReset(); return this.limit - this.used; },
    record()    { this.used += 1; },
};

// ─── OPENAI TRACKER ───────────────────────────────────────────────────────────
const openAiTracker = {
    totalCallsThisSession:  0,
    totalTokensThisSession: 0,
    estimatedUSD:           0,
    record(tokensUsed) {
        this.totalCallsThisSession  += 1;
        this.totalTokensThisSession += tokensUsed;
        this.estimatedUSD           += (tokensUsed / 1_000_000) * 0.30;
    },
    summary() {
        return `GPT: ${this.totalCallsThisSession} calls | ${this.totalTokensThisSession} tokens | ~$${this.estimatedUSD.toFixed(4)}`;
    },
};

// ─── CONCURRENCY RUNNER ───────────────────────────────────────────────────────
async function runWithConcurrency(tasks, limit) {
    const results   = [];
    const executing = new Set();
    for (const task of tasks) {
        const promise = task()
            .then(r => { executing.delete(promise); return r; })
            .catch(()  => { executing.delete(promise); return null; });
        results.push(promise);
        executing.add(promise);
        if (executing.size >= limit) await Promise.race(executing);
    }
    return Promise.allSettled(results);
}

// ─── SINGLE COMPANY PIPELINE ──────────────────────────────────────────────────
async function processOneCompany(rawResult, intent, userProfile, lang, onProgress) {
    try {
        const apiKey    = process.env.OPENAI_API_KEY;
        const tavilyKey = process.env.TAVILY_API_KEY;

        const domain = rawResult._domain;
        if (!domain) return null;

        const companyName = cleanCompanyName(rawResult.title);
        if (!companyName) return null;

        onProgress?.(`📋 Researching ${companyName}...`);
        console.log(`📋 Processing: ${companyName} (${domain})`);

        // ── Parallel: research + MX validation ───────────────────────────────
        const [companyData, mxValid] = await Promise.all([
            researchCompany(companyName, domain, tavilyKey, apiKey, tavilyQuota, openAiTracker, onProgress),
            validateMX(domain),
        ]);

        if (!mxValid) console.warn(`⚠️ [MX FAIL] ${domain} — high bounce risk`);

        const dataScore = scoreDataCompleteness(companyData);
        if (dataScore < 10) {
            console.warn(`🗑️ Skipping ${companyName} — data score ${dataScore}/100`);
            return null;
        }

        // ── Resolve best decision-maker contact ───────────────────────────────
        const employees   = companyData?.employees || [];
        const bestContact = resolveBestContact(employees, intent.preferredContact);

        // ── Email resolution — 5-tier pipeline (no contact@ fallback) ─────────
        const emailResolution = await resolveEmail(
            companyData, bestContact, domain, mxValid,
            tavilyKey, tavilyQuota, companyName, onProgress
        );

        // ── Lead scoring — exact architecture table ───────────────────────────
        const scoringResult = scoreLeadQuality({
            emailType:   emailResolution?.emailType   || 'none',
            mxValid,
            sourcePage:  emailResolution?.sourcePage  || companyData?.sourcePage || 'unknown',
            bestContact,
            companyData,
            dataScore,
        });

        // ── Acceptance gate — reject below 50 ─────────────────────────────────
        if (!shouldAcceptLead(scoringResult, emailResolution)) return null;

        // ── Generate email sequence ───────────────────────────────────────────
        onProgress?.(`✍️ Writing emails for ${companyName}...`);
        const emailSequence = await generateEmailSequence(
            { name: companyName, mission: companyData?.mission, recentNews: companyData?.recentNews, model: companyData?.model },
            bestContact,
            intent,
            userProfile,
            apiKey,
            openAiTracker,
            lang
        );

        console.log(`✅ ${companyName} → ${emailResolution.email} [${emailResolution.emailType}] Score:${scoringResult.leadScore}/100 MX:${mxValid}`);

        // ── Build final enriched lead object ──────────────────────────────────
        return {
            // ── PUBLIC CLEAN OUTPUT (frontend/UI) ─────────────────────────────
            company: companyName,
            website: `https://${domain}`,
            decisionMaker: {
                name:       bestContact?.name || null,
                role:       bestContact?.role || 'Decision Maker',
                email:      emailResolution.email,
                confidence: scoringResult.leadScore,
                source:     emailResolution.sourcePage,
            },

            // ── INTERNAL ENRICHED DATA (backend/debug/scoring) ────────────────
            domain,
            emailType:          emailResolution.emailType,
            emailLabel:         emailResolution.emailLabel,
            verification:       emailResolution.verification,
            allEmailOptions:    emailResolution.allOptions,
            leadScore:          scoringResult.leadScore,
            confidenceLabel:    scoringResult.confidenceLabel,
            confidenceSignals:  scoringResult.confidenceSignals,
            mxValid,
            dataScore,
            companySize:        companyData?.size      || 'unknown',
            companyModel:       companyData?.model     || 'unknown',
            industry:           intent.industry        || 'unknown',
            hq:                 companyData?.hq        || null,
            recentNews:         companyData?.recentNews || null,
            linkedIn:           bestContact?.linkedIn  || null,
            emailLanguage:      lang.code,
            hallucinationFlags: companyData?._hallucinationFlags || [],

            // ── EMAIL SEQUENCES ───────────────────────────────────────────────
            messages: [
                { type: 'initial',  subject: emailSequence.initial.subject,  body: emailSequence.initial.body  },
                { type: 'followup', subject: emailSequence.followup.subject, body: emailSequence.followup.body },
                { type: 'breakup',  subject: emailSequence.breakup.subject,  body: emailSequence.breakup.body  },
            ],
        };

    } catch (err) {
        console.warn(`[processOneCompany Error] ${err.message}`);
        return null;
    }
}

// ─── MAIN EXPORT — generateFreeResponse ───────────────────────────────────────
async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🟢 [LEAD ENGINE] Pipeline started...');
        onProgress?.('🧠 Understanding your request...');

        const apiKey    = process.env.OPENAI_API_KEY;
        const tavilyKey = process.env.TAVILY_API_KEY;

        // ── Language detection ────────────────────────────────────────────────
        const lang = detectLanguage(message);
        console.log(`🌐 [LANGUAGE] Detected: ${lang.name} (${lang.code})`);

        // ── Intent extraction ─────────────────────────────────────────────────
        const intent = await extractIntent(message, apiKey, openAiTracker);
        console.log(`🎯 Intent: ${JSON.stringify(intent)}`);

        // ── Company search ────────────────────────────────────────────────────
        onProgress?.(`🔍 Searching for ${intent.industry} companies${intent.location ? ' in ' + intent.location : ''}...`);
        const cleanResults = await searchCompanies(intent, tavilyKey, tavilyQuota);

        if (cleanResults.length === 0) {
            return {
                reply: 'No companies found. Try narrowing the industry or adding a location.',
                updatedHistory: [
                    ...history,
                    { role: 'user',      content: message      },
                    { role: 'assistant', content: 'No leads found.' },
                ],
            };
        }

        // ── Process companies concurrently ────────────────────────────────────
        onProgress?.(`⚙️ Processing ${cleanResults.length} companies...`);
        const tasks = cleanResults
            .slice(0, MAX_LEADS_RETURNED + 3)
            .map(result => () => processOneCompany(result, intent, userProfile, lang, onProgress));

        const settled = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);

        const leadsToReturn = settled
            .filter(r => r.status === 'fulfilled' && r.value !== null)
            .map(r => r.value)
            .sort((a, b) => b.leadScore - a.leadScore)
            .slice(0, MAX_LEADS_RETURNED);

        // ── Summary logs ──────────────────────────────────────────────────────
        console.log(`🏁 Done. ${leadsToReturn.length} leads returned.`);
        console.log(`📊 ${openAiTracker.summary()}`);
        console.log(`🔍 Tavily: ${tavilyQuota.used}/${tavilyQuota.limit}`);

        if (leadsToReturn.length === 0) {
            return {
                reply: 'Found companies but couldn\'t verify enough data. Try a different industry or location.',
                updatedHistory: [
                    ...history,
                    { role: 'user',      content: message           },
                    { role: 'assistant', content: 'No leads extracted.' },
                ],
            };
        }

        return {
            reply: JSON.stringify(leadsToReturn),
            updatedHistory: [
                ...history,
                { role: 'user',      content: message },
                { role: 'assistant', content: `[Generated ${leadsToReturn.length} leads]` },
            ],
        };

    } catch (error) {
        console.error('❌ [LEAD ENGINE] Fatal error:', error.message);
        return {
            reply: 'An error occurred. Please try again.',
            updatedHistory: history,
        };
    }
}

module.exports = { generateFreeResponse };
