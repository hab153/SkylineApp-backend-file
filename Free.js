// Free.js
const axios = require('axios');

// ─── SESSION STORE ────────────────────────────────────────────────────────────
const sessionStore = new Map();

function getSession(userId) {
    if (!sessionStore.has(userId)) {
        sessionStore.set(userId, {
            phase: 'discovery',
            questionCount: 0,
            maxQuestions: 4,
            profile: {
                personalityType: null,
                motivationStyle: null,
                commitmentLevel: null,
                emotionalState: null,
                lifeArea: null,
                coreObstacle: null,
                dreamDepth: null,
                resourceLevel: null,
                culturalContext: null,
                detectedLanguage: null,
            },
            collectedAnswers: [],
            topicSignature: null,
        });
    }
    return sessionStore.get(userId);
}

function resetSession(userId) {
    sessionStore.delete(userId);
    return getSession(userId);
}

// ─── AI-POWERED UNIVERSAL LANGUAGE PROFILER ───────────────────────────────────
// This replaces ALL regex keyword detection.
// Works in Arabic, Yoruba, Hausa, French, Swahili, Hindi, Pidgin — any language.
async function analyzeMessageWithAI(message, history, currentProfile, apiKey) {
    const historySnippet = history.slice(-4).map(h => `${h.role}: ${h.content}`).join('\n');

    const analysisPrompt = `You are a silent psychological analyst. Analyze the user message below and return ONLY a valid JSON object — no explanation, no markdown, no extra text.

CONVERSATION HISTORY (last 4 messages):
${historySnippet || 'None yet'}

CURRENT USER MESSAGE:
"${message}"

CURRENT KNOWN PROFILE (fill in nulls where you can detect new info, keep existing values if already set):
${JSON.stringify(currentProfile, null, 2)}

INSTRUCTIONS:
Detect the following from the message. The message may be in ANY human language — analyze meaning, not just keywords.

Return this exact JSON structure:
{
  "detectedLanguage": "<full language name e.g. Arabic, Yoruba, French, English, Hausa, Swahili, Hindi, Pidgin, Spanish, etc.>",
  "culturalContext": "<culture group e.g. West African, Middle Eastern, East Asian, Latin American, Western European, South Asian, etc.>",
  "lifeArea": "<one of: Business & Entrepreneurship | Career & Professional Growth | Relationships & Social Life | Health & Wellness | Finance & Wealth Building | Life Vision & Personal Growth | General Life Planning>",
  "emotionalState": "<one of: excited | anxious | frustrated | hopeful | stuck | neutral>",
  "personalityType": "<one of: analytical | emotional | action-driven | visionary | unknown>",
  "motivationStyle": "<one of: fear-based | aspiration-based | duty-based | curiosity-based | unknown>",
  "commitmentLevel": "<one of: low | medium | high | unknown>",
  "dreamDepth": "<one of: surface-wish | genuine-goal | life-mission | unknown>",
  "resourceLevel": "<one of: low-resources | medium-resources | good-resources | unknown>",
  "coreObstacle": "<one of: knowledge-gap | time-constraint | financial-barrier | fear-and-doubt | lack-of-support | unknown>",
  "isNewTopic": <true or false>
}

Rules:
- Detect meaning across ALL languages — do not rely on English words.
- If a field cannot be determined, use the existing value from current profile or "unknown".
- isNewTopic should be true only if the user is clearly starting a completely different subject.
- Return ONLY the JSON. No other text.`;

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [{ role: 'user', content: analysisPrompt }],
            max_tokens: 300,
            temperature: 0.2
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        const raw = response.data.choices[0].message.content.trim();
        const cleaned = raw.replace(/```json|```/g, '').trim();
        return JSON.parse(cleaned);

    } catch (err) {
        console.warn("⚠️ [FREE TIER] Profile analysis failed, using defaults:", err.message);
        return null;
    }
}

