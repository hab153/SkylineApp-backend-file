// aiReplyGenerator.js
// ─────────────────────────────────────────────────────────────────────────────
// STATELESS AI autoreply engine.
// NO database. NO email sending. NO auth. Text in → structured result out.
// ─────────────────────────────────────────────────────────────────────────────
const axios = require('axios');

// ─── CONFIGURATION ────────────────────────────────────────────────────────────
const CONFIG = {
    MODEL:                process.env.AI_MODEL               || 'gpt-4o-mini',
    TEMPERATURE:          0.3,   // Low = predictable, professional, non-hallucinating
    MAX_TOKENS:           500,
    API_URL:              'https://api.openai.com/v1/chat/completions',
    CONFIDENCE_THRESHOLD: 0.3,   // Must be 80%+ confident to auto-reply
    MAX_FOLLOWUPS:        parseInt(process.env.AI_MAX_FOLLOWUPS) || 500,
    HISTORY_LIMIT:        10,     // Last N conversation messages to include for memory
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
};

const ACTIONS = {
    REPLY:    'REPLY',     // Safe to auto-send
    ESCALATE: 'ESCALATE',  // Hand to human
    STOP:     'STOP',      // Thread ended (angry / opt-out)
    DRAFT:    'DRAFT',     // Reply generated but needs human approval first
};

// Hard-stop words — caught BEFORE wasting an API call
const LEGAL_TRIGGERS = [
    'lawsuit', 'lawyer', 'legal action', 'sue', 'attorney',
    'contract', 'refund my money', 'chargeback', 'charge back',
    'this is fraud', 'scam',
];

const ANGRY_TRIGGERS = [
    'stop emailing', 'leave me alone', 'unsubscribe',
    'remove me', 'this is ridiculous', 'do not contact',
];

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * generateAIReply
 *
 * @param {string}   customerMessage          - Latest message from the lead.
 * @param {string}   instructions             - Business rules / knowledge base for this account.
 * @param {string}   leadName                 - Business or lead name for personalisation.
 * @param {Array}    [conversationHistory=[]] - Prior turns: [{ role: 'user'|'assistant', content: string }]
 * @param {Object}   [options={}]
 * @param {Object}   [options.leadContext={}] - Extra facts: { companySize, industry, meetingStatus, … }
 * @param {string}   [options.mode='safe']    - 'draft' | 'safe' | 'full'
 * @param {number}   [options.followUpCount=0]- Follow-ups already sent to this lead.
 *
 * @returns {Promise<{
 *   reply:               string|null,
 *   action:              string,
 *   intent:              string,
 *   confidence:          number,
 *   reasoning:           string,
 *   requiresHumanReview: boolean
 * }>}
 */
