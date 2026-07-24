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
        
        const chatMessagesFormatted = chatMessages.reverse().map(msg => ({
            date: msg.createdAt || new Date(),
            content: msg.content || '',
            subject: msg.title || '',
            from: msg.role === 'user' ? 'ai' : 'lead',
            emailId: msg._id.toString(),
            isChatMessage: true,
            read: true
        }));
        
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
//  POST /api/leads/batch-send - WITH FULL LOGGING & FIXES
// ──────────────────────────────────────────────────────────────
const batchSend = async (req, res) => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📨 [BATCH SEND] Request received');
    console.log('📨 [BATCH SEND] User ID:', req.userId);
    console.log('📨 [BATCH SEND] Body:', JSON.stringify(req.body, null, 2).substring(0, 500));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    try {
        // ✅ STEP 1: Validate user
        if (!req.userId) {
            console.error('❌ [BATCH SEND] No userId');
            return res.status(401).json({ message: 'Unauthorized' });
        }
        if (!isValidObjectId(req.userId)) {
            console.error('❌ [BATCH SEND] Invalid userId format:', req.userId);
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        console.log('✅ [BATCH SEND] User validated:', req.userId);

        const { leads, leadId, allowNewLead = true } = req.body;
        
        // ✅ STEP 2: Validate leads array
        if (!Array.isArray(leads) || leads.length === 0) {
            console.error('❌ [BATCH SEND] Leads array missing or empty');
            return res.status(400).json({ message: 'Leads array is required' });
        }
        console.log(`✅ [BATCH SEND] Leads array received (${leads.length} lead(s))`);
        console.log(`📨 [BATCH SEND] leadId: ${leadId || 'none'}`);
        console.log(`📨 [BATCH SEND] allowNewLead: ${allowNewLead}`);

        // ✅ STEP 3: Handle existing lead (leadId provided)
        if (leadId && isValidObjectId(leadId)) {
            console.log(`🔍 [BATCH SEND] Looking for lead with ID: ${leadId}`);
            
            const targetLead = await Lead.findOne({ _id: leadId, userId: req.userId });
            
            if (!targetLead) {
                console.error(`❌ [BATCH SEND] Lead not found for ID: ${leadId}`);
                return res.status(404).json({
                    success: false,
                    error: 'LEAD_NOT_FOUND',
                    message: 'Conversation not found. Please refresh and try again.'
                });
            }
            
            console.log(`✅ [BATCH SEND] Lead found: ${targetLead.name} (${targetLead._id})`);
            console.log(`📨 [BATCH SEND] Lead email: ${targetLead.email}`);
            console.log(`📨 [BATCH SEND] Lead has ${targetLead.replies?.length || 0} existing replies`);
            
            const leadData = leads[0];
            if (!leadData?.messages?.length) {
                console.error('❌ [BATCH SEND] No message content provided');
                return res.status(400).json({ message: 'No message content provided.' });
            }
            
            const msgContent = leadData.messages[0].body;
            const msgSubject = leadData.messages[0].subject || 'Re: Conversation';
            const now = new Date();
            
            console.log(`📝 [BATCH SEND] Message content: "${msgContent.substring(0, 50)}${msgContent.length > 50 ? '...' : ''}"`);
            console.log(`📝 [BATCH SEND] Message subject: "${msgSubject}"`);
            
            // ✅ STEP 4: Save to Lead.replies
            console.log('💾 [BATCH SEND] Saving to Lead.replies...');
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
            console.log(`✅ [BATCH SEND] Saved to Lead.replies (${targetLead.replies.length} total replies)`);
            
            // ✅ STEP 5: Save to ChatMessage (WITH DUPLICATE CHECK)
            console.log('💾 [BATCH SEND] Saving to ChatMessage...');
            let chatMessageSaved = false;
            try {
                const ChatMessage = require('./ChatMessage');
                const sessionIdStr = targetLead._id.toString();

                // Check if message already exists to prevent doubling from webhooks/retries
                const existingMsg = await ChatMessage.findOne({
                    userId: req.userId,
                    sessionId: sessionIdStr,
                    content: msgContent,
                    createdAt: { $gte: new Date(now.getTime() - 5000) } // Check last 5 seconds
                });

                if (!existingMsg) {
                    const chatMessage = new ChatMessage({
                        userId: req.userId,
                        sessionId: sessionIdStr,
                        role: 'user',
                        content: msgContent,
                        title: msgSubject,
                        createdAt: now
                    });
                    await chatMessage.save();
                    chatMessageSaved = true;
                    console.log(`✅ [BATCH SEND] Saved to ChatMessage with sessionId: ${sessionIdStr}`);
                } else {
                    console.log(`⚠️ [BATCH SEND] Duplicate ChatMessage skipped for lead ${sessionIdStr}`);
                    chatMessageSaved = true; // Consider it saved since it exists
                }
            } catch (chatErr) {
                console.error(`❌ [BATCH SEND] ChatMessage save failed:`, chatErr.message);
            }
            
            // ✅ STEP 6: Send email
            console.log(`📧 [BATCH SEND] Sending email to ${targetLead.email}...`);
            const EmailAccount = require('./EmailAccount');
            const account = await EmailAccount.findOne({ userId: req.userId, isConnected: true });
            
            let emailSent = false;
            let emailError = null;
            
            if (!account) {
                console.warn(`⚠️ [BATCH SEND] No email account connected for user ${req.userId}`);
                emailError = 'No email account connected';
            } else {
                try {
                    const result = await sendEmail(
                        req.userId,
                        targetLead.email,
                        msgSubject,
                        msgContent
                    );
                    if (result.success) {
                        emailSent = true;
                        console.log(`✅ [BATCH SEND] Email sent successfully to ${targetLead.email}`);
                    } else {
                        emailError = result.error || 'Email send failed';
                        console.error(`❌ [BATCH SEND] Email send failed: ${emailError}`);
                        // Mark last reply as failed
                        const lastReply = targetLead.replies[targetLead.replies.length - 1];
                        if (lastReply) lastReply.status = 'failed';
                        await targetLead.save();
                    }
                } catch (emailErr) {
                    emailError = emailErr.message;
                    console.error(`❌ [BATCH SEND] Email error: ${emailError}`);
                    // Mark last reply as failed
                    const lastReply = targetLead.replies[targetLead.replies.length - 1];
                    if (lastReply) lastReply.status = 'failed';
                    await targetLead.save();
                }
            }
            
            // ✅ STEP 7: Send response
            console.log('📤 [BATCH SEND] Sending response...');
            console.log(`📤 [BATCH SEND] Success: true, leadId: ${targetLead._id.toString()}, emailSent: ${emailSent}`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            
            res.json({
                success: true,
                message: emailSent ? 'Email sent successfully.' : 'Message saved but email not sent.',
                leadId: targetLead._id.toString(),
                emailSent: emailSent,
                emailError: emailError || null,
                chatMessageSaved: chatMessageSaved
            });
            
        } else {
            // ✅ No leadId - handle new lead creation
            console.log(`🔍 [BATCH SEND] No leadId provided, checking allowNewLead...`);
            
            if (allowNewLead === false) {
                console.warn(`⚠️ [BATCH SEND] New lead creation not allowed`);
                return res.status(400).json({
                    success: false,
                    error: 'NEW_LEAD_NOT_ALLOWED',
                    message: 'Cannot create a new conversation.'
                });
            }
            
            console.log(`✅ [BATCH SEND] Creating new lead...`);
            
            const leadData = leads[0];
            if (!leadData || !leadData.email) {
                console.error(`❌ [BATCH SEND] Email is required for new lead`);
                return res.status(400).json({
                    success: false,
                    message: 'Email is required to create a new conversation.'
                });
            }
            
            const now = new Date();
            console.log(`📨 [BATCH SEND] New lead: ${leadData.name} (${leadData.email})`);
            
            const newLead = new Lead({
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
                
                console.log(`📝 [BATCH SEND] New lead message: "${msgContent.substring(0, 50)}${msgContent.length > 50 ? '...' : ''}"`);
                
                // Save to ChatMessage
                console.log('💾 [BATCH SEND] Saving new lead to ChatMessage...');
                let chatMessageSaved = false;
                try {
                    const ChatMessage = require('./ChatMessage');
                    const chatMessage = new ChatMessage({
                        userId: req.userId,
                        sessionId: newLead._id.toString(),
                        role: 'user',
                        content: msgContent,
                        title: msgSubject,
                        createdAt: now
                    });
                    await chatMessage.save();
                    chatMessageSaved = true;
                    console.log(`✅ [BATCH SEND] New lead saved to ChatMessage with sessionId: ${newLead._id.toString()}`);
                } catch (chatErr) {
                    console.error(`❌ [BATCH SEND] ChatMessage save failed:`, chatErr.message);
                }
                
                // Save to Lead
                newLead.replies.push({
                    date: now,
                    content: msgContent,
                    subject: msgSubject,
                    from: 'ai',
                    status: 'sent',
                    read: true
                });
                newLead.followUpCount = 1;
                await newLead.save();
                console.log(`✅ [BATCH SEND] New lead saved to database with ID: ${newLead._id}`);
                
                // Send email
                console.log(`📧 [BATCH SEND] Sending email to ${newLead.email}...`);
                const EmailAccount = require('./EmailAccount');
                const account = await EmailAccount.findOne({ userId: req.userId, isConnected: true });
                
                let emailSent = false;
                let emailError = null;
                
                if (account) {
                    try {
                        const result = await sendEmail(
                            req.userId,
                            newLead.email,
                            msgSubject,
                            msgContent
                        );
                        if (result.success) {
                            emailSent = true;
                            console.log(`✅ [BATCH SEND] Email sent to ${newLead.email}`);
                        } else {
                            emailError = result.error || 'Email send failed';
                            console.error(`❌ [BATCH SEND] Email send failed: ${emailError}`);
                        }
                    } catch (emailErr) {
                        emailError = emailErr.message;
                        console.error(`❌ [BATCH SEND] Email error: ${emailError}`);
                    }
                } else {
                    console.warn(`⚠️ [BATCH SEND] No email account connected for user ${req.userId}`);
                    emailError = 'No email account connected';
                }
                
                console.log('📤 [BATCH SEND] Sending response...');
                console.log(`📤 [BATCH SEND] Success: true, leadId: ${newLead._id.toString()}, emailSent: ${emailSent}`);
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                
                res.json({
                    success: true,
                    message: emailSent ? 'Email sent successfully.' : 'Message saved but email not sent.',
                    leadId: newLead._id.toString(),
                    emailSent: emailSent,
                    emailError: emailError || null,
                    chatMessageSaved: chatMessageSaved
                });
            } else {
                console.error('❌ [BATCH SEND] No message content provided');
                res.status(400).json({ message: 'No message content provided.' });
            }
        }
        
    } catch (err) {
        console.error('❌ [BATCH SEND] Fatal error:', err);
        console.error('❌ [BATCH SEND] Error stack:', err.stack);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
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
