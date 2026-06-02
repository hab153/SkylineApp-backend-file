const Lead = require('./Lead');
const { categorizeLeads, generateAdvice, generateActions } = require('./revenueTrackingAI');

// GET /api/revenue/tracking
const getRevenueTracking = async (req, res) => {
    try {
        const userId = req.userId;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const tier = user.subscriptionTier || 'free';

        // Fetch all leads for this user
        const leads = await Lead.find({ userId }).lean();

        if (!leads.length) {
            return res.json({
                categories: {
                    contacted: [],
                    replied: [],
                    interested: [],
                    ongoing: [],
                    win: []
                },
                advice: null,
                actions: null,
                tier
            });
        }

        // 1. Categorise leads (always done)
        const categories = await categorizeLeads(leads);

        let advice = null;
        let actions = null;

        // 2. For Go and Pro, also generate advice
        if (tier === 'go' || tier === 'pro') {
            advice = await generateAdvice(categories, tier);
        }

        // 3. Only Pro gets actions
        if (tier === 'pro') {
            actions = await generateActions(leads);
        }

        res.json({
            categories,
            advice,
            actions,
            tier
        });
    } catch (err) {
        console.error('Revenue tracking error:', err);
        res.status(500).json({ message: 'Server error generating revenue report' });
    }
};

module.exports = { getRevenueTracking };
