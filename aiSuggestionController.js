// aiSuggestionController.js
const User = require('./User');
const { generateSuggestion } = require('./aiReplyGenerator');

const suggestOutreach = async (req, res) => {
    try {
        const userId = req.userId;
        const user = await User.findById(userId);

        if (!user) return res.status(404).json({ message: 'User not found' });

        // Check daily limit based on subscription tier
        const today = new Date().toDateString();
        const lastCallDate = user.usage.lastAiSuggestionDate
            ? new Date(user.usage.lastAiSuggestionDate).toDateString()
            : null;

        // Reset counter if it's a new day
        if (lastCallDate !== today) {
            user.usage.dailyAiSuggestionCount = 0;
            user.usage.lastAiSuggestionDate = new Date();
        }

        // Define limits by plan
        const limits = { free: 7, go: 15, pro: 35 };
        const currentLimit = limits[user.subscriptionTier] || 7;

        if (user.usage.dailyAiSuggestionCount >= currentLimit) {
            return res.status(429).json({
                success: false,
                message: `Daily AI suggestion limit reached (${currentLimit}/${currentLimit}). Upgrade your plan for more calls.`,
                remaining: 0,
                resetAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString()
            });
        }

        // Validate request body
        const { leads } = req.body;
        if (!leads || !Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({ message: 'Leads array is required' });
        }

        // Generate suggestions for each lead
        const suggestions = [];
        for (const lead of leads) {
            const prompt = `Generate a personalized outreach email for ${lead.companyName} in the ${lead.industry || 'general'} industry. Contact: ${lead.email}. Keep it professional and concise.`;
            const suggestion = await generateSuggestion(prompt);
            suggestions.push({
                email: lead.email,
                companyName: lead.companyName,
                suggestedMessage: suggestion
            });
        }

        // Increment usage counter
        user.usage.dailyAiSuggestionCount += 1;
        await user.save();

        res.json({
            success: true,
            suggestions,
            remainingCalls: currentLimit - user.usage.dailyAiSuggestionCount,
            plan: user.subscriptionTier
        });

    } catch (err) {
        console.error('AI Suggestion Error:', err.message);
        res.status(500).json({ message: 'Failed to generate suggestions' });
    }
};

module.exports = { suggestOutreach };
