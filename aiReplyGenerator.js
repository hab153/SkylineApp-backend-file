// aiReplyGenerator.js
// ─────────────────────────────────────────────────────────────────────────────
// STATELESS AI autoreply engine — Production Upgraded v5.2
// FIXES:
//  v5.2 — NEW:
//   FIX L : FORCED INSTRUCTION FOLLOWING — AI MUST follow instructions 100%
//   FIX M : IMPROVED LANGUAGE DETECTION — English prioritized, Dutch false positive fixed
//   FIX N : OUT OF SCOPE SILENCE — If message is out of scope of instructions, AI stays quiet
// ─────────────────────────────────────────────────────────────────────────────
const axios  = require('axios');
const crypto = require('crypto');

// ─── CONFIGURATION ────────────────────────────────────────────────────────────
const CONFIG = {
    MODEL:                  process.env.AI_MODEL             || 'gpt-4o-mini',
    TEMPERATURE:            0.72,
    MAX_TOKENS:             700,
    API_URL:                'https://api.openai.com/v1/chat/completions',
    CONFIDENCE_THRESHOLD:   0.35,
    MAX_FOLLOWUPS:          parseInt(process.env.AI_MAX_FOLLOWUPS) || 10,
    HISTORY_LIMIT:          6,
    MAX_INSTRUCTIONS_CHARS: 8000,
    MAX_BUSINESS_CFG_CHARS: 4000,
    MAX_MESSAGE_CHARS:      2000,
    MAX_REASONING_CHARS:    300,
    MAX_REPLY_CHARS:        2000,
    RETRY_ATTEMPTS:         3,
    RETRY_BASE_DELAY_MS:    500,
};

// ─── INTENTS ──────────────────────────────────────────────────────────────────
const INTENTS = {
    FAQ:          'FAQ',
    QUALIFY:      'QUALIFY',
    SCHEDULE:     'SCHEDULE',
    INTERESTED:   'INTERESTED',
    OBJECTION:    'OBJECTION',
    ANGRY:        'ANGRY',
    OUT_OF_SCOPE: 'OUT_OF_SCOPE',
    UNKNOWN:      'UNKNOWN',
    FOLLOW_UP:    'FOLLOW_UP',
    BUYING:       'BUYING',
    NURTURE:      'NURTURE',
    COMPETITOR:   'COMPETITOR',
    ROI_QUESTION: 'ROI_QUESTION',
};

// ─── ACTIONS ──────────────────────────────────────────────────────────────────
const ACTIONS = {
    REPLY:    'REPLY',
    ESCALATE: 'ESCALATE',
    STOP:     'STOP',
    DRAFT:    'DRAFT',
    WAIT:     'WAIT',
};

// ─── AI MODES ─────────────────────────────────────────────────────────────────
const MODES = {
    SALES:      'sales',
    SUPPORT:    'support',
    BOOKING:    'booking',
    NURTURING:  'nurturing',
    ESCALATION: 'escalation',
    DRAFT:      'draft',
    SAFE:       'safe',
    FULL:       'full',
};

// ─── RISK LEVELS ──────────────────────────────────────────────────────────────
const RISK_LEVELS = {
    LOW:    'low',
    MEDIUM: 'medium',
    HIGH:   'high',
};

// ─── TONES ────────────────────────────────────────────────────────────────────
const TONES = {
    FORMAL:     'formal',
    CASUAL:     'casual',
    FRIENDLY:   'friendly',
    ASSERTIVE:  'assertive',
    EMPATHETIC: 'empathetic',
    CHALLENGER: 'challenger',
};

// ─── REPLY LENGTH ─────────────────────────────────────────────────────────────
const REPLY_LENGTH = {
    SHORT:    'short (1–3 sentences)',
    MEDIUM:   'medium (1–2 short paragraphs)',
    LONG:     'long (3+ paragraphs with detail)',
    AUTO:     'auto',
    MINIMAL:  'minimal (1 sentence + 1 question only)',
    DETAILED: 'detailed (full explanation with examples and clear next step)',
};

// ─── LEAD QUALITY TIERS ───────────────────────────────────────────────────────
const LEAD_QUALITY = {
    HOT:  'hot',
    WARM: 'warm',
    COLD: 'cold',
    DEAD: 'dead',
};

// ─── FIX G: CONVERSATION RHYTHM TYPES ────────────────────────────────────────
const RHYTHM_TYPES = {
    STATEMENT:   'statement',
    QUESTION:    'question',
    REASSURANCE: 'reassurance',
    INSIGHT:     'insight',
    CHALLENGE:   'challenge',
};

// ─── HARD-STOP TRIGGERS ───────────────────────────────────────────────────────
const LEGAL_TRIGGERS = [
    'lawsuit', 'lawyer', 'legal action', 'sue', 'attorney',
    'refund my money', 'chargeback', 'charge back',
    'this is fraud', 'scam',
];

const ANGRY_TRIGGERS = [
    'stop emailing', 'leave me alone', 'unsubscribe',
    'remove me', 'this is ridiculous', 'do not contact',
    'stop contacting', 'never email me',
];

const ABUSE_TRIGGERS = [
    'buy a list', 'blast everyone', 'send to all',
    'ignore gdpr', 'ignore can-spam', 'fake invoice',
];

// ─── SPAM PATTERNS ────────────────────────────────────────────────────────────
const SPAM_PATTERNS = [
    /click here now/i,
    /you have been selected/i,
    /guaranteed results/i,
    /act now/i,
    /limited time offer/i,
    /buy now/i,
    /100% free/i,
    /make money fast/i,
    /risk.?free/i,
    /no obligation/i,
];

// ─── FIX B (v4): RESPONSE VARIATION ENGINE ────────────────────────────────────
const OPENER_VARIATIONS = {
    friendly: [
        'Thanks for getting in touch —',
        'Good to hear from you.',
        'Appreciate you reaching out.',
        'Happy to jump in on this.',
        'Thanks for the message.',
        'Good timing on this one.',
        'Glad you brought this up.',
    ],
    formal: [
        'Thank you for your message.',
        'I appreciate you reaching out.',
        'Thank you for contacting us.',
        'I wanted to respond to your inquiry.',
        'Following up on your message —',
    ],
    casual: [
        'Hey — good to hear from you!',
        'Thanks for the note!',
        'Got your message —',
        'Hey, appreciate you reaching out.',
        'Good timing!',
    ],
    assertive: [
        'Let me be direct about this.',
        'Here is what matters here.',
        'Good question — here is the real answer.',
        'Let me cut to what actually matters.',
        'Here is the honest picture.',
        'Fair question — let me be straight with you.',
    ],
    empathetic: [
        'That is a valid concern.',
        'Makes sense that you would ask this.',
        'Totally understand where you are coming from.',
        'That is worth addressing properly.',
        'I get it — this matters.',
    ],
    challenger: [
        'Worth pushing back on that assumption slightly.',
        'That framing might actually be costing you.',
        'Before answering — quick question:',
        'Most teams ask that. Here is what they miss:',
        'Here is what the data actually shows:',
        'Let me reframe this slightly —',
    ],
};

const CLOSING_VARIATIONS = [
    'What does your current outreach setup look like?',
    'What would be most useful to explore first?',
    'Would a quick call this week make sense?',
    'What is the biggest bottleneck you are running into right now?',
    'What does your team size look like for outreach?',
    'How many leads are you currently working per month?',
    'What has not been working with your current approach?',
    'Is speed or quality the bigger priority for your team right now?',
    'What would make this a no-brainer decision for you?',
    'What is the biggest thing slowing your pipeline right now?',
];

