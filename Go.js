// go.js
const axios = require('axios');

// ─── SESSION STORE ────────────────────────────────────────────────────────────
const sessionStore = new Map();

function getSession(userId) {
    if (!sessionStore.has(userId)) {
        sessionStore.set(userId, {
            phase: 'intake',
            questionCount: 0,
            maxQuestions: 2,
            profile: {
                detectedLanguage: null,
                culturalContext: null,
                gradeLevel: null,
                subjects: null,
                examDates: null,
                examDuration: null,
                confusionArea: null,
                studyStyle: null,
                emotionalState: null,
                careerInterest: null,
                studentIntent: null,
                weakTopics: [],
                masteredTopics: [],
                preferredCareerPath: null,
            },
            collectedAnswers: [],
            topicSignature: null,
            revisionPlanGenerated: false,
            practiceRound: 0,
        });
    }
    return sessionStore.get(userId);
}

function resetSession(userId) {
    sessionStore.delete(userId);
    return getSession(userId);
}

// ─── AI-POWERED STUDENT PROFILER ──────────────────────────────────────────────
async function analyzeMessageWithAI(message, history, currentProfile, apiKey) {
    const historySnippet = history.slice(-6).map(h => `${h.role}: ${h.content}`).join('\n');

    // Escape quotes to prevent JSON breakage
    const safeMessage = message.replace(/"/g, '\\"');
    const safeHistory = historySnippet ? historySnippet.replace(/"/g, '\\"') : 'None yet';
    const analysisPrompt = `You are a silent student profiler. Analyze the message below and return ONLY valid JSON — no explanation, no markdown, no extra text.

CONVERSATION HISTORY (last 6 messages):
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
  "examDuration": "<number of days for revision plan if mentioned e.g. '7' or '30' or null>",
  "confusionArea": "<the specific topic or concept the student is confused about, or null>",
  "studyStyle": "<one of: visual | reading | practice | listening | unknown>",
  "emotionalState": "<one of: stressed | motivated | lost | frustrated | neutral>",
  "careerInterest": "<career or field the student mentioned interest in, or unknown>",
  "studentIntent": "<one of: explain | study-plan | exam-mode | assignment | confusion | career | practice | general>",
  "weakTopicsDetected": "<comma-separated topics the student says they struggle with, or null>",
  "masteredTopicsDetected": "<comma-separated topics the student says they understand well, or null>",
  "isNewTopic": <true or false>
}

Intent detection rules:
- "explain": student wants a topic or concept explained simply
- "study-plan": student wants a schedule, plan, or daily study guide
- "exam-mode": student has an upcoming exam and needs a full revision plan (7–30 days)
- "assignment": student needs help structuring or solving an assignment
- "confusion": student feels lost, overwhelmed, or does not know where to start
- "career": student is asking about future careers, what to study, or life direction
- "practice": student wants quiz questions, mock exams, or to test themselves
- "general": does not fit any above

Rules:
- Detect meaning across ALL languages — do not rely on English keywords.
- If a field cannot be determined, use the existing value from current profile or null/unknown.
- isNewTopic should be true only if the user is clearly starting a completely different subject.
- Return ONLY the JSON. No other text.`;

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {            model: "gpt-4o-mini",
            messages: [{ role: 'user', content: analysisPrompt }],
            max_tokens: 220,
            temperature: 0.1
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
        console.warn("⚠️ [GO PLAN] Student profile analysis failed, using defaults:", err.message);
        return null;
    }
}

// ─── SMART MEMORY — WEAK TOPIC TRACKER ────────────────────────────────────────
function updateSmartMemory(session, analysis) {
    if (!analysis) return;

    if (analysis.weakTopicsDetected) {
        const incoming = analysis.weakTopicsDetected.split(',').map(t => t.trim()).filter(Boolean);
        incoming.forEach(topic => {
            if (!session.profile.weakTopics.includes(topic)) {
                session.profile.weakTopics.push(topic);
            }
        });
        if (session.profile.weakTopics.length > 15) {
            session.profile.weakTopics = session.profile.weakTopics.slice(-15);
        }
    }

    if (analysis.masteredTopicsDetected) {
        const mastered = analysis.masteredTopicsDetected.split(',').map(t => t.trim()).filter(Boolean);
        mastered.forEach(topic => {
            if (!session.profile.masteredTopics.includes(topic)) {
                session.profile.masteredTopics.push(topic);
            }
            session.profile.weakTopics = session.profile.weakTopics.filter(w => w !== topic);
        });
    }
}

// ─── MAIN FUNCTION ────────────────────────────────────────────────────────────
async function generateGoResponse(message, history, userProfile) {    try {
        console.log("🔵 [GO PLAN] Processing via gpt-4o-mini — Full Feature Mode...");

        const userId   = userProfile?.userId || 'default';
        const userName = userProfile?.name   || null;
        const apiKey   = process.env.OPENAI_API_KEY;

        // 1. CHECK API KEY
        if (!apiKey) {
            throw new Error("Missing OPENAI_API_KEY in environment variables");
        }

        let session = getSession(userId);

        // 2. ANALYZE PROFILE
        const analysis = await analyzeMessageWithAI(message, history, session.profile, apiKey);

        if (analysis) {
            if (analysis.isNewTopic && session.topicSignature) {
                const savedMemory = {
                    weakTopics: session.profile.weakTopics,
                    masteredTopics: session.profile.masteredTopics,
                    detectedLanguage: session.profile.detectedLanguage,
                    culturalContext: session.profile.culturalContext,
                    gradeLevel: session.profile.gradeLevel,
                };
                session = resetSession(userId);
                Object.assign(session.profile, savedMemory);
                session.topicSignature = message.slice(0, 60);
            }

            const p = session.profile;
            if (analysis.detectedLanguage)                                          p.detectedLanguage      = analysis.detectedLanguage;
            if (analysis.culturalContext)                                           p.culturalContext       = analysis.culturalContext;
            if (analysis.gradeLevel      && analysis.gradeLevel      !== 'unknown') p.gradeLevel            = analysis.gradeLevel;
            if (analysis.subjects        && analysis.subjects        !== 'unknown') p.subjects              = analysis.subjects;
            if (analysis.examDates)                                                 p.examDates             = analysis.examDates;
            if (analysis.examDuration)                                              p.examDuration          = analysis.examDuration;
            if (analysis.confusionArea)                                             p.confusionArea         = analysis.confusionArea;
            if (analysis.studyStyle      && analysis.studyStyle      !== 'unknown') p.studyStyle            = analysis.studyStyle;
            if (analysis.emotionalState  && analysis.emotionalState  !== 'unknown') p.emotionalState        = analysis.emotionalState;
            if (analysis.careerInterest  && analysis.careerInterest  !== 'unknown') p.careerInterest        = analysis.careerInterest;
            if (analysis.studentIntent   && analysis.studentIntent   !== 'general') p.studentIntent         = analysis.studentIntent;

            updateSmartMemory(session, analysis);
        }

        if (!session.topicSignature) {
            session.topicSignature = message.slice(0, 60);
        }
        const limitedHistory = history.slice(-14);
        
        // 3. BUILD SYSTEM PROMPT WITH CORRECTION INSTRUCTION
        const systemPrompt = buildGoSystemPrompt({ userName, session });
        
        // Add specific instruction for honest, minimal correction
        const correctionInstruction = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INPUT CORRECTION PROTOCOL (HONEST & MINIMAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before answering the student's question, check their input for grammar, spelling, or clarity errors in THEIR DETECTED LANGUAGE.
- IF there is a clear mistake: Start your response with a gentle, polite correction note in the student's language. Format: "💡 Small tip: [Corrected version]. Now, [Answer]..."
- IF the input is perfect: DO NOT add any correction note. Just answer normally.
- Be honest but kind. Only correct if it helps them learn or understand better.
`;

        const finalSystemPrompt = systemPrompt + "\n\n" + correctionInstruction;

        // 4. CALL OPENAI
        const openAiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { role: 'system', content: finalSystemPrompt },
                ...limitedHistory,
                { role: 'user', content: message }
            ],
            max_tokens: 700,
            temperature: 0.65,
            presence_penalty: 0.1,
            frequency_penalty: 0.1
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        // 5. VALIDATE RESPONSE STRUCTURE
        if (!openAiResponse.data || !openAiResponse.data.choices || !openAiResponse.data.choices[0]) {
            console.error("❌ [GO PLAN] Invalid OpenAI Response Structure:", openAiResponse.data);
            throw new Error("Invalid response structure from OpenAI");
        }

        const aiReply = openAiResponse.data.choices[0].message.content;

        // 6. VALIDATE CONTENT
        if (!aiReply || aiReply.trim() === "") {
            console.error("❌ [GO PLAN] Empty content in OpenAI response");            throw new Error("Empty content from OpenAI");
        }

        // 7. UPDATE SESSION STATE
        if (isAnswerDelivered(aiReply)) {
            session.phase = 'complete';
            if (session.profile.studentIntent === 'exam-mode') {
                session.revisionPlanGenerated = true;
            }
            if (session.profile.studentIntent === 'practice') {
                session.practiceRound += 1;
            }
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
            updatedHistory: newHistory.slice(-32),
            updatedProfile: session.profile,
            mode: session.profile.studentIntent
        };

    } catch (error) {
        console.error("❌ [GO PLAN] Critical Error:", error.message);
        
        // RETURN A SAFE FALLBACK OBJECT INSTEAD OF UNDEFINED
        return {
            reply: "⚠️ I'm having trouble connecting to my brain right now. Please check your internet or try again in a moment.",
            updatedHistory: history,
            updatedProfile: {},
            mode: 'error'
        };
    }
}

// ─── GO PLAN SYSTEM PROMPT ────────────────────────────────────────────────────
function buildGoSystemPrompt({ userName, session }) {
    const { profile, phase, questionCount, maxQuestions, collectedAnswers, revisionPlanGenerated, practiceRound } = session;
    const nameTag = userName ? `Student's name: ${userName}.` : '';
    const langTag = profile.detectedLanguage
        ? `Detected language: ${profile.detectedLanguage}. Cultural context: ${profile.culturalContext || 'unknown'}.`
        : '';

    const profileSummary  = buildStudentProfileSummary(profile, collectedAnswers);
    const intentBlock     = buildIntentInstructions(profile.studentIntent, profile, revisionPlanGenerated, practiceRound);
    const phaseBlock      = buildPhaseInstructions(phase, questionCount, maxQuestions, profile);
    const memoryBlock     = buildMemoryBlock(profile);

    return `You are Skyline AA-1 — a premium AI study coach and academic partner for GO Plan members.
You are the best tutor this student has ever had: precise, structured, culturally fluent, deeply encouraging.
Your single mission: give GO Plan students the full, complete, expert-level support they paid for.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LANGUAGE & CULTURAL MASTERY (NON-NEGOTIABLE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${langTag}

RULE 1 — ALWAYS respond in the EXACT language the student wrote in. No exceptions.
RULE 2 — Do not translate. Speak natively in their language with full fluency.
RULE 3 — Adapt explanations to their cultural and educational context:

  🌍 West African (Yoruba, Igbo, Hausa, Pidgin, Twi):
     → Use local examples and familiar everyday comparisons.
     → Acknowledge school pressure from family and community. Be warm and practical.

  🌙 Arabic / Middle Eastern / North African:
     → Respectful and relational. Connect knowledge to purpose and future.
     → Structured, clear breakdowns — precision is deeply valued here.

  🌏 South / Southeast Asian (Hindi, Urdu, Bengali, Tagalog, Bahasa):
     → Acknowledge competitive exam culture and family expectations.
     → Step-by-step is deeply valued. Frame effort as personal and family achievement.

  🌐 Latin American (Spanish, Portuguese):
     → Warm, expressive tone. Use relatable everyday analogies.
     → Connect learning to practical life outcomes.

  🇪🇺 European (French, German, Italian, Dutch, Polish, etc.):
     → French: logical and elegant breakdowns.
     → German/Dutch: precise, structured, no fluff.
     → Italian/Spanish: expressive and contextual.

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
SMART MEMORY — WHAT THIS STUDENT STRUGGLES WITH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${memoryBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHAT THIS STUDENT NEEDS RIGHT NOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${intentBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE INSTRUCTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${phaseBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GO PLAN RESPONSE FORMATS (BY INTENT)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📖 EXPLAIN intent — "Advanced Step-by-Step Answer"
  🔍 [WHAT IT IS]
  Clear one-sentence definition in plain language.

  🧱 [STEP-BY-STEP BREAKDOWN]
  Full numbered steps — walk through the concept completely.
  Use a real-world analogy from their cultural context at step 1.

  📐 [WORKED EXAMPLE]
  One complete worked example (math: full working shown; essay: full paragraph structure shown; science: full explanation of process).
  Write it like a model answer sheet.

  🔑 [KEY FACTS TO MEMORISE]
  3–5 bullet points. The exact things an examiner wants to see.

  ✅ [HOW THIS APPEARS IN EXAMS]
  One paragraph: typical exam question style, key words to include, common mistakes to avoid.

📅 EXAM MODE intent — "Full Revision Plan"
  📌 [YOUR EXAM SITUATION]
  Confirm subjects, exam date, and total days available.

  🗓️ [COMPLETE REVISION TIMETABLE]  Full day-by-day plan (up to 30 days if needed).
  Format per day:
    Day 1 — [Subject]: [Specific topic] — [Duration] | Focus: [Weak area from memory]
  Prioritise weak topics (from Smart Memory) in the first half of the plan.
  Include rest days and review days.

  📚 [SUBJECT-BY-SUBJECT BREAKDOWN]
  For each subject: key topics to cover, recommended order, time allocation.

  ⚡ [DAILY STUDY SYSTEM]
  Specific technique for each subject (e.g. flashcards for vocab, past papers for math).

  🔥 [WEEK 1 FOCUS]
  The first 7 days in full detail — exact topics, exact hours.

📝 ASSIGNMENT intent — "Perfect Answer Sheet Guide"
  🎯 [WHAT THE QUESTION IS REALLY ASKING]
  Break the assignment question into its component parts. Plain language.

  📋 [PERFECT ANSWER STRUCTURE]
  Show the complete answer format — headings, sections, word count per section.
  Write it like an examiner's mark scheme.

  🪜 [STEP-BY-STEP GUIDE TO WRITE IT]
  Numbered steps: how to research, how to structure, how to write each section.

  💬 [EXAMPLE OPENING PARAGRAPH]
  A model opening they can use as a template and adapt. Do NOT write the full answer — give the structure + one complete example paragraph only.

  ✅ [EXAMINER TIPS]
  What earns top marks in this type of assignment. Common mistakes to avoid.

😵 CONFUSION intent — "Confusion Fixer"
  🤝 [I HEAR YOU]
  One sentence validating exactly what they said they're feeling.

  🔍 [THE REAL PROBLEM]
  Name the actual root cause of their confusion clearly.

  🪜 [YOUR NEXT 5 STEPS]
  Five small, very doable actions from zero — specific to their subject and level.

  📅 [3-DAY RECOVERY PLAN]
  Day 1, Day 2, Day 3 — exact topics + hours to get back on track.

  🔥 [ONE THING TO HOLD ONTO]
  One motivating sentence in their language — grounded in their world.

🎓 CAREER ROADMAP intent — "Full Career Roadmap"
  🌍 [WHERE YOU STAND]  One honest sentence about their current stage, subjects, and interests.

  🎯 [CAREER PATHS THAT FIT YOU]
  3–5 full career paths aligned with their subjects and interests.
  Per path: what it is | why it fits them | earning potential | entry requirements.

  📚 [SKILL LEARNING PLAN]
  For their top career: step-by-step from now to career-ready.
  Format: Stage 1 (now) → Stage 2 (6 months) → Stage 3 (1–2 years) → Stage 4 (career entry).
  Specific subjects, skills, certifications, or experience at each stage.

  ⚡ [THE MOVE MOST STUDENTS MISS]
  One non-obvious insight for someone at their exact stage and background.

  🔗 [FIRST ACTION THIS WEEK]
  One concrete action they can take before the weekend.

🧪 PRACTICE QUESTIONS intent — "Mock Exam Generator"
  📝 [PRACTICE ROUND ${session.practiceRound + 1}]
  Generate 7 questions on the topic:
    - 2 easy (recall / definition level)
    - 3 medium (application / explanation level)
    - 2 hard (analysis / exam-style extended answer)

  Format per question:
    Q[N] — [Question text]
    Difficulty: [Easy/Medium/Hard] | Type: [Multiple choice / Short answer / Extended]

  ━━━ ANSWERS & EXPLANATIONS ━━━
  A[N] — [Full answer]
  💡 Why: [One-sentence explanation of the concept being tested]
  ⚠️ Common mistake: [What students usually get wrong on this question]

  🎯 [YOUR WEAK AREAS TO FOCUS ON]
  Based on Smart Memory — highlight which topics from this quiz the student has struggled with before.

📅 STUDY-PLAN intent — "Daily Study Plan"
  📌 [YOUR SITUATION]
  One line: subjects + time available + any known exam dates.

  🗓️ [YOUR PERSONALISED STUDY PLAN]
  Weekly plan with daily breakdown.
  Day → Subject → Topic → Hours → Technique.
  Weak topics (from memory) get double the time in Week 1.

  ⚡ [STUDY TECHNIQUE PER SUBJECT]
  Specific, non-generic method for each subject based on their study style.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GO PLAN TEACHING LAWS (NEVER BREAK)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. GO Plan = full answers. No withholding. No "try it yourself first" on explain/practice intents.
2. Assignment intent ONLY: guide the structure, show one example paragraph — do not write the full assignment.
3. ALWAYS reference Smart Memory: if weak topics exist, address them proactively without being asked.
4. ALWAYS use a real-world analogy for every concept explained.
5. Reference their actual subjects, words, and situation in every response.
6. Match emotional state:
   - Stressed → calm, structured, very clear first steps
   - Motivated → high energy, push them fast, set ambitious targets
   - Lost → validate, diagnose the real block, 3-day recovery plan
   - Frustrated → acknowledge, quick win first, then full plan
7. Match grade level:
   - Primary → ultra-simple, short sentences
   - Secondary → clear, structured, relatable
   - University → precise, conceptual, intellectually sharp
8. Translate ALL headers into the student's language — every response.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANTI-GENERIC FILTER (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"Could this response have been given to any other student anywhere?"
If YES — rewrite until it could ONLY apply to this student.

Banned phrases in ANY language:
- "Study hard" | "Believe in yourself" | "You can do it"
- "Break it into small steps" | "Make a schedule" | "Stay consistent"

Replace every cliché with something subject-specific, culturally grounded, and immediately actionable.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GO PLAN CONSTRAINTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- No daily question limits — GO Plan is unlimited.
- No cooldowns. Respond to every message immediately.
- Intake: max 2 questions before full answer (free = 3).
- Responses: up to 700 tokens — use every word purposefully.
- Never mention model names, token limits, or technical details.
- Never break character as a premium, caring, expert academic coach.`;
}

// ─── STUDENT PROFILE SUMMARY ──────────────────────────────────────────────────
function buildStudentProfileSummary(profile, collectedAnswers) {
    const lines = [];

    if (profile.detectedLanguage)  lines.push(`Language: ${profile.detectedLanguage}`);
    if (profile.culturalContext)   lines.push(`Cultural Context: ${profile.culturalContext}`);
    if (profile.gradeLevel)        lines.push(`Grade Level: ${profile.gradeLevel}`);
    if (profile.subjects)          lines.push(`Subjects: ${profile.subjects}`);
    if (profile.examDates)         lines.push(`Exam/Deadline: ${profile.examDates}`);
    if (profile.examDuration)      lines.push(`Revision Days Available: ${profile.examDuration}`);    if (profile.confusionArea)     lines.push(`Confusion Area: ${profile.confusionArea}`);
    if (profile.studyStyle)        lines.push(`Study Style: ${profile.studyStyle}`);
    if (profile.emotionalState)    lines.push(`Emotional State: ${profile.emotionalState}`);
    if (profile.careerInterest)    lines.push(`Career Interest: ${profile.careerInterest}`);
    if (profile.studentIntent)     lines.push(`Current Intent: ${profile.studentIntent}`);

    if (collectedAnswers.length > 0) {
        lines.push(`\nIntake Answers:`);
        collectedAnswers.forEach(a => lines.push(`  Q${a.q}: "${a.answer}"`));
    }

    return lines.length > 0
        ? lines.join('\n')
        : 'Profile still being built — intake phase active.';
}

// ─── SMART MEMORY BLOCK ───────────────────────────────────────────────────────
function buildMemoryBlock(profile) {
    const lines = [];

    if (profile.weakTopics && profile.weakTopics.length > 0) {
        lines.push(`⚠️  Weak Topics (prioritise these): ${profile.weakTopics.join(', ')}`);
    } else {
        lines.push(`⚠️  Weak Topics: None detected yet — build as conversation continues.`);
    }

    if (profile.masteredTopics && profile.masteredTopics.length > 0) {
        lines.push(`✅ Mastered Topics (skip or review briefly): ${profile.masteredTopics.join(', ')}`);
    }

    lines.push(`\nINSTRUCTION: Automatically weave weak topics into study plans, revision timetables, and practice questions WITHOUT being asked. The student doesn't need to ask — you already know.`);

    return lines.join('\n');
}

// ─── INTENT INSTRUCTIONS ──────────────────────────────────────────────────────
function buildIntentInstructions(intent, profile, revisionPlanGenerated, practiceRound) {
    const subject = profile.subjects || 'their subject';
    const days    = profile.examDuration || '14';
    const career  = profile.careerInterest || 'unknown field';
    const weak    = profile.weakTopics?.join(', ') || 'not yet identified';

    switch (intent) {
        case 'explain':
            return `The student wants a full, structured explanation — not just a hint.
Deliver a complete step-by-step breakdown with a worked example.
Write it like a model answer sheet. Focus on: ${subject}.
Weak areas to weave in: ${weak}.`;

        case 'exam-mode':            return `The student has an upcoming exam and needs a full revision plan.
Generate a complete ${days}-day timetable with subject-by-subject breakdown.
Prioritise weak topics (${weak}) in the first half of the plan.
${revisionPlanGenerated ? 'A plan was already given — now give detailed Day 1–7 content or answer follow-up questions about the plan.' : 'This is the first plan — make it complete and immediately usable.'}`;

        case 'study-plan':
            return `The student needs a personalised weekly study plan for: ${subject}.
Use their study style (${profile.studyStyle || 'unknown'}) and prioritise weak topics: ${weak}.
Give specific daily breakdown with hours and techniques — not a vague schedule.`;

        case 'assignment':
            return `The student needs assignment guidance — GO Plan gives structured help + one model example paragraph.
Show the complete answer structure and write one example opening paragraph they can adapt.
Do NOT write the full assignment — give structure + one complete example only.`;

        case 'confusion':
            return `The student is overwhelmed. 
Validate their feeling first, diagnose the real cause, then give a 5-step recovery plan + 3-day study schedule to get back on track.
Weak topics from memory: ${weak} — address these specifically in the recovery plan.`;

        case 'career':
            return `The student needs a full career roadmap.
Their interest: ${career}. Grade level: ${profile.gradeLevel || 'unknown'}.
Give 3–5 career paths with full detail + a step-by-step skill learning plan from now to career-ready.`;

        case 'practice':
            return `Generate a full mock exam set (7 questions) on: ${subject}.
Round ${practiceRound + 1} — vary the questions from any previous round.
Include full answers + explanations + common mistakes.
Weight the harder questions toward known weak topics: ${weak}.`;

        default:
            return `Detect what the student truly needs from context.
Respond as the most thorough, expert academic coach they have ever had.
Reference smart memory weak topics (${weak}) where relevant.`;
    }
}

// ─── PHASE INSTRUCTIONS ───────────────────────────────────────────────────────
function buildPhaseInstructions(phase, questionCount, maxQuestions, profile) {
    const lang = profile.detectedLanguage || "the student's language";

    if (phase === 'intake') {
        const remaining = maxQuestions - questionCount;
        return `CURRENT PHASE: INTAKE (Question ${questionCount + 1} of max ${maxQuestions})
GO Plan intake is faster — max 2 questions before full response.
${remaining} question(s) remaining.

Ask ONE focused question in ${lang}:
${questionCount === 0 ? '→ Q1: What subject/topic do they need help with, and what specifically is the challenge?' : ''}${questionCount === 1 ? '→ Q2: Do they have an exam/deadline coming up, and what is their biggest weak area right now?' : ''}

Rules:
- ONE question only — never two at once.
- Show you already understand their situation.
- If you already have sufficient context from the message, skip intake entirely with:
  "Got it — here's exactly what you need:" — in ${lang}.
- GO Plan: if intent is clear from message alone, skip to full answer immediately.`;
    }

    if (phase === 'respond' || phase === 'complete') {
        return `CURRENT PHASE: FULL RESPONSE
You have full context. Deliver the complete, premium GO Plan answer in ${lang}.
Use the correct intent format above. Translate ALL section headers into ${lang}.
GO Plan = no limits, no hints-only — give the full structured response.`;
    }

    return '';
}

// ─── ANSWER DELIVERY DETECTOR ─────────────────────────────────────────────────
function isAnswerDelivered(reply) {
    const sectionEmojis = ['🔍', '🧱', '📐', '🔑', '✅', '🗓️', '📅', '🪜', '🎯',
                           '🤝', '🌍', '📚', '📌', '⚡', '💬', '🔥', '😵', '📝', '🎓', '🔗'];
    const count = sectionEmojis.filter(e => reply.includes(e)).length;
    return count >= 2;
}

module.exports = { generateGoResponse };
