'use strict';

// ────────────────────────────────────────────────────────────────
// 1. Imports – only what we need
// ────────────────────────────────────────────────────────────────

const axios = require('axios');
const crypto = require('crypto');

// Database models and cache services
const Company = require('./Company');
const SearchCache = require('./SearchCache');
const { generateQueryHash, getCachedSearchResults, saveSearchCache, saveCompanyFromLead } = require('./companyMemoryService');

// The Router Agent – handles intent classification and entity extraction
const agent1 = require('./agent1');

// The Prospecting Agent – discovers prospects based on intent
const agent2 = require('./agent2');

// The Enrichment Agent – enriches and verifies prospects
const agent3 = require('./agent3');

// The Qualification Agent – qualifies and prioritizes leads
const agent4 = require('./agent4');

// The Final Output Agent – formats final leads with outreach messages
const agent5 = require('./agent5');

// ────────────────────────────────────────────────────────────────
// 2. Config & Constants
// ────────────────────────────────────────────────────────────────

const MAX_LEADS_RETURNED = 5;
const MAX_MESSAGE_LENGTH = 800;
const CURRENT_YEAR       = new Date().getFullYear();

// Output quantity control
const QUANTITY_RULE_HARD_MIN    = 2;
const QUANTITY_RULE_DEFAULT_MAX = MAX_LEADS_RETURNED;

// Intent labels (used internally for routing)
const INTENT = {
    LEAD_GEN:    'lead_gen',
    CHAT:        'chat',
    EMAIL_DRAFT: 'email_draft',
    BUSINESS_QA: 'business_qa',
};

// ────────────────────────────────────────────────────────────────
// 3. Copy Controls (for email draft / QA)
// ────────────────────────────────────────────────────────────────

const BANNED_ADJECTIVES = [
    'transformative', 'seamless', 'mission-critical', 'synergy', 'game-changer',
    'revolutionary', 'cutting-edge', 'innovative', 'disruptive', 'next-level',
    'holistic', 'robust', 'scalable', 'leverage', 'streamline', 'optimize',
    'empower', 'unlock', 'elevate', 'enhance', 'boost', 'accelerate', 'amplify',
    'delve', 'awe-inspiring', 'exciting', 'landscape', 'unleash', 'dynamic',
    'groundbreaking', 'paradigm', 'ecosystem', 'value-add', 'best-in-class',
];

const BANNED_PHRASES = [
    'I hope this finds you well', 'I wanted to reach out', 'touch base',
    'circle back', 'quick question', 'just following up', 'as per my last email',
    'I am reaching out because', 'My name is', 'I hope you are doing well',
    'let me know your thoughts', 'feel free to', 'do not hesitate',
    'please find attached', 'as mentioned', 'at your earliest convenience',
    'in today\'s world', 'in the current landscape', 'going forward',
];

const BANNED_STATS_INSTRUCTION = `
BANNED FABRICATED STATS — NEVER use:
"30% increase", "3x growth", "50% faster", "double your revenue", "10x results",
"proven results", "guaranteed ROI", "increase by X%", "save X hours".
If you have no real stat, describe the MECHANISM instead.
BAD:  "We increased leads by 30% for agencies like yours."
GOOD: "We cut the time agencies spend on prospecting by replacing manual research with an automated pipeline."
`;

function buildBannedWordsInstruction() {
    return [
        `BANNED ADJECTIVES — NEVER use: ${BANNED_ADJECTIVES.join(', ')}. Replace with specific facts.`,
        `BANNED PHRASES — NEVER use: ${BANNED_PHRASES.join(' | ')}.`,
        BANNED_STATS_INSTRUCTION,
    ].join('\n');
}

// ────────────────────────────────────────────────────────────────
// 4. Utilities
// ────────────────────────────────────────────────────────────────

async function withRetry(fn, label, retries = 2, delayMs = 800) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isLast = attempt === retries;
            if (err.response?.status && err.response.status < 500 && err.response.status !== 429) {
                console.warn(`⛔ [${label}] Non-retryable (${err.response.status}): ${err.message}`);
                return null;
            }
            console.warn(`⚠️ [${label}] attempt ${attempt + 1} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying'}`);
            if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
    }
    return null;
}

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

