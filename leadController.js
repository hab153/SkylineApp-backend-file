const Lead = require('./Lead');
const { sendEmail, getThreads } = require('./nylasService');
const { isValidObjectId, sanitizeQuery, sanitizeObject, sanitizeEmail } = require('./sanitize');

// ──────────────────────────────────────────────────────────────
//  GET /api/conversations
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
//  GET /api/conversations/:leadId
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
        
        // ✅ FIX: Only use Lead.replies for consistency. 
        // If you must use ChatMessage, ensure you deduplicate.
        // For now, let's stick to Lead.replies to avoid the doubling issue.
        
        let allMessages = lead.replies || [];
        
        // Sort by date just in case
        allMessages.sort((a, b) => {
            const dateA = a.date ? new Date(a.date) : new Date(0);
            const dateB = b.date ? new Date(b.date) : new Date(0);
            return dateA - dateB;
        });
        
        // Limit to last 50
        if (allMessages.length > 50) {
            allMessages = allMessages.slice(-50);
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
//  POST /api/leads/batch-send - FIXED TO PREVENT DUPLICATES
// ──────────────────────────────────────────────────────────────
const batchSend = async (req, res) => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📨 [BATCH SEND] Request received');
    console.log('📨 [BATCH SEND] User ID:', req.userId);
    
    try {
        if (!req.userId) {
            console.error('❌ [BATCH SEND] No userId');
            return res.status(401).json({ message: 'Unauthorized' });
        }
        if (!isValidObjectId(req.userId)) {
            console.error('❌ [BATCH SEND] Invalid userId format:', req.userId);
            return res.status(400).json({ message: 'Invalid user ID' });
        }

        const { leads, leadId, allowNewLead = true } = req.body;
        
        if (!Array.isArray(leads) || leads.length === 0) {
            console.error('❌ [BATCH SEND] Leads array missing or empty');
            return res.status(400).json({ message: 'Leads array is required' });
        }

        // ✅ STEP 3: Handle existing lead (leadId provided)
        if (leadId && isValidObjectId(leadId)) {
            const targetLead = await Lead.findOne({ _id: leadId, userId: req.userId });
            
            if (!targetLead) {
                return res.status(404).json({
                    success: false,
                    error: 'LEAD_NOT_FOUND',
                    message: 'Conversation not found.'
                });
            }
            
            const leadData = leads[0];
            if (!leadData?.messages?.length) {
                return res.status(400).json({ message: 'No message content provided.' });
            }
            
            const msgContent = leadData.messages[0].body;
            const msgSubject = leadData.messages[0].subject || 'Re: Conversation';
            const now = new Date();
            
            // ✅ STEP 4: Save ONLY to Lead.replies (Source of Truth)
            if (!targetLead.replies) targetLead.replies = [];
            
            // Check for duplicate content in last 5 seconds to prevent double-sends
            const lastReply = targetLead.replies[targetLead.replies.length - 1];
            const isDuplicate = lastReply && 
                                lastReply.content === msgContent && 
                                (new Date() - new Date(lastReply.date)) < 5000;

            if (!isDuplicate) {
                targetLead.replies.push({
                    date: now,
                    content: msgContent,
                    subject: msgSubject,
                    from: 'ai', // User message
                    status: 'sent',
                    read: true
                });
                targetLead.lastContactDate = now;
                targetLead.status = 'Contacted';
                await targetLead.save();
                console.log(`✅ [BATCH SEND] Saved to Lead.replies`);
            } else {
                console.log(`⚠️ [BATCH SEND] Duplicate message skipped in Lead.replies`);
            }
            
            // ✅ STEP 5: DO NOT save to ChatMessage here to avoid doubling.
            // The webhook will handle ChatMessage if needed, or we rely on Lead.replies.
            
            // ✅ STEP 6: Send email
            const EmailAccount = require('./EmailAccount');
            const account = await EmailAccount.findOne({ userId: req.userId, isConnected: true });
            
            let emailSent = false;
            let emailError = null;
            
            if (account) {
                try {
                    const result = await sendEmail(req.userId, targetLead.email, msgSubject, msgContent);
                    if (result.success) {
                        emailSent = true;
                        console.log(`✅ [BATCH SEND] Email sent successfully`);
                    } else {
                        emailError = result.error || 'Email send failed';
                        console.error(`❌ [BATCH SEND] Email send failed: ${emailError}`);
                    }
                } catch (emailErr) {
                    emailError = emailErr.message;
                    console.error(`❌ [BATCH SEND] Email error: ${emailError}`);
                }
            } else {
                emailError = 'No email account connected';
            }
            
            res.json({
                success: true,
                message: emailSent ? 'Email sent successfully.' : 'Message saved but email not sent.',
                leadId: targetLead._id.toString(),
                emailSent: emailSent,
                emailError: emailError || null
            });
            
        } else {
            // ✅ Handle New Lead Creation
            if (allowNewLead === false) {
                return res.status(400).json({ success: false, error: 'NEW_LEAD_NOT_ALLOWED' });
            }
            
            const leadData = leads[0];
            if (!leadData || !leadData.email) {
                return res.status(400).json({ message: 'Email is required.' });
            }
            
            const now = new Date();
            const newLead = new Lead({
                userId: req.userId,
                name: leadData.name || 'Unknown',
                email: leadData.email,
                company: leadData.company || '',
                status: 'Contacted',
                lastContactDate: now,
                replies: []
            });
            
            const msgContent = leadData.messages[0].body;
            const msgSubject = leadData.messages[0].subject || 'Re: Conversation';

            newLead.replies.push({
                date: now,
                content: msgContent,
                subject: msgSubject,
                from: 'ai',
                status: 'sent',
                read: true
            });
            
            await newLead.save();
            console.log(`✅ [BATCH SEND] New lead created with ID: ${newLead._id}`);
            
            res.json({
                success: true,
                leadId: newLead._id.toString(),
                message: 'New conversation started.'
            });
        }
        
    } catch (err) {
        console.error('❌ [BATCH SEND] Fatal error:', err);
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