// ─── FIX C (v4): QUALIFICATION QUESTIONS ─────────────────────────────────────
const QUALIFICATION_QUESTIONS = {
    volume:       'How much outreach volume is your team currently handling monthly?',
    team_size:    'How many people are managing your outreach right now?',
    current_tool: 'What tools are you currently using for follow-ups?',
    pain:         'What is the biggest manual task eating your team\'s time?',
    timeline:     'Is there a timeline you are working toward for getting this in place?',
    budget:       'Have you allocated budget for this, or are we still exploring?',
    decision:     'Are you the main decision-maker on this, or is there a team involved?',
    goal:         'What does success look like 90 days from now for your outreach?',
};

// ─── FIX E (v4): COMPETITOR POSITIONING ──────────────────────────────────────
const COMPETITOR_POSITIONING = {
    default: `Most platforms automate the sending. The problem is that sending more emails is not the bottleneck for most teams — it is knowing when to follow up, what to say, and when to hand off to a human. Skyline AI focuses on the decision layer, not just the delivery layer. That means fewer wasted touchpoints and more conversations that actually convert.`,
    vs_apollo: `Apollo is built for prospecting at scale — finding contacts and building lists. Skyline AI starts where Apollo ends. Once a lead responds, Apollo does not know what to do next. Skyline handles the entire reply-to-meeting flow automatically, with AI that reads intent, handles objections, and books meetings without human input.`,
    vs_clay: `Clay is a powerful data enrichment tool — it helps you build better lists. Skyline AI is not a list-building tool. It is a conversation tool. Once you have the leads, Skyline handles what happens after the first email lands — the follow-ups, the replies, the qualification, the booking.`,
    vs_freelancer: `A freelancer works 8 hours a day, takes weekends off, and handles one conversation at a time. Skyline AI handles hundreds of conversations simultaneously, responds within seconds, never misses a follow-up, and costs a fraction of one freelancer's monthly salary. The question is not freelancer vs. AI — it is whether you want your team spending time on repetitive reply management or on closing deals.`,
    vs_hiring: `Hiring a sales rep to handle outreach replies costs $3,000–$6,000 per month in salary alone — before benefits, management time, or onboarding. Skyline AI handles the same reply volume, 24/7, at a fraction of that cost. Most teams use Skyline to handle the top-of-funnel volume so their human reps can focus exclusively on closing.`,
};

// ─── FIX D (v4): OUTCOME LANGUAGE ────────────────────────────────────────────
const OUTCOME_LANGUAGE = {
    time_saved:    'hours per week your team currently spends on manual follow-up',
    pipeline:      'conversations that would have gone cold without a timely reply',
    scale:         'handling reply volume that would require 2–3 additional headcount',
    response_time: 'responding within seconds instead of hours — which directly impacts reply rates',
    consistency:   'every lead gets the same quality follow-up regardless of team capacity',
    cost:          'reducing the cost-per-conversation by removing manual handling from the equation',
};

// ─────────────────────────────────────────────────────────────────────────────
// FIX H: STRONGER PRODUCT POSITIONING — worldview + philosophy
// ─────────────────────────────────────────────────────────────────────────────
const PRODUCT_WORLDVIEW = {
    philosophy: `Skyline AI is built on one belief: the biggest revenue leak in most businesses is not the leads they never find — it is the leads they find but lose in the gap between first contact and first conversation. Most outreach tools are built to send more. Skyline is built to convert more from what you already have.`,
    differentiation: `Unlike general AI tools that generate content, Skyline AI is a decision engine. It does not just write replies — it reads intent, routes conversations, qualifies leads, and hands off to humans at the right moment. The result is a system that scales like software but responds like a trained sales rep.`,
    target_customer: `Skyline AI is built for teams doing serious outreach — agencies, SaaS companies, consultants, and B2B service businesses — that are growing faster than their ability to manually manage every conversation. If you are still replying to leads by hand or hiring people just to manage email threads, Skyline was built for your exact situation.`,
    core_pain: `The real problem is not sending emails. It is what happens after the email lands. Most teams have no system for: reading intent in replies, knowing when to follow up, handling objections at scale, or booking meetings automatically. Skyline solves that specific problem.`,
};

// ─────────────────────────────────────────────────────────────────────────────
// FIX I: SAFE REFUSAL LIBRARY — never silent, always redirect
// ─────────────────────────────────────────────────────────────────────────────
const SAFE_REFUSALS = {
    legal: `This touches on a legal or contractual matter that I am not able to address directly. I want to make sure you get the right answer here — let me connect you with the right person on our team who can speak to this properly.`,
    pricing_not_confirmed: `I want to give you accurate pricing rather than an estimate that might be off. Let me have someone from the team share the exact details — that way you have the right numbers to make a decision.`,
    out_of_scope: `That one is a bit outside what I can help with directly, but I do not want to leave you without a useful answer. If you can share more about what you are trying to solve, I can point you in the right direction or connect you with someone who can help.`,
    sensitive_topic: `That is not something I am able to speak to in this context, but I want to make sure you get what you need. The best next step is to connect you with someone on our team directly — what is the best way to reach you?`,
    uncertain: `Honestly, I want to give you a confident answer on this rather than guess. Let me make sure the right person follows up with you on this specifically — that way you get accurate information rather than a placeholder.`,
    competitor_attack: `I am not going to speak negatively about other tools — that is not useful to you. What I can do is be clear about what Skyline does well and let you decide if it fits. What is the specific problem you are trying to solve?`,
};

// ─────────────────────────────────────────────────────────────────────────────
// FIX J: ADVANCED SALES LOGIC — ROI estimation frameworks
// ─────────────────────────────────────────────────────────────────────────────
const ROI_FRAMEWORKS = {
    time_cost: `If your team spends even 5 hours per week on manual reply management, that is roughly 20 hours per month — or half a full-time week per quarter — on tasks Skyline handles automatically. At an average loaded cost of $25–$50/hour for that time, the math usually works out before the first month is done.`,
    lead_recovery: `Most teams we speak with are losing 20–40% of warm leads simply because follow-ups are too slow or get dropped entirely. If your team generates even 50 qualified leads per month, recovering 10–20 of those through consistent follow-up directly impacts pipeline in a measurable way.`,
    headcount_avoided: `The alternative to automating reply handling is hiring someone to do it. A part-time outreach coordinator costs $1,500–$2,500/month. A full-time hire is $3,000–$5,000+. Skyline operates at a fraction of that cost and does not require onboarding, management, or days off.`,
    response_speed: `Studies consistently show that responding to a lead within the first 5 minutes increases conversion likelihood by up to 9x compared to responding after an hour. Most human teams cannot maintain that response window at scale. Skyline responds within seconds, every time.`,
};