// ────────────────────────────────────────────────────────────────
// 5. Language Detection (for chat / email draft)
// ────────────────────────────────────────────────────────────────

function _detectLanguage(message) {
    if (!message || typeof message !== 'string') return { code: 'en', name: 'English', rtl: false };

    const unicodeText = message.replace(/[\x00-\x7F]+/g, ' ').trim();

    if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(unicodeText)) {
        if (/[\u0698\u06AF\u06CC\u06BE]/.test(unicodeText)) return { code: 'fa', name: 'Farsi',  rtl: true };
        if (/[\u06C1\u06BE\u06D2]/.test(unicodeText))        return { code: 'ur', name: 'Urdu',   rtl: true };
        return { code: 'ar', name: 'Arabic', rtl: true };
    }
    if (/[\u0590-\u05FF\uFB1D-\uFB4F]/.test(unicodeText)) return { code: 'he', name: 'Hebrew',   rtl: true  };
    if (/[\u0400-\u04FF]/.test(unicodeText))               return { code: 'ru', name: 'Russian',  rtl: false };
    if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(unicodeText)) {
        if (/[\u3040-\u309F\u30A0-\u30FF]/.test(unicodeText)) return { code: 'ja', name: 'Japanese', rtl: false };
        return { code: 'zh', name: 'Chinese', rtl: false };
    }
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(unicodeText)) return { code: 'ja', name: 'Japanese', rtl: false };
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(unicodeText)) return { code: 'ko', name: 'Korean',   rtl: false };
    if (/[\u0900-\u097F]/.test(unicodeText))               return { code: 'hi', name: 'Hindi',    rtl: false };
    if (/[\u0E00-\u0E7F]/.test(unicodeText))               return { code: 'th', name: 'Thai',     rtl: false };
    if (/[\u0370-\u03FF]/.test(unicodeText))               return { code: 'el', name: 'Greek',    rtl: false };

    const lower = message.toLowerCase();
    const langPatterns = [
        { code: 'es', name: 'Spanish',    rtl: false, pattern: /\b(gracias|hola|por favor|cómo|también|sí|buenas|estimado|empresa|necesito|quiero|podría|tenemos|nuestro|sistema|equipo|proceso)\b/ },
        { code: 'fr', name: 'French',     rtl: false, pattern: /\b(merci|bonjour|comment|nous|vous|les|des|une|pour|avec|très|aussi|notre|votre|pouvez|entreprise|besoin|système|équipe)\b/ },
        { code: 'de', name: 'German',     rtl: false, pattern: /\b(danke|hallo|bitte|wie|haben|sind|kann|wir|das|die|der|und|nicht|ich|sie|mit|für|eine|unser|team|system|prozess|brauchen)\b/ },
        { code: 'pt', name: 'Portuguese', rtl: false, pattern: /\b(obrigado|olá|temos|nosso|empresa|preciso|quero|poderia|sistema|equipe|processo|também|muito|para|com|por)\b/ },
        { code: 'it', name: 'Italian',    rtl: false, pattern: /\b(grazie|ciao|come|abbiamo|nostro|azienda|bisogno|voglio|potrebbe|sistema|squadra|processo|anche|molto|per|con)\b/ },
        { code: 'nl', name: 'Dutch',      rtl: false, pattern: /\b(bedankt|hallo|hoe|wij|onze|bedrijf|nodig|wil|zou|systeem|team|proces|ook|heel|voor|met)\b/ },
        { code: 'pl', name: 'Polish',     rtl: false, pattern: /\b(dziękuję|cześć|jak|mamy|nasz|firma|potrzebuję|chcę|mógłby|system|zespół|proces|też|bardzo|dla|z)\b/ },
        { code: 'tr', name: 'Turkish',    rtl: false, pattern: /\b(teşekkür|merhaba|nasıl|bizim|şirket|ihtiyaç|istiyorum|olur|sistem|ekip|süreç|ayrıca|çok|için|ile)\b/ },
        { code: 'sv', name: 'Swedish',    rtl: false, pattern: /\b(tack|hej|hur|vi|vårt|företag|behöver|vill|skulle|system|team|process|också|mycket|för|med)\b/ },
        { code: 'no', name: 'Norwegian',  rtl: false, pattern: /\b(takk|hei|hvordan|vi|vår|selskap|trenger|vil|ville|system|team|prosess|også|veldig|for|med)\b/ },
        { code: 'da', name: 'Danish',     rtl: false, pattern: /\b(tak|hej|hvordan|vi|vores|virksomhed|behøver|vil|ville|system|team|proces|også|meget|for|med)\b/ },
        { code: 'fi', name: 'Finnish',    rtl: false, pattern: /\b(kiitos|hei|miten|meillä|meidän|yritys|tarvitsen|haluan|voisi|järjestelmä|tiimi|prosessi|myös|paljon|varten)\b/ },
        { code: 'id', name: 'Indonesian', rtl: false, pattern: /\b(terima kasih|halo|bagaimana|kami|perusahaan|butuh|ingin|bisa|sistem|tim|proses|juga|sangat|untuk|dengan)\b/ },
        { code: 'ms', name: 'Malay',      rtl: false, pattern: /\b(terima kasih|hai|bagaimana|kami|syarikat|perlu|mahu|boleh|sistem|pasukan|proses|juga|sangat|untuk|dengan)\b/ },
        { code: 'vi', name: 'Vietnamese', rtl: false, pattern: /\b(cảm ơn|xin chào|chúng tôi|công ty|cần|muốn|có thể|hệ thống|đội|quy trình|cũng|rất|cho|với)\b/ },
    ];
    for (const lang of langPatterns) {
        if (lang.pattern.test(lower)) return { code: lang.code, name: lang.name, rtl: lang.rtl };
    }

    return { code: 'en', name: 'English', rtl: false };
}

