const OpenAI = require('openai');
const User = require('./User');
const Lead = require('./Lead');
const ChatMessage = require('./ChatMessage');
const Notification = require('./Notification');
const Company = require('./Company');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generateAssistantResponse(userId, userMessage) {
    console.log('[assist.js] Starting for user:', userId);

    try {
        const user = await User.findById(userId).lean();
        if (!user) throw new Error('User not found');

        const leads = await Lead.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();
        const chatHistory = await ChatMessage.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();
        const notifications = await Notification.find({ userId, isRead: false }).lean();
        const companies = await Company.find({}).sort({ leadScore: -1 }).limit(20).lean();

        // Calculate business stats
        const totalLeads = leads.length;
        const leadsWithReplies = leads.filter(l => l.replies && l.replies.length > 0).length;
        const replyRate = totalLeads > 0 ? Math.round((leadsWithReplies / totalLeads) * 100) : 0;

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
            stats: {
                totalLeads,
                leadsWithReplies,
                replyRate,
                topIndustries: topIndustries || 'None detected',
                avgCompanyScore: avgScore
            }
        };

        // Updated system prompt: friendly, smart, and natural
        const systemPrompt = `You are Skyline, a friendly and smart business assistant.

You help users understand their business data and make better decisions. You have access to their leads, companies, chat history, and usage stats.

Your style: warm, clear, and practical. Give useful insights without being overly formal. Use bullet points only when they help clarity. If you notice something interesting in their data, point it out. If they ask for advice, give concrete suggestions based on what you see.

Important: always base your answers on the data provided below. If you don't know something, say so and offer to help them find it.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USER PROFILE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Name: ${context.user.name}
Email: ${context.user.email}
Plan: ${context.user.subscriptionTier.toUpperCase()} (expires: ${context.user.subscriptionEndDate})
Nylas Connected: ${context.user.nylasConnected ? '✅ Yes' : '❌ No'}
Account Created: ${new Date(context.user.createdAt).toLocaleDateString()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DAILY USAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Chat messages: ${context.user.usage?.dailyCallCount || 0}
Hints used: ${context.user.usage?.dailyHintCount || 0}
Emails sent: ${context.user.usage?.dailySentCount || 0}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BUSINESS SNAPSHOT (from your data)
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
- Be warm, helpful, and practical.
- Use the data to answer questions and give advice.
- If the user asks about leads, summarise them and highlight interesting ones.
- If they ask about their plan or limits, tell them clearly.
- If they ask for recommendations, base them on their actual data.
- If you need more info, ask a friendly follow‑up question.
- Keep answers concise but thorough – no fluff, just useful insight.`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            max_tokens: 900,
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