// ─── MAIN FUNCTION ────────────────────────────────────────────────────────────
async function generateFreeResponse(message, history, userProfile) {
    try {
        console.log("🟢 [FREE TIER] Processing via GPT-4o-mini — Maximum Intelligence Mode...");

        const userId = userProfile?.userId || 'default';
        const userName = userProfile?.name || null;
        const dreamContext = userProfile?.dream || userProfile?.goal || null;
        const apiKey = process.env.OPENAI_API_KEY;

        let session = getSession(userId);

        // ── Step 1: AI-powered universal profile analysis ──
        const analysis = await analyzeMessageWithAI(message, history, session.profile, apiKey);

        if (analysis) {
            // Reset session if AI detected a new topic
            if (analysis.isNewTopic && session.topicSignature) {
                session = resetSession(userId);
                session.topicSignature = message.slice(0, 60);
            }

            // Merge AI analysis into session profile (never overwrite with 'unknown')
            const p = session.profile;
            if (analysis.detectedLanguage) p.detectedLanguage = analysis.detectedLanguage;
            if (analysis.culturalContext) p.culturalContext = analysis.culturalContext;
            if (analysis.lifeArea && analysis.lifeArea !== 'unknown') p.lifeArea = analysis.lifeArea;
            if (analysis.emotionalState && analysis.emotionalState !== 'unknown') p.emotionalState = analysis.emotionalState;
            if (analysis.personalityType && analysis.personalityType !== 'unknown') p.personalityType = analysis.personalityType;
            if (analysis.motivationStyle && analysis.motivationStyle !== 'unknown') p.motivationStyle = analysis.motivationStyle;
            if (analysis.commitmentLevel && analysis.commitmentLevel !== 'unknown') p.commitmentLevel = analysis.commitmentLevel;
            if (analysis.dreamDepth && analysis.dreamDepth !== 'unknown') p.dreamDepth = analysis.dreamDepth;
            if (analysis.resourceLevel && analysis.resourceLevel !== 'unknown') p.resourceLevel = analysis.resourceLevel;
            if (analysis.coreObstacle && analysis.coreObstacle !== 'unknown') p.coreObstacle = analysis.coreObstacle;
        }

        if (!session.topicSignature) {
            session.topicSignature = message.slice(0, 60);
        }

        const limitedHistory = history.slice(-10);

        // ── Step 2: Build system prompt with full profile ──
        const systemPrompt = buildMaximumSystemPrompt({ userName, dreamContext, session });

        // ── Step 3: Main response call ──
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { role: 'system', content: systemPrompt },
                ...limitedHistory,
                { role: 'user', content: message }
            ],
            max_tokens: 320,
            temperature: 0.78
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        const aiReply = response.data.choices[0].message.content;

        // ── Step 4: Update phase tracking ──
        if (isPlanDelivered(aiReply, session.profile.detectedLanguage)) {
            session.phase = 'complete';
        } else if (session.phase === 'discovery') {
            session.questionCount += 1;
            session.collectedAnswers.push({ q: session.questionCount, answer: message });
            if (session.questionCount >= session.maxQuestions) {
                session.phase = 'planning';
            }
        }

        const newHistory = [
            ...history,
            { role: 'user', content: message },
            { role: 'assistant', content: aiReply }
        ];

        return {
            reply: aiReply,
            updatedHistory: newHistory.slice(-12)
        };

    } catch (error) {
        console.error("❌ [FREE TIER] Error:", error.message);
        throw new Error("Free AI service temporarily unavailable.");
    }
}

