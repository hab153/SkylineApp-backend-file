// aiSuggestionController.js
// UPDATED: Accepts count, batch generation, returns flat array

const { checkAndIncrement } = require('./limitService');
const { generateOutreachSuggestions } = require('./outreachSuggestionService');

const suggestOutreach = async (req, res) => {
    try {
        const userId = req.userId;
        const { leads, count } = req.body;

        // ─── Validate ───
        if (!leads || !Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({ 
                success: false,
                message: 'Leads array is required' 
            });
        }

        // If count not provided, default to leads.length
        const requestedCount = Number(count) || leads.length;
        
        if (requestedCount !== leads.length) {
            return res.status(400).json({
                success: false,
                message: `count (${requestedCount}) must match leads length (${leads.length})`
            });
        }

        if (requestedCount > 50) {
            return res.status(400).json({
                success: false,
                message: 'Maximum 50 leads per request'
            });
        }

        // ─── Check plan-based daily limit ───
        const limitResult = await checkAndIncrement(userId, 'aiSuggestion');

        if (!limitResult.allowed) {
            return res.status(429).json({
                success: false,
                message: `Daily AI suggestion limit reached (${limitResult.limit}/${limitResult.limit}). Upgrade your plan for more calls.`,
                remaining: 0,
                resetAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString()
            });
        }

        // ─── Generate in ONE call ───
        const drafts = await generateOutreachSuggestions(leads, requestedCount);

        // ─── Return flat structure ───
        res.json({
            success: true,
            count: drafts.length,
            drafts: drafts,  // [{leadEmail, subject, message}]
            remainingCalls: limitResult.remaining,
            plan: req.user?.subscriptionTier || 'free'
        });

    } catch (err) {
        console.error('❌ [AI Suggestion Controller] Error:', err.message);
        res.status(500).json({ 
            success: false,
            message: err.message || 'Failed to generate suggestions' 
        });
    }
};

module.exports = { suggestOutreach };