function _buildMultilingualEmailBlock(detectedLanguage) {
    const rtlNote = detectedLanguage.rtl
        ? `NOTE: ${detectedLanguage.name} is a right-to-left language. Format text accordingly.`
        : '';
    return `
MULTILINGUAL ENGINE — CRITICAL:
The user's request was written in: ${detectedLanguage.name} (${detectedLanguage.code}).
${rtlNote}

ALL THREE EMAILS MUST be written entirely in ${detectedLanguage.name}.
RULES — NEVER VIOLATE:
1. Write every word of every email in ${detectedLanguage.name}. No exceptions.
2. Translate subject line, salutation, body, CTA, and sign-off into ${detectedLanguage.name}.
3. Do NOT mix languages. The emails must be 100% in ${detectedLanguage.name}.
4. Maintain all tone, rhythm, banned-word, and sales-logic rules in ${detectedLanguage.name}.
5. If ${detectedLanguage.name} is English, this rule has no additional effect.
`;
}

// ────────────────────────────────────────────────────────────────
// 6. Intent Classification (internal, used for initial routing)
// ────────────────────────────────────────────────────────────────

async function _classifyIntent(message, history, apiKey) {
    const recentHistory = (history || []).slice(-6).map(h => `${h.role}: ${h.content}`).join('\n');

    const classifyPrompt = `You are an intent classifier for an AI assistant.
Classify the user message into EXACTLY ONE of these intents:

1. "lead_gen"    — user wants to find leads, prospect companies, get contacts, find businesses to outreach
2. "email_draft" — user wants to write, draft, compose, or improve an email (NOT find leads)
3. "business_qa" — user wants business advice, strategy, analysis, calculations, or professional Q&A
4. "chat"        — anything else: greetings, small talk, general questions, follow-up clarifications

RECENT CONVERSATION:
${recentHistory || 'None'}

USER MESSAGE: "${message}"

Rules:
- If the message mentions finding companies, leads, prospects, outreach targets → "lead_gen"
- If the message says write/draft/compose/fix/improve an email → "email_draft"
- If the message asks for business advice, strategy, metrics, pricing, sales tips → "business_qa"
- Greetings like "hi", "hello", "thanks", "what can you do" → "chat"
- Short follow-up messages after a lead_gen result (like "give me more" or "try another industry") → "lead_gen"

Return ONLY the intent string. No explanation. No JSON. Just one of: lead_gen | email_draft | business_qa | chat`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: classifyPrompt }],
            max_tokens:  10,
            temperature: 0.0,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:classify');

        if (!res) return INTENT.CHAT;
        const raw = res.data.choices[0].message.content.trim().toLowerCase();
        if (raw.includes('lead_gen'))    return INTENT.LEAD_GEN;
        if (raw.includes('email_draft')) return INTENT.EMAIL_DRAFT;
        if (raw.includes('business_qa')) return INTENT.BUSINESS_QA;
        return INTENT.CHAT;

    } catch (err) {
        console.warn('[Intent Classify Failed]:', err.message);
        return INTENT.CHAT;
    }
}

