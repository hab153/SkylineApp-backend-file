// followUpController.js
const Lead = require('./Lead');
const { generateFollowUpSuggestion } = require('./followUpAI');

// POST /api/leads/:leadId/auto-follow-up (toggle auto follow-up on/off)
const toggleAutoFollowUp = async (req, res) => {
    try {
        const { leadId } = req.params;
        const { enabled, delayDays } = req.body;

        const lead = await Lead.findOne({ _id: leadId, userId: req.userId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });

        if (enabled === true) {
            // Use user object attached by middleware (checkAutoFollowUpLimit)
            const user = req.userWithAutoLimit;
            if (!user) {
                // Fallback – should not happen because middleware already ran
                return res.status(500).json({ message: 'User not found in request' });
            }

            const days = (delayDays && typeof delayDays === 'number' && delayDays > 0) ? delayDays : 3;
            const scheduledDate = new Date();
            scheduledDate.setDate(scheduledDate.getDate() + days);
            
            lead.autoFollowUpEnabled = true;
            lead.followUpScheduledDate = scheduledDate;
            lead.followUpCount = 0;
            await lead.save();

            // Increment daily auto follow-up counter
            if (!user.usage) user.usage = {};
            user.usage.dailyAutoFollowUpCount = (user.usage.dailyAutoFollowUpCount || 0) + 1;
            await user.save();
            
            return res.json({ 
                success: true, 
                autoFollowUpEnabled: true, 
                followUpScheduledDate: scheduledDate,
                message: `Auto follow-up enabled. First follow-up scheduled in ${days} day(s).`
            });
        } else {
            // Disable
            lead.autoFollowUpEnabled = false;
            lead.followUpScheduledDate = null;
            await lead.save();
            return res.json({ 
                success: true, 
                autoFollowUpEnabled: false,
                message: 'Auto follow-up disabled'
            });
        }
    } catch (err) {
        console.error('Toggle auto follow-up error:', err);
        res.status(500).json({ message: 'Server error toggling auto follow-up' });
    }
};

// POST /api/leads/:leadId/suggest-follow-up (generate a follow-up suggestion)
const suggestFollowUp = async (req, res) => {
    try {
        const { leadId } = req.params;

        const lead = await Lead.findOne({ _id: leadId, userId: req.userId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });

        const messages = lead.replies || [];
        if (messages.length === 0) {
            return res.status(400).json({ 
                message: 'No conversation history to base follow-up on. Send a message first.' 
            });
        }

        const formattedMessages = messages.slice(-3).map(msg => ({
            from: msg.from,
            content: msg.content,
            date: msg.date
        }));

        const suggestion = await generateFollowUpSuggestion(
            formattedMessages,
            lead.name,
            lead.company || 'the team'
        );

        // Increment daily suggest follow-up counter
        const user = req.userWithSuggestLimit;
        if (user) {
            if (!user.usage) user.usage = {};
            user.usage.dailySuggestFollowUpCount = (user.usage.dailySuggestFollowUpCount || 0) + 1;
            await user.save();
        }

        res.json({ 
            success: true, 
            suggestion,
            message: 'Follow-up suggestion generated'
        });
    } catch (err) {
        console.error('Suggest follow-up error:', err);
        const errorMsg = err.message || 'Failed to generate follow-up suggestion';
        res.status(500).json({ message: errorMsg });
    }
};

// GET /api/leads/:leadId/follow-up-status (get current follow-up status)
const getFollowUpStatus = async (req, res) => {
    try {
        const { leadId } = req.params;

        const lead = await Lead.findOne({ _id: leadId, userId: req.userId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });

        res.json({
            autoFollowUpEnabled: lead.autoFollowUpEnabled || false,
            followUpScheduledDate: lead.followUpScheduledDate || null,
            lastFollowUpSent: lead.lastFollowUpSent || null,
            followUpCount: lead.followUpCount || 0,
            hasConversation: (lead.replies || []).length > 0
        });
    } catch (err) {
        console.error('Get follow-up status error:', err);
        res.status(500).json({ message: 'Server error fetching follow-up status' });
    }
};

module.exports = {
    toggleAutoFollowUp,
    suggestFollowUp,
    getFollowUpStatus
};