async function generateAIReply(
    customerMessage,
    instructions,
    leadName,
    conversationHistory = [],
    options = {}
) {
    const {
        leadContext    = {},
        mode           = 'safe',
        followUpCount  = 0,
    } = options;

    // ── LAYER 0: API Key Guard ────────────────────────────────────────────────
    if (!process.env.OPENAI_API_KEY) {
        console.error('❌ [AI GENERATOR] OPENAI_API_KEY is missing.');
        return _errorResult('missing_api_key');
    }

    // ── LAYER 1: Pre-AI Hard Guardrails ───────────────────────────────────────
    // These are deterministic — no AI call needed, no tokens wasted.
    const guardrail = _runGuardrails(customerMessage, followUpCount);
    if (guardrail) {
        console.warn(`🛡️  [AI GENERATOR] Guardrail hit: ${guardrail.reasoning}`);
        return guardrail;
    }

    // ── LAYER 2: Build Prompt ─────────────────────────────────────────────────
    const systemPrompt = _buildSystemPrompt(instructions, leadName, leadContext, mode);

    const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory.slice(-CONFIG.HISTORY_LIMIT), // Memory: last N turns
        { role: 'user',   content: customerMessage },
    ];

    // ── LAYER 3: AI API Call ──────────────────────────────────────────────────
    let rawContent;
    try {
        const response = await axios.post(CONFIG.API_URL, {
            model:           CONFIG.MODEL,
            messages,
            temperature:     CONFIG.TEMPERATURE,
            max_tokens:      CONFIG.MAX_TOKENS,
            response_format: { type: 'json_object' }, // Enforces clean JSON natively
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type':  'application/json',
            },
        });

        rawContent = response.data.choices[0].message.content;
    } catch (err) {
        _logAPIError(err);
        return _errorResult('api_call_failed');
    }

    // ── LAYER 4: Parse AI Response ────────────────────────────────────────────
    let aiData;
    try {
        aiData = JSON.parse(rawContent);
    } catch (_) {
        console.error('❌ [AI GENERATOR] JSON parse failed. Raw:', rawContent);
        return _errorResult('parse_failed');
    }

    const {
        intent     = INTENTS.UNKNOWN,
        confidence = 0,
        action     = ACTIONS.ESCALATE,
        reasoning  = '',
        reply      = null,
    } = aiData;

    console.log(`🧠 [AI GENERATOR] Intent: ${intent} | Confidence: ${confidence} | Action: ${action}`);

    // ── LAYER 5: Post-AI Safety Routing ──────────────────────────────────────
    // AI said what it thinks — WE decide the final action. AI cannot override us.
    const finalAction            = _resolveAction(intent, confidence, action, mode, reply);
    const requiresHumanReview    = _needsReview(finalAction, confidence, mode);

    if (requiresHumanReview) {
        console.warn(`⚠️  [AI GENERATOR] Human review required. Reason: ${reasoning}`);
    }

    return {
        reply:               finalAction === ACTIONS.REPLY || finalAction === ACTIONS.DRAFT ? reply : null,
        action:              finalAction,
        intent,
        confidence:          Math.round(confidence * 100) / 100,
        reasoning,
        requiresHumanReview,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _buildSystemPrompt(instructions, leadName, leadContext, mode) {
    const modeRules = {
        draft: 'Always set action to "DRAFT". Your reply must be reviewed by a human before sending.',
        safe:  'Auto-reply only for FAQ, QUALIFY, SCHEDULE. Set action to "ESCALATE" for INTERESTED, ANGRY, OUT_OF_SCOPE.',
        full:  'Auto-reply for all in-scope intents. Always escalate ANGRY and OUT_OF_SCOPE.',
    };

    const contextBlock = Object.keys(leadContext).length
        ? `\nLEAD CONTEXT (use this to personalise the reply):\n${JSON.stringify(leadContext, null, 2)}\n`
        : '';

    return `
You are a controlled, professional email assistant for the business: "${leadName}".
Your ONLY job is to reply to leads safely, using the business instructions below.

OPERATING MODE: ${mode.toUpperCase()}
${modeRules[mode] || modeRules['safe']}
${contextBlock}
STRICT GUARDRAILS — NEVER VIOLATE:
1. NEVER promise pricing not explicitly stated in the business instructions.
2. NEVER invent features or capabilities.
3. NEVER argue emotionally or apply pressure.
4. NEVER discuss contracts or make legal claims.
5. NEVER claim to be human if the lead directly asks.
6. If the message is angry, threatening, or requires human judgment → set action to "ESCALATE".
7. Every reply must move the conversation toward: qualify → schedule → convert. No idle chatter.

INTENT DETECTION — classify into exactly one:
- "FAQ"          : Simple question about the service, pricing, or process.
- "QUALIFY"      : Lead revealing company size, goals, use case, or industry.
- "SCHEDULE"     : Lead wants to book a call or meeting.
- "INTERESTED"   : Clear buying intent or readiness signal.
- "OBJECTION"    : Hesitation, concern, or pushback that needs addressing.
- "ANGRY"        : Rude, frustrated, or threatening tone.
- "OUT_OF_SCOPE" : Unrelated, requires human judgment, or cannot be answered from instructions.
- "UNKNOWN"      : Cannot be classified with confidence.

CONFIDENCE SCORE:
- Rate 0.0–1.0 how certain you are the reply is accurate given the business instructions.
- If confidence < ${CONFIG.CONFIDENCE_THRESHOLD}, set action to "ESCALATE" and reply to null.

RESPONSE FORMAT — return ONLY a valid JSON object, nothing else:
{
  "intent":     "<one of the intents above>",
  "confidence": <number 0.0–1.0>,
  "action":     "REPLY" | "ESCALATE" | "DRAFT",
  "reasoning":  "<1 sentence: why this intent, confidence, and action>",
  "reply":      "<professional email reply, or null if action is ESCALATE>"
}

BUSINESS INSTRUCTIONS:
${instructions}
`.trim();
}

/**
 * Pre-AI guardrail check. Catches hard-stop cases without burning tokens.
 * Returns a result object on a hit, or null if clear.
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
        };
    }

    return null;
}

/**
 * We own the final action — the AI's suggestion is just input, not law.
 */
function _resolveAction(intent, confidence, aiAction, mode, reply) {
    // Low confidence → always escalate, regardless of what AI said
    if (confidence < CONFIG.CONFIDENCE_THRESHOLD) return ACTIONS.ESCALATE;

    // No reply content → nothing to send
    if (!reply) return ACTIONS.ESCALATE;

    // Dangerous intents always escalate
    if ([INTENTS.ANGRY, INTENTS.OUT_OF_SCOPE, INTENTS.UNKNOWN].includes(intent)) {
        return ACTIONS.ESCALATE;
    }

    // Draft mode overrides everything — human always reviews
    if (mode === 'draft') return ACTIONS.DRAFT;

    // Safe mode: only handle low-risk intents automatically
    if (mode === 'safe') {
        const safeIntents = [INTENTS.FAQ, INTENTS.QUALIFY, INTENTS.SCHEDULE];
        return safeIntents.includes(intent) ? ACTIONS.REPLY : ACTIONS.ESCALATE;
    }

    // Full mode: trust the AI's action if confidence is high
    return aiAction === ACTIONS.ESCALATE ? ACTIONS.ESCALATE : ACTIONS.REPLY;
}

function _needsReview(finalAction, confidence, mode) {
    if (mode === 'draft') return true;
    if (finalAction === ACTIONS.ESCALATE || finalAction === ACTIONS.STOP) return true;
    if (confidence < CONFIG.CONFIDENCE_THRESHOLD) return true;
    return false;
}

function _errorResult(reason) {
    return {
        reply:               null,
        action:              ACTIONS.ESCALATE,
        intent:              INTENTS.UNKNOWN,
        confidence:          0,
        reasoning:           `Internal error: ${reason}`,
        requiresHumanReview: true,
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
        429: 'Rate limit hit — slow down requests or upgrade plan.',
        500: 'OpenAI server error — try again shortly.',
    };
    console.error(`❌ [AI GENERATOR] API error ${status}: ${msgs[status] || err.response.data}`);
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
    generateAIReply,
    INTENTS,
    ACTIONS,
    CONFIG,
};