// ────────────────────────────────────────────────────────────────
// 7. Handlers: Chat, Email Draft, Business QA
// ────────────────────────────────────────────────────────────────

async function _handleChat(message, history, userProfile, apiKey) {
    const senderName = userProfile?.senderName || 'there';
    const usp        = userProfile?.usp || null;

    const systemPrompt = `You are an intelligent AI assistant and business operator.
You help with conversations, answer questions, give advice, and assist with business tasks.
You are direct, sharp, and genuinely helpful — not corporate or robotic.
${usp ? `The user's business value proposition is: "${usp}". Reference this naturally when relevant.` : ''}
You also have the ability to find leads, draft emails, and give business strategy advice.
If the user seems to want leads or emails, gently let them know you can do that.
Keep responses concise but complete. Never pad with filler.`;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...(history || []).slice(-20).map(h => ({ role: h.role, content: h.content })),
        { role: 'user',   content: message },
    ];

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages,
            max_tokens:  600,
            temperature: 0.7,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:chat');

        if (!res) return 'I had trouble responding — please try again.';
        return res.data.choices[0].message.content.trim();

    } catch (err) {
        console.warn('[Chat Handler Error]:', err.message);
        return 'Something went wrong. Please try again.';
    }
}

async function _handleEmailDraft(message, history, userProfile, apiKey) {
    const senderName    = userProfile?.senderName || 'Alex';
    const usp           = userProfile?.usp || null;
    const recentContext = (history || []).slice(-6).map(h => `${h.role}: ${h.content}`).join('\n');

    const draftPrompt = `${buildBannedWordsInstruction()}

You are a world-class B2B email copywriter.
Write the email the user is asking for based on their instructions below.

SENDER NAME: ${senderName}
${usp ? `SENDER VALUE PROP: ${usp}` : ''}

RECENT CONTEXT:
${recentContext || 'None'}

USER INSTRUCTION: "${message}"

Rules:
- Write a complete, ready-to-send email
- Subject line must be specific and compelling (4-7 words)
- Never use banned adjectives or phrases listed above
- Never invent stats or percentages
- Opening line must hook immediately — no "I hope this finds you well"
- CTA must be one soft, specific ask
- Sign off with: Best, ${senderName}
- Keep total length under 150 words unless the user asks for longer

Return ONLY valid JSON:
{
  "subject": "string",
  "body": "string"
}`;

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o',
            messages:    [{ role: 'user', content: draftPrompt }],
            max_tokens:  600,
            temperature: 0.7,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:emaildraft');

        if (!res) throw new Error('Draft returned null');
        const parsed = JSON.parse(res.data.choices[0].message.content.trim().replace(/```json|```/g, ''));
        return `Here's your email:\n\n**Subject:** ${parsed.subject}\n\n${parsed.body}`;

    } catch (err) {
        console.warn('[Email Draft Error]:', err.message);
        return 'I had trouble drafting that email. Can you give me a bit more detail about who it\'s for and what you want to say?';
    }
}

