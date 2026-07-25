// followUpController.js
const Lead = require('./Lead');
const User = require('./User');
const { generateFollowUpSuggestion } = require('./followUpAI');
const { isValidObjectId, sanitizeObject } = require('./sanitize');

// POST /api/leads/:leadId/auto-follow-up (toggle auto follow-up on/off)
const toggleAutoFollowUp = async (req, res) => {
    try {
        const { leadId } = req.params;
        let { enabled, delayDays } = req.body;
        
        console.log(`🔄 [FOLLOW-UP] Toggle auto follow-up for lead ${leadId}:`, { enabled, delayDays });
        
        if (!isValidObjectId(leadId)) {
            return res.status(400).json({ success: false, message: 'Invalid lead ID' });
        }
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ success: false, message: 'Enabled must be a boolean' });
        }
        
        // Sanitize delayDays
        delayDays = delayDays && typeof delayDays === 'number' && delayDays > 0 ? Math.floor(delayDays) : 3;
        if (delayDays > 30) delayDays = 30;

        const lead = await Lead.findOne({ _id: leadId, userId: req.userId });
        if (!lead) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }

        if (enabled === true) {
            // ✅ FIX: Get user properly instead of relying on middleware
            const user = await User.findById(req.userId);
            if (!user) {
                return res.status(500).json({ success: false, message: 'User not found' });
            }

            const scheduledDate = new Date();
            scheduledDate.setDate(scheduledDate.getDate() + delayDays);
            
            lead.autoFollowUpEnabled = true;
            lead.followUpScheduledDate = scheduledDate;
            lead.followUpCount = 0;
            await lead.save();

            if (!user.usage) user.usage = {};
            user.usage.dailyAutoFollowUpCount = (user.usage.dailyAutoFollowUpCount || 0) + 1;
            await user.save();
            
            console.log(`✅ [FOLLOW-UP] Auto follow-up ENABLED for lead ${leadId}, scheduled for ${scheduledDate}`);
            
            return res.json({ 
                success: true, 
                autoFollowUpEnabled: true, 
                followUpScheduledDate: scheduledDate,
                message: `Auto follow-up enabled. First follow-up scheduled in ${delayDays} day(s).`
            });
        } else {
            lead.autoFollowUpEnabled = false;
            lead.followUpScheduledDate = null;
            await lead.save();
            
            console.log(`✅ [FOLLOW-UP] Auto follow-up DISABLED for lead ${leadId}`);
            
            return res.json({ 
                success: true, 
                autoFollowUpEnabled: false,
                message: 'Auto follow-up disabled'
            });
        }
    } catch (err) {
        console.error('❌ Toggle auto follow-up error:', err);
        res.status(500).json({ success: false, message: 'Server error toggling auto follow-up' });
    }
};

// POST /api/leads/:leadId/suggest-follow-up (generate a follow-up suggestion)
const suggestFollowUp = async (req, res) => {
    try {
        const { leadId } = req.params;
        console.log(`💡 [FOLLOW-UP] Suggest follow-up for lead ${leadId}`);
        
        if (!isValidObjectId(leadId)) {
            return res.status(400).json({ success: false, message: 'Invalid lead ID' });
        }

        const lead = await Lead.findOne({ _id: leadId, userId: req.userId });
        if (!lead) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }

        const messages = lead.replies || [];
        if (messages.length === 0) {
            return res.status(400).json({ 
                success: false,
                message: 'No conversation history to base follow-up on. Send a message first.' 
            });
        }

        // Sanitize messages
        const formattedMessages = messages.slice(-3).map(msg => ({
            from: msg.from,
            content: msg.content ? msg.content.replace(/<[^>]*>?/gm, '').substring(0, 500) : '',
            date: msg.date
        }));

        // ✅ FIX: Wrap AI call in try-catch
        let suggestion;
        try {
            suggestion = await generateFollowUpSuggestion(
                formattedMessages,
                lead.name || 'the prospect',
                lead.company || 'the team'
            );
        } catch (aiErr) {
            console.error('❌ AI generation error:', aiErr.message);
            return res.status(500).json({ 
                success: false, 
                message: 'AI service temporarily unavailable. Please try again.' 
            });
        }

        // ✅ FIX: Get user properly instead of relying on middleware
        try {
            const user = await User.findById(req.userId);
            if (user) {
                if (!user.usage) user.usage = {};
                user.usage.dailySuggestFollowUpCount = (user.usage.dailySuggestFollowUpCount || 0) + 1;
                await user.save();
            }
        } catch (userErr) {
            console.warn('⚠️ Could not update usage count:', userErr.message);
        }

        console.log(`✅ [FOLLOW-UP] Suggestion generated for lead ${leadId}`);
        
        res.json({ 
            success: true, 
            suggestion,
            message: 'Follow-up suggestion generated'
        });
    } catch (err) {
        console.error('❌ Suggest follow-up error:', err);
        const errorMsg = err.message || 'Failed to generate follow-up suggestion';
        res.status(500).json({ success: false, message: errorMsg });
    }
};

// GET /api/leads/:leadId/follow-up-status (get current follow-up status)
const getFollowUpStatus = async (req, res) => {
    try {
        const { leadId } = req.params;
        console.log(`📊 [FOLLOW-UP] Get status for lead ${leadId}`);
        
        if (!isValidObjectId(leadId)) {
            return res.status(400).json({ success: false, message: 'Invalid lead ID' });
        }

        const lead = await Lead.findOne({ _id: leadId, userId: req.userId });
        if (!lead) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }

        res.json({
            autoFollowUpEnabled: lead.autoFollowUpEnabled || false,
            followUpScheduledDate: lead.followUpScheduledDate || null,
            lastFollowUpSent: lead.lastFollowUpSent || null,
            followUpCount: lead.followUpCount || 0,
            hasConversation: (lead.replies || []).length > 0
        });
    } catch (err) {
        console.error('❌ Get follow-up status error:', err);
        res.status(500).json({ success: false, message: 'Server error fetching follow-up status' });
    }
};

module.exports = {
    toggleAutoFollowUp,
    suggestFollowUp,
    getFollowUpStatus
};
