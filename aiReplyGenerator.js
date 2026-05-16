// aiReplyGenerator.js
// ─────────────────────────────────────────────────────────────────────────────
// STATELESS AI autoreply engine — Production Upgraded v2.0
// NO database. NO email sending. NO auth. Text in → structured result out.
//
// UPGRADES v2.0 (27 total):
//  🔴 Bug Fixes      : #1–4
//  🟡 Logic Upgrades : #5–15
//  🟠 Safety         : #16–19
//  🟢 Observability  : #20–24
//  ⭐ SaaS Extras    : #25–27
// ─────────────────────────────────────────────────────────────────────────────
const axios  = require('axios');
const crypto = require('crypto');

// ─── CONFIGURATION ────────────────────────────────────────────────────────────
const CONFIG = {
    MODEL:                  process.env.AI_MODEL                || 'gpt-4o-mini',
    TEMPERATURE:            0.7,
    MAX_TOKENS:             600,
    API_URL:                'https://api.openai.com/v1/chat/completions',
    CONFIDENCE_THRESHOLD:   0.35,  // #2 FIX: Now actually used in _resolveAction
    MAX_FOLLOWUPS:          parseInt(process.env.AI_MAX_FOLLOWUPS) || 10,  // #3 FIX: Was 500
    HISTORY_LIMIT:          6,
    MAX_INSTRUCTIONS_CHARS: 8000,  // #15: Hard cap to prevent token blowout
    MAX_MESSAGE_CHARS:      2000,  // #16: Cap on incoming message size
    MAX_REASONING_CHARS:    300,   // #18: Cap AI reasoning field length
    MAX_REPLY_CHARS:        2000,  // #19: Post-AI reply length guard
    RETRY_ATTEMPTS:         3,     // #5: Retry on API failure
    RETRY_BASE_DELAY_MS:    500,   // #5: Exponential backoff base
};

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const INTENTS = {
    FAQ:          'FAQ',
    QUALIFY:      'QUALIFY',
    SCHEDULE:     'SCHEDULE',
    INTERESTED:   'INTERESTED',
    OBJECTION:    'OBJECTION',
    ANGRY:        'ANGRY',
    OUT_OF_SCOPE: 'OUT_OF_SCOPE',
    UNKNOWN:      'UNKNOWN',
    FOLLOW_UP:    'FOLLOW_UP',   // #1 FIX: Was referenced but never defined
};

const ACTIONS = {
    REPLY:    'REPLY',
    ESCALATE: 'ESCALATE',
    STOP:     'STOP',
    DRAFT:    'DRAFT',
};

// #23: Risk level definitions
const RISK_LEVELS = {
    LOW:    'low',
    MEDIUM: 'medium',
    HIGH:   'high',
};

// #8: Supported tone options
const TONES = {
    FORMAL:   'formal',
    CASUAL:   'casual',
    FRIENDLY: 'friendly',
};

// #12: Reply length presets (approximate word targets)
const REPLY_LENGTH = {
    SHORT:  'short (1–3 sentences)',
    MEDIUM: 'medium (1–2 short paragraphs)',
    LONG:   'long (3+ paragraphs with detail)',
};

// Hard-stop triggers — caught BEFORE wasting an API call
const LEGAL_TRIGGERS = [
    'lawsuit', 'lawyer', 'legal action', 'sue', 'attorney',
    'contract', 'refund my money', 'chargeback', 'charge back',
    'this is fraud', 'scam',
];

const ANGRY_TRIGGERS = [
    'stop emailing', 'leave me alone', 'unsubscribe',
    'remove me', 'this is ridiculous', 'do not contact',
];

