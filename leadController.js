const Lead = require('./Lead');
const ChatMessage = require('./ChatMessage');
const { sendEmail, getThreads } = require('./nylasService');
const { isValidObjectId, sanitizeQuery, sanitizeObject, sanitizeEmail } = require('./sanitize');

// ──────────────────────────────────────────────────────────────
//  GET /api/conversations - FIXED (Proper userId filtering)
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
        
        const leads = await Lead.find({ userId: req.userId })
            .sort({ lastContactDate: -1 })
            .limit(100);
            
        console.log(`✅ [getConversations] Found ${leads.length} leads for user ${req.userId}`);
        
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
        
        console.log(`📤 [getConversations] Returning ${conversations.length} conversations for user ${req.userId}`);
        res.json(conversations);
    } catch (err) {
        console.error('❌ [getConversations] Error:', err);
        console.error('❌ [getConversations] Error stack:', err.stack);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ──────────────────────────────────────────────────────────────
//  GET /api/conversations/:leadId - FIXED ARRAY FILTER ERROR
// ────────────────────────────────────────────────────────────
const getConversationById = async (req, res) => {
    console.log('🔵 [getConversationById] ENTERED - leadId:', req.params.leadId);
    
    try {
        if (!req.userId) {
            console.error('❌ [getConversationById] No userId');
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }
        if (!isValidObjectId(req.userId)) {
            console.error('❌ [getConversationById] Invalid userId format');
            return res.status(400).json({ success: false, message: 'Invalid user ID' });
        }
        const { leadId } = req.params;
        
        if (!isValidObjectId(leadId)) {
            console.error('❌ [getConversationById] Invalid leadId format:', leadId);
            return res.status(400).json({ success: false, message: 'Invalid lead ID format' });
        }
        
        console.log(`📡 [getConversationById] Fetching lead ${leadId} for user ${req.userId}`);
        
        const lead = await Lead.findOne({ _id: leadId, userId: req.userId });
        
        if (!lead) {
            console.warn(`⚠️ [getConversationById] Lead not found for leadId: ${leadId}, userId: ${req.userId}`);
            return res.status(404).json({ success: false, message: 'Conversation not found' });
        }
        console.log(`✅ [getConversationById] Lead found: ${lead.name || lead.email || 'Unknown'}`);
        
        const email = lead.email || '';
        
        // ✅ FIX: Mark replies as read WITHOUT triggering schema validation on arrayFilters
        if (lead.replies && lead.replies.length > 0) {
            const unreadReplies = lead.replies.filter(r => r.from === 'lead' && !r.read);
            if (unreadReplies.length > 0) {
                // ✅ Added { strict: false } to bypass schema validation for arrayFilters
                await Lead.updateOne(
                    { _id: leadId, userId: req.userId },
                    { $set: { 'replies.$[elem].read': true } },
                    { 
                        arrayFilters: [{ 'elem.from': 'lead', 'elem.read': false }],
                        strict: false  // ← THIS IS THE FIX
                    }
                );
                console.log(`📖 [getConversationById] Marked ${unreadReplies.length} replies as read`);
            }
        }
        
        let allMessages = lead.replies || [];
        console.log(`📡 [getConversationById] Found ${allMessages.length} replies in lead`);
        
        allMessages.sort((a, b) => {
            const dateA = a.date ? new Date(a.date) : new Date(0);
            const dateB = b.date ? new Date(b.date) : new Date(0);
            return dateA - dateB;
        });
        
        const cleanHistory = allMessages.map(msg => ({
            from: msg.from || 'lead',
            content: msg.content || '',
            subject: msg.subject || '',
            date: msg.date || new Date(),
            messageId: msg.messageId || null,
            read: msg.read || false
        }));
        
        console.log(`📤 [getConversationById] Returning ${cleanHistory.length} messages for lead ${leadId}`);
        
        res.json({
            success: true,
            lead: {
                id: lead._id.toString(),
                name: lead.name || lead.email || 'Unknown',
                email: email,
                company: lead.company || '',
                status: lead.status || 'New',
                autoReplyEnabled: lead.autoReplyEnabled || false,
                autoReplyInstructions: lead.autoReplyInstructions || ''
            },
            messages: cleanHistory
        });
        
    } catch (err) {
        console.error(' [getConversationById] Error:', err);
        console.error('❌ [getConversationById] Error stack:', err.stack);
        res.status(500).json({ success: false, message: 'Server Error fetching conversation' });
    }
};

// ─────────────────────────────────────────────────────────────
//  PUT /api/leads/:leadId/rename
// ─────────────────────────────────────────────────────────────
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
        
        const lead = await Lead.findOne({ _id: req.params.leadId, userId: req.userId });
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
        
        const lead = await Lead.findOne({ _id: req.params.leadId, userId: req.userId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        lead.autoReplyEnabled = enabled;
        if (instructions !== undefined) lead.autoReplyInstructions = sanitizedInstructions;
        await lead.save();
        console.log(` [updateAutoReply] Lead ${lead._id} auto-reply enabled=${enabled}`);
        res.json({ success: true, enabled: lead.autoReplyEnabled, instructions: lead.autoReplyInstructions });
    } catch (err) {
        console.error('❌ [updateAutoReply] Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ──────────────────────────────────────────────────────────────
//  POST /api/leads/batch-send - COMPLETE FIX FOR PAGE.HTML
// ──────────────────────────────────────────────────────────────
const batchSend = async (req, res) => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📨 [BE-BATCH] Request received');
    console.log('👤 [BE-BATCH] User ID:', req.userId);
    console.log('🆔 [BE-BATCH] Received Lead ID:', req.body.leadId);
    console.log('🚫 [BE-BATCH] Allow New Lead:', req.body.allowNewLead);
    
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        
        const { leads, leadId, allowNewLead = true } = req.body;
        
        if (!Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({ message: 'Leads array is required' });
        }

        // ✅ CASE 1: Sending to an EXISTING lead (from notifications.html)
        if (leadId) {
            console.log('🔍 [BE-BATCH] Searching for existing lead:', leadId);
            
            const targetLead = await Lead.findOne({ _id: leadId, userId: req.userId });
            
            if (!targetLead) {
                console.error('❌ [BE-BATCH] Lead NOT FOUND for ID:', leadId);
                return res.status(404).json({
                    success: false,
                    error: 'LEAD_NOT_FOUND',
                    message: 'Conversation not found.'
                });
            }
            
            console.log('✅ [BE-BATCH] Lead FOUND:', targetLead.name, '(ID:', targetLead._id, ')');
            
            const leadData = leads[0];
            const msgContent = leadData.messages[0].body;
            const msgSubject = leadData.messages[0].subject || 'Re: Conversation';
            const now = new Date();
            
            const lastReply = targetLead.replies && targetLead.replies.length > 0 ? targetLead.replies[targetLead.replies.length - 1] : null;
            const isDuplicate = lastReply && 
                                lastReply.content === msgContent && 
                                (new Date() - new Date(lastReply.date)) < 5000;

            if (!isDuplicate) {
                console.log('💾 [BE-BATCH] Saving new reply to Lead.replies...');
                if (!targetLead.replies) targetLead.replies = [];
                targetLead.replies.push({
                    date: now,
                    content: msgContent,
                    subject: msgSubject,
                    from: 'lead', // ✅ CHANGED FROM 'ai' TO 'lead'
                    status: 'sent',
                    read: true
                });
                targetLead.lastContactDate = now;
                targetLead.status = 'Contacted';
            } else {
                console.log('️ [BE-BATCH] Duplicate detected. Skipping save.');
            }
            
            // ── SEND EMAIL ──
            const EmailAccount = require('./EmailAccount');
            const account = await EmailAccount.findOne({ userId: req.userId, isConnected: true });
            
            let emailSent = false;
            let emailError = null;
            let threadId = null;
            
            if (!account) {
                console.warn(`️ [BE-BATCH] No email account connected for user ${req.userId}`);
                emailError = 'No email account connected';
            } else {
                try {
                    console.log(`📧 [BE-BATCH] Attempting to send via Nylas for grant: ${account.nylasGrantId}`);
                    
                    const result = await sendEmail(
                        req.userId,
                        targetLead.email,
                        msgSubject,
                        msgContent
                    );
                    
                    if (result.success) {
                        emailSent = true;
                        threadId = result.threadId;
                        console.log(`✅ [BE-BATCH] Email sent successfully to ${targetLead.email}`);
                        
                        if (threadId) {
                            targetLead.threadId = threadId;
                            console.log(`💾 [BE-BATCH] Saved threadId to lead: ${threadId}`);
                        }
                    } else {
                        emailError = result.error || 'Email send failed';
                        console.error(`❌ [BE-BATCH] Email send failed: ${emailError}`);
                    }
                } catch (emailErr) {
                    emailError = emailErr.message;
                    console.error(`❌ [BE-BATCH] Email error: ${emailError}`);
                }
            }
            
            await targetLead.save();
            
            console.log(' [BE-BATCH] Returning response...');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            
            res.json({
                success: true,
                message: emailSent ? 'Email sent successfully.' : 'Message saved but email not sent.',
                leadId: targetLead._id.toString(),
                emailSent: emailSent,
                emailError: emailError || null,
                threadId: threadId || null
            });
            
        // ✅ CASE 2: Creating NEW leads and sending (from page.html)
        } else {
            console.log(' [BE-BATCH] No Lead ID provided. Creating new leads...');
            if (allowNewLead === false) {
                console.error('❌ [BE-BATCH] New lead creation blocked by allowNewLead=false');
                return res.status(400).json({ success: false, error: 'NEW_LEAD_NOT_ALLOWED' });
            }

            const EmailAccount = require('./EmailAccount');
            const account = await EmailAccount.findOne({ userId: req.userId, isConnected: true });
            
            let results = [];
            let anyFailed = false;

            // Loop through all leads sent from page.html
            for (const leadData of leads) {
                const now = new Date();
                
                // 1. Create the Lead in DB
                const newLead = new Lead({
                    userId: req.userId,
                    name: leadData.name || leadData.company || 'Unknown',
                    email: leadData.email,
                    company: leadData.company || '',
                    status: 'Contacted',
                    lastContactDate: now,
                    replies: []
                });

                const msgContent = leadData.messages?.[0]?.body || '';
                const msgSubject = leadData.messages?.[0]?.subject || 'Hello from Skyline';

                // 2. Add initial reply record
                newLead.replies.push({
                    date: now,
                    content: msgContent,
                    subject: msgSubject,
                    from: 'lead', // ✅ CHANGED FROM 'ai' TO 'lead'
                    status: 'sent',
                    read: true
                });

                // 3. Send Email via Nylas
                let emailSent = false;
                let emailError = null;

                if (account && leadData.email) {
                    try {
                        const result = await sendEmail(
                            req.userId,
                            leadData.email,
                            msgSubject,
                            msgContent
                        );
                        if (result.success) {
                            emailSent = true;
                            if (result.threadId) newLead.threadId = result.threadId;
                        } else {
                            emailError = result.error;
                            anyFailed = true;
                        }
                    } catch (err) {
                        emailError = err.message;
                        anyFailed = true;
                    }
                } else {
                    emailError = 'No email account or missing lead email';
                    anyFailed = true;
                }

                // 4. Save Lead
                await newLead.save();
                
                results.push({
                    leadId: newLead._id,
                    email: leadData.email,
                    sent: emailSent,
                    error: emailError
                });
            }

            console.log(`📤 [BE-BATCH] Batch complete. Sent ${results.filter(r=>r.sent).length}/${results.length}`);
            
            res.json({
                success: !anyFailed,
                message: anyFailed ? 'Some emails failed to send.' : 'All emails sent successfully.',
                results: results
            });
        }
        
    } catch (err) {
        console.error('💥 [BE-BATCH] Fatal Error:', err);
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
        console.error(' [reconnectAndSend] Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ──────────────────────────────────────────────────────────────
//  GET /api/leads - FIXED (Proper userId filtering)
// ─────────────────────────────────────────────────────────────
const getAllLeads = async (req, res) => {
    console.log('🔵 [getAllLeads] ENTERED - userId:', req.userId);
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        const leads = await Lead.find({ userId: req.userId })
            .sort({ createdAt: -1 });
            
        console.log(`✅ [getAllLeads] Found ${leads.length} leads for user ${req.userId}`);
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
