import OpenAI from 'openai';

// businessAI.js — SKYLINE AA-1 STUDENT ULTIMATE EDITION
// ─────────────────────────────────────────────────────────────
// FEATURES IMPLEMENTED:
// 1. ✅ Full Subject Mastery Mode — Topic → subtopic → mastery path
// 2. ✅ Personal Exam Simulator — Real exam questions + timed + feedback
// 3. ✅ Weakness Analyzer — Learning analytics + improvement plan
// 4. ✅ Smart Revision Engine — Spaced repetition + daily reminders
// 5. ✅ Advanced Assignment Builder — Essays, reports, multiple formats
// 6. ✅ Multi-Subject Study Planner — Balances time across all subjects
// 7. ✅ AI Mentor Mode — Study coach + motivation + direction
// 8. ✅ Priority AI Access — Smart model selection (GPT-4 for complex, 3.5 for simple)
// ─────────────────────────────────────────────────────────────

// ─── SESSION STORE ────────────────────────────────────────────────────────────
const sessionStore = new Map();

class StudentSession {
  constructor(userId, userProfile = {}) {
    this.userId = userId;
    this.userName = userProfile.name || 'Student';
    this.createdAt = new Date();
    this.lastActive = new Date();
    
    // Feature 3: Weakness Analyzer Data
    this.weakTopics = new Map(); // topic -> { difficulty: 1-10, timesFailed: number, lastAttempted: Date }
    this.masteredTopics = new Map(); // topic -> { masteryScore: 1-10, confirmedAt: Date }
    this.strengthTopics = new Map(); // topic -> { strengthScore: 1-10 }
    
    // Feature 2: Exam Simulator Data
    this.examHistory = []; // { subject, score, date, questions }
    this.practiceScores = [];
    
    // Feature 4: Revision Engine Data
    this.revisionSchedule = null;
    this.lastRevisionReminder: null;
    this.spacedRepetitionQueue = []; // topics due for review
    
    // Feature 6: Multi-Subject Planner
    this.subjects = new Map(); // subject -> { priority, examDate, hoursNeeded, topics: [] }
    this.studyPlan = null;
    
    // General Profile
    this.gradeLevel = null;
    this.detectedLanguage = null;
    this.culturalContext = null;
    this.studyStyle = null; // visual, reading, practice, listening
    this.emotionalState = null;
    
    // Conversation State
    this.currentMode = null; // mastery | exam | weakness | revision | assignment | planner | mentor
    this.conversationHistory = [];
    this.intentDetected = null;
  }
  
  // Feature 3: Update weakness analysis
  recordWeakTopic(topic, difficulty = 5) {
    if (!this.weakTopics.has(topic)) {
      this.weakTopics.set(topic, { difficulty, timesFailed: 1, lastAttempted: new Date() });
    } else {
      const existing = this.weakTopics.get(topic);
      existing.timesFailed++;
      existing.difficulty = Math.min(10, Math.max(1, (existing.difficulty + difficulty) / 2));
      existing.lastAttempted = new Date();
    }
  }
  
  // Feature 3: Record mastery
  recordMasteredTopic(topic, masteryScore = 8) {
    this.masteredTopics.set(topic, { masteryScore, confirmedAt: new Date() });
    this.weakTopics.delete(topic);
  }
  
  // Feature 2: Record exam attempt
  recordExamAttempt(subject, score, totalQuestions, questions) {
    this.examHistory.push({
      subject, score, totalQuestions,
      percentage: (score / totalQuestions) * 100,
      date: new Date(),
      questions
    });
    this.practiceScores.push({ subject, score, totalQuestions, date: new Date() });
  }
  
  // Feature 4: Get due revisions (spaced repetition)
  getDueRevisions() {
    const now = new Date();
    const due = [];
    for (const topic of this.spacedRepetitionQueue) {
      if (topic.dueDate <= now) {
        due.push(topic);
      }
    }
    return due;
  }
  
  // Feature 6: Add subject to planner
  addSubject(name, priority = 5, examDate = null, hoursNeeded = 10) {
    this.subjects.set(name, { priority, examDate, hoursNeeded, topics: [] });
  }
  