async function _handleBusinessQA(message, history, userProfile, apiKey) {
    const usp = userProfile?.usp || null;

    const systemPrompt = `You are a sharp senior business strategist and operator.
You give direct, actionable business advice with zero corporate fluff.
You think like a founder, operator, and growth expert simultaneously.
${usp ? `The user runs a business with this value proposition: "${usp}". Use this as context when relevant.` : ''}
When answering:
- Be specific and concrete — no vague generalities
- Use frameworks only when they genuinely help
- Give a direct recommendation, not just options
- If you need more information to give a good answer, ask one focused question
- Never pad responses with filler sentences`;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...(history || []).slice(-12).map(h => ({ role: h.role, content: h.content })),
        { role: 'user',   content: message },
    ];

    try {
        const res = await withRetry(() => axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o',
            messages,
            max_tokens:  800,
            temperature: 0.5,
        }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }), 'OpenAI:businessqa');

        if (!res) return 'I had trouble with that — please try again.';
        return res.data.choices[0].message.content.trim();

    } catch (err) {
        console.warn('[Business QA Error]:', err.message);
        return 'Something went wrong. Please try again.';
    }
}

// ────────────────────────────────────────────────────────────────
// 8. LEAD GEN PIPELINE ORCHESTRATOR (FIXED - with complete lead caching)
// ────────────────────────────────────────────────────────────────

