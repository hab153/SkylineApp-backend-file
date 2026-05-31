// followUpController.js
const Lead = require('./Lead');
const { generateFollowUpSuggestion } = require('./followUpAI');

// POST /api/leads/:leadId/auto-follow-up (toggle auto follow-up on/off)
const toggleAutoFollowUp = async (req, res) => {
    try {
        const { leadId } = req.params;
        const { enabled } = req.body; // true or false

        const lead = await Lead.findOne({ _id: leadId, userId: req.userId });
        if (!lead) {
            return res.status(404).json({ message: 'Lead not found' });
        }

        if (enabled === true) {
            // Turning ON: schedule first follow-up for 3 days from now
            const scheduledDate = new Date();
            scheduledDate.setDate(scheduledDate.getDate() + 3);
            
            lead.autoFollowUpEnabled = true;
            lead.followUpScheduledDate = scheduledDate;
            lead.followUpCount = 0;
            
            await lead.save();
            
            return res.json({ 
                success: true, 
                autoFollowUpEnabled: true, 
                followUpScheduledDate: scheduledDate,
                message: `Auto follow-up enabled. First follow-up scheduled for ${scheduledDate.toLocaleDateString()}`
            });
        } else {
            // Turning OFF
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
        if (!lead) {
            return res.status(404).json({ message: 'Lead not found' });
        }

        // Get last 2-3 messages from conversation
        const messages = lead.replies || [];
        if (messages.length === 0) {
            return res.status(400).json({ 
                message: 'No conversation history to base follow-up on. Send a message first.' 
            });
        }

        // Format messages for AI
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
        if (!lead) {
            return res.status(404).json({ message: 'Lead not found' });
        }

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