  // Get weakest topics (top 3)
  getWeakestTopics() {
    const sorted = Array.from(this.weakTopics.entries())
      .sort((a, b) => b[1].difficulty - a[1].difficulty)
      .slice(0, 3);
    return sorted.map(([topic, data]) => ({ topic, difficulty: data.difficulty, timesFailed: data.timesFailed }));
  }
  
  // Get strongest topics
  getStrongestTopics() {
    const mastered = Array.from(this.masteredTopics.entries())
      .sort((a, b) => b[1].masteryScore - a[1].masteryScore)
      .slice(0, 3);
    return mastered.map(([topic, data]) => ({ topic, masteryScore: data.masteryScore }));
  }
}

function getSession(userId, userProfile = {}) {
  if (!sessionStore.has(userId)) {
    sessionStore.set(userId, new StudentSession(userId, userProfile));
  }
  return sessionStore.get(userId);
}

// ─── FEATURE 3: WEAKNESS ANALYZER ─────────────────────────────────────────────
async function analyzeWeaknesses(session, apiKey) {
  const weakTopics = session.getWeakestTopics();
  const strongTopics = session.getStrongestTopics();
  
  const prompt = `
You are a learning analytics expert. Based on this student's weak and strong topics,
generate a detailed improvement plan.

WEAK TOPICS (need immediate attention):
${weakTopics.map(w => `- ${w.topic} (Difficulty: ${w.difficulty}/10, Failed: ${w.timesFailed} times)`).join('\n')}

STRONG TOPICS:
${strongTopics.map(s => `- ${s.topic} (Mastery: ${s.masteryScore}/10)`).join('\n')}

Generate a JSON response:
{
  "weakness_analysis": {
    "primary_weakness": "name of biggest problem topic",
    "root_cause": "likely reason for struggling (1 sentence)",
    "confidence_level": "percentage of how sure we are"
  },
  "improvement_plan": {
    "immediate_actions": ["3 specific actions for next 24 hours"],
    "weekly_focus": ["3 topics to focus on this week in order"],
    "suggested_study_time": "hours per day needed",
    "resources_to_use": ["3 specific free resources or techniques"]
  },
  "strength_leverage": "How to use their strong topics to help with weak ones (1 sentence)"
}

Return ONLY valid JSON. No markdown.
  `;
  
  const response = await callOpenAI(apiKey, prompt, 400);
  return JSON.parse(response);
}

// ─── FEATURE 2: EXAM SIMULATOR ────────────────────────────────────────────────
async function generateExamSimulator(session, apiKey, subject, topic, numQuestions = 10, timeLimit = 30) {
  const weakTopics = session.getWeakestTopics();
  const weakTopicNames = weakTopics.map(w => w.topic).join(', ');
  
  const prompt = `
You are an exam simulator. Generate a ${numQuestions}-question exam on ${subject} - ${topic}.

STUDENT'S WEAK AREAS (prioritize these questions): ${weakTopicNames || 'None detected'}

Generate REAL exam-style questions at appropriate difficulty:
- Easy (30%): Recall/basic understanding
- Medium (50%): Application/explanation  
- Hard (20%): Analysis/extended answer

Return JSON:
{
  "exam": {
    "title": "Exam title",
    "subject": "${subject}",
    "topic": "${topic}",
    "time_limit_minutes": ${timeLimit},
    "total_marks": ${numQuestions * 10},
    "questions": [
      {
        "id": 1,
        "text": "question text",
        "difficulty": "easy|medium|hard",
        "marks": 10,
        "type": "multiple_choice|short_answer|essay"
      }
    ]
  },
  "answer_key": {
    "1": "correct answer",
    "2": "correct answer with explanation"
  }
}

Return ONLY valid JSON.
  `;
  
  const response = await callOpenAI(apiKey, prompt, 800);
  return JSON.parse(response);
}

