const OpenAI = require('openai');
const User = require('./User');
const Lead = require('./Lead');
const ChatMessage = require('./ChatMessage');
const Notification = require('./Notification');
const Company = require('./Company');

// Initialize OpenAI with API key
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Generate a personal assistant response for a user
 * @param {string} userId - The user's MongoDB ID
 * @param {string} userMessage - The user's question/message
 * @returns {Promise<string>} - The AI response
 */
async function generateAssistantResponse(userId, userMessage) {
    console.log('[assist.js] Starting for user:', userId);

    try {
        // 1. Fetch user
        const user = await User.findById(userId).lean();
        if (!user) {
            throw new Error('User not found');
        }

        // 2. Fetch leads (limit 50, sorted newest first)
        const leads = await Lead.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();

        // 3. Fetch chat history (last 50 messages)
        const chatHistory = await ChatMessage.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();

        // 4. Fetch unread notifications
        const notifications = await Notification.find({ userId, isRead: false }).lean();

        // 5. Fetch companies (top 20 by score)
        const companies = await Company.find({}).sort({ leadScore: -1 }).limit(20).lean();

        // 6. Build context with enhanced business insights
        const totalLeads = leads.length;
        const leadsWithReplies = leads.filter(l => l.replies && l.replies.length > 0).length;
        const replyRate = totalLeads > 0 ? Math.round((leadsWithReplies / totalLeads) * 100) : 0;

        // Count industries from companies
        const industryCounts = {};
        companies.forEach(c => {
            const ind = c.industry || 'Unknown';
            industryCounts[ind] = (industryCounts[ind] || 0) + 1;
        });
        const topIndustries = Object.entries(industryCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([ind, count]) => `${ind} (${count})`)
            .join(', ');

        // Average lead score from companies
        const avgScore = companies.length > 0
            ? Math.round(companies.reduce((sum, c) => sum + (c.leadScore || 0), 0) / companies.length)
            : 0;

        const context = {
            user: {
                name: user.name || user.email || 'User',
                email: user.email || 'No email',
                subscriptionTier: user.subscriptionTier || 'free',
                subscriptionEndDate: user.subscriptionEndDate || 'N/A',
                usage: user.usage || {},
                nylasConnected: !!(user.nylasIntegration && user.nylasIntegration.accessToken),
                createdAt: user.createdAt || new Date()
            },
            recentLeads: leads.map(l => ({
                name: l.name || 'Unknown',
                email: l.email || 'No email',
                company: l.company || 'Unknown company',
                status: l.status || 'active',
                replies: (l.replies && l.replies.length) || 0,
                createdAt: l.createdAt || new Date()
            })),
            recentChats: chatHistory.map(c => ({
                role: c.role || 'user',
                content: (c.content && c.content.substring(0, 200)) || '',
                createdAt: c.createdAt || new Date()
            })),
            unreadNotifications: notifications.length,
            recentCompanies: companies.map(c => ({
                name: c.name || 'Unknown',
                domain: c.domain || 'No domain',
                industry: c.industry || 'Unknown',
                leadScore: c.leadScore || 0
            })),
            // Business intelligence stats
            stats: {
                totalLeads,
                leadsWithReplies,
                replyRate,
                topIndustries: topIndustries || 'None detected',
                avgCompanyScore: avgScore
            }
        };

        // 7. Build a powerful business‑consultant system prompt
        const systemPrompt = `You are Skyline, a senior business consultant with 20 years of experience in B2B sales, marketing, and operations.

Your mission: Help the user grow their business by providing actionable, data‑driven advice based on their Skyline data.

Always structure your response like this:
1. **Diagnosis** – What is the core issue or opportunity?
2. **Strategic Options** – What are 2–3 possible approaches?
3. **Recommended Action** – Which option do you recommend and why?
4. **Expected Outcomes** – What results can the user expect?

Be direct, pragmatic, and use the user's actual data (leads, companies, chats) to personalise your answer. If you lack specific data, ask clarifying questions to help the user refine their question.

Use bullet points and clear headings. Avoid vague advice – be specific and concrete.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USER PROFILE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Name: ${context.user.name}
Email: ${context.user.email}
Plan: ${context.user.subscriptionTier.toUpperCase()} (expires: ${context.user.subscriptionEndDate})
Nylas Connected: ${context.user.nylasConnected ? '✅ Yes' : '❌ No'}
Account Created: ${new Date(context.user.createdAt).toLocaleDateString()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DAILY USAGE (limits based on plan)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Chat messages: ${context.user.usage?.dailyCallCount || 0}
Hints used: ${context.user.usage?.dailyHintCount || 0}
Emails sent: ${context.user.usage?.dailySentCount || 0}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BUSINESS INTELLIGENCE (from your data)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total leads: ${context.stats.totalLeads}
Leads with replies: ${context.stats.leadsWithReplies} (${context.stats.replyRate}% reply rate)
Top industries: ${context.stats.topIndustries}
Average company score: ${context.stats.avgCompanyScore}/100

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECENT LEADS (${context.recentLeads.length} shown)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${context.recentLeads.length > 0 ? context.recentLeads.map((l, i) => 
    `${i+1}. ${l.name} (${l.company}) – ${l.email}\n   Status: ${l.status} | Replies: ${l.replies}`
).join('\n') : 'No leads found yet.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECENT CHATS (${context.recentChats.length} shown)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${context.recentChats.length > 0 ? context.recentChats.map((c, i) => 
    `${i+1}. ${c.role.toUpperCase()}: ${c.content}`
).join('\n') : 'No chat history yet.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UNREAD NOTIFICATIONS: ${context.unreadNotifications}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECENT COMPANIES (${context.recentCompanies.length} shown)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${context.recentCompanies.length > 0 ? context.recentCompanies.map((c, i) => 
    `${i+1}. ${c.name} (${c.domain}) – ${c.industry} – Score: ${c.leadScore}`
).join('\n') : 'No companies discovered yet.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Always follow the Diagnosis → Options → Recommendation → Outcomes structure.
2. Use the user's actual data to back your advice. If a lead or company is mentioned, refer to it by name.
3. If the user asks about improving their outreach, suggest specific tactics based on their lead quality and reply rates.
4. If they ask about their plan or limits, reference the usage data and offer upgrade suggestions if appropriate.
5. If you need more context, ask a clarifying question before giving advice.
6. Maintain a professional, direct, and helpful tone. Avoid fluff – be concise and actionable.
7. If asked something completely outside your data, say: "I don't have enough information to answer that, but I can help you with your business data."`;

        // 8. Call OpenAI with a higher token limit for thoughtful reasoning
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini', // you can switch to 'gpt-4o' if you need deeper reasoning
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            max_tokens: 1200,       // increased to allow longer structured responses
            temperature: 0.7
        });

        return response.choices[0].message.content;

    } catch (error) {
        console.error('[assist.js] ERROR:', error);
        console.error('[assist.js] Error stack:', error.stack);
        throw error;
    }
}

module.exports = { generateAssistantResponse };
