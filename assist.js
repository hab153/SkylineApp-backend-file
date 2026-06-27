const OpenAI = require('openai');
const User = require('./User');
const Lead = require('./Lead');
const ChatMessage = require('./ChatMessage');
const Notification = require('./Notification');
const Company = require('./Company');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Generate a personal assistant response for a user
 * @param {string} userId - The user's MongoDB ID
 * @param {string} userMessage - The user's question/message
 * @returns {Promise<string>} - The AI response
 */
async function generateAssistantResponse(userId, userMessage) {
    try {
        // 1. Fetch ALL user data from MongoDB
        const user = await User.findById(userId).lean();
        if (!user) {
            throw new Error('User not found');
        }

        const leads = await Lead.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();
        const chatHistory = await ChatMessage.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();
        const notifications = await Notification.find({ userId, isRead: false }).lean();
        const companies = await Company.find({}).sort({ leadScore: -1 }).limit(20).lean();

        // 2. Build context object with all user data
        const context = {
            user: {
                name: user.name || user.email,
                email: user.email,
                subscriptionTier: user.subscriptionTier || 'free',
                subscriptionEndDate: user.subscriptionEndDate || 'N/A',
                usage: user.usage || {},
                nylasConnected: !!user.nylasIntegration?.accessToken,
                createdAt: user.createdAt || new Date()
            },
            recentLeads: leads.map(l => ({
                name: l.name || 'Unknown',
                email: l.email || 'No email',
                company: l.company || 'Unknown company',
                status: l.status || 'active',
                replies: l.replies?.length || 0,
                createdAt: l.createdAt || new Date()
            })),
            recentChats: chatHistory.map(c => ({
                role: c.role || 'user',
                content: c.content?.substring(0, 200) || '',
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

        // 3. Build system prompt with all context injected
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
Chat messages: ${context.user.usage?.chatCount || 0} / ${context.user.usage?.chatLimit || 0}
Hints used: ${context.user.usage?.hintCount || 0} / ${context.user.usage?.hintLimit || 0}
Emails sent: ${context.user.usage?.emailSent || 0} / ${context.user.usage?.emailLimit || 0}
Suggest follow-ups: ${context.user.usage?.suggestFollowUpCount || 0} / ${context.user.usage?.suggestFollowUpLimit || 0}
Auto follow-ups: ${context.user.usage?.autoFollowUpCount || 0} / ${context.user.usage?.autoFollowUpLimit || 0}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECENT LEADS (${context.recentLeads.length} total)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${context.recentLeads.length > 0 ? context.recentLeads.map((l, i) => 
    `${i+1}. ${l.name} (${l.company}) - ${l.email}\n   Status: ${l.status} | Replies: ${l.replies} | Created: ${new Date(l.createdAt).toLocaleDateString()}`
).join('\n') : 'No leads found yet.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECENT CHATS (${context.recentChats.length} total)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${context.recentChats.length > 0 ? context.recentChats.map((c, i) => 
    `${i+1}. ${c.role.toUpperCase()}: ${c.content}`
).join('\n') : 'No chat history yet.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UNREAD NOTIFICATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${context.unreadNotifications} unread notification${context.unreadNotifications !== 1 ? 's' : ''}

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
4. If asked about a specific company, check the recent companies list.
5. If asked about notifications, tell them how many unread they have.
6. If asked about chat history, reference the recent chats.
7. If the user asks something you cannot answer from the data, say: "I don't have that information in your profile. You can check your dashboard for more details."
8. Always maintain a professional, friendly, and helpful tone.
9. If the user asks about their subscription, tell them their plan and expiry date.
10. If the user asks about email connection, tell them if Nylas is connected or not.

Remember: You are a BUSINESS ASSISTANT, not a general AI. Only use the data provided above.`;

        // 4. Call OpenAI with context
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
        console.error('[assist.js] Error:', error);
        throw new Error('Failed to generate assistant response: ' + error.message);
    }
}

module.exports = { generateAssistantResponse };