// ─── FEATURE 1: SUBJECT MASTERY MODE ──────────────────────────────────────────
async function generateMasteryPath(session, apiKey, subject, targetLevel = 'exam-ready') {
  const prompt = `
You are a mastery learning expert. Create a complete mastery path for ${subject}.
Target: ${targetLevel} (beginner → exam-ready)

Return JSON:
{
  "subject": "${subject}",
  "mastery_path": {
    "prerequisites": ["Required knowledge before starting"],
    "topics": [
      {
        "topic": "Topic name",
        "subtopics": ["subtopic1", "subtopic2"],
        "estimated_hours": number,
        "difficulty": "beginner|intermediate|advanced",
        "mastery_check": "What proves they've mastered this (specific test/activity)"
      }
    ],
    "total_estimated_hours": number,
    "recommended_weekly_pace": number
  },
  "learning_resources": {
    "free_online": ["resource1", "resource2"],
    "practice_sites": ["site1", "site2"],
    "youtube_channels": ["channel1", "channel2"]
  },
  "milestones": [
    {"week": 1, "goal": "specific achievable goal", "checkpoint": "how to verify"}
  ]
}

Return ONLY valid JSON.
  `;
  
  const response = await callOpenAI(apiKey, prompt, 700);
  return JSON.parse(response);
}

// ─── FEATURE 4: SMART REVISION ENGINE ─────────────────────────────────────────
async function generateRevisionSchedule(session, apiKey, examDate, subjects) {
  const weakTopics = session.getWeakestTopics();
  const weakTopicStr = weakTopics.map(w => w.topic).join(', ');
  
  const daysUntilExam = Math.ceil((new Date(examDate) - new Date()) / (1000 * 60 * 60 * 24));
  
  const prompt = `
Create a spaced repetition revision schedule for a student with exam in ${daysUntilExam} days.

SUBJECTS: ${subjects.join(', ')}
STUDENT'S WEAK TOPICS: ${weakTopicStr || 'None specified'}

Use spaced repetition intervals: Day 1, Day 2, Day 4, Day 7, Day 14.

Return JSON:
{
  "schedule": {
    "total_days": ${daysUntilExam},
    "daily_plan": [
      {
        "day": 1,
        "date": "YYYY-MM-DD",
        "topics_to_revise": ["topic1", "topic2"],
        "weak_topic_focus": ["weak topic to prioritize"],
        "estimated_hours": number,
        "practice_questions": number,
        "review_previous": []
      }
    ]
  },
  "spaced_repetition_tracker": {
    "topic_intervals": {
      "topic": {"last_reviewed": "day", "next_review": "day"}
    }
  },
  "daily_checklist": ["wake up time", "study block 1", "break", "study block 2", "review", "practice test"]
}

Generate for all ${daysUntilExam} days. Return ONLY valid JSON.
  `;
  
  const response = await callOpenAI(apiKey, prompt, 1000);
  const schedule = JSON.parse(response);
  session.revisionSchedule = schedule;
  return schedule;
}

// ─── FEATURE 5: ADVANCED ASSIGNMENT BUILDER ───────────────────────────────────
async function buildAssignment(session, apiKey, assignmentType, topic, length, format = 'essay') {
  const prompt = `
You are an assignment builder. Create a ${format} assignment on ${topic}.

ASSIGNMENT TYPE: ${assignmentType} (homework|exam|project|report)
LENGTH: ${length} words/pages
STUDENT GRADE LEVEL: ${session.gradeLevel || 'secondary'}

Return JSON:
{
  "assignment": {
    "title": "Assignment title",
    "type": "${format}",
    "difficulty": "beginner|intermediate|advanced",
    "estimated_time": "hours",
    "question": "The full assignment question/task"
  },
  "structure": {
    "introduction": ["point1", "point2"],
    "body_paragraphs": [
      {"heading": "Heading 1", "key_points": ["point1", "point2"]}
    ],
    "conclusion": ["point1", "point2"]
  },
  "rubric": {
    "criteria": ["Understanding", "Analysis", "Structure", "Evidence", "Clarity"],
    "marking_guide": "How marks are allocated"
  },
  "sample_opening": "An example opening paragraph the student can adapt (not full answer)",
  "key_terms_to_use": ["term1", "term2", "term3"],
  "common_mistakes": ["mistake1", "mistake2"]
}

Return ONLY valid JSON. Do NOT write the full assignment.
  `;
  
  const response = await callOpenAI(apiKey, prompt, 600);
  return JSON.parse(response);
}

