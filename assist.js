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

        // 2. Fetch leads
        const leads = await Lead.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();

        // 3. Fetch chat history
        const chatHistory = await ChatMessage.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();

        // 4. Fetch notifications
        const notifications = await Notification.find({ userId, isRead: false }).lean();

        // 5. Fetch companies
        const companies = await Company.find({}).sort({ leadScore: -1 }).limit(20).lean();

        // 6. Build context
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
            }))
        };

        // 7. Build system prompt
        const systemPrompt = `You are Skyline, a personal business assistant for a lead generation platform user.
You have COMPLETE access to the user's data. Answer questions based ONLY on the provided context below.
If asked something outside your knowledge, say "I don't have that information in your profile."

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
RECENT LEADS (${context.recentLeads.length} total)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${context.recentLeads.length > 0 ? context.recentLeads.map((l, i) => 
    `${i+1}. ${l.name} (${l.company}) - ${l.email}\n   Status: ${l.status} | Replies: ${l.replies}`
).join('\n') : 'No leads found yet.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECENT CHATS (${context.recentChats.length} total)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${context.recentChats.length > 0 ? context.recentChats.map((c, i) => 
    `${i+1}. ${c.role.toUpperCase()}: ${c.content}`
).join('\n') : 'No chat history yet.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UNREAD NOTIFICATIONS: ${context.unreadNotifications}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECENT COMPANIES (${context.recentCompanies.length} total)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${context.recentCompanies.length > 0 ? context.recentCompanies.map((c, i) => 
    `${i+1}. ${c.name} (${c.domain}) - ${c.industry} - Score: ${c.leadScore}`
).join('\n') : 'No companies discovered yet.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Be concise and helpful. Use bullet points when listing multiple items.
2. If asked about leads, summarize from the recent leads list above.
3. If asked about plan/limits, use the usage data above.
4. If asked about notifications, tell them how many unread they have.
5. Always maintain a professional, friendly, and helpful tone.
6. If asked something you cannot answer from the data, say: "I don't have that information in your profile."`;

        // 8. Call OpenAI
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            max_tokens: 800,
            temperature: 0.7
        });

        return response.choices[0].message.content;

    } catch (error) {
        console.error('[assist.js] ERROR:', error);
        console.error('[assist.js] Error stack:', error.stack);
        throw error;
    }
}

// EXPORT - MAKE SURE THIS IS CORRECT
module.exports = { generateAssistantResponse };