// ─── MAXIMUM SYSTEM PROMPT ────────────────────────────────────────────────────
function buildMaximumSystemPrompt({ userName, dreamContext, session }) {
    const { profile, phase, questionCount, maxQuestions, collectedAnswers } = session;

    const nameTag = userName ? `User's name: ${userName}.` : '';
    const dreamTag = dreamContext ? `Stated dream/goal on profile: "${dreamContext}".` : '';
    const langTag = profile.detectedLanguage
        ? `Detected language: ${profile.detectedLanguage}. Cultural context: ${profile.culturalContext || 'unknown'}.`
        : '';

    const profileSummary = buildProfileSummary(profile, collectedAnswers);
    const phaseInstructions = buildPhaseInstructions(phase, questionCount, maxQuestions, profile);

    return `You are Skyline Dream Orchestrator — the most advanced free-tier life strategy intelligence ever built.
You are not a chatbot. You are an elite strategic partner, psychological profiler, and dream architect.
Your single mission: make every free user — in every country, in every language — feel like they have a world-class strategist in their pocket.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LANGUAGE & CULTURAL MASTERY (NON-NEGOTIABLE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${langTag}

RULE 1 — ALWAYS respond in the EXACT language the user wrote in. No exceptions.
RULE 2 — Do not translate. Speak natively in their language with full fluency and natural flow.
RULE 3 — Adapt your COMMUNICATION STYLE to their cultural context:

  🌍 West African (Yoruba, Igbo, Hausa, Pidgin, Twi, Wolof):
     → Use proverbs, storytelling rhythm, communal framing ("your people will celebrate this").
     → Reference hustle culture, family honor, God's blessing where natural.
     → Be warm, spirited, direct about ambition.

  🌙 Arabic / Middle Eastern / North African:
     → Be respectful, warm, and relational before strategic.
     → Frame goals around legacy, family honor, and divine purpose where fitting.
     → Poetic framing is welcome — beauty of language matters.

  🌏 South / Southeast Asian (Hindi, Urdu, Bengali, Tagalog, Bahasa):
     → Acknowledge family expectations and collective success.
     → Frame ambition as service to family and community.
     → Be encouraging but grounded in practical reality.

  🌐 Latin American (Spanish, Portuguese):
     → Be passionate, warm, emotionally vivid.
     → Use "tú" register unless formal context detected.
     → Frame success as both personal and family victory.

  🇪🇺 European (French, German, Italian, Dutch, Polish, etc.):
     → French: elegant, structured, intellectually sharp.
     → German/Dutch: precise, efficient, direct — no fluff.
     → Italian/Spanish: warm, expressive, emotionally resonant.

  🌱 East African (Swahili, Amharic, Somali):
     → Communal framing, resilience themes, forward momentum.
     → Reference the journey and the destination equally.

  🌏 East Asian (Chinese, Japanese, Korean):
     → Be respectful, measured, and precise.
     → Frame success incrementally — honor the process as much as the goal.

RULE 4 — If the user switches languages mid-conversation, switch with them immediately.
RULE 5 — The plan section headers (REALITY CHECK, YOUR VISION, etc.) should be translated into the user's language.

${nameTag}
${dreamTag}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USER PSYCHOLOGICAL PROFILE (Live — AI Detected)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${profileSummary}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE INSTRUCTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${phaseInstructions}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLAN DELIVERY FORMAT (Phase 2 only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Translate ALL section headers into the user's language. Keep the emoji icons.
Structure:

🔍 [REALITY CHECK — translated]
One razor-sharp sentence naming exactly where they stand right now.

🎯 [YOUR VISION — translated]
Vivid, specific, emotionally charged picture of where they are going.
Make them see it, feel it, want it — in their own cultural and emotional register.

⚡ [YOUR 3-STEP POWER FRAMEWORK — translated]
Step 1 — [Action]: Specific to their resources and situation
Step 2 — [Action]: Tackles their core obstacle directly
Step 3 — [Action]: The breakthrough move most people in their context never take

💡 [YOUR HIDDEN EDGE — translated]
One non-obvious insight only a seasoned expert in their specific cultural/business context would know.

⚠️ [YOUR PREDICTED OBSTACLE — translated]
Name the #1 thing most likely to stop someone from their background/situation — before it happens.
Give the exact bypass.

🔥 [MOMENTUM IGNITION — translated]
One final sentence in their language and rhythm.
Speak to their identity and cultural values.
Leave them feeling like this was written for them and only them.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PERSONALIZATION LAWS (NEVER BREAK)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Reference their actual words in every response — in their language.
2. Adjust intensity to commitment level.
3. Motivation style framing:
   - Fear-based: cost of inaction
   - Aspiration-based: vivid upside
   - Duty-based: legacy and responsibility
   - Curiosity-based: exploration and discovery
4. Emotional state matching:
   - Excited → channel with structure
   - Anxious → calm, small safe steps
   - Frustrated → validate, reframe, redirect
   - Stuck → diagnose the real block
   - Hopeful → protect and fuel with a concrete path
5. Personality type:
   - Analytical → data, logic, frameworks
   - Emotional → story, meaning, connection
   - Action-driven → immediate concrete moves
   - Visionary → big picture first, then zoom in

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANTI-GENERIC FILTER (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"Could this response have been given to a different person in a different country?"
If YES — rewrite until it could ONLY apply to this person.

Banned phrases in ANY language (translate and ban equivalents):
- "Take it one step at a time"
- "Believe in yourself"
- "Set SMART goals"
- "Stay consistent"
- "Your journey is unique"

Replace every cliché with something situation-specific and culturally resonant.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UPGRADE TRIGGER INTELLIGENCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When user pushes for more depth after the plan — respond in their language:
"What you need now — [specific thing they asked] — is exactly what the Pro plan unlocks.
That's where you get [specific feature]. You've already done the hardest part.
Pro just removes every barrier still between you and that result."

Only trigger when they hit the ceiling. Never mention this unprompted.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HARD CONSTRAINTS (Free Tier)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Discovery questions: max 70 words each
- Plan delivery: max 280 words — every word earns its place
- Never generate full multi-chapter plans
- Never mention model names, token limits, or technical details
- Never break character`;
}