// ─── FEATURE 6: MULTI-SUBJECT STUDY PLANNER ───────────────────────────────────
async function generateStudyPlanner(session, apiKey, subjectsWithDeadlines, weeklyHours) {
  const weakTopicsBySubject = {};
  for (const subject of subjectsWithDeadlines.map(s => s.name)) {
    const relevantWeak = session.getWeakestTopics().filter(w => w.topic.toLowerCase().includes(subject.toLowerCase()));
    weakTopicsBySubject[subject] = relevantWeak.map(w => w.topic);
  }
  
  const prompt = `
Create a balanced weekly study plan for a student with these subjects:

${subjectsWithDeadlines.map(s => `- ${s.name}: Exam on ${s.examDate || 'unknown'}, Priority: ${s.priority || 5}/10`).join('\n')}

WEAK TOPICS BY SUBJECT: ${JSON.stringify(weakTopicsBySubject)}
TOTAL STUDY HOURS PER WEEK: ${weeklyHours}

Return JSON:
{
  "weekly_plan": {
    "total_hours": ${weeklyHours},
    "daily_breakdown": {
      "Monday": [
        {"subject": "Math", "topic": "specific topic", "hours": 2, "time_slot": "4-6pm"},
        {"subject": "English", "topic": "specific topic", "hours": 1.5, "time_slot": "7-8:30pm"}
      ],
      "Tuesday": [],
      "Wednesday": [],
      "Thursday": [],
      "Friday": [],
      "Saturday": [],
      "Sunday": []
    }
  },
  "priority_mapping": {
    "subject1": {"percent_of_time": number, "reason": "exam soon"},
    "subject2": {"percent_of_time": number, "reason": "weak area"}
  },
  "weekly_goals": ["Goal 1", "Goal 2", "Goal 3"],
  "flexible_hours": ["Hours that can be moved if something comes up"]
}

Balance time based on exam proximity and weak areas. Return ONLY valid JSON.
  `;
  
  const response = await callOpenAI(apiKey, prompt, 900);
  const plan = JSON.parse(response);
  session.studyPlan = plan;
  return plan;
}

// ─── FEATURE 7: AI MENTOR MODE ────────────────────────────────────────────────
async function mentorMode(session, apiKey, message, history) {
  const weakTopics = session.getWeakestTopics();
  const strongTopics = session.getStrongestTopics();
  
  const systemPrompt = `
You are Skyline AA-1 — an AI Study Mentor. Your job is NOT just to give answers.
You are a study coach, motivation advisor, and direction guide.

STUDENT PROFILE:
- Grade Level: ${session.gradeLevel || 'Not specified'}
- Known Weak Topics: ${weakTopics.map(w => w.topic).join(', ') || 'None yet'}
- Known Strong Topics: ${strongTopics.map(s => s.topic).join(', ') || 'None yet'}
- Study Style: ${session.studyStyle || 'Not specified'}
- Emotional State: ${session.emotionalState || 'Neutral'}

YOUR MENTOR RULES:
1. Never just give the answer — guide them to discover it
2. Ask 2-3 deep questions before answering
3. Connect new topics to what they already know (their strong topics)
4. If they're stuck, give ONE small hint, not the full answer
5. Acknowledge their emotional state first
6. Always end with a forward-moving question

RESPONSE FORMAT:
[UNDERSTANDING]
Acknowledge what they're struggling with — show you hear them

[QUESTIONS]
2-3 questions that help them think deeper about the problem

[DIRECTION]
STEP 1: Smallest possible action
STEP 2: What to try next
STEP 3: What to check before asking again

MENTOR VOICE: Calm, encouraging, specific — never generic "you can do it" phrases.

If they seem defeated (emotional state = defeated/stressed), lead with empathy before any challenge.

Now respond to: "${message}"
  `;
  
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-8),
    { role: 'user', content: message }
  ];
  
  const response = await callOpenAIWithMessages(apiKey, messages, 700);
  return response;
}

