'use strict';

/**
 * agent1.js – Router Agent
 * 
 * The first and most important control layer in the B2B lead-generation AI system.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Read the raw user request carefully.
 * 2. Identify the true intent.
 * 3. Extract all relevant entities and constraints.
 * 4. Decide which pipeline should run next.
 * 5. Estimate confidence in the classification.
 * 6. Detect missing information, ambiguity, or mixed intent.
 * 7. If the request is unclear, stop and ask a clarification question.
 * 8. Return only structured output.
 * 
 * YOU MUST NOT:
 * - Search for leads.
 * - Verify emails.
 * - Enrich companies directly.
 * - Draft outreach.
 * - Send emails.
 * - Make policy decisions outside your routing role.
 * - Produce long explanations.
 * - Invent missing facts.
 */

const axios = require('axios');

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const ROUTER_MODEL = 'gpt-4o-mini';
const FALLBACK_MODEL = 'gpt-4o';
const MAX_OUTPUT_TOKENS = 400;
const CONFIDENCE_THRESHOLD_ROUTE = 0.90;
const CONFIDENCE_THRESHOLD_CLARIFY = 0.50;

// ────────────────────────────────────────────────────────────────
// 2. The Router System Prompt (locked, production-grade)
// ────────────────────────────────────────────────────────────────

const ROUTER_SYSTEM_PROMPT = `You are Router Agent, the first and most important control layer in a B2B lead-generation AI system.

Your only job is to understand the user's request, classify the intent, extract key entities, assess confidence, detect ambiguity, and decide which downstream pipeline should run.

You must be precise, conservative, and structured.

PRIMARY RESPONSIBILITIES
1. Read the raw user request carefully.
2. Identify the true intent.
3. Extract all relevant entities and constraints.
4. Decide which pipeline should run next.
5. Estimate confidence in your classification.
6. Detect missing information, ambiguity, or mixed intent.
7. If the request is unclear, stop and ask a clarification question.
8. Return only structured output.

YOU MUST NOT
- Search for leads.
- Verify emails.
- Enrich companies directly.
- Draft outreach.
- Send emails.
- Make policy decisions outside your routing role.
- Produce long explanations.
- Invent missing facts.

ROUTING GOALS
Classify user requests into one of these intents:
- lead_generation
- lead_enrichment
- email_verification
- outreach_drafting
- export
- general_chat
- mixed_workflow
- unknown

DECISION RULES
- If the request is clear and specific, classify it and route it.
- If the request is partially clear, return a clarification question.
- If confidence is below threshold, do not route automatically.
- If the request contains risky or high-impact actions, mark it for policy review.
- If multiple tasks appear in one request and your system does not support splitting, ask the user to choose one.
- Preserve user constraints exactly: location, industry, role, lead count, format, approval requirements, and time sensitivity.

CONFIDENCE GUIDELINES
- 0.90 to 1.00 = very clear
- 0.70 to 0.89 = mostly clear
- 0.50 to 0.69 = ambiguous, clarification needed
- below 0.50 = do not route

OUTPUT FORMAT
Return valid JSON only, using this schema:
{
  "intent": string,
  "confidence": number,
  "needs_clarification": boolean,
  "clarification_question": string|null,
  "next_pipeline": string|null,
  "entities": {
    "industry": string|null,
    "location": string|null,
    "role": string|null,
    "company": string|null,
    "lead_count": number|null,
    "email": string|null,
    "domain": string|null,
    "source_type": string|null
  },
  "risk_level": "low" | "medium" | "high",
  "policy_flags": string[],
  "reason": string
}

ROUTING EXAMPLES
- Lead discovery request -> next_pipeline = lead_finder
- Existing list verification -> next_pipeline = email_verifier
- Need outreach copy -> next_pipeline = outreach_drafting
- Unclear request -> needs_clarification = true
- Multi-step workflow -> next_pipeline = mixed_workflow if allowed

IMPORTANT
- Be consistent.
- Do not hallucinate entities.
- Do not output extra commentary.
- Do not explain your reasoning beyond the short reason field.
- Always prefer safe clarification over incorrect routing.`;

// ────────────────────────────────────────────────────────────────
// 3. Utility: Retry helper
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

// ────────────────────────────────────────────────────────────────
// 4. Main Router Function
// ────────────────────────────────────────────────────────────────

/**
 * Routes the user request by classifying intent and extracting entities.
 * 
 * @param {Object} params
 * @param {string} params.message - The raw user message.
 * @param {string} params.apiKey - OpenAI API key (required).
 * @param {Array}  params.history - Previous conversation history (optional).
 * @param {string} params.userId - User identifier for logging.
 * @param {Function} params.onProgress - Optional progress callback.
 * 
 * @returns {Object} Structured routing decision.
 */
