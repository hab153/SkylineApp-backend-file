const axios = require('axios');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const MAX_SEARCH_RESULTS = 20; // Reduced slightly for speed in Review mode
const MAX_LEADS_RETURNED = 5;  // Increased to give user more options to review
const TAVILY_LIMIT       = 1000;

// ─── REASONING FILTER ──────────────────────────────────────────────────────────
const REASONING_FILTER = `
⚠️ REASONING FILTER — NON-NEGOTIABLE:
1. You are a strict fact extractor. Use ONLY facts from SNIPPETS.
2. IGNORE training data. If not in snippets, return null.
3. Current year is 2026.
`;

// ─── BANNED WORDS (Keep existing list for quality) ─────────────────────────────
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
    'in today\'s world','in the current landscape','going forward'
];

function buildBannedWordsInstruction() {
    return `BANNED WORDS — NEVER use these: ${BANNED_WORDS.join(', ')}. Replace with specific facts.`;
}

// ─── QUOTA TRACKERS (Keep existing logic) ──────────────────────────────────────
const tavilyQuota = { used: 0, limit: TAVILY_LIMIT, lastReset: Date.now() };
const openAiTracker = { totalCallsThisSession: 0, totalTokensThisSession: 0 };

function checkTavilyReset() {
    const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - tavilyQuota.lastReset >= ONE_MONTH) {
        tavilyQuota.used = 0;
        tavilyQuota.lastReset = Date.now();
    }
}

function getTavilyRemaining() {
    checkTavilyReset();
    return tavilyQuota.limit - tavilyQuota.used;}

function recordTavilyUsage() {
    tavilyQuota.used += 1;
}

function recordOpenAiUsage(fnName, model, tokensUsed) {
    openAiTracker.totalCallsThisSession += 1;
    openAiTracker.totalTokensThisSession += tokensUsed;
}

// ─── TAVILY SEARCH HELPER ──────────────────────────────────────────────────────
async function searchWithTavily(query, tavilyKey, options = {}) {
    if (getTavilyRemaining() <= 0) throw new Error('Tavily quota exhausted');
    
    try {
        const response = await axios.post('https://api.tavily.com/search', {
            api_key: tavilyKey,
            query,
            search_depth: 'advanced',
            max_results: options.maxResults || 5,
            include_answer: false,
            include_raw_content: false,
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });

        recordTavilyUsage();
        return (response.data?.results || []).map(r => ({
            title: r.title || '',
            url: r.url || '',
            snippet: r.content || '',
            date: r.published_date || null,
        }));
    } catch (err) {
        console.warn(`[Tavily Error] ${err.message}`);
        return [];
    }
}

// ─── COMPANY RESEARCH HELPER (Simplified for Speed/JSON Output) ───────────────
async function researchCompanyForLead(companyName, tavilyKey, openAiKey) {
    if (getTavilyRemaining() <= 0) return null;

    try {
        // 1. Search for basic info and recent news
        const results = await searchWithTavily(
            `${companyName} about us mission headquarters employees news 2025 2026`, 
            tavilyKey, { maxResults: 5 }
        );

        if (results.length === 0) return null;
        const snippets = results.map(r => `SOURCE: ${r.url}\n${r.snippet}`).join('\n\n');

        // 2. Extract structured data using GPT-4o-mini
        const extractPrompt = `${REASONING_FILTER}
Extract details for "${companyName}" from snippets. Return ONLY valid JSON:
{
  "mission": "string or null",
  "hq": "city, country or null",
  "size": "1-10 | 11-50 | 51-200 | 200+ | unknown",
  "model": "B2B | B2C | SaaS | Services | unknown",
  "recentNews": "one sentence summary of most recent relevant news or null"
}
SNIPPETS:
${snippets}`;

        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: extractPrompt }],
            max_tokens: 300,
            temperature: 0.1,
        }, { headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' } });

        recordOpenAiUsage('researchCompany', 'gpt-4o-mini', res.data?.usage?.total_tokens || 0);
        
        const raw = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        return JSON.parse(raw);

    } catch (err) {
        console.warn(`[Research Error] ${err.message}`);
        return null;
    }
}

