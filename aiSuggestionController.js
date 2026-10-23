// aiSuggestionController.js
const { checkAndIncrement } = require('./limitService');
const { generateOutreachSuggestion } = require('./outreachSuggestionService');

const suggestOutreach = async (req, res) => {
    try {
        const userId = req.userId;
        const { leads } = req.body;

        if (!leads || !Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({ message: 'Leads array is required' });
        }

        // ✅ Check plan-based daily limit BEFORE calling AI
        const limitResult = await checkAndIncrement(userId, 'aiSuggestion');

        if (!limitResult.allowed) {
            return res.status(429).json({
                success: false,
                message: `Daily AI suggestion limit reached (${limitResult.limit}/${limitResult.limit}). Upgrade your plan for more calls.`,
                remaining: 0,
                resetAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString()
            });
        }

        // ✅ Generate suggestions using dedicated outreach service
        const suggestions = [];
        for (const lead of leads) {
            const message = await generateOutreachSuggestion({
                companyName: lead.companyName,
                email: lead.email,
                industry: lead.industry || ''
            });

            suggestions.push({
                email: lead.email,
                companyName: lead.companyName,
                suggestedMessage: message
            });
        }

        res.json({
            success: true,
            suggestions,
            remainingCalls: limitResult.remaining,
            plan: req.user?.subscriptionTier || 'free'
        });

    } catch (err) {
        console.error('AI Suggestion Controller Error:', err.message);
        res.status(500).json({ message: 'Failed to generate suggestions' });
    }
};

module.exports = { suggestOutreach };