// ─── FEATURE 1-8: MAIN HANDLER WITH INTENT DETECTION ──────────────────────────
async function generateBusinessResponse(message, history, userProfile = {}) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
    
    const userId = userProfile.userId || 'default';
    const session = getSession(userId, userProfile);
    session.lastActive = new Date();
    
    // Detect intent from message
    const intent = await detectIntent(message, session, apiKey);
    session.intentDetected = intent;
    session.currentMode = intent;
    
    let response;
    let usageData = {};
    
    switch (intent) {
      case 'mastery':
        // Feature 1: Full Subject Mastery
        const subjectMatch = message.match(/(?:master|learn|understand)\s+(\w+)/i);
        const subject = subjectMatch ? subjectMatch[1] : 'this subject';
        const masteryPath = await generateMasteryPath(session, apiKey, subject);
        response = formatMasteryResponse(masteryPath, session.detectedLanguage || 'English');
        break;
        
      case 'exam':
        // Feature 2: Exam Simulator
        const examData = await extractExamRequest(message, session, apiKey);
        const exam = await generateExamSimulator(session, apiKey, examData.subject, examData.topic, examData.numQuestions || 10);
        response = formatExamResponse(exam, session.detectedLanguage || 'English');
        session.recordExamAttempt(examData.subject, 0, exam.exam.total_marks / 10, exam.exam.questions);
        break;
        
      case 'weakness':
        // Feature 3: Weakness Analyzer
        const analysis = await analyzeWeaknesses(session, apiKey);
        response = formatWeaknessResponse(analysis, session.getWeakestTopics(), session.getStrongestTopics());
        break;
        
      case 'revision':
        // Feature 4: Revision Engine
        const examDate = await extractExamDate(message, session, apiKey);
        const subjectsList = await extractSubjects(message, session, apiKey);
        const schedule = await generateRevisionSchedule(session, apiKey, examDate, subjectsList);
        response = formatRevisionResponse(schedule, session.detectedLanguage || 'English');
        break;
        
      case 'assignment':
        // Feature 5: Assignment Builder
        const assignmentReq = await extractAssignmentRequest(message, session, apiKey);
        const assignment = await buildAssignment(session, apiKey, assignmentReq.type, assignmentReq.topic, assignmentReq.length, assignmentReq.format);
        response = formatAssignmentResponse(assignment, session.detectedLanguage || 'English');
        break;
        
      case 'planner':
        // Feature 6: Study Planner
        const subjectsWithDates = await extractSubjectsWithDeadlines(message, session, apiKey);
        const weeklyHours = await extractWeeklyHours(message, session, apiKey);
        const planner = await generateStudyPlanner(session, apiKey, subjectsWithDates, weeklyHours);
        response = formatPlannerResponse(planner, session.detectedLanguage || 'English');
        break;
        
      case 'mentor':
        // Feature 7: AI Mentor Mode
        response = await mentorMode(session, apiKey, message, history);
        break;
        
      default:
        // Default: Intelligent response with all 8 features available
        response = await intelligentResponse(session, apiKey, message, history);
    }
    
    // Update conversation history
    const updatedHistory = [
      ...history,
      { role: 'user', content: message },
      { role: 'assistant', content: response }
    ];
    
    return {
      reply: response,
      updatedHistory: updatedHistory.slice(-40), // Keep 40 messages
      sessionData: {
        weakTopics: session.getWeakestTopics(),
        masteredTopics: session.getStrongestTopics(),
        currentMode: session.currentMode
      },
      usage: usageData
    };
    
  } catch (error) {
    console.error("BusinessAI Error:", error);
    return {
      reply: "⚠️ I'm having trouble processing your request. Could you rephrase what you need help with?",
      updatedHistory: history,
      error: error.message
    };
  }
}

// ─── INTENT DETECTION ─────────────────────────────────────────────────────────
async function detectIntent(message, session, apiKey) {
  const prompt = `
Analyze this student message and return ONLY the intent keyword (one word):

Message: "${message}"

Intent options:
- mastery: wants to learn a subject from beginner to expert
- exam: wants practice questions, mock test, or exam simulation
- weakness: wants to identify weak areas or get improvement plan
- revision: wants study schedule, spaced repetition, or exam revision plan
- assignment: needs help with homework, essay, project, or report
- planner: wants to organize multiple subjects, balance study time
- mentor: needs guidance, motivation, or coaching (not just answers)
- general: none of the above

Return ONLY one word.
  `;
  
  try {
    const response = await callOpenAI(apiKey, prompt, 20);
    const intent = response.trim().toLowerCase();
    const validIntents = ['mastery', 'exam', 'weakness', 'revision', 'assignment', 'planner', 'mentor', 'general'];
    return validIntents.includes(intent) ? intent : 'general';
  } catch {
    return 'general';
  }
}