async function routeRequest({ message, apiKey, history = [], userId = 'anonymous', onProgress = null }) {
    // apiKey is REQUIRED – we must have it to call OpenAI
    if (!apiKey) {
        throw new Error('API key is required for routeRequest. Please provide apiKey.');
    }

    console.log(`🧭 [ROUTER] Processing request from user ${userId}...`);
    onProgress?.('🧠 Understanding your request...');

    const sanitisedMessage = typeof message === 'string' ? message.slice(0, 800) : '';
    if (!sanitisedMessage.trim()) {
        return {
            intent: 'general_chat',
            confidence: 0.95,
            needs_clarification: false,
            clarification_question: null,
            next_pipeline: 'chat',
            entities: {},
            risk_level: 'low',
            policy_flags: [],
            reason: 'Empty or whitespace-only message – treating as general chat.'
        };
    }

    const recentHistory = (history || []).slice(-6)
        .map(h => `${h.role || 'user'}: ${h.content || ''}`)
        .join('\n');

    const userPrompt = `
USER REQUEST: "${sanitisedMessage}"
${recentHistory ? `\nRECENT CONVERSATION:\n${recentHistory}` : ''}

Classify this request and return valid JSON only.`;

    let result = await callRouterModel(ROUTER_MODEL, userPrompt, apiKey);

    if (!result || result.confidence < CONFIDENCE_THRESHOLD_CLARIFY) {
        console.log(`🔄 [ROUTER] Low confidence (${result?.confidence || 0}) – trying fallback model...`);
        onProgress?.('🤔 Clarifying your request...');
        const fallbackResult = await callRouterModel(FALLBACK_MODEL, userPrompt, apiKey);
        if (fallbackResult) {
            result = fallbackResult;
        }
    }

    if (!result) {
        return {
            intent: 'unknown',
            confidence: 0.0,
            needs_clarification: true,
            clarification_question: 'I couldn\'t understand your request. Could you please rephrase it? For example, tell me what industry, location, or type of leads you\'re looking for.',
            next_pipeline: null,
            entities: {},
            risk_level: 'low',
            policy_flags: ['router_failure'],
            reason: 'Router failed to produce a valid classification.'
        };
    }

    // Apply confidence-based decision logic
    if (result.confidence >= CONFIDENCE_THRESHOLD_ROUTE) {
        // High confidence – route immediately
        result.needs_clarification = false;
        result.clarification_question = null;
        console.log(`✅ [ROUTER] High confidence (${result.confidence}) – routing to ${result.next_pipeline}`);
    } else if (result.confidence >= CONFIDENCE_THRESHOLD_CLARIFY) {
        // Medium confidence – route with caution, but still route
        console.log(`⚠️ [ROUTER] Medium confidence (${result.confidence}) – routing with caution`);
        result.needs_clarification = false;
        result.clarification_question = null;
    } else {
        // Low confidence – ask for clarification
        console.log(`❓ [ROUTER] Low confidence (${result.confidence}) – requesting clarification`);
        result.needs_clarification = true;
        result.next_pipeline = null;
        if (!result.clarification_question) {
            result.clarification_question = 'Could you be more specific about what you\'re looking for? For example: what industry, location, or type of leads?';
        }
    }

    // Ensure all required fields are present
    return {
        intent: result.intent || 'unknown',
        confidence: result.confidence || 0,
        needs_clarification: result.needs_clarification ?? false,
        clarification_question: result.clarification_question || null,
        next_pipeline: result.next_pipeline || null,
        entities: {
            industry: result.entities?.industry || null,
            location: result.entities?.location || null,
            role: result.entities?.role || null,
            company: result.entities?.company || null,
            lead_count: result.entities?.lead_count || null,
            email: result.entities?.email || null,
            domain: result.entities?.domain || null,
            source_type: result.entities?.source_type || null,
        },
        risk_level: result.risk_level || 'low',
        policy_flags: result.policy_flags || [],
        reason: result.reason || 'Router processed request.',
    };
}

// ────────────────────────────────────────────────────────────────
// 5. Model Call Helper
// ────────────────────────────────────────────────────────────────

async function callRouterModel(model, userPrompt, apiKey) {
    try {
        const response = await withRetry(() => axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: model,
                messages: [
                    { role: 'system', content: ROUTER_SYSTEM_PROMPT },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: MAX_OUTPUT_TOKENS,
                temperature: 0.0,
                response_format: { type: 'json_object' }
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        ), `Router:${model}`);

        if (!response) return null;

        const rawContent = response.data.choices[0].message.content.trim();
        const parsed = JSON.parse(rawContent);

        // Validate that parsed contains the required schema fields
        if (!parsed.intent || typeof parsed.confidence !== 'number') {
            console.warn(`⚠️ [ROUTER] Invalid schema from ${model} – missing required fields`);
            return null;
        }

        return parsed;

    } catch (error) {
        console.error(`❌ [ROUTER] Model call failed (${model}):`, error.message);
        return null;
    }
}

// ────────────────────────────────────────────────────────────────
// 6. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
    routeRequest,
    CONFIDENCE_THRESHOLD_ROUTE,
    CONFIDENCE_THRESHOLD_CLARIFY,
};
