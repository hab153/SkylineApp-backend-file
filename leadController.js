const Lead = require('./Lead');
const { sendEmail, getThreads } = require('./nylasService');
const { isValidObjectId, sanitizeQuery, sanitizeObject, sanitizeEmail } = require('./sanitize');

// ──────────────────────────────────────────────────────────────
//  GET /api/conversations - ✅ FIXED: NO .lean()
// ──────────────────────────────────────────────────────────────
const getConversations = async (req, res) => {
    console.log('🔵 [getConversations] ENTERED - userId:', req.userId);
    try {
        if (!req.userId) {
            console.error('❌ [getConversations] No userId in request');
            return res.status(401).json({ message: 'Unauthorized: No user ID' });
        }
        if (!isValidObjectId(req.userId)) {
            console.error('❌ [getConversations] Invalid userId format:', req.userId);
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        console.log(`📡 [getConversations] Fetching leads for userId: ${req.userId}`);
        const query = sanitizeQuery({ userId: req.userId });
        
        // ✅ FIX: Remove .lean() - getters will auto-decrypt emails
        const leads = await Lead.find(query)
            .sort({ lastContactDate: -1 })
            .limit(50);
            
        console.log(`✅ [getConversations] Found ${leads.length} leads`);
        
        const conversations = leads.map(lead => {
            const replies = lead.replies || [];
            const lastReply = replies.length > 0 ? replies[replies.length - 1] : null;
            const preview = lastReply
                ? lastReply.content.replace(/<[^>]*>?/gm, '').substring(0, 50)
                : "No messages yet";
            
            const unreadCount = replies.filter(r => r.from === 'lead' && !r.read).length || 0;
            const email = lead.email || '';
            
            return {
                id: lead._id.toString(),
                name: lead.name || 'Unknown',
                company: lead.company || '',
                email: email,
                status: lead.status || 'New',
                lastMessage: preview,
                lastDate: lead.lastContactDate || lead.createdAt,
                unreadCount: unreadCount > 0 ? unreadCount : 0,
                unread: unreadCount > 0,
                autoReplyEnabled: lead.autoReplyEnabled || false,
                autoReplyInstructions: lead.autoReplyInstructions || ''
            };
        });
        
        console.log(`📤 [getConversations] Returning ${conversations.length} conversations`);
        res.json(conversations);
    } catch (err) {
        console.error('❌ [getConversations] Error:', err);
        console.error('❌ [getConversations] Error stack:', err.stack);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ──────────────────────────────────────────────────────────────
//  GET /api/conversations/:leadId - ✅ FIXED
// ──────────────────────────────────────────────────────────────
const getConversationById = async (req, res) => {
    console.log('🔵 [getConversationById] ENTERED - leadId:', req.params.leadId);
    
    try {
        if (!req.userId) {
            console.error('❌ [getConversationById] No userId');
            return res.status(401).json({ message: 'Unauthorized' });
        }
        if (!isValidObjectId(req.userId)) {
            console.error('❌ [getConversationById] Invalid userId format');
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        const { leadId } = req.params;
        
        if (!isValidObjectId(leadId)) {
            console.error('❌ [getConversationById] Invalid leadId format:', leadId);
            return res.status(400).json({ message: 'Invalid lead ID format' });
        }
        
        console.log(`📡 [getConversationById] Fetching lead ${leadId} for user ${req.userId}`);
        const query = sanitizeQuery({ _id: leadId, userId: req.userId });
        
        // ✅ FIX: Remove .lean() - getters will auto-decrypt emails
        const lead = await Lead.findOne(query);
        if (!lead) {
            console.warn(`⚠️ [getConversationById] Lead not found for leadId: ${leadId}, userId: ${req.userId}`);
            return res.status(404).json({ message: 'Conversation not found' });
        }
        console.log(`✅ [getConversationById] Lead found: ${lead.name}`);
        
        const email = lead.email || '';
        
        // Mark replies as read
        if (lead.replies && lead.replies.length > 0) {
            const unreadReplies = lead.replies.filter(r => r.from === 'lead' && !r.read);
            if (unreadReplies.length > 0) {
                await Lead.updateOne(
                    { _id: leadId },
                    { $set: { 'replies.$[elem].read': true } },
                    { arrayFilters: [{ 'elem.from': 'lead', 'elem.read': false }] }
                );
                console.log(`📖 [getConversationById] Marked ${unreadReplies.length} replies as read`);
            }
        }
        
        // Fetch messages from ChatMessage
        const ChatMessage = require('./ChatMessage');
        console.log(`📡 [getConversationById] Fetching ChatMessages with sessionId: ${leadId}`);
        
        const chatMessages = await ChatMessage.find({
            userId: req.userId,
            sessionId: leadId
        })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
        
        console.log(`📊 [getConversationById] Found ${chatMessages.length} messages in ChatMessage`);
        
        // ✅ FIX: Convert ChatMessage to format - CORRECT from mapping
        const chatMessagesFormatted = chatMessages.reverse().map(msg => ({
            date: msg.createdAt || new Date(),
            content: msg.content || '',
            subject: msg.title || '',
            from: msg.role === 'user' ? 'ai' : 'lead',
            emailId: msg._id.toString(),
            isChatMessage: true,
            read: true
        }));
        
        // Merge both sources
        let allMessages = lead.replies || [];
        
        if (chatMessagesFormatted.length > 0) {
            allMessages = [...allMessages, ...chatMessagesFormatted];
            allMessages.sort((a, b) => {
                const dateA = a.date ? new Date(a.date) : new Date(0);
                const dateB = b.date ? new Date(b.date) : new Date(0);
                return dateA - dateB;
            });
            
            if (allMessages.length > 50) {
                allMessages = allMessages.slice(-50);
                console.log(`📊 [getConversationById] Trimmed to last 50 messages`);
            }
        }
        
        const cleanHistory = allMessages.map(msg => ({
            ...msg,
            content: msg.content || ''
        }));
        
        console.log(`📤 [getConversationById] Returning ${cleanHistory.length} messages`);
        
        res.json({
            lead: {
                id: lead._id.toString(),
                name: lead.name,
                email: email,
                company: lead.company,
                status: lead.status,
                autoReplyEnabled: lead.autoReplyEnabled || false,
                autoReplyInstructions: lead.autoReplyInstructions || ''
            },
            messages: cleanHistory
        });
    } catch (err) {
        console.error('❌ [getConversationById] Error:', err);
        console.error('❌ [getConversationById] Error stack:', err.stack);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ──────────────────────────────────────────────────────────────
//  PUT /api/leads/:leadId/rename
// ──────────────────────────────────────────────────────────────
const renameLead = async (req, res) => {
    console.log('🔵 [renameLead] ENTERED - leadId:', req.params.leadId);
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

// ──────────────────────────────────────────────────────────────
//  PUT /api/leads/:leadId/auto-reply
// ──────────────────────────────────────────────────────────────
const updateAutoReply = async (req, res) => {
    console.log('🔵 [updateAutoReply] ENTERED - leadId:', req.params.leadId);
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

// ──────────────────────────────────────────────────────────────
//  POST /api/leads/batch-send - ✅ FIXED
// ──────────────────────────────────────────────────────────────
const batchSend = async (req, res) => {
    console.log('🔵 [batchSend] ENTERED');
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        console.log(`📧 [batchSend] Starting batch send for user ${req.userId}`);

        const { leads, leadId } = req.body;
        if (!Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({ message: 'Leads array is required' });
        }
        console.log(`📧 [batchSend] Processing ${leads.length} leads`);
        console.log(`📧 [batchSend] leadId provided: ${leadId || 'none'}`);

        const EmailAccount = require('./EmailAccount');
        const account = await EmailAccount.findOne({ userId: req.userId, isConnected: true });
        if (!account) {
            console.error('❌ [batchSend] No Nylas connection found for user:', req.userId);
            return res.status(401).json({
                success: false,
                error: 'NYLAS_DISCONNECTED',
                message: 'Please connect your email account first.'
            });
        }
        console.log(`✅ [batchSend] Nylas account found for user`);

        const ChatMessage = require('./ChatMessage');

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

        // ✅ CRITICAL FIX: Determine which lead to use
        let targetLead = null;

        // ✅ If leadId is provided, find the existing lead
        if (leadId && isValidObjectId(leadId)) {
            console.log(`🔍 [batchSend] Looking for lead by ID: ${leadId}`);
            targetLead = await Lead.findOne({ _id: leadId, userId: req.userId });
            
            if (!targetLead) {
                console.error(`❌ [batchSend] Lead with ID ${leadId} not found for user ${req.userId}`);
                return res.status(404).json({
                    success: false,
                    error: 'LEAD_NOT_FOUND',
                    message: 'The conversation you are replying to no longer exists.'
                });
            }
            
            console.log(`✅ [batchSend] Found lead by ID: ${targetLead.name} (${targetLead._id})`);
            
            // ✅ Update the existing lead with new message
            if (sanitizedLeads[0]?.messages?.length > 0) {
                const msgContent = sanitizedLeads[0].messages[0].body;
                const msgSubject = sanitizedLeads[0].messages[0].subject || 'Re: Conversation';
                
                // ✅ Save to Lead.replies
                if (!targetLead.replies) targetLead.replies = [];
                targetLead.replies.push({
                    date: now,
                    content: msgContent,
                    subject: msgSubject,
                    from: 'ai',
                    status: 'sent',
                    read: true
                });
                targetLead.followUpCount = (targetLead.followUpCount || 0) + 1;
                targetLead.lastContactDate = now;
                targetLead.status = 'Contacted';
                await targetLead.save();

                // ✅ Save to ChatMessage with lead._id as sessionId
                try {
                    const chatMessage = new ChatMessage({
                        userId: req.userId,
                        sessionId: targetLead._id.toString(),
                        role: 'user',
                        content: msgContent,
                        title: msgSubject,
                        createdAt: now
                    });
                    await chatMessage.save();
                    console.log(`📝 [batchSend] Saved message to ChatMessage with sessionId: ${targetLead._id.toString()}`);
                } catch (chatErr) {
                    console.warn(`⚠️ [batchSend] Failed to save to ChatMessage:`, chatErr.message);
                }

                // ✅ Send the email
                const result = await sendEmail(
                    req.userId,
                    targetLead.email,
                    msgSubject,
                    msgContent
                );
                
                if (result.success) {
                    sentCount++;
                    console.log(`✅ [batchSend] Email sent to ${targetLead.email}`);
                } else {
                    // Mark as failed
                    const lastReply = targetLead.replies[targetLead.replies.length - 1];
                    if (lastReply) lastReply.status = 'failed';
                    await targetLead.save();
                    errors.push({ email: targetLead.email, error: result.error });
                }
            }
            
        } else {
            // ✅ No leadId provided - create a new lead
            console.log(`🔍 [batchSend] No leadId provided, creating new lead`);
            
            // Get the first lead data
            const leadData = sanitizedLeads[0];
            if (!leadData || !leadData.email) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'INVALID_EMAIL',
                    message: 'Email is required to create a new conversation.' 
                });
            }
            
            // Create new lead
            targetLead = new Lead({
                userId: req.userId,
                name: leadData.name || 'Unknown',
                email: leadData.email,
                company: leadData.company || '',
                status: 'Contacted',
                lastContactDate: now,
                followUpCount: 0,
                replies: []
            });
            
            if (leadData.messages?.length > 0) {
                const msgContent = leadData.messages[0].body;
                const msgSubject = leadData.messages[0].subject || 'Re: Conversation';
                
                targetLead.replies.push({
                    date: now,
                    content: msgContent,
                    subject: msgSubject,
                    from: 'ai',
                    status: 'sent',
                    read: true
                });
                targetLead.followUpCount = 1;
                
                // ✅ Save to ChatMessage
                try {
                    const chatMessage = new ChatMessage({
                        userId: req.userId,
                        sessionId: targetLead._id.toString(),
                        role: 'user',
                        content: msgContent,
                        title: msgSubject,
                        createdAt: now
                    });
                    await chatMessage.save();
                    console.log(`📝 [batchSend] Saved message to ChatMessage with new sessionId: ${targetLead._id.toString()}`);
                } catch (chatErr) {
                    console.warn(`⚠️ [batchSend] Failed to save to ChatMessage:`, chatErr.message);
                }
                
                await targetLead.save();
                
                // ✅ Send the email
                const result = await sendEmail(
                    req.userId,
                    targetLead.email,
                    msgSubject,
                    msgContent
                );
                
                if (result.success) {
                    sentCount++;
                    console.log(`✅ [batchSend] Email sent to ${targetLead.email}`);
                } else {
                    // Mark as failed
                    const lastReply = targetLead.replies[targetLead.replies.length - 1];
                    if (lastReply) lastReply.status = 'failed';
                    await targetLead.save();
                    errors.push({ email: targetLead.email, error: result.error });
                }
            }
        }

        console.log(`📤 [batchSend] Completed. Sent ${sentCount} emails, ${errors.length} errors`);
        res.json({ 
            success: true, 
            message: `Sent ${sentCount} email${sentCount !== 1 ? 's' : ''}.`, 
            leadId: targetLead?._id?.toString() || null,
            errors 
        });
        
    } catch (err) {
        console.error('❌ [batchSend] Error:', err);
        console.error('❌ [batchSend] Error stack:', err.stack);
        res.status(500).json({ message: 'Server Error during batch send' });
    }
};

// ──────────────────────────────────────────────────────────────
//  POST /api/reconnect-and-send
// ──────────────────────────────────────────────────────────────
const reconnectAndSend = async (req, res) => {
    console.log('🔵 [reconnectAndSend] ENTERED');
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        console.log(`🔄 [reconnectAndSend] For user ${req.userId}`);

        const EmailAccount = require('./EmailAccount');
        const account = await EmailAccount.findOne({ userId: req.userId, isConnected: true });
        if (!account) {
            console.error('❌ [reconnectAndSend] No Nylas connection found');
            return res.status(401).json({
                success: false,
                error: 'NYLAS_DISCONNECTED',
                message: 'Please connect your email account first.'
            });
        }

        const leadsWithPending = await Lead.find({ userId: req.userId, 'replies.status': 'pending' });
        console.log(`📧 [reconnectAndSend] Found ${leadsWithPending.length} leads with pending messages`);
        let sentCount = 0;
        for (const lead of leadsWithPending) {
            const pendingMessages = lead.replies.filter(r => r.status === 'pending');
            for (const msg of pendingMessages) {
                try {
                    const result = await sendEmail(
                        req.userId,
                        lead.email,
                        msg.subject || 'Re: Conversation',
                        msg.content
                    );
                    if (result.success) {
                        msg.status = 'sent';
                        sentCount++;
                        console.log(`✅ [reconnectAndSend] Sent to ${lead.email}`);
                    } else {
                        msg.status = 'failed';
                        console.error(`❌ [reconnectAndSend] Failed for ${lead.email}:`, result.error);
                    }
                } catch (err) {
                    console.error(`❌ [reconnectAndSend] Failed for ${lead.email}:`, err.message);
                    msg.status = 'failed';
                }
            }
            await lead.save();
        }
        console.log(`📤 [reconnectAndSend] Completed. Sent ${sentCount} messages`);
        res.json({ success: true, sentCount });
    } catch (err) {
        console.error('❌ [reconnectAndSend] Error:', err);
        console.error('❌ [reconnectAndSend] Error stack:', err.stack);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ──────────────────────────────────────────────────────────────
//  GET /api/leads
// ──────────────────────────────────────────────────────────────
const getAllLeads = async (req, res) => {
    console.log('🔵 [getAllLeads] ENTERED - userId:', req.userId);
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        const query = sanitizeQuery({ userId: req.userId });
        const leads = await Lead.find(query).sort({ createdAt: -1 });
        console.log(`✅ [getAllLeads] Found ${leads.length} leads`);
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