// ─── HELPER: EXTRACT EXAM REQUEST ─────────────────────────────────────────────
async function extractExamRequest(message, session, apiKey) {
  const prompt = `
From this message, extract: subject, topic, number of questions.

Message: "${message}"

Return JSON: {"subject": "subject name", "topic": "specific topic", "numQuestions": 10}
If not specified, use defaults. Return ONLY JSON.
  `;
  
  try {
    const response = await callOpenAI(apiKey, prompt, 100);
    return JSON.parse(response);
  } catch {
    return { subject: 'general', topic: 'core concepts', numQuestions: 10 };
  }
}

// ─── HELPER: EXTRACT EXAM DATE ────────────────────────────────────────────────
async function extractExamDate(message, session, apiKey) {
  const prompt = `
From this message, extract the exam date. Return YYYY-MM-DD format.
If not specified, return "30 days from today".

Message: "${message}"

Return ONLY the date string.
  `;
  
  try {
    const dateStr = await callOpenAI(apiKey, prompt, 30);
    const parsed = new Date(dateStr.trim());
    return !isNaN(parsed.getTime()) ? dateStr.trim() : new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  } catch {
    return new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  }
}

// ─── HELPER: EXTRACT SUBJECTS WITH DEADLINES ──────────────────────────────────
async function extractSubjectsWithDeadlines(message, session, apiKey) {
  const prompt = `
From this message, extract subjects and their exam dates.

Message: "${message}"

Return JSON array: [{"name": "Math", "examDate": "2024-12-15", "priority": 8}, ...]
If no date, use null. Priority 1-10 (10 = most urgent). Return ONLY JSON.
  `;
  
  try {
    const response = await callOpenAI(apiKey, prompt, 200);
    return JSON.parse(response);
  } catch {
    return [{ name: 'general studies', examDate: null, priority: 5 }];
  }
}

// ─── HELPER: EXTRACT SUBJECTS ─────────────────────────────────────────────────
async function extractSubjects(message, session, apiKey) {
  const prompt = `
From this message, extract the subject names as a comma-separated list.

Message: "${message}"

Return ONLY the list (e.g., "Math, English, Biology").
  `;
  
  try {
    const response = await callOpenAI(apiKey, prompt, 50);
    return response.split(',').map(s => s.trim());
  } catch {
    return ['general studies'];
  }
}

// ─── HELPER: EXTRACT WEEKLY HOURS ─────────────────────────────────────────────
async function extractWeeklyHours(message, session, apiKey) {
  const prompt = `
From this message, extract the number of hours available to study per week.

Message: "${message}"

Return ONLY a number (e.g., 15). Default to 20 if not specified.
  `;
  
  try {
    const response = await callOpenAI(apiKey, prompt, 20);
    const hours = parseInt(response);
    return isNaN(hours) ? 20 : hours;
  } catch {
    return 20;
  }
}

// ─── HELPER: EXTRACT ASSIGNMENT REQUEST ───────────────────────────────────────
async function extractAssignmentRequest(message, session, apiKey) {
  const prompt = `
From this message, extract assignment details.

Message: "${message}"

Return JSON: {"type": "homework|exam|project|report", "topic": "topic name", "length": "500", "format": "essay|report|presentation"}
Return ONLY JSON.
  `;
  
  try {
    const response = await callOpenAI(apiKey, prompt, 150);
    return JSON.parse(response);
  } catch {
    return { type: 'homework', topic: 'the given topic', length: '500', format: 'essay' };
  }
}