// #19: Spam signal patterns checked post-AI
const SPAM_PATTERNS = [
    /click here now/i,
    /you have been selected/i,
    /guaranteed results/i,
    /act now/i,
    /limited time offer/i,
    /buy now/i,
    /100% free/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * generateAIReply
 *
 * @param {string}   customerMessage           - Latest message from the lead.
 * @param {string}   instructions              - Business rules / knowledge base for this account.
 * @param {string}   leadName                  - Business or lead name for personalisation.
 * @param {Array}    [conversationHistory=[]]  - Prior turns: [{ role: 'user'|'assistant', content }]
 * @param {Object}   [options={}]
 * @param {Object}   [options.leadContext={}]  - Extra facts: { companySize, industry, meetingStatus }
 * @param {string}   [options.mode='full']     - 'draft' | 'safe' | 'full'
 * @param {number}   [options.followUpCount=0] - Follow-ups already sent to this lead.
 * @param {string}   [options.tone='friendly'] - #8  Tone: 'formal'|'casual'|'friendly'
 * @param {string}   [options.channel='email'] - #13 Channel: 'email'|'sms'|'chat'
 * @param {string}   [options.replyLength]     - #12 'short'|'medium'|'long'
 * @param {string}   [options.personaName]     - #25 AI persona name (e.g. 'Sara')
 *
 * @returns {Promise<{
 *   reply:               string|null,
 *   action:              string,
 *   intent:              string,
 *   confidence:          number,
 *   reasoning:           string,
 *   requiresHumanReview: boolean,
 *   shouldAIReply:       boolean,       // #26
 *   riskLevel:           string,        // #23
 *   schedulingHints:     Object|null,   // #10
 *   durationMs:          number,        // #20
 *   tokensUsed:          number|null,   // #21
 *   modelVersion:        string,        // #22
 *   replyFingerprint:    string|null,   // #27
 * }>}
 */
async function generateAIReply(
    customerMessage,
    instructions,
    leadName,
    conversationHistory = [],
    options = {}
) {
    const startTime = Date.now(); // #20: Start timer

    const {
        leadContext  = {},
        mode         = 'full',
        followUpCount = 0,
        tone         = TONES.FRIENDLY,   // #8
        channel      = 'email',          // #13
        replyLength  = 'medium',         // #12
        personaName  = null,             // #25
    } = options;

    // ── LAYER 0: API Key Guard ────────────────────────────────────────────────
    if (!process.env.OPENAI_API_KEY) {
        console.error('❌ [AI GENERATOR] OPENAI_API_KEY is missing.');
        return _errorResult('missing_api_key', startTime);
    }

    // ── LAYER 1: Input Sanitization ───────────────────────────────────────────
    // #16 Sanitize customerMessage, #17 Sanitize instructions
    const safeMessage      = _sanitizeInput(customerMessage, CONFIG.MAX_MESSAGE_CHARS);
    const safeInstructions = _sanitizeInput(instructions,    CONFIG.MAX_INSTRUCTIONS_CHARS);

    // ── LAYER 2: Pre-AI Hard Guardrails ───────────────────────────────────────
    const guardrail = _runGuardrails(safeMessage, followUpCount);
    if (guardrail) {
        console.warn(`🛡️  [AI GENERATOR] Guardrail hit: ${guardrail.reasoning}`);
        return { ...guardrail, durationMs: Date.now() - startTime, modelVersion: CONFIG.MODEL };
    }

    // ── LAYER 3: Token Budget Guard ───────────────────────────────────────────
    // #6: Trim history if it's getting too large (rough char estimate)
    const safeHistory = _trimHistory(conversationHistory, CONFIG.HISTORY_LIMIT);

    // ── LAYER 4: Build Prompt ─────────────────────────────────────────────────
    const systemPrompt = _buildSystemPrompt(
        safeInstructions, leadName, leadContext, mode,
        tone, channel, replyLength, personaName         // #8, #12, #13, #25
    );

    const messages = [
        { role: 'system', content: systemPrompt },
        ...safeHistory,
        { role: 'user',   content: safeMessage },
    ];

    // ── LAYER 5: AI API Call with Retry ──────────────────────────────────────
    // #5: Retry up to 3 times with exponential backoff
    let rawContent  = null;
    let tokensUsed  = null; // #21
    let lastError   = null;

    for (let attempt = 1; attempt <= CONFIG.RETRY_ATTEMPTS; attempt++) {
        try {
            const response = await axios.post(CONFIG.API_URL, {
                model:           CONFIG.MODEL,
                messages,
                temperature:     CONFIG.TEMPERATURE,
                max_tokens:      CONFIG.MAX_TOKENS,
                response_format: { type: 'json_object' },
            }, {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    'Content-Type':  'application/json',
                },
                timeout: 15000,
            });

            rawContent = response.data.choices[0].message.content;
            tokensUsed = response.data.usage?.total_tokens ?? null; // #21
            lastError  = null;
            break; // Success — exit retry loop

        } catch (err) {
            lastError = err;
            const status = err.response?.status;

            // Don't retry auth failures — they won't self-heal
            if (status === 401) break;

            if (attempt < CONFIG.RETRY_ATTEMPTS) {
                const delay = CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                console.warn(`⚠️  [AI GENERATOR] Attempt ${attempt} failed. Retrying in ${delay}ms…`);
                await _sleep(delay);
            }
        }
    }

    if (lastError) {
        _logAPIError(lastError);
        return _errorResult('api_call_failed', startTime);
    }

    // ── LAYER 6: Parse AI Response ────────────────────────────────────────────
    let aiData;
    try {
        aiData = JSON.parse(rawContent);
    } catch (_) {
        console.error('❌ [AI GENERATOR] JSON parse failed. Raw:', rawContent);
        return _errorResult('parse_failed', startTime);
    }

    // ── LAYER 7: Validate AI Response Fields ─────────────────────────────────
    // #7: Reject unknown intents/actions returned by the AI
    const validationError = _validateAIResponse(aiData);
    if (validationError) {
        console.error(`❌ [AI GENERATOR] Validation failed: ${validationError}`);
        return _errorResult(`validation_failed:${validationError}`, startTime);
    }

    let {
        intent     = INTENTS.UNKNOWN,
        confidence = 0,
        action     = ACTIONS.REPLY,
        reasoning  = '',
        reply      = null,
        schedulingHints = null, // #10
    } = aiData;

    // #18: Cap reasoning length
    reasoning = typeof reasoning === 'string'
        ? reasoning.slice(0, CONFIG.MAX_REASONING_CHARS)
        : '';

    console.log(`🧠 [AI GENERATOR] Intent: ${intent} | Confidence: ${confidence} | Action: ${action} | Tokens: ${tokensUsed}`);

    // ── LAYER 8: Post-AI Reply Validator ──────────────────────────────────────
    // #19: Check reply for spam signals and length violations
    if (reply) {
        const replyIssue = _validateReply(reply);
        if (replyIssue) {
            console.warn(`⚠️  [AI GENERATOR] Reply failed post-validation: ${replyIssue}`);
            return _errorResult(`reply_validation_failed:${replyIssue}`, startTime);
        }
    }

    // ── LAYER 9: Post-AI Safety Routing ──────────────────────────────────────
    // We own the final action — AI suggestion is input, not law.
    const finalAction         = _resolveAction(intent, confidence, action, mode, reply); // #2 used here
    const requiresHumanReview = _needsReview(finalAction, confidence, mode);
    const riskLevel           = _computeRiskLevel(intent, confidence, finalAction);      // #23
    const shouldAIReply       = finalAction === ACTIONS.REPLY || finalAction === ACTIONS.DRAFT; // #26

    if (requiresHumanReview) {
        console.warn(`⚠️  [AI GENERATOR] Human review required. Reason: ${reasoning}`);
    }

    // #10: Only extract scheduling hints when relevant
    const resolvedSchedulingHints = intent === INTENTS.SCHEDULE ? (schedulingHints || {}) : null;

    // #27: Fingerprint the reply to detect repeat sends
    const replyFingerprint = reply
        ? crypto.createHash('sha1').update(reply.trim().toLowerCase()).digest('hex').slice(0, 12)
        : null;

    const durationMs = Date.now() - startTime; // #20

    return {
        reply:               shouldAIReply ? reply : null,
        action:              finalAction,
        intent,
        confidence:          Math.round(confidence * 100) / 100,
        reasoning,
        requiresHumanReview,
        shouldAIReply,                  // #26
        riskLevel,                      // #23
        schedulingHints:                resolvedSchedulingHints, // #10
        durationMs,                     // #20
        tokensUsed,                     // #21
        modelVersion:        CONFIG.MODEL, // #22
        replyFingerprint,               // #27
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * #8 #12 #13 #14 #25: Expanded prompt builder with tone, channel, length,
 * persona, language detection, and safe fallback instruction.
 */
function _buildSystemPrompt(instructions, leadName, leadContext, mode, tone, channel, replyLength, personaName) {
    const modeRules = {
        draft: 'Always set action to "DRAFT". Your reply must be reviewed by a human before sending.',
        safe:  'Auto-reply only for FAQ, QUALIFY, SCHEDULE. Set action to "ESCALATE" for INTERESTED, ANGRY, OUT_OF_SCOPE.',
        full:  'Auto-reply for ALL intents except ANGRY or LEGAL threats. Be helpful and conversational.',
    };

    // #13: Channel-specific tone guidance
    const channelRules = {
        email: 'This is an EMAIL reply. Use proper greeting, paragraphs, and sign-off.',
        sms:   'This is an SMS reply. Be SHORT (under 160 chars if possible), no formal greeting.',
        chat:  'This is a CHAT/widget reply. Be conversational, brief, and friendly. No email sign-off.',
    };

    // #8: Tone guidance
    const toneRules = {
        formal:   'Use a professional, formal tone. Avoid contractions and casual language.',
        casual:   'Use a relaxed, casual tone. Contractions and light humour are fine.',
        friendly: 'Use a warm, friendly tone. Be approachable but professional.',
    };

    // #25: Persona injection
    const personaBlock = personaName
        ? `\nYOU ARE: "${personaName}" — the AI assistant for this business. Never break character. Never say you are an AI or ChatGPT. If asked, say you are ${personaName}.\n`
        : '';

    // #9: Language detection instruction
    const languageBlock = `\nLANGUAGE RULE: Detect the language the lead is writing in. Always reply in the SAME language as the lead's message.\n`;

    // #12: Reply length instruction
    const lengthRule = REPLY_LENGTH[replyLength?.toUpperCase()] || REPLY_LENGTH.MEDIUM;

    // #14: Safe fallback when AI is unsure
    const fallbackBlock = `\nFALLBACK RULE: If you are genuinely unsure how to reply, set action to "ESCALATE" and reply to null. Never guess on sensitive topics.\n`;

    const contextBlock = Object.keys(leadContext).length
        ? `\nLEAD CONTEXT (use this to personalise the reply):\n${JSON.stringify(leadContext, null, 2)}\n`
        : '';

    // #11: Special objection handling rule
    const objectionBlock = `\nOBJECTION HANDLING: If intent is OBJECTION, reply with empathy first. Acknowledge their concern before addressing it. Never be defensive.\n`;

    return `
You are a helpful assistant for the business: "${leadName}".
${personaBlock}
OPERATING MODE: ${mode.toUpperCase()}
${modeRules[mode] || modeRules['full']}

CHANNEL: ${channel.toUpperCase()}
${channelRules[channel] || channelRules['email']}

TONE: ${tone.toUpperCase()}
${toneRules[tone] || toneRules['friendly']}

REPLY LENGTH: Aim for ${lengthRule}.
${languageBlock}
${fallbackBlock}
${objectionBlock}
${contextBlock}
STRICT GUARDRAILS — NEVER VIOLATE:
1. NEVER promise pricing not explicitly stated in the business instructions.
2. NEVER invent features or capabilities.
3. NEVER argue emotionally or apply pressure.
4. NEVER discuss contracts or make legal claims.
5. If the message is angry, threatening, or contains legal threats → set action to "ESCALATE".
6. NEVER claim to be human if directly and sincerely asked.
7. NEVER include spam-like phrases (e.g. "Act now!", "Limited time!", "Guaranteed results").

INTENT DETECTION — classify into exactly one:
- "FAQ"          : Simple question about the service, pricing, or process.
- "QUALIFY"      : Lead revealing company size, goals, use case, or industry.
- "SCHEDULE"     : Lead wants to book a call or meeting.
- "INTERESTED"   : Clear buying intent or readiness signal.
- "OBJECTION"    : Hesitation, concern, or pushback that needs addressing.
- "ANGRY"        : Rude, frustrated, or threatening tone.
- "OUT_OF_SCOPE" : Completely unrelated (e.g., spam, wrong person).
- "UNKNOWN"      : Vague or short messages (e.g., "Hi", "Thanks"). Reply politely.

CONFIDENCE SCORE:
- Rate 0.0–1.0 how certain you are the reply is accurate and safe.

SCHEDULING HINTS (only when intent is SCHEDULE):
- Extract any time preferences, timezone, or urgency signals from the message.
- Include as "schedulingHints": { "preferredTime": "...", "timezone": "...", "urgency": "..." }
- If nothing found, set schedulingHints to null.

RESPONSE FORMAT — return ONLY a valid JSON object, nothing else:
{
  "intent":          "<one of the intents above>",
  "confidence":      <number 0.0–1.0>,
  "action":          "REPLY" | "ESCALATE" | "DRAFT",
  "reasoning":       "<1 sentence max>",
  "reply":           "<reply text, or null if action is ESCALATE>",
  "schedulingHints": <object or null>
}

BUSINESS INSTRUCTIONS:
${instructions}
`.trim();
}

/**
 * Pre-AI guardrail check. Returns a result object on hit, or null if clear.
 */
function _runGuardrails(message, followUpCount) {
    const lower = message.toLowerCase();

    if (LEGAL_TRIGGERS.some(t => lower.includes(t))) {
        return {
            reply:               null,
            action:              ACTIONS.ESCALATE,
            intent:              INTENTS.OUT_OF_SCOPE,
            confidence:          1.0,
            reasoning:           'Legal or contract language detected. Human must handle this immediately.',
            requiresHumanReview: true,
            shouldAIReply:       false,
            riskLevel:           RISK_LEVELS.HIGH,
            schedulingHints:     null,
            tokensUsed:          0,
            replyFingerprint:    null,
        };
    }

    if (ANGRY_TRIGGERS.some(t => lower.includes(t))) {
        return {
            reply:               null,
            action:              ACTIONS.STOP,
            intent:              INTENTS.ANGRY,
            confidence:          1.0,
            reasoning:           'Opt-out or angry signal detected. Thread stopped to protect brand reputation.',
            requiresHumanReview: true,
            shouldAIReply:       false,
            riskLevel:           RISK_LEVELS.HIGH,
            schedulingHints:     null,
            tokensUsed:          0,
            replyFingerprint:    null,
        };
    }

    // #4 FIX: OUT_OF_SCOPE spam → STOP instead of ESCALATE (saves human time)
    if (lower.length < 5 && !lower.match(/[a-z]/)) {
        return {
            reply:               null,
            action:              ACTIONS.STOP,
            intent:              INTENTS.OUT_OF_SCOPE,
            confidence:          1.0,
            reasoning:           'Message appears to be empty or non-text spam. Thread stopped.',
            requiresHumanReview: false,
            shouldAIReply:       false,
            riskLevel:           RISK_LEVELS.LOW,
            schedulingHints:     null,
            tokensUsed:          0,
            replyFingerprint:    null,
        };
    }

    if (followUpCount >= CONFIG.MAX_FOLLOWUPS) {
        return {
            reply:               null,
            action:              ACTIONS.ESCALATE,
            intent:              INTENTS.FOLLOW_UP,
            confidence:          1.0,
            reasoning:           `Follow-up cap (${CONFIG.MAX_FOLLOWUPS}) reached. Escalating to human.`,
            requiresHumanReview: true,
            shouldAIReply:       false,
            riskLevel:           RISK_LEVELS.MEDIUM,
            schedulingHints:     null,
            tokensUsed:          0,
            replyFingerprint:    null,
        };
    }

    return null;
}

/**
 * #7: Validate AI returned known intents and actions only.
 */
function _validateAIResponse(aiData) {
    if (!aiData || typeof aiData !== 'object') return 'response_not_object';

    const validIntents = Object.values(INTENTS);
    const validActions = ['REPLY', 'ESCALATE', 'DRAFT'];

    if (aiData.intent && !validIntents.includes(aiData.intent)) {
        return `unknown_intent:${aiData.intent}`;
    }
    if (aiData.action && !validActions.includes(aiData.action)) {
        return `unknown_action:${aiData.action}`;
    }
    if (aiData.confidence !== undefined) {
        const c = Number(aiData.confidence);
        if (isNaN(c) || c < 0 || c > 1) return 'confidence_out_of_range';
    }

    return null; // All good
}

/**
 * #19: Post-AI reply validator — spam signals, length, forbidden patterns.
 */
function _validateReply(reply) {
    if (typeof reply !== 'string') return 'reply_not_string';
    if (reply.length > CONFIG.MAX_REPLY_CHARS)  return `reply_too_long:${reply.length}`;
    if (reply.trim().length === 0)              return 'reply_empty';

    for (const pattern of SPAM_PATTERNS) {
        if (pattern.test(reply)) return `spam_pattern_detected:${pattern}`;
    }

    return null; // Valid
}

/**
 * #2 FIX: CONFIDENCE_THRESHOLD now actually gates low-confidence replies in safe/full modes.
 */
function _resolveAction(intent, confidence, aiAction, mode, reply) {
    if (!reply) return ACTIONS.ESCALATE;

    if ([INTENTS.ANGRY, INTENTS.OUT_OF_SCOPE].includes(intent)) return ACTIONS.ESCALATE;
    if (mode === 'draft') return ACTIONS.DRAFT;

    // #2: Low confidence forces escalation regardless of mode
    if (confidence < CONFIG.CONFIDENCE_THRESHOLD) {
        console.warn(`⚠️  [AI GENERATOR] Confidence ${confidence} below threshold ${CONFIG.CONFIDENCE_THRESHOLD}. Escalating.`);
        return ACTIONS.ESCALATE;
    }

    if (mode === 'full') return ACTIONS.REPLY;

    if (mode === 'safe') {
        const safeIntents = [INTENTS.FAQ, INTENTS.QUALIFY, INTENTS.SCHEDULE, INTENTS.UNKNOWN];
        return safeIntents.includes(intent) ? ACTIONS.REPLY : ACTIONS.ESCALATE;
    }

    return ACTIONS.REPLY;
}

function _needsReview(finalAction, confidence, mode) {
    if (mode === 'draft') return true;
    if (finalAction === ACTIONS.ESCALATE || finalAction === ACTIONS.STOP) return true;
    if (confidence < CONFIG.CONFIDENCE_THRESHOLD) return true;
    return false;
}

/**
 * #23: Risk score engine — maps intent + confidence + action → risk level.
 */
function _computeRiskLevel(intent, confidence, finalAction) {
    if (finalAction === ACTIONS.STOP)                                      return RISK_LEVELS.HIGH;
    if ([INTENTS.ANGRY, INTENTS.OUT_OF_SCOPE].includes(intent))           return RISK_LEVELS.HIGH;
    if (finalAction === ACTIONS.ESCALATE)                                  return RISK_LEVELS.HIGH;
    if ([INTENTS.OBJECTION, INTENTS.INTERESTED].includes(intent))         return RISK_LEVELS.MEDIUM;
    if (confidence < 0.5)                                                  return RISK_LEVELS.MEDIUM;
    return RISK_LEVELS.LOW;
}

/**
 * #6: Trim conversation history to stay within token budget.
 * Keeps the most recent N turns.
 */
function _trimHistory(history, limit) {
    if (!Array.isArray(history)) return [];
    return history.slice(-limit);
}

/**
 * #16 #17: Sanitize input to prevent prompt injection.
 * Strips known injection patterns and enforces char limit.
 */
function _sanitizeInput(text, maxChars) {
    if (typeof text !== 'string') return '';

    return text
        .slice(0, maxChars)
        // Strip common prompt injection attempts
        .replace(/ignore (all )?(previous|above|prior) instructions?/gi, '[FILTERED]')
        .replace(/you are now/gi,                                         '[FILTERED]')
        .replace(/pretend (you are|to be)/gi,                             '[FILTERED]')
        .replace(/act as (if you are|a)?/gi,                              '[FILTERED]')
        .replace(/reveal (your|the) (system|instructions?|prompt)/gi,     '[FILTERED]')
        .replace(/disregard (all )?instructions?/gi,                      '[FILTERED]')
        .trim();
}

/**
 * #24: Structured error result with error code for upstream handling.
 */
function _errorResult(reason, startTime = Date.now()) {
    return {
        reply:               null,
        action:              ACTIONS.ESCALATE,
        intent:              INTENTS.UNKNOWN,
        confidence:          0,
        reasoning:           `Internal error: ${reason}`,
        requiresHumanReview: true,
        shouldAIReply:       false,
        riskLevel:           RISK_LEVELS.HIGH,
        schedulingHints:     null,
        durationMs:          Date.now() - startTime,
        tokensUsed:          null,
        modelVersion:        CONFIG.MODEL,
        replyFingerprint:    null,
        errorCode:           reason, // #24: Structured error code for caller
    };
}

function _logAPIError(err) {
    if (!err.response) {
        console.error('❌ [AI GENERATOR] Network error — no response from OpenAI.');
        return;
    }
    const status = err.response.status;
    const msgs = {
        401: 'Auth failed — check OPENAI_API_KEY.',
        429: 'Rate limit hit — back off or upgrade plan.',
        500: 'OpenAI server error — retry shortly.',
        503: 'OpenAI overloaded — retry shortly.',
    };
    console.error(`❌ [AI GENERATOR] API error ${status}: ${msgs[status] || JSON.stringify(err.response.data)}`);
}

function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
    generateAIReply,
    INTENTS,
    ACTIONS,
    RISK_LEVELS,
    TONES,
    REPLY_LENGTH,
    CONFIG,
};
