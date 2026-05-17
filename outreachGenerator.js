'use strict';

const axios = require('axios');

// ─── BANNED WORDS ─────────────────────────────────────────────────────────────
const BANNED_WORDS = [
    'transformative','seamless','mission-critical','synergy','game-changer',
    'revolutionary','cutting-edge','innovative','disruptive','next-level',
    'holistic','robust','scalable','leverage','streamline','optimize',
    'empower','unlock','elevate','enhance','boost','accelerate','amplify',
    'delve','awe-inspiring','exciting','landscape','unleash','dynamic',
    'groundbreaking','paradigm','ecosystem','value-add','best-in-class',
    'I hope this finds you well','I wanted to reach out','touch base',
    'circle back','quick question','just following up','as per my last email',
    'I am reaching out because','My name is','I hope you are doing well',
    'let me know your thoughts','feel free to','do not hesitate',
    'please find attached','as mentioned','at your earliest convenience',
    'in today\'s world','in the current landscape','going forward',
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
    return `BANNED WORDS — NEVER use: ${BANNED_WORDS.join(', ')}. Replace with specific facts.\n${BANNED_STATS_INSTRUCTION}`;
}

// ─── MULTILINGUAL ENGINE ──────────────────────────────────────────────────────
function detectLanguage(message) {
    if (!message || typeof message !== 'string') return { code: 'en', name: 'English', rtl: false };
    const text  = message.trim();

    if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text)) {
        if (/[\u0698\u06AF\u06CC\u06BE]/.test(text)) return { code: 'fa', name: 'Farsi',  rtl: true };
        if (/[\u06C1\u06BE\u06D2]/.test(text))        return { code: 'ur', name: 'Urdu',   rtl: true };
        return { code: 'ar', name: 'Arabic', rtl: true };
    }
    if (/[\u0590-\u05FF\uFB1D-\uFB4F]/.test(text))  return { code: 'he', name: 'Hebrew',   rtl: true  };
    if (/[\u0400-\u04FF]/.test(text))                return { code: 'ru', name: 'Russian',  rtl: false };
    if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(text)) {
        if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return { code: 'ja', name: 'Japanese', rtl: false };
        return { code: 'zh', name: 'Chinese', rtl: false };
    }
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text))  return { code: 'ja', name: 'Japanese', rtl: false };
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(text))  return { code: 'ko', name: 'Korean',   rtl: false };
    if (/[\u0900-\u097F]/.test(text))                return { code: 'hi', name: 'Hindi',    rtl: false };
    if (/[\u0E00-\u0E7F]/.test(text))                return { code: 'th', name: 'Thai',     rtl: false };
    if (/[\u0370-\u03FF]/.test(text))                return { code: 'el', name: 'Greek',    rtl: false };

    const lower = text.toLowerCase();
    const langPatterns = [
        { code: 'es', name: 'Spanish',    rtl: false, pattern: /\b(gracias|hola|por favor|cómo|está|empresa|necesito|quiero|podría|tenemos|nuestro|sistema|equipo)\b/ },
        { code: 'fr', name: 'French',     rtl: false, pattern: /\b(merci|bonjour|comment|nous|vous|les|des|pour|avec|très|notre|votre|pouvez|entreprise)\b/ },
        { code: 'de', name: 'German',     rtl: false, pattern: /\b(danke|hallo|bitte|wie|haben|sind|kann|wir|das|die|der|und|nicht|ich|sie|mit|für)\b/ },
        { code: 'pt', name: 'Portuguese', rtl: false, pattern: /\b(obrigado|olá|como|temos|nosso|empresa|preciso|quero|poderia|sistema|equipe)\b/ },
        { code: 'it', name: 'Italian',    rtl: false, pattern: /\b(grazie|ciao|come|abbiamo|nostro|azienda|bisogno|voglio|potrebbe|sistema)\b/ },
        { code: 'nl', name: 'Dutch',      rtl: false, pattern: /\b(bedankt|hallo|hoe|wij|onze|bedrijf|nodig|wil|zou|systeem|team)\b/ },
        { code: 'pl', name: 'Polish',     rtl: false, pattern: /\b(dziękuję|cześć|jak|mamy|nasz|firma|potrzebuję|chcę|system|zespół)\b/ },
        { code: 'tr', name: 'Turkish',    rtl: false, pattern: /\b(teşekkür|merhaba|nasıl|bizim|şirket|ihtiyaç|istiyorum|sistem|ekip)\b/ },
        { code: 'sv', name: 'Swedish',    rtl: false, pattern: /\b(tack|hej|hur|vi|vårt|företag|behöver|vill|system|team)\b/ },
        { code: 'id', name: 'Indonesian', rtl: false, pattern: /\b(terima kasih|halo|bagaimana|kami|perusahaan|butuh|ingin|bisa|sistem|tim)\b/ },
    ];
    for (const lang of langPatterns) {
        if (lang.pattern.test(lower)) return { code: lang.code, name: lang.name, rtl: lang.rtl };
    }
    return { code: 'en', name: 'English', rtl: false };
}

function buildMultilingualBlock(lang) {
    const rtlNote = lang.rtl ? `NOTE: ${lang.name} is right-to-left. Format accordingly.` : '';
    return `
MULTILINGUAL ENGINE — CRITICAL:
User's language: ${lang.name} (${lang.code}). ${rtlNote}
ALL THREE EMAILS must be written entirely in ${lang.name}. No exceptions.
Translate subject, salutation, body, CTA, sign-off into ${lang.name}.
Do NOT mix languages. Maintain all tone and sales-logic rules in ${lang.name}.
`;
}