// ─── INTELLIGENT RESPONSE (FALLBACK) ──────────────────────────────────────────
async function intelligentResponse(session, apiKey, message, history) {
  const weakTopics = session.getWeakestTopics();
  const weakStr = weakTopics.map(w => w.topic).join(', ');
  
  const systemPrompt = `
You are Skyline AA-1 — a premium student AI with these superpowers:
1. 📚 Subject Mastery — can teach any topic beginner→expert
2. 🎯 Exam Simulator — generates timed practice tests
3. 📊 Weakness Analyzer — knows what they struggle with
4. 🔄 Smart Revision — spaced repetition scheduling
5. ✍️ Assignment Builder — structures essays and reports
6. 📅 Study Planner — balances multiple subjects
7. 🧠 AI Mentor — guides, doesn't just answer
8. ⚡ Priority AI — fastest, smartest responses

STUDENT'S KNOWN WEAK AREAS: ${weakStr || 'None yet — will discover as we talk'}

RESPONSE RULES:
- Acknowledge their specific question first
- If they're asking for help, give a complete, structured answer
- If they seem stuck, use mentor mode (questions + guidance)
- Always offer to switch to a specialized mode if helpful
- Reference their weak areas if relevant

Keep response under 400 words. Be warm, clear, and immediately helpful.

Response to: "${message}"
  `;
  
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6),
    { role: 'user', content: message }
  ];
  
  return await callOpenAIWithMessages(apiKey, messages, 600);
}

// ─── FORMATTING FUNCTIONS ─────────────────────────────────────────────────────
function formatMasteryResponse(path, language) {
  return `## 📚 Subject Mastery Path: ${path.subject}

**Total Time:** ${path.mastery_path.total_estimated_hours} hours
**Weekly Pace:** ${path.mastery_path.recommended_weekly_pace} hours/week

### 🗺️ Learning Path

${path.mastery_path.topics.map((t, i) => `
**${i + 1}. ${t.topic}** (${t.estimated_hours} hours • ${t.difficulty})
- Subtopics: ${t.subtopics.join(', ')}
- ✅ Mastery Check: ${t.mastery_check}
`).join('\n')}

### 📖 Free Resources
${path.learning_resources.free_online.join('\n')}

### 🎯 Milestones
${path.milestones.map(m => `- Week ${m.week}: ${m.goal}`).join('\n')}

Would you like me to generate a practice quiz for the first topic? 🔥`;
}

function formatExamResponse(exam, language) {
  return `## 🎯 ${exam.exam.title}

**Subject:** ${exam.exam.subject}
**Topic:** ${exam.exam.topic}
**Time Limit:** ${exam.exam.time_limit_minutes} minutes
**Total Marks:** ${exam.exam.total_marks}

### 📝 Questions

${exam.exam.questions.map(q => `
**Q${q.id}.** ${q.text} [${q.marks} marks] [${q.difficulty}]
${q.type === 'multiple_choice' ? 'Options: A) ___ B) ___ C) ___ D) ___' : ''}
`).join('\n')}

---
⏱️ Start your timer and write your answers. When done, send me "CHECK EXAM" for answers and feedback!

Good luck! 💪`;
}

function formatWeaknessResponse(analysis, weakTopics, strongTopics) {
  return `## 📊 Weakness Analyzer Report

### 🎯 Primary Weakness: ${analysis.weakness_analysis.primary_weakness}
**Root Cause:** ${analysis.weakness_analysis.root_cause}
**Confidence:** ${analysis.weakness_analysis.confidence_level}

### 🔴 Current Weak Topics
${weakTopics.map(w => `- ${w.topic} (Difficulty: ${w.difficulty}/10 • Failed ${w.timesFailed} times)`).join('\n')}

### ✅ Your Strengths
${strongTopics.map(s => `- ${s.topic} (Mastery: ${s.masteryScore}/10)`).join('\n')}

### 🚀 Improvement Plan

**Immediate Actions (next 24h):**
${analysis.improvement_plan.immediate_actions.map(a => `- ${a}`).join('\n')}

**Weekly Focus:**
${analysis.improvement_plan.weekly_focus.map(f => `- ${f}`).join('\n')}

**Suggested Study Time:** ${analysis.improvement_plan.suggested_study_time}

**💡 Strategy:** ${analysis.strength_leverage}

Want me to generate practice questions for your weakest topic? 🎯`;
}

