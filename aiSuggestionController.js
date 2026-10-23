// aiSuggestionController.js
const { checkAndIncrement } = require('./limitService');
const aiReplyGenerator = require('./aiReplyGenerator'); // Import the whole module

const suggestOutreach = async (req, res) => {
    try {
        const userId = req.userId;

        // ✅ Validate request body first
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

        // Generate suggestions for each lead
        const suggestions = [];
        for (const lead of leads) {
            const prompt = `Generate a personalized outreach email for ${lead.companyName} in the ${lead.industry || 'general'} industry. Contact: ${lead.email}. Keep it professional and concise.`;
            
            // ✅ Safe access to the function regardless of export style
            const suggestionFn = aiReplyGenerator.generateSuggestion || aiReplyGenerator;
            const suggestion = await suggestionFn(prompt);
            
            suggestions.push({
                email: lead.email,
                companyName: lead.companyName,
                suggestedMessage: suggestion
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