// ─── EMAIL SEQUENCE GENERATOR ─────────────────────────────────────────────────
async function generateEmailSequence(companyData, contactPerson, intent, userProfile, openAiKey, openAiTracker, lang) {
    try {
        const companyName   = companyData.name;
        const mission       = companyData.mission    || null;
        const news          = companyData.recentNews || null;
        const industry      = intent.industry        || 'their industry';
        const businessModel = companyData.model      || 'unknown';
        const senderName    = userProfile?.senderName || 'Alex';
        const usp           = userProfile?.usp        || null;
        const contactName   = contactPerson?.name     || null;
        const contactRole   = contactPerson?.role     || null;
        const firstName     = contactName ? contactName.split(' ')[0] : null;

        const uspToUse = (usp && usp.trim().length > 10)
            ? usp
            : 'We build done-for-you outreach pipelines that replace manual prospecting — so business owners spend time closing, not searching.';

        const industryContext = `
INDUSTRY: ${industry}
BUSINESS TYPE: ${businessModel}
CONTACT ROLE: ${contactRole || 'Business Owner/Decision Maker'}

Write as if you genuinely understand the day-to-day reality of running a ${industry} ${businessModel} business.
Think: what does a ${contactRole || 'owner'} in ${industry} actually struggle with daily?
What does their pipeline look like? What wastes their time?
Reference these realities naturally — do NOT mention this instruction in the email.
The reader should think: "this person actually understands my world."
`;

        const writePrompt = `${buildBannedWordsInstruction()}
${buildMultilingualBlock(lang)}

You are a world-class B2B cold email copywriter. NEVER write generic emails.
Every word is tailored to the recipient's exact business type.

TARGET COMPANY: ${companyName}
${contactName ? `CONTACT: ${contactName} (${contactRole || 'Decision Maker'})` : `CONTACT: Decision maker at ${companyName}`}
${mission ? `COMPANY MISSION: ${mission}` : ''}
${news    ? `RECENT NEWS: ${news}` : ''}
SENDER: ${senderName}
VALUE PROP: ${uspToUse}
${industryContext}

─── EMAIL 1 — INITIAL OUTREACH ───
Subject: 4-6 words. Specific to ${companyName} or ${industry}. NOT generic.
Salutation: "${firstName || 'Hi'}" — alone on its own line. NEVER skip. NEVER "Dear".

Para 1 — Hook:
${news    ? `Reference this specific news: "${news}". 1-2 sentences.`
  : mission ? `Reference this mission: "${mission}". Connect to something real. 1-2 sentences.`
  : `Reference a real specific challenge that ${industry} ${businessModel} businesses face daily.
     Do NOT say "I noticed you are growing" or anything vague.
     Write something a ${contactRole || 'owner'} in ${industry} would read and think "how did they know?"
     1-2 sentences only.`}

Para 2 — Value:
Connect "${uspToUse}" to how it solves the specific problem referenced.
Describe the mechanism — what actually happens. One concrete sentence.
NO invented stats. NO percentages. NO vague promises.

Para 3 — CTA:
One soft ask only. "Worth 15 minutes this week?" — one sentence.

Sign-off: Best, ${senderName}

─── EMAIL 2 — FOLLOW-UP (3 days later) ───
Subject: "Re: " + Email 1 subject exactly.
Salutation: "${firstName || 'Hi'}" — alone on its own line.
Para 1: Add ONE new observation about ${companyName} OR a trend in ${industry} right now. NOT a repeat.
Para 2: Re-state the ask in a fresh way. Max 2 sentences.
Sign-off: Best, ${senderName}

─── EMAIL 3 — BREAK-UP (7 days later) ───
Subject: "Closing my file on ${companyName}"
Salutation: "${firstName || 'Hi'}" — alone on its own line.
3 sentences total. Acknowledge timing. No sell. Leave door open gracefully.
Sign-off: Best, ${senderName}

HARD RULES:
- Every email MUST open with salutation before any other text.
- NEVER invent stats, percentages, or results.
- NEVER use banned words.
- NEVER write an email that could work for any industry unchanged.
- If a plumber and SaaS founder could both receive it unchanged — rewrite it.

Return ONLY valid JSON, no markdown:
{
  "initial":  { "subject": "string", "body": "string" },
  "followup": { "subject": "string", "body": "string" },
  "breakup":  { "subject": "string", "body": "string" }
}`;

        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
            model:       'gpt-4o-mini',
            messages:    [{ role: 'user', content: writePrompt }],
            max_tokens:  900,
            temperature: 0.7,
        }, { headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' } });

        openAiTracker.record(res.data?.usage?.total_tokens || 0);
        const raw = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        return JSON.parse(raw);

    } catch (err) {
        console.warn(`[Email Gen Error] ${err.message}`);
        const name = contactPerson?.name?.split(' ')[0] || 'Hi';
        const senderName = userProfile?.senderName || 'Alex';
        return {
            initial:  { subject: `Quick thought on ${companyData.name}`, body: `${name},\n\nSaw what ${companyData.name} is working on — worth a direct note.\n\n${userProfile?.usp || 'We build outreach pipelines that cut manual prospecting.'}\n\nOpen to 15 minutes this week?\n\nBest,\n${senderName}` },
            followup: { subject: `Re: Quick thought on ${companyData.name}`, body: `${name},\n\nFloating this back up — one thing I noticed about ${intent?.industry || 'your industry'} felt relevant.\n\nStill worth a chat?\n\nBest,\n${senderName}` },
            breakup:  { subject: `Closing my file on ${companyData.name}`, body: `${name},\n\nAssuming timing isn't right — I'll stop following up. Reach out whenever it makes sense.\n\nBest,\n${senderName}` },
        };
    }
}

module.exports = { generateEmailSequence, detectLanguage };