async function _runLeadGenPipeline(safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, userId) {

    console.log(`🔢 [ORCHESTRATOR] Starting lead gen pipeline...`);

    // ─── Step 1: Route the request via agent1 ───
    console.log(`🔁 [ORCHESTRATOR] Routing request via agent1...`);
    onProgress?.('🧠 Understanding your request...');

    const routerResult = await agent1.routeRequest({
        message: safeMessage,
        apiKey: apiKey,
        history: history,
        userId: userId,
        onProgress: onProgress,
    });

    console.log(`📋 [ROUTER] Result: intent=${routerResult.intent}, confidence=${routerResult.confidence}, needsClarification=${routerResult.needs_clarification}`);

    // ─── Step 2: Handle clarification needed ───
    if (routerResult.needs_clarification) {
        return {
            reply: routerResult.clarification_question || 'Could you be more specific about what you\'re looking for?',
            updatedHistory: [
                ...history,
                { role: 'user', content: safeMessage },
                { role: 'assistant', content: routerResult.clarification_question || 'Could you be more specific?' }
            ],
            _meta: { needsClarification: true, routerResult }
        };
    }

    // ─── Step 3: Handle lead_generation intent ───
    if (routerResult.intent === 'lead_generation') {
        const entities = routerResult.entities || {};
        
        const leadIntent = {
            industry: entities.industry || 'general',
            location: entities.location || null,
            target: entities.company || entities.industry || 'businesses',
            preferredContact: entities.role || 'Any',
            lead_count: entities.lead_count || QUANTITY_RULE_DEFAULT_MAX,
            entities: entities,
        };

        console.log(`🎯 [ORCHESTRATOR] Lead generation confirmed:`, leadIntent);

        // ─── Step 4: Check cache (FIXED - handles complete leads) ───
        const queryParams = {
            industry: leadIntent.industry,
            location: leadIntent.location,
            target: leadIntent.target,
            preferredContact: leadIntent.preferredContact,
        };
        const queryHash = generateQueryHash(queryParams);
        const cachedData = await getCachedSearchResults(queryHash);

        if (cachedData && cachedData.length > 0) {
            console.log(`🎉 [CACHE HIT] Returning ${cachedData.length} items from memory`);
            
            // Detect if cached data is raw companies or complete leads
            const isRawCompany = cachedData[0] && cachedData[0]._id && !cachedData[0].messages;
            
            let leads;
            if (isRawCompany) {
                // Auto-convert raw companies to complete leads
                console.log(`🔄 [CACHE] Auto-converting ${cachedData.length} raw companies to leads`);
                const senderName = userProfile?.senderName || 'Alex';
                
                leads = cachedData.map(company => ({
                    name: company.name || company.companyName || company.domain || 'Unknown',
                    company: company.name || company.companyName || company.domain || 'Unknown',
                    domain: company.domain || null,
                    email: company.emails?.[0] || '',
                    emailConfidence: 'cached',
                    emailLabel: 'From cached company',
                    verificationGrade: company.research?.verificationGrade || 'B',
                    role: 'Decision Maker',
                    linkedIn: null,
                    companySize: company.size || 'unknown',
                    companyModel: company.model || 'unknown',
                    industry: leadIntent.industry || 'general',
                    hq: company.hq || leadIntent.location || null,
                    recentNews: company.research?.recentNews || null,
                    leadScore: company.leadScore || 50,
                    messages: [
                        {
                            type: 'initial',
                            subject: `Revisiting ${company.name || company.domain || 'your company'}`,
                            body: `Hi,\n\nWe previously connected about ${leadIntent.industry || 'your industry'} opportunities. Still relevant?\n\nBest,\n${senderName}`
                        },
                        {
                            type: 'followup',
                            subject: `Re: ${company.name || company.domain || 'your company'}`,
                            body: `Hi,\n\nJust circling back on this. Still interested in exploring how we can help?\n\nBest,\n${senderName}`
                        },
                        {
                            type: 'breakup',
                            subject: `Closing the loop`,
                            body: `Hi,\n\nHaven't heard back so I'll assume timing isn't right. Reach out whenever it makes sense.\n\nBest,\n${senderName}`
                        }
                    ]
                }));
                
                // Auto-update cache with complete leads for future requests
                await saveSearchCache(queryHash, queryParams, leads, 90);
                console.log(`💾 [CACHE] Updated cache with complete leads for future requests`);
                
            } else {
                // Already complete leads
                leads = cachedData;
                console.log(`✅ [CACHE] Using ${leads.length} complete leads from cache`);
            }
            
            const finalLeads = _applyOutputQuantityRules(leads, leadIntent.lead_count || QUANTITY_RULE_DEFAULT_MAX);
            
            return {
                reply: JSON.stringify(finalLeads),
                updatedHistory: [
                    ...history,
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: `[Retrieved ${finalLeads.length} leads from memory]` },
                ],
                _meta: { fromCache: true, cacheHit: true, leadIntent }
            };
        }

        // ─── Step 5: Cache miss – Call Agent 2 ───
        console.log(`🔁 [CACHE MISS] Calling agent2 for prospect discovery...`);
        onProgress?.('🔎 Searching for matching prospects...');

        const tavilyKey = process.env.TAVILY_API_KEY;
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
                    ...history,
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: agent2Result.clarification_question }
                ],
                _meta: { needsClarification: true, agent2Result }
            };
        }

        if (!agent2Result.prospects || agent2Result.prospects.length === 0) {
            return {
                reply: `I couldn't find any matching prospects for ${leadIntent.industry || 'your industry'}${leadIntent.location ? ' in ' + leadIntent.location : ''}. Try a different industry or location.`,
                updatedHistory: [
                    ...history,
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No matching prospects found.' }
                ],
                _meta: { found: 0, agent2Stats: agent2Result.stats }
            };
        }

        // ─── Step 6: Call Agent 3 ───
        console.log(`🔁 [ORCHESTRATOR] Calling agent3 for enrichment...`);
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
                    ...history,
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: agent3Result.clarification_question }
                ],
                _meta: { needsClarification: true, agent3Result }
            };
        }

        if (!agent3Result.enriched_prospects || agent3Result.enriched_prospects.length === 0) {
            return {
                reply: `I found prospects but couldn't verify any of them. Try a different industry or location.`,
                updatedHistory: [
                    ...history,
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No verified prospects found.' }
                ],
                _meta: { found: 0, agent3Stats: agent3Result.stats }
            };
        }

        // ─── Step 7: Call Agent 4 ───
        console.log(`🔁 [ORCHESTRATOR] Calling agent4 for qualification...`);
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
                    ...history,
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: agent4Result.clarification_question }
                ],
                _meta: { needsClarification: true, agent4Result }
            };
        }

        const qualifiedProspects = agent4Result.qualified_prospects || [];
        const qualified = qualifiedProspects.filter(p => p.qualification_status === 'qualified');

        if (qualified.length === 0) {
            return {
                reply: `I reviewed ${agent4Result.stats.reviewed} prospects but none met the qualification criteria. Try broadening your search.`,
                updatedHistory: [
                    ...history,
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No qualified leads found.' }
                ],
                _meta: { found: 0, agent4Stats: agent4Result.stats }
            };
        }

        // ─── Step 8: Call Agent 5 ───
        console.log(`🔁 [ORCHESTRATOR] Calling agent5 for final formatting...`);
        onProgress?.('📦 Packaging final leads...');

        const agent5Result = await agent5.formatFinalLeads({
            qualified_prospects: qualified,
            intent: leadIntent,
            userProfile: userProfile,
            apiKey: apiKey,
            tavilyKey: tavilyKey,
            userId: userId,
            onProgress: onProgress,
        });

        if (agent5Result.needs_clarification) {
            return {
                reply: agent5Result.clarification_question || 'I formatted the leads but some fields are missing. Please check the output.',
                updatedHistory: [
                    ...history,
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: agent5Result.clarification_question }
                ],
                _meta: { needsClarification: true, agent5Result }
            };
        }

        const finalLeads = agent5Result.leads || [];

        if (finalLeads.length === 0) {
            return {
                reply: `I processed ${qualified.length} qualified prospects but couldn't generate final leads. Please try again.`,
                updatedHistory: [
                    ...history,
                    { role: 'user', content: safeMessage },
                    { role: 'assistant', content: 'No final leads generated.' }
                ],
                _meta: { found: 0, agent5Stats: agent5Result.stats }
            };
        }

        // ─── Step 9: Save leads to cache (FIXED - stores complete leads) ───
        if (finalLeads.length > 0) {
            // Save complete leads to cache (not just company IDs)
            await saveSearchCache(queryHash, queryParams, finalLeads, 90);
            console.log(`💾 [ORCHESTRATOR] Saved ${finalLeads.length} complete leads to cache`);
            
            // Also save to Company collection for fallback
            for (const lead of finalLeads) {
                if (!lead.domain) continue;
                const existing = await Company.findOne({ domain: lead.domain });
                if (!existing) {
                    const researchData = {
                        recentNews: lead.recentNews || null,
                        website: lead.website || null,
                        linkedin_url: lead.linkedIn || null,
                        verificationGrade: lead.verificationGrade || null,
                        emailValidation: lead.emailValidation || null,
                        messages: lead.messages || [],
                        emailConfidence: lead.emailConfidence || null,
                        emailLabel: lead.emailLabel || null,
                        allEmailOptions: lead.allEmailOptions || [],
                        role: lead.role || null,
                        companySize: lead.companySize || null,
                        companyModel: lead.companyModel || null,
                        industry: lead.industry || null,
                        hq: lead.hq || null,
                        leadScore: lead.leadScore || 0,
                        pageScore: lead.pageScore || 0,
                        mxValid: lead.mxValid || false,
                        dataScore: lead.dataScore || 0,
                        hallucinationFlags: lead.hallucinationFlags || [],
                        emailLanguage: lead.emailLanguage || 'en',
                        _memoryStats: lead._memoryStats || {}
                    };
                    const researchSummaryString = JSON.stringify(researchData);
                    await saveCompanyFromLead({
                        company: lead.company,
                        domain: lead.domain,
                        industry: lead.industry || leadIntent.industry,
                        country: lead.hq || leadIntent.location,
                        companySize: lead.companySize || 'unknown',
                        emails: lead.email ? [lead.email] : [],
                        researchSummary: researchSummaryString,
                        leadScore: lead.leadScore || 50,
                    });
                }
            }
        }

        // ─── Step 10: Return final leads to user ───
        return {
            reply: JSON.stringify(finalLeads),
            updatedHistory: [
                ...history,
                { role: 'user', content: safeMessage },
                { role: 'assistant', content: `[Generated ${finalLeads.length} final leads]` },
            ],
            _meta: {
                fromCache: false,
                cacheHit: false,
                leadIntent,
                totalGenerated: finalLeads.length,
                agent2Stats: agent2Result.stats,
                agent2Confidence: agent2Result.confidence,
                agent3Stats: agent3Result.stats,
                agent3Confidence: agent3Result.confidence,
                agent4Stats: agent4Result.stats,
                agent4Confidence: agent4Result.confidence,
                agent5Stats: agent5Result.stats,
                agent5Confidence: agent5Result.confidence,
            }
        };
    }

    // ─── Handle general_chat ───
    if (routerResult.intent === 'general_chat') {
        const reply = await _handleChat(safeMessage, history, userProfile, apiKey);
        return {
            reply,
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: reply }],
        };
    }

    // ─── Handle other intents ───
    return {
        reply: `I understood you want "${routerResult.intent}". This feature is being built. For now, try asking for leads or business advice.`,
        updatedHistory: [
            ...history,
            { role: 'user', content: safeMessage },
            { role: 'assistant', content: `I understood you want ${routerResult.intent}. This feature is coming soon.` }
        ],
        _meta: {
            intent: routerResult.intent,
            confidence: routerResult.confidence,
            needsClarification: false,
        }
    };
}