// ─────────────────────────────────────────────────────────────────────────────
// FIX G: RHYTHM SELECTOR
// ─────────────────────────────────────────────────────────────────────────────
function _selectRhythm(intent, conversationLength, lastRhythm) {
    const avoid = lastRhythm;
    const primaryMap = {
        [INTENTS.FAQ]:          RHYTHM_TYPES.STATEMENT,
        [INTENTS.QUALIFY]:      RHYTHM_TYPES.QUESTION,
        [INTENTS.SCHEDULE]:     RHYTHM_TYPES.STATEMENT,
        [INTENTS.INTERESTED]:   RHYTHM_TYPES.QUESTION,
        [INTENTS.BUYING]:       RHYTHM_TYPES.STATEMENT,
        [INTENTS.OBJECTION]:    RHYTHM_TYPES.REASSURANCE,
        [INTENTS.NURTURE]:      RHYTHM_TYPES.INSIGHT,
        [INTENTS.COMPETITOR]:   RHYTHM_TYPES.CHALLENGE,
        [INTENTS.ROI_QUESTION]: RHYTHM_TYPES.INSIGHT,
        [INTENTS.UNKNOWN]:      RHYTHM_TYPES.QUESTION,
        [INTENTS.FOLLOW_UP]:    RHYTHM_TYPES.STATEMENT,
    };
    let rhythm = primaryMap[intent] || RHYTHM_TYPES.STATEMENT;
    if (rhythm === avoid) {
        const all   = Object.values(RHYTHM_TYPES);
        const idx   = all.indexOf(rhythm);
        rhythm = all[(idx + 1) % all.length];
    }
    if (conversationLength > 4 && rhythm === RHYTHM_TYPES.STATEMENT) {
        rhythm = RHYTHM_TYPES.QUESTION;
    }
    return rhythm;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX F: LENGTH RESOLVER
// ─────────────────────────────────────────────────────────────────────────────
function _resolveReplyLength(replyLength, intent, conversationLength) {
    if (replyLength && replyLength !== 'auto') {
        return REPLY_LENGTH[replyLength?.toUpperCase()] || REPLY_LENGTH.MEDIUM;
    }
    if (intent === INTENTS.BUYING || intent === INTENTS.SCHEDULE) {
        return REPLY_LENGTH.MINIMAL;
    }
    if (intent === INTENTS.ROI_QUESTION || intent === INTENTS.COMPETITOR) {
        return REPLY_LENGTH.DETAILED;
    }
    if (intent === INTENTS.OBJECTION) {
        return REPLY_LENGTH.MEDIUM;
    }
    if (conversationLength > 4) {
        return REPLY_LENGTH.SHORT;
    }
    if (intent === INTENTS.FAQ || intent === INTENTS.NURTURE) {
        return REPLY_LENGTH.MEDIUM;
    }
    return REPLY_LENGTH.MEDIUM;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX J: PAIN DETECTOR
// ─────────────────────────────────────────────────────────────────────────────
function _detectPainSignals(message) {
    const lower = message.toLowerCase();
    const painMap = {
        manual_work:    /manual|manually|by hand|doing it ourselves|takes too long|time consuming/.test(lower),
        no_system:      /no system|no process|nothing in place|winging it|ad hoc|inconsistent/.test(lower),
        losing_leads:   /losing leads|leads go cold|not following up|missing leads|drop off/.test(lower),
        scaling_issue:  /can.?t scale|too many|overwhelmed|capacity|growing fast|volume/.test(lower),
        cost_pressure:  /too expensive|cost too much|budget|afford|cheaper|reduce cost/.test(lower),
        speed_issue:    /too slow|slow response|late reply|not fast enough|response time/.test(lower),
        team_size:      /small team|just me|solo|one person|two people|no team/.test(lower),
    };
    const detected = Object.entries(painMap).filter(([, hit]) => hit).map(([pain]) => pain);
    return {
        pains:       detected,
        painCount:   detected.length,
        highPain:    detected.length >= 2,
        primaryPain: detected[0] || null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX J: URGENCY DETECTOR
// ─────────────────────────────────────────────────────────────────────────────
function _detectUrgencyLevel(message, messageSignals) {
    const lower = message.toLowerCase();
    if (messageSignals?.isUrgent) return 'high';
    const mediumSignals = /soon|next month|planning|looking into|evaluating|quarter/.test(lower);
    const lowSignals    = /someday|eventually|maybe|thinking about|not sure yet/.test(lower);
    if (mediumSignals) return 'medium';
    if (lowSignals)    return 'low';
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ✅ FIX M: IMPROVED LANGUAGE DETECTOR — English priority, Dutch false positive fixed
// ─────────────────────────────────────────────────────────────────────────────
function _detectLanguage(message) {
    if (!message || typeof message !== 'string') return { code: 'en', name: 'English', rtl: false };

    // ✅ Strip HTML tags first
    let text = message.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return { code: 'en', name: 'English', rtl: false };

    // Script-based detection (highest confidence)
    if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text)) {
        if (/[\u0698\u06AF\u06CC\u06BE]/.test(text)) return { code: 'fa', name: 'Farsi', rtl: true };
        if (/[\u06C1\u06BE\u06D2]/.test(text)) return { code: 'ur', name: 'Urdu', rtl: true };
        return { code: 'ar', name: 'Arabic', rtl: true };
    }
    if (/[\u0590-\u05FF\uFB1D-\uFB4F]/.test(text)) return { code: 'he', name: 'Hebrew', rtl: true };
    if (/[\u0400-\u04FF]/.test(text)) return { code: 'ru', name: 'Russian', rtl: false };
    if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(text)) {
        if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return { code: 'ja', name: 'Japanese', rtl: false };
        return { code: 'zh', name: 'Chinese', rtl: false };
    }
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return { code: 'ja', name: 'Japanese', rtl: false };
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(text)) return { code: 'ko', name: 'Korean', rtl: false };
    if (/[\u0900-\u097F]/.test(text)) return { code: 'hi', name: 'Hindi', rtl: false };
    if (/[\u0E00-\u0E7F]/.test(text)) return { code: 'th', name: 'Thai', rtl: false };
    if (/[\u0370-\u03FF]/.test(text)) return { code: 'el', name: 'Greek', rtl: false };

    const lower = text.toLowerCase();

    // ✅ ENGLISH WORDS — common English words (prioritized)
    const englishWords = /\b(the|and|for|are|but|not|you|all|can|had|her|was|one|our|out|day|get|has|him|his|how|its|may|new|now|old|see|two|way|who|boy|did|yet|she|say|use|let|put|end|own|too|any|big|far|got|hot|lot|man|men|new|now|old|out|own|see|she|two|way|who|boy|did|yet|she|say|use|let|put|end|own|too|any|big|far|got|hot|lot|man|men|new|now|old|out|own|see|she|two|way|who|boy|did|yet|she|say|use|let|put|end|own|too|any|big|far|got|hot|lot|man|men|new|now|old|out|own|see|she|two|way|who|boy|did|yet|she|say|use|let|put|end|own|too|any|big|far|get|got|hot|lot|man|men|new|now|old|out|own|see|she|two|way|who|boy|did|yet|she|say|use|let|put|end|own|too|any|big|far|get|got|hot|lot|man|men|new|now|old|out|own|see|she|two|way|who)\b/i;
    const englishMatch = lower.match(englishWords);
    const englishCount = englishMatch ? englishMatch.length : 0;

    // ✅ DUTCH WORDS — moved to separate check with lower priority
    const dutchWords = /\b(ik|jij|hij|zij|wij|jullie|mijn|jouw|zijn|haar|ons|hun|me|je|hem|haar|ons|jullie|hen|ben|bent|is|zijn|was|waren|zal|zou|heb|hebt|heeft|hebben|had|zouden|moet|kunt|kan|mogen|mag|wil|wilt|zullen|gaan|gaat|ging|kwam|komen|kwamen|zien|zag|zagen|doen|deed|deden|zeggen|zei|zeiden|vinden|vond|vonden|denken|dacht|dachten|weten|wist|wisten|krijgen|kreeg|kregen|houden|hield|hielden|spelen|speelde|speelden|lopen|liep|liepen|rijden|reed|reden|vliegen|vloog|vlogen|zwemmen|zwom|zwommen)\b/i;
    const dutchMatch = lower.match(dutchWords);
    const dutchCount = dutchMatch ? dutchMatch.length : 0;

    // ✅ If English words count >= Dutch words count, it's English
    if (englishCount >= dutchCount && englishCount > 0) {
        return { code: 'en', name: 'English', rtl: false };
    }

    // ✅ If Dutch words significantly outnumber English words (3:1), it's Dutch
    if (dutchCount > englishCount * 3 && dutchCount > 2) {
        return { code: 'nl', name: 'Dutch', rtl: false };
    }

    // ✅ Latin-script languages — word-frequency heuristics
    const langPatterns = [
        { code: 'es', name: 'Spanish',    rtl: false, pattern: /\b(gracias|hola|por favor|cómo|está|estás|que|también|sí|no|bien|buenas|buenos días|estimado|empresa|necesito|quiero|podría|tenemos|nuestro|sistema|equipo|proceso)\b/ },
        { code: 'fr', name: 'French',     rtl: false, pattern: /\b(merci|bonjour|comment|est-ce|nous|vous|les|des|une|pour|avec|sur|mais|très|aussi|bien|notre|votre|pouvez|entreprise|besoin|système|équipe)\b/ },
        { code: 'de', name: 'German',     rtl: false, pattern: /\b(danke|hallo|bitte|wie|haben|sind|kann|wir|das|die|der|und|nicht|ich|sie|mit|für|eine|unser|team|system|prozess|brauchen)\b/ },
        { code: 'pt', name: 'Portuguese', rtl: false, pattern: /\b(obrigado|olá|como|temos|nosso|empresa|preciso|quero|poderia|sistema|equipe|processo|também|muito|para|com|por)\b/ },
        { code: 'it', name: 'Italian',    rtl: false, pattern: /\b(grazie|ciao|come|abbiamo|nostro|azienda|bisogno|voglio|potrebbe|sistema|squadra|processo|anche|molto|per|con)\b/ },
        { code: 'pl', name: 'Polish',     rtl: false, pattern: /\b(dziękuję|cześć|jak|mamy|nasz|firma|potrzebuję|chcę|mógłby|system|zespół|proces|też|bardzo|dla|z)\b/ },
        { code: 'tr', name: 'Turkish',    rtl: false, pattern: /\b(teşekkür|merhaba|nasıl|bizim|şirket|ihtiyaç|istiyorum|olur|sistem|ekip|süreç|ayrıca|çok|için|ile)\b/ },
        { code: 'sv', name: 'Swedish',    rtl: false, pattern: /\b(tack|hej|hur|vi|vårt|företag|behöver|vill|skulle|system|team|process|också|mycket|för|med)\b/ },
        { code: 'no', name: 'Norwegian',  rtl: false, pattern: /\b(takk|hei|hvordan|vi|vår|selskap|trenger|vil|ville|system|team|prosess|også|veldig|for|med)\b/ },
        { code: 'da', name: 'Danish',     rtl: false, pattern: /\b(tak|hej|hvordan|vi|vores|virksomhed|behøver|vil|ville|system|team|proces|også|meget|for|med)\b/ },
        { code: 'fi', name: 'Finnish',    rtl: false, pattern: /\b(kiitos|hei|miten|meillä|meidän|yritys|tarvitsen|haluan|voisi|järjestelmä|tiimi|prosessi|myös|paljon|varten)\b/ },
        { code: 'id', name: 'Indonesian', rtl: false, pattern: /\b(terima kasih|halo|bagaimana|kami|perusahaan|butuh|ingin|bisa|sistem|tim|proses|juga|sangat|untuk|dengan)\b/ },
        { code: 'ms', name: 'Malay',      rtl: false, pattern: /\b(terima kasih|hai|bagaimana|kami|syarikat|perlu|mahu|boleh|sistem|pasukan|proses|juga|sangat|untuk|dengan)\b/ },
        { code: 'vi', name: 'Vietnamese', rtl: false, pattern: /\b(cảm ơn|xin chào|như thế nào|chúng tôi|công ty|cần|muốn|có thể|hệ thống|đội|quy trình|cũng|rất|cho|với)\b/ },
    ];

    let bestMatch = null;
    let bestScore = 0;

    for (const lang of langPatterns) {
        const matches = lower.match(lang.pattern);
        const score = matches ? matches.length : 0;
        if (score > bestScore) {
            bestScore = score;
            bestMatch = lang;
        }
    }

    if (bestMatch && bestScore >= 2) {
        return { code: bestMatch.code, name: bestMatch.name, rtl: bestMatch.rtl };
    }

    return { code: 'en', name: 'English', rtl: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION
// ─────────────────────────────────────────────────────────────────────────────
async function generateAIReply(
    customerMessage,
    instructions,
    leadName,
    conversationHistory = [],
    options = {}
) {
    const startTime = Date.now();

    const {
        leadContext          = {},
        businessConfig       = {},
        mode                 = MODES.FULL,
        followUpCount        = 0,
        tone                 = TONES.FRIENDLY,
        channel              = 'email',
        replyLength          = 'auto',
        personaName          = null,
        industry             = null,
        leadScore            = 0,
        campaignGoal         = null,
        competitorContext    = null,
        enableChallengerMode = false,
        lastRhythm           = null,
    } = options;

    // ── LAYER 0: API Key Guard ────────────────────────────────────────────────
    if (!process.env.OPENAI_API_KEY) {
        console.error('❌ [AI GENERATOR] OPENAI_API_KEY is missing.');
        return _errorResult('missing_api_key', startTime);
    }

    // ── LAYER 1: Input Sanitization ───────────────────────────────────────────
    const safeMessage      = _sanitizeInput(customerMessage, CONFIG.MAX_MESSAGE_CHARS);
    const safeInstructions = _sanitizeInput(instructions,    CONFIG.MAX_INSTRUCTIONS_CHARS);
    const safeBusinessCfg  = _sanitizeBusinessConfig(businessConfig);

    // ── LAYER 2: Pre-AI Hard Guardrails ──────────────────────────────────────
    const guardrail = _runGuardrails(safeMessage, followUpCount, leadScore);
    if (guardrail) {
        console.warn(`🛡️ [AI GENERATOR] Guardrail hit: ${guardrail.reasoning}`);
        return { ...guardrail, durationMs: Date.now() - startTime, modelVersion: CONFIG.MODEL };
    }

    // ── LAYER 3: History Trimming ─────────────────────────────────────────────
    const safeHistory = _trimHistory(conversationHistory, CONFIG.HISTORY_LIMIT);

    // ── LAYER 4: Signal Detection ─────────────────────────────────────────────
    const messageSignals = _detectMessageSignals(safeMessage);
    const painSignals    = _detectPainSignals(safeMessage);
    const urgencyLevel   = _detectUrgencyLevel(safeMessage, messageSignals);

    // ── FIX K: Language Detection ─────────────────────────────────────────────
    const detectedLanguage = _detectLanguage(safeMessage);

    // ── LAYER 5: Resolve tone + rhythm + length ───────────────────────────────
    const resolvedTone = enableChallengerMode ? TONES.CHALLENGER : tone;
    const conversationLength = safeHistory.length;
    const resolvedLengthMode = replyLength;

    // ── LAYER 6: Build Prompt ─────────────────────────────────────────────────
    const systemPrompt = _buildSystemPrompt({
        instructions:     safeInstructions,
        businessConfig:   safeBusinessCfg,
        leadName,
        leadContext,
        mode,
        tone:             resolvedTone,
        channel,
        replyLength:      resolvedLengthMode,
        personaName,
        industry,
        campaignGoal,
        leadScore,
        competitorContext: competitorContext || messageSignals.competitor,
        messageSignals,
        conversationLength,
        painSignals,
        urgencyLevel,
        lastRhythm,
        detectedLanguage,
    });

    const messages = [
        { role: 'system', content: systemPrompt },
        ...safeHistory,
        { role: 'user',   content: safeMessage },
    ];

    // ── LAYER 7: AI API Call with Retry ──────────────────────────────────────
    let rawContent = null;
    let tokensUsed = null;
    let lastError  = null;

    for (let attempt = 1; attempt <= CONFIG.RETRY_ATTEMPTS; attempt++) {
        try {
            const response = await axios.post(CONFIG.API_URL, {
                model:           CONFIG.MODEL,
                messages,
                temperature:     _resolveTemperature(mode, resolvedTone),
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
            tokensUsed = response.data.usage?.total_tokens ?? null;
            lastError  = null;
            break;

        } catch (err) {
            lastError = err;
            if (err.response?.status === 401) break;
            if (attempt < CONFIG.RETRY_ATTEMPTS) {
                const delay = CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                console.warn(`⚠️ [AI GENERATOR] Attempt ${attempt} failed. Retrying in ${delay}ms…`);
                await _sleep(delay);
            }
        }
    }

    if (lastError) {
        _logAPIError(lastError);
        return _errorResult('api_call_failed', startTime);
    }

    // ── LAYER 8: Parse ────────────────────────────────────────────────────────
    let aiData;
    try {
        aiData = JSON.parse(rawContent);
    } catch (_) {
        console.error('❌ [AI GENERATOR] JSON parse failed. Raw:', rawContent);
        return _errorResult('parse_failed', startTime);
    }

    // ── LAYER 9: Validate ─────────────────────────────────────────────────────
    const validationError = _validateAIResponse(aiData);
    if (validationError) {
        console.error(`❌ [AI GENERATOR] Validation failed: ${validationError}`);
        return _errorResult(`validation_failed:${validationError}`, startTime);
    }

    let {
        intent             = INTENTS.UNKNOWN,
        confidence         = 0,
        action             = ACTIONS.REPLY,
        reasoning          = '',
        reply              = null,
        schedulingHints    = null,
        ctaType            = null,
        qualifyingData     = null,
        objectionType      = null,
        qualifyingQuestion = null,
        urgencySignal      = null,
        rhythmUsed         = null,
        roiEstimate        = null,
        refusalReason      = null,
        painIdentified     = null,
        replyLanguage      = null,
    } = aiData;

    reasoning = typeof reasoning === 'string'
        ? reasoning.slice(0, CONFIG.MAX_REASONING_CHARS)
        : '';

    console.log(`🧠 [AI GENERATOR] Intent: ${intent} | Confidence: ${confidence} | Action: ${action} | Tokens: ${tokensUsed} | Mode: ${mode} | Rhythm: ${rhythmUsed} | Language: ${detectedLanguage.code}`);

    // ── LAYER 10: Post-AI Reply Validator ─────────────────────────────────────
    if (reply) {
        const replyIssue = _validateReply(reply);
        if (replyIssue) {
            console.warn(`⚠️ [AI GENERATOR] Reply failed post-validation: ${replyIssue}`);
            return _errorResult(`reply_validation_failed:${replyIssue}`, startTime);
        }
    }

    // ── LAYER 11: Post-AI Safety Routing ─────────────────────────────────────
    const finalAction         = _resolveAction(intent, confidence, action, mode, reply);
    const requiresHumanReview = _needsReview(finalAction, confidence, mode);
    const riskLevel           = _computeRiskLevel(intent, confidence, finalAction);
    const shouldAIReply       = finalAction === ACTIONS.REPLY || finalAction === ACTIONS.DRAFT;

    if (requiresHumanReview) {
        console.warn(`⚠️ [AI GENERATOR] Human review required. Reason: ${reasoning}`);
    }

    const resolvedSchedulingHints = intent === INTENTS.SCHEDULE ? (schedulingHints || {}) : null;
    const leadQualityScore        = _assessLeadQuality(intent, confidence, leadScore, qualifyingData);
    const followUpHint            = _computeFollowUpHint(intent, finalAction, followUpCount);
    const patternData             = _buildPatternData(intent, confidence, finalAction, mode, resolvedTone, industry, campaignGoal);
    const resolvedRhythm = rhythmUsed || _selectRhythm(intent, conversationLength, lastRhythm);
    const combinedPain = painIdentified || (painSignals.primaryPain ? painSignals.primaryPain : null);
    const resolvedLanguage = replyLanguage || detectedLanguage.code;

    const replyFingerprint = reply
        ? crypto.createHash('sha1').update(reply.trim().toLowerCase()).digest('hex').slice(0, 12)
        : null;

    const durationMs = Date.now() - startTime;

    return {
        reply:               shouldAIReply ? reply : null,
        action:              finalAction,
        intent,
        confidence:          Math.round(confidence * 100) / 100,
        reasoning,
        requiresHumanReview,
        shouldAIReply,
        riskLevel,
        ctaType,
        qualifyingData,
        qualifyingQuestion,
        objectionType,
        urgencySignal:       urgencySignal || urgencyLevel,
        rhythmUsed:          resolvedRhythm,
        refusalReason,
        roiEstimate,
        painIdentified:      combinedPain,
        painSignals,
        detectedLanguage,
        replyLanguage:       resolvedLanguage,
        leadQualityScore,
        leadQualityTier:     _getLeadQualityTier(leadQualityScore),
        schedulingHints:     resolvedSchedulingHints,
        followUpHint,
        durationMs,
        tokensUsed,
        modelVersion:        CONFIG.MODEL,
        replyFingerprint,
        patternData,
        messageSignals,
        errorCode:           null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL DETECTOR
// ─────────────────────────────────────────────────────────────────────────────
function _detectMessageSignals(message) {
    const lower = message.toLowerCase();
    const competitorKeywords = {
        apollo:     ['apollo', 'apollo.io'],
        clay:       ['clay', 'clay.com'],
        freelancer: ['freelancer', 'hire someone', 'hire a person', 'hire a va'],
        hiring:     ['hire a rep', 'sales rep', 'hire staff', 'employee'],
        instantly:  ['instantly', 'instantly.ai'],
        lemlist:    ['lemlist'],
        smartlead:  ['smartlead'],
        outreach:   ['outreach.io', 'salesloft'],
    };
    let competitor = null;
    for (const [name, keywords] of Object.entries(competitorKeywords)) {
        if (keywords.some(k => lower.includes(k))) { competitor = name; break; }
    }
    return {
        competitor,
        isROIQuestion: /worth it|roi|return|cost|expensive|cheaper|price|value/.test(lower),
        isCompetitor:  competitor !== null,
        isUrgent:      /asap|urgent|this week|right now|immediately|today/.test(lower),
        isSkeptical:   /not sure|doubt|really work|prove|skeptical|don.?t believe/.test(lower),
        isQualifying:  /team|company|size|budget|monthly|weekly|volume|leads/.test(lower),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// ✅ FIX L & N: PROMPT BUILDER v5.2 — FORCED INSTRUCTION FOLLOWING + OUT OF SCOPE SILENCE
// ─────────────────────────────────────────────────────────────────────────────
function _buildSystemPrompt({
    instructions, businessConfig, leadName, leadContext,
    mode, tone, channel, replyLength, personaName,
    industry, campaignGoal, leadScore,
    competitorContext, messageSignals, conversationLength,
    painSignals, urgencyLevel, lastRhythm,
    detectedLanguage,
}) {
    const modeRules = {
        sales:      'You are in SALES MODE. Qualify, identify buying intent, handle objections, move toward booking. Always end with a question or CTA.',
        support:    'You are in SUPPORT MODE. Answer clearly and resolve concerns. Do not push for a sale.',
        booking:    'You are in BOOKING MODE. Your ONLY goal is to get a meeting scheduled.',
        nurturing:  'You are in NURTURING MODE. Long-term warm lead. Do NOT pressure. Build trust.',
        escalation: 'You are in ESCALATION MODE. Set action to ESCALATE. Do not auto-reply.',
        draft:      'You are in DRAFT MODE. Write best reply but set action to "DRAFT".',
        safe:       'You are in SAFE MODE. Auto-reply only for FAQ, QUALIFY, SCHEDULE, UNKNOWN.',
        full:       'You are in FULL AUTO MODE. Reply to all messages except angry, legal, out-of-scope.',
    };

    const toneRules = {
        formal:     'Professional, formal. No contractions. Sign off formally.',
        casual:     'Relaxed, casual. Contractions welcome. Sound human.',
        friendly:   'Warm and approachable but professional.',
        assertive:  'Direct and confident. Lead with value. Drive toward action.',
        empathetic: 'Lead with acknowledgment. Validate before informing. Never dismissive.',
        challenger: 'Challenge assumptions respectfully. Reframe. Ask strategic questions. Make the lead think.',
    };

    const channelRules = {
        email: 'FORMAT: Email. Greeting, clear paragraphs, professional sign-off.',
        sms:   'FORMAT: SMS. Max 160 chars. No greeting or sign-off. Direct.',
        chat:  'FORMAT: Chat widget. Short, conversational. No email formatting.',
    };

    // ── ✅ FIX L: FORCED INSTRUCTION FOLLOWING ──
    const forcedInstructionBlock = `
╔══════════════════════════════════════════════════════════════════╗
║  🔒 CRITICAL: YOU MUST FOLLOW THESE INSTRUCTIONS 100%          ║
║  ══════════════════════════════════════════════════════════════ ║
║  The user has provided INSTRUCTIONS that OVERRIDE all other    ║
║  rules. You MUST follow them EXACTLY.                         ║
║                                                                 ║
║  USER INSTRUCTIONS:                                            ║
║  "${instructions}"                                             ║
║                                                                 ║
║  RULES:                                                        ║
║  1. DO NOT add extra content beyond the instructions           ║
║  2. DO NOT change the meaning of the instructions              ║
║  3. DO NOT ask questions unless the instructions say to        ║
║  4. If instructions say "thank them" — ONLY thank them        ║
║  5. If instructions say "ask about X" — ONLY ask about X      ║
║  6. If instructions say "do not reply" — set action to STOP    ║
║  7. Instructions ALWAYS take priority over sales/support rules ║
║  8. If instructions are unclear, default to a simple thank you ║
╚══════════════════════════════════════════════════════════════════╝
`;

    // ── ✅ FIX N: OUT OF SCOPE SILENCE ──
    const outOfScopeBlock = `
🔇 OUT OF SCOPE RULES — STAY QUIET IF OUTSIDE INSTRUCTIONS:
- If the user's message is NOT related to what the instructions ask for:
  → Set action to "STOP"
  → Set reply to null
  → Set reasoning to "Message is out of scope of instructions"
- If the user asks something completely unrelated to the instructions:
  → Set action to "STOP"
  → Set reply to null
- If you are uncertain whether the message is in scope:
  → Set action to "STOP" (better to stay quiet than to reply incorrectly)
- ONLY reply if the message DIRECTLY relates to the instructions given.
`;

    const lengthBlock = `
REPLY LENGTH CONTROL — CRITICAL:
- AUTO mode is active. Select the right length for the situation:
  * BUYING or SCHEDULE intent → MINIMAL (1 sentence + next step only)
  * ROI_QUESTION or COMPETITOR → DETAILED
  * OBJECTION → MEDIUM
  * Conversation longer than 4 messages → SHORT
  * Early conversation (1–2 messages) → MEDIUM
  * FAQ or NURTURE → MEDIUM
- If caller specified length: ${replyLength !== 'auto' ? replyLength.toUpperCase() : 'AUTO (engine decides)'}
- Never pad replies with filler. If you have said what needs to be said, stop.
`;

    const lastRhythmNote = lastRhythm ? `LAST REPLY RHYTHM WAS: ${lastRhythm.toUpperCase()} — do NOT repeat it.` : '';
    const rhythmBlock = `
CONVERSATION RHYTHM ENGINE — CRITICAL:
${lastRhythmNote}
Pick ONE rhythm for this reply and report it in "rhythmUsed":
- STATEMENT   : Make a clear, confident point. No question needed.
- QUESTION     : Ask ONE strategic question to qualify or advance.
- REASSURANCE  : Short validation + one forward move.
- INSIGHT      : Share a specific data point or observation.
- CHALLENGE    : Respectfully push back or reframe an assumption.
Never use the same rhythm twice in a row.
`;

    const worldviewBlock = `
PRODUCT WORLDVIEW — WHO WE ARE AND WHY WE EXIST:
Philosophy: "${PRODUCT_WORLDVIEW.philosophy}"
Differentiation: "${PRODUCT_WORLDVIEW.differentiation}"
Core pain we solve: "${PRODUCT_WORLDVIEW.core_pain}"
Target customer: "${PRODUCT_WORLDVIEW.target_customer}"
`;

    const refusalBlock = `
SAFE REFUSAL RULES — NEVER REFUSE SILENTLY:
If you cannot or should not answer something directly:
1. Acknowledge the question — do NOT ignore it.
2. Explain briefly WHY you cannot address it directly.
3. Redirect professionally to the right next step.
4. Set "refusalReason" in your response.
`;

    const advancedSalesBlock = `
ADVANCED SALES LOGIC:
${painSignals?.pains?.length > 0 ? `Pain signals detected: ${painSignals.pains.join(', ')}.` : ''}
${urgencyLevel ? `Urgency level detected: ${urgencyLevel.toUpperCase()}.` : ''}
`;

    const rtlNote = detectedLanguage.rtl ? `NOTE: This language (${detectedLanguage.name}) is right-to-left. Format accordingly.` : '';
    const multilingualBlock = `
MULTILINGUAL ENGINE — CRITICAL:
The lead's message has been detected as: ${detectedLanguage.name} (${detectedLanguage.code}).
${rtlNote}

RULES — NEVER VIOLATE:
1. ALWAYS reply in the EXACT SAME LANGUAGE as the lead's message. No exceptions.
2. Do NOT switch to English unless the lead's message is in English.
3. Do NOT mix languages.
4. Set "replyLanguage" in your JSON response to the BCP-47 language code.
`;

    const openers = OPENER_VARIATIONS[tone] || OPENER_VARIATIONS.friendly;
    const sampleOpeners = openers.slice(0, 4).join(' | ');
    const sampleClosings = CLOSING_VARIATIONS.slice(0, 4).join(' | ');

    const variationBlock = `
RESPONSE VARIATION — CRITICAL:
- NEVER start with "I completely understand", "I appreciate your concern", "Great question", "Certainly".
- Vary opener every time. Sample openers: ${sampleOpeners}
- Vary closing every time. Sample closings: ${sampleClosings}
`;

    const persuasionBlock = `
PERSUASION POWER:
- Lead with PAIN, not features. Use CONCRETE language.
- AVOID: "improve efficiency", "streamline workflow".
- USE: "${OUTCOME_LANGUAGE.time_saved}", "${OUTCOME_LANGUAGE.pipeline}".
`;

    const salesControlBlock = `
SALES CONTROL:
- Answer briefly — then ask ONE qualifying question to advance the sale.
- Never ask more than ONE question per reply.
- BUYING intent → skip explanation, go to next step immediately.
`;

    let competitorBlock = '';
    if (messageSignals?.isCompetitor || competitorContext) {
        const key = competitorContext || messageSignals?.competitor || 'default';
        const position = COMPETITOR_POSITIONING[key] || COMPETITOR_POSITIONING.default;
        competitorBlock = `
COMPETITOR DETECTED:
Use this positioning: "${position}"
Then ask: "What specifically are you trying to solve?"
`;
    }

    const personaBlock = personaName
        ? `\nPERSONA: You are "${personaName}". Never break character.\n`
        : '';

    const businessCfgBlock = Object.keys(businessConfig).length
        ? `\nBUSINESS KNOWLEDGE BASE:\n${JSON.stringify(businessConfig, null, 2)}\n`
        : '';

    const leadMemoryBlock = Object.keys(leadContext).length
        ? `\nLEAD MEMORY:\n${JSON.stringify(leadContext, null, 2)}\n`
        : '';

    const leadScoreBlock = leadScore > 0
        ? `\nLEAD SCORE: ${leadScore}/100. ${leadScore >= 70 ? 'HIGH — prioritise closing.' : leadScore >= 40 ? 'MEDIUM — nurture carefully.' : 'LOW — qualify first.'}\n`
        : '';

    const campaignBlock = campaignGoal
        ? `\nCAMPAIGN GOAL: ${campaignGoal}. Move every reply toward this goal.\n`
        : '';

    const industryBlock = industry
        ? `\nINDUSTRY: ${industry}. Adapt language to feel native to this industry.\n`
        : '';

    return `
You are a professional AI sales and communication assistant for: "${leadName}".
${personaBlock}
${businessCfgBlock}
${leadMemoryBlock}
${leadScoreBlock}
${campaignBlock}
${industryBlock}
${competitorBlock}

═══════════════════════════════════════
${forcedInstructionBlock}
${outOfScopeBlock}
═══════════════════════════════════════

MODE: ${mode.toUpperCase()} — ${modeRules[mode] || modeRules['full']}
CHANNEL: ${(channel || 'email').toUpperCase()} — ${channelRules[channel] || channelRules['email']}
TONE: ${(tone || 'friendly').toUpperCase()} — ${toneRules[tone] || toneRules['friendly']}

${worldviewBlock}
${lengthBlock}
${rhythmBlock}
${variationBlock}
${persuasionBlock}
${salesControlBlock}
${advancedSalesBlock}
${refusalBlock}
${multilingualBlock}

═══════════════════════════════════════
INTENT — classify into exactly one:
- "FAQ"          : Question about service, pricing, or process.
- "QUALIFY"      : Lead sharing company size, goals, budget, use case.
- "SCHEDULE"     : Lead wants to book a call or meeting.
- "INTERESTED"   : Clear interest or buying signal.
- "BUYING"       : Strong purchase intent — ready to proceed.
- "OBJECTION"    : Hesitation, concern, or pushback.
- "COMPETITOR"   : Asking about alternatives or comparisons.
- "ROI_QUESTION" : Asking if this is worth the money/time.
- "NURTURE"      : Engaged but not ready — long-term lead.
- "ANGRY"        : Frustrated, rude, or threatening.
- "OUT_OF_SCOPE" : Spam, wrong person, off-topic.
- "FOLLOW_UP"    : Response to a previous follow-up.
- "UNKNOWN"      : Vague — reply and ask ONE clarifying question.

RESPONSE FORMAT — return ONLY valid JSON:
{
  "intent":              "<intent>",
  "confidence":          <0.0–1.0>,
  "action":              "REPLY" | "ESCALATE" | "DRAFT" | "WAIT" | "STOP",
  "reasoning":           "<1 sentence>",
  "reply":               "<reply text or null>",
  "ctaType":             "<cta type or null>",
  "qualifyingData":      <object or null>,
  "qualifyingQuestion":  "<question asked or null>",
  "objectionType":       "<type or null>",
  "urgencySignal":       "<high|medium|low|null>",
  "schedulingHints":     <object or null>,
  "rhythmUsed":          "<statement|question|reassurance|insight|challenge>",
  "roiEstimate":         "<framework used or null>",
  "refusalReason":       "<reason or null>",
  "painIdentified":      "<primary pain or null>",
  "replyLanguage":       "<BCP-47 language code>"
}
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// GUARDRAILS
// ─────────────────────────────────────────────────────────────────────────────
function _runGuardrails(message, followUpCount, leadScore) {
    const lower = message.toLowerCase();
    if (LEGAL_TRIGGERS.some(t => lower.includes(t)))
        return _guardrailResult(ACTIONS.ESCALATE, INTENTS.OUT_OF_SCOPE, RISK_LEVELS.HIGH,
            'Legal or contract language detected.');
    if (ANGRY_TRIGGERS.some(t => lower.includes(t)))
        return _guardrailResult(ACTIONS.STOP, INTENTS.ANGRY, RISK_LEVELS.HIGH,
            'Opt-out or angry signal detected.');
    if (ABUSE_TRIGGERS.some(t => lower.includes(t)))
        return _guardrailResult(ACTIONS.ESCALATE, INTENTS.OUT_OF_SCOPE, RISK_LEVELS.HIGH,
            'Platform abuse detected.');
    if (lower.trim().length < 3)
        return _guardrailResult(ACTIONS.STOP, INTENTS.OUT_OF_SCOPE, RISK_LEVELS.LOW,
            'Message empty or non-text.');
    if (leadScore !== undefined && leadScore < 10 && followUpCount >= 3)
        return _guardrailResult(ACTIONS.STOP, INTENTS.FOLLOW_UP, RISK_LEVELS.LOW,
            'Lead score critically low.');
    if (followUpCount >= CONFIG.MAX_FOLLOWUPS)
        return _guardrailResult(ACTIONS.ESCALATE, INTENTS.FOLLOW_UP, RISK_LEVELS.MEDIUM,
            `Follow-up cap (${CONFIG.MAX_FOLLOWUPS}) reached.`);
    return null;
}

function _guardrailResult(action, intent, riskLevel, reasoning) {
    return {
        reply:               null,
        action,
        intent,
        confidence:          1.0,
        reasoning,
        requiresHumanReview: riskLevel === RISK_LEVELS.HIGH,
        shouldAIReply:       false,
        riskLevel,
        schedulingHints:     null,
        followUpHint:        { action: 'stop', waitDays: null, reason: reasoning },
        leadQualityScore:    0,
        leadQualityTier:     LEAD_QUALITY.DEAD,
        ctaType:             null,
        qualifyingData:      null,
        qualifyingQuestion:  null,
        objectionType:       null,
        urgencySignal:       null,
        rhythmUsed:          null,
        roiEstimate:         null,
        refusalReason:       null,
        painIdentified:      null,
        painSignals:         null,
        detectedLanguage:    null,
        replyLanguage:       null,
        tokensUsed:          0,
        replyFingerprint:    null,
        patternData:         null,
        messageSignals:      null,
        errorCode:           null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
function _validateAIResponse(aiData) {
    if (!aiData || typeof aiData !== 'object') return 'response_not_object';
    const validIntents = Object.values(INTENTS);
    const validActions = ['REPLY', 'ESCALATE', 'DRAFT', 'WAIT', 'STOP'];
    if (aiData.intent && !validIntents.includes(aiData.intent)) return `unknown_intent:${aiData.intent}`;
    if (aiData.action && !validActions.includes(aiData.action)) return `unknown_action:${aiData.action}`;
    if (aiData.confidence !== undefined) {
        const c = Number(aiData.confidence);
        if (isNaN(c) || c < 0 || c > 1) return 'confidence_out_of_range';
    }
    return null;
}

function _validateReply(reply) {
    if (typeof reply !== 'string') return 'reply_not_string';
    if (reply.trim().length === 0) return 'reply_empty';
    if (reply.length > CONFIG.MAX_REPLY_CHARS) return `reply_too_long:${reply.length}`;
    for (const pattern of SPAM_PATTERNS) {
        if (pattern.test(reply)) return 'spam_pattern_detected';
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────
function _resolveAction(intent, confidence, aiAction, mode, reply) {
    if (!reply && aiAction !== ACTIONS.WAIT) return ACTIONS.ESCALATE;
    if ([INTENTS.ANGRY, INTENTS.OUT_OF_SCOPE].includes(intent)) return ACTIONS.ESCALATE;
    if (mode === MODES.ESCALATION) return ACTIONS.ESCALATE;
    if (mode === MODES.DRAFT) return ACTIONS.DRAFT;
    if (confidence < CONFIG.CONFIDENCE_THRESHOLD) {
        console.warn(`⚠️ [AI GENERATOR] Confidence ${confidence} below threshold. Escalating.`);
        return ACTIONS.ESCALATE;
    }
    if (aiAction === ACTIONS.WAIT) return ACTIONS.WAIT;
    if (aiAction === ACTIONS.STOP) return ACTIONS.STOP;
    if (mode === MODES.SAFE) {
        const safeIntents = [INTENTS.FAQ, INTENTS.QUALIFY, INTENTS.SCHEDULE, INTENTS.UNKNOWN];
        return safeIntents.includes(intent) ? ACTIONS.REPLY : ACTIONS.ESCALATE;
    }
    return ACTIONS.REPLY;
}

function _needsReview(finalAction, confidence, mode) {
    if (mode === MODES.DRAFT) return true;
    if (finalAction === ACTIONS.ESCALATE || finalAction === ACTIONS.STOP) return true;
    if (confidence < CONFIG.CONFIDENCE_THRESHOLD) return true;
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// RISK + LEAD QUALITY + FOLLOW-UP
// ─────────────────────────────────────────────────────────────────────────────
function _computeRiskLevel(intent, confidence, finalAction) {
    if (finalAction === ACTIONS.STOP) return RISK_LEVELS.HIGH;
    if ([INTENTS.ANGRY, INTENTS.OUT_OF_SCOPE].includes(intent)) return RISK_LEVELS.HIGH;
    if (finalAction === ACTIONS.ESCALATE) return RISK_LEVELS.HIGH;
    if ([INTENTS.OBJECTION, INTENTS.BUYING, INTENTS.COMPETITOR, INTENTS.ROI_QUESTION].includes(intent)) return RISK_LEVELS.MEDIUM;
    if (confidence < 0.5) return RISK_LEVELS.MEDIUM;
    return RISK_LEVELS.LOW;
}

function _assessLeadQuality(intent, confidence, existingScore, qualifyingData) {
    let score = existingScore || 0;
    const intentBonus = {
        [INTENTS.BUYING]: 40, [INTENTS.INTERESTED]: 30, [INTENTS.SCHEDULE]: 25,
        [INTENTS.QUALIFY]: 20, [INTENTS.ROI_QUESTION]: 20, [INTENTS.COMPETITOR]: 15,
        [INTENTS.OBJECTION]: 10, [INTENTS.FAQ]: 10, [INTENTS.NURTURE]: 5,
        [INTENTS.UNKNOWN]: 0, [INTENTS.ANGRY]: -20, [INTENTS.OUT_OF_SCOPE]: -30,
    };
    score += intentBonus[intent] || 0;
    if (qualifyingData) {
        if (qualifyingData.budget) score += 10;
        if (qualifyingData.timeline) score += 10;
        if (qualifyingData.decisionMaker) score += 15;
        if (qualifyingData.companySize) score += 5;
    }
    if (confidence > 0.8) score += 5;
    return Math.min(100, Math.max(0, score));
}

function _getLeadQualityTier(score) {
    if (score >= 70) return LEAD_QUALITY.HOT;
    if (score >= 40) return LEAD_QUALITY.WARM;
    if (score >= 10) return LEAD_QUALITY.COLD;
    return LEAD_QUALITY.DEAD;
}

function _computeFollowUpHint(intent, finalAction, followUpCount) {
    if (finalAction === ACTIONS.STOP || finalAction === ACTIONS.ESCALATE)
        return { action: 'stop', waitDays: null, reason: 'Conversation ended or escalated.' };
    if ([INTENTS.BUYING, INTENTS.SCHEDULE].includes(intent))
        return { action: 'follow_up', waitDays: 1, reason: 'High intent — follow up quickly.' };
    if ([INTENTS.INTERESTED, INTENTS.QUALIFY, INTENTS.ROI_QUESTION, INTENTS.COMPETITOR].includes(intent))
        return { action: 'follow_up', waitDays: 2, reason: 'Good signal — follow up in 2 days.' };
    if (followUpCount >= 5)
        return { action: 'wait', waitDays: 7, reason: 'Multiple follow-ups — give space.' };
    if ([INTENTS.UNKNOWN, INTENTS.FAQ].includes(intent))
        return { action: 'follow_up', waitDays: 3, reason: 'Neutral signal — follow up in 3 days.' };
    return { action: 'follow_up', waitDays: 3, reason: 'Standard follow-up cadence.' };
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN DATA
// ─────────────────────────────────────────────────────────────────────────────
function _buildPatternData(intent, confidence, action, mode, tone, industry, campaignGoal) {
    return {
        intent,
        confidence,
        action,
        mode,
        tone,
        industry:     industry     || null,
        campaignGoal: campaignGoal || null,
        timestamp:    new Date().toISOString(),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _sanitizeBusinessConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return {};
    const str = JSON.stringify(cfg);
    if (str.length > CONFIG.MAX_BUSINESS_CFG_CHARS) {
        console.warn('⚠️ [AI GENERATOR] businessConfig truncated — too large.');
        return {
            companyName:  cfg.companyName,
            productName:  cfg.productName,
            positioning:  cfg.positioning,
            pricing:      cfg.pricing,
            plans:        cfg.plans,
            refundPolicy: cfg.refundPolicy,
        };
    }
    return cfg;
}

function _resolveTemperature(mode, tone) {
    if (mode === MODES.BOOKING) return 0.5;
    if (mode === MODES.SALES) return 0.65;
    if (mode === MODES.NURTURING) return 0.8;
    if (tone === TONES.ASSERTIVE) return 0.6;
    if (tone === TONES.CHALLENGER) return 0.7;
    return CONFIG.TEMPERATURE;
}

function _trimHistory(history, limit) {
    if (!Array.isArray(history)) return [];
    return history.slice(-limit);
}

function _sanitizeInput(text, maxChars) {
    if (typeof text !== 'string') return '';
    return text
        .slice(0, maxChars)
        .replace(/ignore (all )?(previous|above|prior) instructions?/gi, '[FILTERED]')
        .replace(/you are now/gi, '[FILTERED]')
        .replace(/pretend (you are|to be)/gi, '[FILTERED]')
        .replace(/act as (if you are|a)?/gi, '[FILTERED]')
        .replace(/reveal (your|the) (system|instructions?|prompt)/gi, '[FILTERED]')
        .replace(/disregard (all )?instructions?/gi, '[FILTERED]')
        .replace(/jailbreak/gi, '[FILTERED]')
        .replace(/DAN mode/gi, '[FILTERED]')
        .trim();
}

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
        followUpHint:        { action: 'stop', waitDays: null, reason: 'System error.' },
        leadQualityScore:    0,
        leadQualityTier:     LEAD_QUALITY.COLD,
        ctaType:             null,
        qualifyingData:      null,
        qualifyingQuestion:  null,
        objectionType:       null,
        urgencySignal:       null,
        rhythmUsed:          null,
        roiEstimate:         null,
        refusalReason:       null,
        painIdentified:      null,
        painSignals:         null,
        detectedLanguage:    null,
        replyLanguage:       null,
        durationMs:          Date.now() - startTime,
        tokensUsed:          null,
        modelVersion:        CONFIG.MODEL,
        replyFingerprint:    null,
        patternData:         null,
        messageSignals:      null,
        errorCode:           reason,
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
    MODES,
    RISK_LEVELS,
    TONES,
    REPLY_LENGTH,
    LEAD_QUALITY,
    RHYTHM_TYPES,
    COMPETITOR_POSITIONING,
    QUALIFICATION_QUESTIONS,
    OUTCOME_LANGUAGE,
    PRODUCT_WORLDVIEW,
    SAFE_REFUSALS,
    ROI_FRAMEWORKS,
    CONFIG,
};