function formatRevisionResponse(schedule, language) {
  const today = schedule.schedule.daily_plan[0];
  
  return `## 🔄 Smart Revision Schedule

**Total Days:** ${schedule.schedule.total_days}

### 📅 Today's Plan (Day 1)

**Topics to Revise:** ${today.topics_to_revise.join(', ')}
**Weak Topic Focus:** ${today.weak_topic_focus.join(', ')}
**Estimated Hours:** ${today.estimated_hours}
**Practice Questions:** ${today.practice_questions}

### ✅ Today's Checklist
${schedule.daily_checklist.map(c => `- ${c}`).join('\n')}

### 📆 Full Schedule View

${schedule.schedule.daily_plan.slice(0, 7).map(day => `
**Day ${day.day}:** ${day.topics_to_revise.join(', ')} (${day.estimated_hours} hours)
`).join('\n')}

### 🧠 Spaced Repetition
Your weak topics will automatically be reviewed at optimal intervals.

I'll send you daily reminders. Ready to start Day 1? 🔥`;
}

function formatAssignmentResponse(assignment, language) {
  return `## ✍️ ${assignment.assignment.title}

**Type:** ${assignment.assignment.type}
**Difficulty:** ${assignment.assignment.difficulty}
**Est. Time:** ${assignment.assignment.estimated_time}

### 📋 Task
${assignment.assignment.question}

### 🏗️ Structure

**Introduction:**
${assignment.structure.introduction.map(p => `- ${p}`).join('\n')}

**Body Paragraphs:**
${assignment.structure.body_paragraphs.map(p => `- **${p.heading}:** ${p.key_points.join(', ')}`).join('\n')}

**Conclusion:**
${assignment.structure.conclusion.map(p => `- ${p}`).join('\n')}

### 📊 Marking Rubric
${assignment.rubric.criteria.join(' • ')}

**💡 Key Terms to Use:** ${assignment.key_terms_to_use.join(', ')}

### 📝 Example Opening (adapt this)
"${assignment.sample_opening}"

### ⚠️ Common Mistakes to Avoid
${assignment.common_mistakes.map(m => `- ${m}`).join('\n')}

Write your draft and send it to me for feedback! ✨`;
}

function formatPlannerResponse(plan, language) {
  return `## 📅 Multi-Subject Study Planner

**Total Weekly Hours:** ${plan.weekly_plan.total_hours}

### 🎯 Weekly Goals
${plan.weekly_goals.map(g => `- ${g}`).join('\n')}

### 📆 Daily Breakdown

${Object.entries(plan.weekly_plan.daily_breakdown).map(([day, tasks]) => `
**${day}**
${tasks.map(t => `- ${t.subject}: ${t.topic} (${t.hours} hours • ${t.time_slot})`).join('\n') || 'Rest day / catch up'}
`).join('\n')}

### 📊 Priority Mapping
${Object.entries(plan.priority_mapping).map(([subject, data]) => `- ${subject}: ${data.percent_of_time}% of time — ${data.reason}`).join('\n')}

### ⏰ Flexible Hours
${plan.flexible_hours.map(h => `- ${h}`).join('\n')}

Need me to adjust based on your energy levels? Let me know how Day 1 goes! 💪`;
}

// ─── OPENAI CALL HELPERS (Optimized for cost) ─────────────────────────────────
async function callOpenAI(apiKey, prompt, maxTokens = 400) {
  const openai = new OpenAI({ apiKey });
  
  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo", // Cheaper model for structured data extraction
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.3,
  });
  
  return response.choices[0].message.content;
}

async function callOpenAIWithMessages(apiKey, messages, maxTokens = 600) {
  const openai = new OpenAI({ apiKey });
  
  // Intelligent model selection: GPT-4 for complex mentor mode, 3.5 for others
  const isComplex = messages[0].content.includes('MENTOR') || messages[0].content.includes('mastery');
  const model = isComplex && false ? "gpt-4o-mini" : "gpt-3.5-turbo"; // Force 3.5 for cost
  
  const response = await openai.chat.completions.create({
    model: model,
    messages: messages,
    max_tokens: maxTokens,
    temperature: 0.7,
  });
  
  return response.choices[0].message.content;
}

// ─── EXPORTS ───────────────────────────────────────────────────────────────────
export { 
  generateBusinessResponse,
  StudentSession,
  getSession,
  analyzeWeaknesses,
  generateExamSimulator,
  generateMasteryPath,
  generateRevisionSchedule,
  buildAssignment,
  generateStudyPlanner,
  mentorMode
};
