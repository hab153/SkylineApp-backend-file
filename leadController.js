const Lead = require('./Lead');
const { sendEmail, getThreads } = require('./nylasService'); // Updated import
const { isValidObjectId, sanitizeQuery, sanitizeObject, sanitizeEmail } = require('./sanitize');

// GET /api/conversations
const getConversations = async (req, res) => {
    try {
        if (!req.userId) {
            console.error('❌ [getConversations] No userId in request');
            return res.status(401).json({ message: 'Unauthorized: No user ID' });
        }
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        console.log(`📡 [getConversations] Fetching leads for userId: ${req.userId}`);
        const query = sanitizeQuery({ userId: req.userId });
        const leads = await Lead.find(query).sort({ lastContactDate: -1 }).limit(50);
        console.log(`✅ [getConversations] Found ${leads.length} leads`);
        const conversations = leads.map(lead => {
            const lastReply = lead.replies?.length > 0 ? lead.replies[lead.replies.length - 1] : null;
            const preview = lastReply
                ? lastReply.content.replace(/<[^>]*>?/gm, '').substring(0, 50)
                : "No messages yet";
            return {
                id: lead._id,
                name: lead.name,
                company: lead.company,
                email: lead.email,
                status: lead.status,
                lastMessage: preview,
                lastDate: lead.lastContactDate,
                unread: !lastReply || lastReply.from === 'lead',
                autoReplyEnabled: lead.autoReplyEnabled
            };
        });
        res.json(conversations);
    } catch (err) {
        console.error('❌ [getConversations] Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// GET /api/conversations/:leadId
const getConversationById = async (req, res) => {
    try {
        if (!req.userId) {
            console.error('❌ [getConversationById] No userId');
            return res.status(401).json({ message: 'Unauthorized' });
        }
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        const { leadId } = req.params;
        if (!isValidObjectId(leadId)) {
            return res.status(400).json({ message: 'Invalid lead ID' });
        }
        console.log(`📡 [getConversationById] Fetching lead ${leadId} for user ${req.userId}`);
        const query = sanitizeQuery({ _id: leadId, userId: req.userId });
        const lead = await Lead.findOne(query);
        if (!lead) {
            console.warn(`⚠️ [getConversationById] Lead not found`);
            return res.status(404).json({ message: 'Conversation not found' });
        }
        const cleanHistory = (lead.replies || []).map(msg => ({
            ...msg.toObject(),
            content: msg.content.replace(/<[^>]*>?/gm, '')
        }));
        res.json({
            lead: {
                id: lead._id,
                name: lead.name,
                email: lead.email,
                company: lead.company,
                status: lead.status,
                autoReplyEnabled: lead.autoReplyEnabled,
                autoReplyInstructions: lead.autoReplyInstructions
            },
            messages: cleanHistory
        });
    } catch (err) {
        console.error('❌ [getConversationById] Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// PUT /api/leads/:leadId/rename
const renameLead = async (req, res) => {
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!isValidObjectId(req.userId) || !isValidObjectId(req.params.leadId)) {
            return res.status(400).json({ message: 'Invalid ID' });
        }
        const { newName } = req.body;
        if (!newName || typeof newName !== 'string' || newName.trim() === '') {
            return res.status(400).json({ message: 'New name is required' });
        }
        const sanitizedNewName = newName.trim().slice(0, 100);
        const query = sanitizeQuery({ _id: req.params.leadId, userId: req.userId });
        const lead = await Lead.findOne(query);
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        lead.name = sanitizedNewName;
        await lead.save();
        console.log(`✏️ [renameLead] Lead ${lead._id} renamed to ${lead.name}`);
        res.json({ success: true, newName: lead.name });
    } catch (err) {
        console.error('❌ [renameLead] Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// PUT /api/leads/:leadId/auto-reply
const updateAutoReply = async (req, res) => {
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!isValidObjectId(req.userId) || !isValidObjectId(req.params.leadId)) {
            return res.status(400).json({ message: 'Invalid ID' });
        }
        const { enabled, instructions } = req.body;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ message: 'Enabled must be a boolean' });
        }
        const sanitizedInstructions = instructions ? instructions.trim().slice(0, 2000) : '';
        const query = sanitizeQuery({ _id: req.params.leadId, userId: req.userId });
        const lead = await Lead.findOne(query);
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        lead.autoReplyEnabled = enabled;
        if (instructions !== undefined) lead.autoReplyInstructions = sanitizedInstructions;
        await lead.save();
        console.log(`🤖 [updateAutoReply] Lead ${lead._id} auto-reply enabled=${enabled}`);
        res.json({ success: true, enabled: lead.autoReplyEnabled, instructions: lead.autoReplyInstructions });
    } catch (err) {
        console.error('❌ [updateAutoReply] Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// POST /api/leads/batch-send
const batchSend = async (req, res) => {
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        console.log(`📧 [batchSend] Starting batch send for user ${req.userId}`);

        const { leads } = req.body;
        if (!Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({ message: 'Leads array is required' });
        }

        // Check Nylas connection via EmailAccount model
        const EmailAccount = require('./EmailAccount');
        const account = await EmailAccount.findOne({ userId: req.userId, isConnected: true });
        if (!account) {
            return res.status(401).json({
                success: false,
                error: 'NYLAS_DISCONNECTED',
                message: 'Please connect your email account first.'
            });
        }

        // Sanitize each lead
        const sanitizedLeads = leads.map(lead => ({
            name: lead.name ? lead.name.trim().slice(0, 100) : '',
            email: sanitizeEmail(lead.email),
            company: lead.company ? lead.company.trim().slice(0, 100) : '',
            messages: (lead.messages || []).map(msg => ({
                subject: msg.subject ? msg.subject.trim().slice(0, 200) : '',
                body: msg.body ? msg.body.trim().slice(0, 10000) : ''
            }))
        }));

        let sentCount = 0;
        let errors = [];
        const now = new Date();

        for (const leadData of sanitizedLeads) {
            try {
                if (!leadData.email) {
                    errors.push({ email: 'missing', error: 'Email is required' });
                    continue;
                }

                let lead = await Lead.findOne({ email: leadData.email, userId: req.userId });
                if (!lead) {
                    lead = new Lead({
                        userId: req.userId,
                        name: leadData.name || 'Unknown',
                        email: leadData.email,
                        company: leadData.company || '',
                        status: 'Contacted',
                        lastContactDate: now,
                        followUpCount: 0
                    });
                } else {
                    lead.status = 'Contacted';
                    lead.lastContactDate = now;
                }

                if (leadData.messages?.length > 0) {
                    if (!lead.replies) lead.replies = [];
                    lead.replies.push({
                        date: now,
                        content: leadData.messages[0].body,
                        subject: leadData.messages[0].subject,
                        from: 'ai',
                        status: 'sent'
                    });
                    lead.followUpCount = (lead.followUpCount || 0) + 1;
                }
                await lead.save();

                if (leadData.messages?.length > 0) {
                    // Use new service function
                    const result = await sendEmail(
                        req.userId,
                        leadData.email,
                        leadData.messages[0].subject,
                        leadData.messages[0].body
                    );
                    
                    if (result.success) {
                        sentCount++;
                        console.log(`✅ [batchSend] Email sent to ${leadData.email}`);
                    } else {
                        throw new Error(result.error);
                    }
                }
            } catch (err) {
                console.error(`❌ [batchSend] Error sending to ${leadData.email}:`, err.message);
                errors.push({ email: leadData.email, error: err.message });
                // Update lead status to failed
                try {
                    const lead = await Lead.findOne({ email: leadData.email, userId: req.userId });
                    if (lead) {
                        lead.status = 'Failed';
                        await lead.save();
                    }
                } catch (saveErr) {
                    // Ignore
                }
            }
        }

        res.json({ success: true, message: `Sent ${sentCount} emails.`, errors });
    } catch (err) {
        console.error('❌ [batchSend] Error:', err);
        res.status(500).json({ message: 'Server Error during batch send' });
    }
};

// POST /api/reconnect-and-send
const reconnectAndSend = async (req, res) => {
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        console.log(`🔄 [reconnectAndSend] For user ${req.userId}`);

        const EmailAccount = require('./EmailAccount');
        const account = await EmailAccount.findOne({ userId: req.userId, isConnected: true });
        if (!account) {
            return res.status(401).json({
                success: false,
                error: 'NYLAS_DISCONNECTED',
                message: 'Please connect your email account first.'
            });
        }

        const leadsWithPending = await Lead.find({ userId: req.userId, 'replies.status': 'pending' });
        let sentCount = 0;
        for (const lead of leadsWithPending) {
            const pendingMessages = lead.replies.filter(r => r.status === 'pending');
            for (const msg of pendingMessages) {
                try {
                    // Use new service function
                    const result = await sendEmail(
                        req.userId,
                        lead.email,
                        msg.subject || 'Re: Conversation',
                        msg.content
                    );
                    if (result.success) {
                        msg.status = 'sent';
                        sentCount++;
                    } else {
                        msg.status = 'failed';
                    }
                } catch (err) {
                    console.error(`❌ [reconnectAndSend] Failed for ${lead.email}:`, err.message);
                    msg.status = 'failed';
                }
            }
            await lead.save();
        }
        res.json({ success: true, sentCount });
    } catch (err) {
        console.error('❌ [reconnectAndSend] Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// GET /api/leads
const getAllLeads = async (req, res) => {
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        const query = sanitizeQuery({ userId: req.userId });
        const leads = await Lead.find(query).sort({ createdAt: -1 });
        res.json(leads);
    } catch (err) {
        console.error('❌ [getAllLeads] Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = {
    getConversations,
    getConversationById,
    renameLead,
    updateAutoReply,
    batchSend,
    reconnectAndSend,
    getAllLeads
};