// ────────────────────────────────────────────────────────────────
// 9. Helper: Apply quantity rules
// ────────────────────────────────────────────────────────────────

function _applyOutputQuantityRules(leads, requestedMax) {
    if (!Array.isArray(leads)) return [];
    const cap = Math.min(requestedMax || QUANTITY_RULE_DEFAULT_MAX, QUANTITY_RULE_DEFAULT_MAX);
    const sliceTo = Math.max(QUANTITY_RULE_HARD_MIN, Math.min(cap, leads.length));
    return leads.slice(0, sliceTo);
}

// ────────────────────────────────────────────────────────────────
// 10. MAIN ENTRY POINT
// ────────────────────────────────────────────────────────────────

async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🟢 [AI ENGINE] Pipeline started...');
        onProgress?.('🧠 Understanding your request...');

        const apiKey = process.env.OPENAI_API_KEY;
        const userId = userProfile?.userId || userProfile?.id || 'anonymous';

        const rawMessage = typeof message === 'string' ? message.slice(0, MAX_MESSAGE_LENGTH) : '';
        const safeMessage = sanitizeUserMessage(rawMessage);

        if (!safeMessage.trim()) {
            return {
                reply: 'How can I help you today? I can find leads, draft emails, answer business questions, or just chat.',
                updatedHistory: history,
            };
        }

        const detectedLanguage = _detectLanguage(safeMessage);
        console.log(`🌐 [LANGUAGE] Detected: ${detectedLanguage.name} (${detectedLanguage.code})`);

        const intent = await _classifyIntent(safeMessage, history, apiKey);
        console.log(`🎯 [INTENT] ${intent}`);
        onProgress?.(`🧠 Mode: ${intent.replace('_', ' ')}...`);

        if (intent === INTENT.LEAD_GEN) {
            return await _runLeadGenPipeline(safeMessage, history, userProfile, onProgress, detectedLanguage, apiKey, userId);
        }

        if (intent === INTENT.EMAIL_DRAFT) {
            const reply = await _handleEmailDraft(safeMessage, history, userProfile, apiKey);
            return {
                reply,
                updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: reply }],
            };
        }

        if (intent === INTENT.BUSINESS_QA) {
            const reply = await _handleBusinessQA(safeMessage, history, userProfile, apiKey);
            return {
                reply,
                updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: reply }],
            };
        }

        const reply = await _handleChat(safeMessage, history, userProfile, apiKey);
        return {
            reply,
            updatedHistory: [...history, { role: 'user', content: safeMessage }, { role: 'assistant', content: reply }],
        };

    } catch (error) {
        console.error('❌ [AI ENGINE] Fatal error:', error.message);
        return { reply: 'An error occurred. Please try again.', updatedHistory: history };
    }
}

// ────────────────────────────────────────────────────────────────
// 11. PUBLIC EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    generateFreeResponse,
};