// ─── EMAIL GENERATION HELPER ───────────────────────────────────────────────────
async function generateEmailForLead(companyData, userProfile, openAiKey) {
    try {
        const companyName = companyData.name;
        const mission = companyData.mission || 'your business';
        const news = companyData.recentNews || 'recent growth';
        
        const senderName = userProfile?.senderName || 'User';
        const usp = userProfile?.usp || 'We help businesses grow with AI automation.';

        const writePrompt = `${buildBannedWordsInstruction()}
Write a cold email to ${companyName}.
SENDER USP: ${usp}
SENDER NAME: ${senderName}
COMPANY INFO: Mission: ${mission}. Recent News: ${news}.
RULES:
1. Subject Line: Max 5 words. Specific. No "Hello" or "Introduction".
2. Body: 3 short paragraphs.
   - Para 1: Hook based on ${news} or ${mission}.
   - Para 2: Connect to ${usp}. Be specific.
   - Para 3: Soft CTA (e.g., "Open to a quick chat?").
3. Tone: Professional but human.
4. NO banned words.

Return ONLY valid JSON:
{
  "subject": "string",
  "body": "string"
}`;

        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: writePrompt }],
            max_tokens: 400,
            temperature: 0.7,
        }, { headers: { 'Authorization': `Bearer ${openAiKey}`, 'Content-Type': 'application/json' } });

        recordOpenAiUsage('generateEmail', 'gpt-4o-mini', res.data?.usage?.total_tokens || 0);
        
        const raw = res.data.choices[0].message.content.trim().replace(/```json|```/g, '');
        return JSON.parse(raw);

    } catch (err) {
        console.warn(`[Email Gen Error] ${err.message}`);
        return {
            subject: `Quick question for ${companyData.name}`,
            body: `Hi Team,\n\nI noticed ${companyData.name} is growing. We help companies like yours streamline operations.\n\nOpen to a quick chat?\n\nBest,\n${userProfile?.senderName || 'User'}`
        };
    }
}

// ─── MAIN FUNCTION: generateFreeResponse ───────────────────────────────────────
async function generateFreeResponse(message, history, userProfile) {
    try {
        console.log('🟢 [FREE AI] Processing Lead Generation...');

        const apiKey = process.env.OPENAI_API_KEY;
        const tavilyKey = process.env.TAVILY_API_KEY;

        // 1. Parse Intent (What is the user looking for?)
        const intentPrompt = `Extract search parameters from: "${message}".
Return JSON: { "target": "description of ideal customer", "industry": "niche", "location": "place or null" }`;
        
        let target = "businesses needing logo design"; // Default fallback
        let industry = "design";        
        try {
            const intentRes = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: intentPrompt }],
                max_tokens: 100,
            }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
            
            const intent = JSON.parse(intentRes.data.choices[0].message.content.replace(/```json|```/g, ''));
            if (intent.target) target = intent.target;
            if (intent.industry) industry = intent.industry;
        } catch (e) { console.warn('Intent parse failed, using defaults'); }

        // 2. Search for Companies
        const query = `${target} ${industry} companies site:linkedin.com OR site:crunchbase.com`;
        const rawResults = await searchWithTavily(query, tavilyKey, { maxResults: 10 });

        if (rawResults.length === 0) {
            return {
                reply: "I couldn't find any matches for that criteria. Try being more specific.",
                updatedHistory: [...history, { role: 'user', content: message }, { role: 'assistant', content: "No leads found." }]
            };
        }

        // 3. Process Top Leads into JSON Structure
        const leadsToReturn = [];
        const seenDomains = new Set();

        for (const result of rawResults) {
            if (leadsToReturn.length >= MAX_LEADS_RETURNED) break;
            
            // Simple domain extraction to avoid duplicates
            let domain = '';
            try { domain = new URL(result.url).hostname; } catch {}
            if (seenDomains.has(domain)) continue;
            seenDomains.add(domain);

            // Extract Company Name from Title/URL
            let companyName = result.title.split('|')[0].trim() || domain.split('.')[1] || 'Unknown Company';
            if (companyName.length > 30) companyName = companyName.substring(0, 30);

            // Research Company Details
            const companyData = await researchCompanyForLead(companyName, tavilyKey, apiKey);
            
            // Generate Email
            const emailDraft = await generateEmailForLead({
                name: companyName,
                mission: companyData?.mission,
                recentNews: companyData?.recentNews
            }, userProfile, apiKey);
            // Guess Email (Simple heuristic for demo)
            const guessedEmail = `contact@${domain}`;

            leadsToReturn.push({
                name: companyName,
                company: companyName,
                email: guessedEmail,
                role: companyData?.model === 'B2B' ? 'Decision Maker' : 'Owner',
                messages: [
                    {
                        type: "initial",
                        subject: emailDraft.subject,
                        body: emailDraft.body
                    },
                    {
                        type: "followup",
                        subject: `Re: ${emailDraft.subject}`,
                        body: `Hi there,\n\nJust floating this to the top of your inbox. Would love to connect regarding ${companyName}'s growth.\n\nBest,`
                    },
                    {
                        type: "breakup",
                        subject: "Closing file",
                        body: `Hi,\n\nAssuming this isn't a priority right now. I'll close my file. Feel free to reach out in the future.\n\nBest,`
                    }
                ]
            });
        }

        // 4. Return Structured JSON for Frontend
        // The frontend will detect this JSON and render the Review Panel
        const jsonReply = JSON.stringify(leadsToReturn);

        return {
            reply: jsonReply, // This triggers the UI change in page.html
            updatedHistory: [...history, { role: 'user', content: message }, { role: 'assistant', content: `[Generated ${leadsToReturn.length} leads for review]` }]
        };

    } catch (error) {
        console.error('❌ [FREE AI] Error:', error.message);
        return {
            reply: "An error occurred while generating leads. Please try again.",
            updatedHistory: history
        };
    }
}

module.exports = { generateFreeResponse };
