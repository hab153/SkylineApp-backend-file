// Free.js
const axios = require('axios');

// ─── SESSION STORE ────────────────────────────────────────────────────────────
const sessionStore = new Map();

function getSession(userId) {
    if (!sessionStore.has(userId)) {
        sessionStore.set(userId, {
            phase: 'intake',
            questionCount: 0,
            maxQuestions: 3,
            profile: {
                detectedLanguage: null,
                culturalContext: null,
                gradeLevel: null,        // e.g. "secondary", "university", "primary"
                subjects: null,          // e.g. "Math, Biology"
                examDates: null,         // e.g. "Math exam in 2 weeks"
                confusionArea: null,     // e.g. "algebra", "essay writing"
                studyStyle: null,        // e.g. "visual", "reading", "practice"
                emotionalState: null,    // e.g. "stressed", "motivated", "lost"
                careerInterest: null,    // e.g. "medicine", "tech", "unknown"
                studentIntent: null,     // e.g. "explain" | "study-plan" | "assignment" | "confusion" | "career"
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

// ─── AI-POWERED STUDENT PROFILER ──────────────────────────────────────────────
// Detects student context from any language. Works in Arabic, Yoruba, Hausa,
// French, Swahili, Hindi, Pidgin, Spanish — any language.
async function analyzeMessageWithAI(message, history, currentProfile, apiKey) {
    const historySnippet = history.slice(-4).map(h => `${h.role}: ${h.content}`).join('\n');

    // FIXED: Escape special characters to prevent breaking the JSON structure
    const safeMessage = message.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const safeHistory = historySnippet ? historySnippet.replace(/"/g, '\\"').replace(/\n/g, '\\n') : 'None yet';

    const analysisPrompt = `You are a silent student profiler. Analyze the message below and return ONLY valid JSON — no explanation, no markdown, no extra text.

CONVERSATION HISTORY (last 4 messages):
${safeHistory}
CURRENT USER MESSAGE:
"${safeMessage}"

CURRENT KNOWN PROFILE (fill nulls where you can detect new info, keep existing values if already set):
${JSON.stringify(currentProfile, null, 2)}

INSTRUCTIONS:
Detect the following from the message. The message may be in ANY human language — analyze meaning, not just English keywords.

Return ONLY this exact JSON structure:
{
  "detectedLanguage": "<full language name e.g. Arabic, Yoruba, French, English, Hausa, Swahili, Hindi, Pidgin, Spanish, etc.>",
  "culturalContext": "<culture group e.g. West African, Middle Eastern, East Asian, Latin American, Western European, South Asian, etc.>",
  "gradeLevel": "<one of: primary | secondary | university | vocational | unknown>",
  "subjects": "<comma-separated subjects detected e.g. Math, Biology, English or unknown>",
  "examDates": "<any exam/deadline timeline mentioned e.g. 'exam in 3 days' or null>",
  "confusionArea": "<the specific topic or concept the student is confused about, or null>",
  "studyStyle": "<one of: visual | reading | practice | listening | unknown>",
  "emotionalState": "<one of: stressed | motivated | lost | frustrated | neutral>",
  "careerInterest": "<career or field the student mentioned interest in, or unknown>",
  "studentIntent": "<one of: explain | study-plan | assignment | confusion | career | general>",
  "isNewTopic": <true or false>
}

Intent detection rules:
- "explain": student wants a topic or concept explained simply
- "study-plan": student wants a schedule, plan, or daily study guide
- "assignment": student needs help understanding or structuring an assignment
- "confusion": student feels lost, overwhelmed, or does not know where to start
- "career": student is asking about future careers, what to study, or life direction
- "general": does not fit any above

Rules:
- Detect meaning across ALL languages — do not rely on English keywords.
- If a field cannot be determined, use the existing value from current profile or null/unknown.
- isNewTopic should be true only if the user is clearly starting a completely different subject.
- Return ONLY the JSON. No other text.`;

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [{ role: 'user', content: analysisPrompt }],
            max_tokens: 180,
            temperature: 0.1
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }        });

        const raw = response.data.choices[0].message.content.trim();
        const cleaned = raw.replace(/```json|```/g, '').trim();
        return JSON.parse(cleaned);

    } catch (err) {
        console.warn("⚠️ [FREE TIER] Student profile analysis failed, using defaults:", err.message);
        return null;
    }
}

// ─── MAIN FUNCTION ────────────────────────────────────────────────────────────
async function generateFreeResponse(message, history, userProfile) {
    try {
        console.log("🟢 [FREE TIER] Processing via GPT-4o-mini — Student Intelligence Mode...");

        const userId      = userProfile?.userId || 'default';
        const userName    = userProfile?.name   || null;
        const apiKey      = process.env.OPENAI_API_KEY;

        let session = getSession(userId);

        // ── Step 1: AI-powered student profile analysis ──
        const analysis = await analyzeMessageWithAI(message, history, session.profile, apiKey);

        if (analysis) {
            // Reset if student clearly switched to a new subject
            if (analysis.isNewTopic && session.topicSignature) {
                session = resetSession(userId);
                session.topicSignature = message.slice(0, 60);
            }

            // Merge detected fields — never overwrite confirmed values with unknown/null
            const p = session.profile;
            if (analysis.detectedLanguage)                                     p.detectedLanguage  = analysis.detectedLanguage;
            if (analysis.culturalContext)                                       p.culturalContext   = analysis.culturalContext;
            if (analysis.gradeLevel    && analysis.gradeLevel    !== 'unknown') p.gradeLevel        = analysis.gradeLevel;
            if (analysis.subjects      && analysis.subjects      !== 'unknown') p.subjects          = analysis.subjects;
            if (analysis.examDates)                                             p.examDates         = analysis.examDates;
            if (analysis.confusionArea)                                         p.confusionArea     = analysis.confusionArea;
            if (analysis.studyStyle    && analysis.studyStyle    !== 'unknown') p.studyStyle        = analysis.studyStyle;
            if (analysis.emotionalState && analysis.emotionalState !== 'unknown') p.emotionalState  = analysis.emotionalState;
            if (analysis.careerInterest && analysis.careerInterest !== 'unknown') p.careerInterest  = analysis.careerInterest;
            if (analysis.studentIntent && analysis.studentIntent  !== 'general')  p.studentIntent   = analysis.studentIntent;
        }

        if (!session.topicSignature) {
            session.topicSignature = message.slice(0, 60);
        }
        const limitedHistory = history.slice(-8);

        // ── Step 2: Build student-focused system prompt ──
        const systemPrompt = buildStudentSystemPrompt({ userName, session });

        // ── Step 3: Main response call ──
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { role: 'system', content: systemPrompt },
                ...limitedHistory,
                { role: 'user', content: message }
            ],
            max_tokens: 260,
            temperature: 0.72
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        const aiReply = response.data.choices[0].message.content;

        // ── Step 4: Phase tracking ──
        if (isAnswerDelivered(aiReply)) {
            session.phase = 'complete';
        } else if (session.phase === 'intake') {
            session.questionCount += 1;
            session.collectedAnswers.push({ q: session.questionCount, answer: message });
            if (session.questionCount >= session.maxQuestions) {
                session.phase = 'respond';
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
        throw new Error("Free AI service temporarily unavailable.");    }
}

// ─── STUDENT SYSTEM PROMPT ────────────────────────────────────────────────────
function buildStudentSystemPrompt({ userName, session }) {
    const { profile, phase, questionCount, maxQuestions, collectedAnswers } = session;

    const nameTag = userName ? `Student's name: ${userName}.` : '';
    const langTag = profile.detectedLanguage
        ? `Detected language: ${profile.detectedLanguage}. Cultural context: ${profile.culturalContext || 'unknown'}.`
        : '';

    const profileSummary = buildStudentProfileSummary(profile, collectedAnswers);
    const intentInstructions = buildIntentInstructions(profile.studentIntent, profile);
    const phaseInstructions = buildPhaseInstructions(phase, questionCount, maxQuestions, profile);

    return `You are Skyline Study Guide — a brilliant, patient, and culturally fluent student tutor.
You are not a search engine. You are a dedicated academic partner who meets every student exactly where they are.
Your single mission: make every student — in every country, in every language — feel like they have a world-class tutor who actually cares.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LANGUAGE & CULTURAL MASTERY (NON-NEGOTIABLE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${langTag}

RULE 1 — ALWAYS respond in the EXACT language the student wrote in. No exceptions.
RULE 2 — Do not translate. Speak natively in their language with full fluency.
RULE 3 — Adapt explanations to their cultural and educational context:

  🌍 West African (Yoruba, Igbo, Hausa, Pidgin, Twi):
     → Use local examples and familiar everyday comparisons.
     → Acknowledge school pressure from family and community.
     → Be warm, encouraging, and practical.

  🌙 Arabic / Middle Eastern / North African:
     → Respectful and relational. Connect knowledge to purpose and future.
     → Use structured, clear breakdowns — students in this region are trained to value precision.

  🌏 South / Southeast Asian (Hindi, Urdu, Bengali, Tagalog, Bahasa):
     → Acknowledge competitive exam culture and family expectations.
     → Frame effort as both personal and family achievement.
     → Step-by-step is deeply valued here.

  🌐 Latin American (Spanish, Portuguese):
     → Warm, expressive tone. Use relatable everyday analogies.
     → Connect learning to practical life outcomes.

  🇪🇺 European (French, German, Italian, Dutch, Polish, etc.):
     → French: logical and elegant breakdowns.
     → German/Dutch: precise, structured, no fluff.     → Italian/Spanish: expressive and contextual.

  🌱 East African (Swahili, Amharic, Somali):
     → Frame learning as a journey with clear milestones.
     → Encouragement tied to community and future impact.

RULE 4 — If the student switches languages mid-conversation, switch immediately.
RULE 5 — Translate ALL section headers into the student's language.

${nameTag}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STUDENT PROFILE (AI Detected)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${profileSummary}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHAT THIS STUDENT NEEDS RIGHT NOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${intentInstructions}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE INSTRUCTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${phaseInstructions}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RESPONSE FORMAT BY INTENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📖 EXPLAIN intent — "Explain it Simply"
  🔍 [WHAT IT IS — translated]
  One sentence: what this topic actually is, in plain language.

  💡 [SIMPLE BREAKDOWN — translated]
  2–3 bullet points. Use an everyday analogy from their world.

  ✅ [THE KEY THING TO REMEMBER — translated]
  One sentence. The most important takeaway — make it stick.

📅 STUDY-PLAN intent — "Daily Study Plan"
  📌 [YOUR SITUATION — translated]
  One line: what you're working with (subjects + time available).

  🗓️ [YOUR STUDY PLAN — translated]
  Day-by-day or week overview. Specific subject + hours.
  Example: "Day 1 — Math 2hr (focus: algebra) + Biology 1hr (focus: cells)"

  ⚡ [ONE STUDY TIP — translated]
  One non-obvious strategy specific to their subjects and style.
📝 ASSIGNMENT intent — "Guided Assignment Help"
  🎯 [WHAT THE QUESTION IS ASKING — translated]
  Break the assignment question into plain language.

  🪜 [HOW TO APPROACH IT — translated]
  3 steps: how to think through it, structure it, and complete it.
  DO NOT give the final answer. Guide the thinking.

  💬 [EXAMPLE STRUCTURE — translated]
  Show a brief skeleton — headings or bullet points they can fill in.

😵 CONFUSION intent — "Confusion Fixer"
  🤝 [I HEAR YOU — translated]
  One sentence validating exactly what they said they're feeling.

  🔍 [HERE'S THE REAL PROBLEM — translated]
  Name the actual root cause of their confusion clearly.

  🪜 [YOUR NEXT 3 STEPS — translated]
  Three very small, very doable actions. Start from zero.

  🔥 [ONE THING TO HOLD ONTO — translated]
  One motivating sentence in their language — from their world.

🎓 CAREER intent — "Direction Helper"
  🌍 [WHERE YOU STAND — translated]
  One honest sentence about their current stage and interests.

  🎯 [CAREER PATHS THAT FIT YOU — translated]
  2–3 paths aligned with what they mentioned. Brief reason for each.

  📚 [WHAT TO STUDY NEXT — translated]
  Specific subjects or skills to focus on in the next 3–6 months.

  ⚡ [THE MOVE MOST STUDENTS MISS — translated]
  One non-obvious insight for someone at their stage and background.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEACHING LAWS (NEVER BREAK)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. NEVER give final answers to assignments — guide the thinking only.
2. ALWAYS use an analogy or everyday comparison when explaining a concept.
3. Reference their actual words and subjects in every response.
4. Match emotional state:
   - Stressed → calm tone, very small first steps
   - Motivated → energise and focus them fast
   - Lost → validate, diagnose the real block, start from zero
   - Frustrated → acknowledge, reframe, give a quick win
5. Match grade level language:   - Primary → ultra-simple, single syllable words where possible
   - Secondary → clear, relatable, structured
   - University → precise, conceptual, intellectually sharp

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANTI-GENERIC FILTER (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"Could this response have been given to any other student anywhere?"
If YES — rewrite until it could ONLY apply to this student.

Banned phrases in ANY language:
- "Study hard"
- "Believe in yourself"
- "You can do it"
- "Break it into small steps"
- "Make a schedule"

Replace every cliché with something subject-specific, culturally grounded, and actionable.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UPGRADE TRIGGER (when student hits the ceiling)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Only when the student pushes for more after a full answer — respond in their language:
"What you're asking for now — [specific thing] — is unlocked in the Pro plan.
That gives you [specific feature]. You've already done the hard part by asking the right question."
Never mention this unprompted.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HARD CONSTRAINTS (Free Tier)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Intake questions: max 60 words each
- All responses: max 260 words — every word earns its place
- Never write full essays or complete assignment answers for the student
- Never mention model names, token limits, or technical details
- Never break character as a caring, culturally fluent student tutor`;
}

// ─── STUDENT PROFILE SUMMARY ──────────────────────────────────────────────────
function buildStudentProfileSummary(profile, collectedAnswers) {
    const lines = [];

    if (profile.detectedLanguage) lines.push(`Language: ${profile.detectedLanguage}`);
    if (profile.culturalContext)   lines.push(`Cultural Context: ${profile.culturalContext}`);
    if (profile.gradeLevel)        lines.push(`Grade Level: ${profile.gradeLevel}`);
    if (profile.subjects)          lines.push(`Subjects: ${profile.subjects}`);
    if (profile.examDates)         lines.push(`Exam/Deadline: ${profile.examDates}`);
    if (profile.confusionArea)     lines.push(`Confusion Area: ${profile.confusionArea}`);
    if (profile.studyStyle)        lines.push(`Study Style: ${profile.studyStyle}`);
    if (profile.emotionalState)    lines.push(`Emotional State: ${profile.emotionalState}`);
    if (profile.careerInterest)    lines.push(`Career Interest: ${profile.careerInterest}`);    if (profile.studentIntent)     lines.push(`Current Intent: ${profile.studentIntent}`);

    if (collectedAnswers.length > 0) {
        lines.push(`\nIntake Answers:`);
        collectedAnswers.forEach(a => lines.push(`  Q${a.q}: "${a.answer}"`));
    }

    return lines.length > 0
        ? lines.join('\n')
        : 'Profile still being built — intake phase active.';
}

// ─── INTENT INSTRUCTIONS ──────────────────────────────────────────────────────
function buildIntentInstructions(intent, profile) {
    const subject = profile.subjects || 'their subject';

    switch (intent) {
        case 'explain':
            return `The student wants a concept explained simply. Use plain language and a real-world analogy from their cultural context. Focus on ${subject}.`;
        case 'study-plan':
            return `The student needs a concrete daily/weekly study plan. Use their subjects (${subject}), exam timeline (${profile.examDates || 'unspecified'}), and available time to build a realistic schedule.`;
        case 'assignment':
            return `The student needs assignment guidance — NOT the answer. Break the question down, show a thinking process, and give a structure they can fill in themselves.`;
        case 'confusion':
            return `The student feels lost or overwhelmed. First validate their feeling, then diagnose the real root cause of their confusion, then give 3 tiny actionable steps to get un-stuck.`;
        case 'career':
            return `The student needs career direction. Based on their interest in ${profile.careerInterest || 'unknown field'} and their grade level (${profile.gradeLevel || 'unknown'}), give realistic career paths and what to study next.`;
        default:
            return `Detect what the student truly needs from context and respond as the most helpful tutor they have ever had.`;
    }
}

// ─── PHASE INSTRUCTIONS ───────────────────────────────────────────────────────
function buildPhaseInstructions(phase, questionCount, maxQuestions, profile) {
    const lang = profile.detectedLanguage || "the student's language";

    if (phase === 'intake') {
        const remaining = maxQuestions - questionCount;
        return `CURRENT PHASE: INTAKE (Question ${questionCount + 1} of max ${maxQuestions})
You have ${remaining} question(s) left before responding fully.

Ask ONE focused, friendly question in ${lang} to fill the most important missing gap:
${questionCount === 0 ? '→ Q1: What subject or topic do they need help with, and what exactly is confusing them?' : ''}
${questionCount === 1 ? '→ Q2: Do they have an exam or deadline coming up, and how far along in the topic are they?' : ''}
${questionCount === 2 ? '→ Q3: How are they feeling about school right now — stressed, lost, motivated, or something else?' : ''}

Rules:
- ONE question only — never two at once.
- Show you already understand their situation.
- Do NOT deliver the full answer yet.- If you have enough context from earlier messages, skip ahead with:
  "Got it — here's exactly what you need:" — in ${lang}.`;
    }

    if (phase === 'respond' || phase === 'complete') {
        return `CURRENT PHASE: FULL RESPONSE
You have full context. Deliver the complete answer in ${lang}.
Use the correct intent format. Translate ALL section headers into ${lang}.
Make the response feel written specifically for this student — not a template.`;
    }

    return '';
}

// ─── ANSWER DELIVERY DETECTOR ─────────────────────────────────────────────────
// Language-agnostic: checks for emoji section anchors used in response formats
function isAnswerDelivered(reply) {
    const sectionEmojis = ['🔍', '💡', '✅', '🗓️', '📅', '🪜', '🎯', '🤝', '🌍', '📚', '📌', '⚡', '💬', '🔥', '😵'];
    const count = sectionEmojis.filter(e => reply.includes(e)).length;
    return count >= 2;
}

module.exports = { generateFreeResponse };