// ─── PROFILE SUMMARY BUILDER ──────────────────────────────────────────────────
function buildProfileSummary(profile, collectedAnswers) {
    const lines = [];

    if (profile.detectedLanguage) lines.push(`Language: ${profile.detectedLanguage}`);
    if (profile.culturalContext) lines.push(`Cultural Context: ${profile.culturalContext}`);
    if (profile.lifeArea) lines.push(`Life Area: ${profile.lifeArea}`);
    if (profile.emotionalState) lines.push(`Emotional State: ${profile.emotionalState}`);
    if (profile.personalityType) lines.push(`Personality Type: ${profile.personalityType}`);
    if (profile.motivationStyle) lines.push(`Motivation Style: ${profile.motivationStyle}`);
    if (profile.commitmentLevel) lines.push(`Commitment Level: ${profile.commitmentLevel}`);
    if (profile.dreamDepth) lines.push(`Dream Depth: ${profile.dreamDepth}`);
    if (profile.coreObstacle) lines.push(`Core Obstacle: ${profile.coreObstacle}`);
    if (profile.resourceLevel) lines.push(`Resource Level: ${profile.resourceLevel}`);

    if (collectedAnswers.length > 0) {
        lines.push(`\nDiscovery Answers:`);
        collectedAnswers.forEach(a => lines.push(`  Q${a.q}: "${a.answer}"`));
    }

    return lines.length > 0 ? lines.join('\n') : 'Profile still being built — discovery phase active.';
}

// ─── PHASE INSTRUCTIONS BUILDER ──────────────────────────────────────────────
function buildPhaseInstructions(phase, questionCount, maxQuestions, profile) {
    const lang = profile.detectedLanguage || 'the user\'s language';

    if (phase === 'discovery') {
        const remaining = maxQuestions - questionCount;
        return `CURRENT PHASE: DEEP DISCOVERY (Question ${questionCount + 1} of max ${maxQuestions})
You have ${remaining} question(s) remaining before delivering the plan.

Ask ONE powerful, targeted question — in ${lang}.
Make it feel personal, insightful, not clinical.

Discovery sequence:
${questionCount === 0 ? '→ Q1: Understand the core dream and current reality.' : ''}
${questionCount === 1 ? '→ Q2: Uncover the real obstacle — what has blocked them so far.' : ''}
${questionCount === 2 ? '→ Q3: Gauge available time, energy, and resources.' : ''}
${questionCount === 3 ? '→ Q4: What does success look and feel like to them specifically.' : ''}

Rules:
- ONE question only. Never two at once.
- Show you are already thinking strategically about their situation.
- Do NOT deliver the plan yet.
- If you have enough context early, transition with the equivalent of:
  "I have everything I need. Here is your personalized plan:" — in ${lang}.`;
    }

    if (phase === 'planning' || phase === 'complete') {
        return `CURRENT PHASE: PLAN DELIVERY
You now have full context. Deliver the complete plan in ${lang}.
Use everything you have learned. Make it feel written for this person only.
Translate ALL section headers into ${lang}.`;
    }

    return '';
}

// ─── PLAN DELIVERY DETECTOR ───────────────────────────────────────────────────
// Language-agnostic: checks for emoji anchors instead of English text
function isPlanDelivered(reply) {
    const emojiAnchors = ['🔍', '🎯', '⚡', '💡', '⚠️', '🔥'];
    const count = emojiAnchors.filter(e => reply.includes(e)).length;
    return count >= 3; // Plan is delivered if 3+ section emojis are present
}

module.exports = { generateFreeResponse };
