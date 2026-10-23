// aiSuggestionController.js
const { checkAndIncrement } = require('./limitService');
const { generateAIReply } = require('./aiReplyGenerator');

const suggestOutreach = async (req, res) => {
    try {
        const userId = req.userId;
        const { leads } = req.body;

        if (!leads || !Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({ message: 'Leads array is required' });
        }

        // ✅ Check and increment AI suggestion limit via limitService
        const limitResult = await checkAndIncrement(userId, 'aiSuggestion');

        if (!limitResult.allowed) {
            return res.status(429).json({
                success: false,
                message: `Daily AI suggestion limit reached (${limitResult.limit}/${limitResult.limit}). Upgrade your plan for more calls.`,
                remaining: 0,
                resetAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString()
            });
        }

        // Generate suggestions using your existing production v6.0 engine
        const suggestions = [];
        for (const lead of leads) {
            // Craft a focused instruction set for outreach generation
            const instructions = `Generate a personalized, professional outreach email for ${lead.companyName} in the ${lead.industry || 'general'} industry. Contact: ${lead.email}. Keep it concise, value-driven, and end with a clear call to action.`;
            
            // Call your existing engine with minimal context to get a clean reply
            const result = await generateAIReply(
                `Draft an initial outreach message for this lead.`, 
                instructions,
                lead.companyName,
                [], // Empty history for fresh outreach
                { mode: 'draft', tone: 'professional' }
            );

            suggestions.push({
                email: lead.email,
                companyName: lead.companyName,
                suggestedMessage: result.reply || result.reasoning || 'Unable to generate suggestion at this time.'
            });
        }

        res.json({
            success: true,
            suggestions,
            remainingCalls: limitResult.remaining,
            plan: req.user?.subscriptionTier || 'free'
        });

    } catch (err) {
        console.error('AI Suggestion Error:', err.message);
        res.status(500).json({ message: 'Failed to generate suggestions' });
    }
};

module.exports = { suggestOutreach };
