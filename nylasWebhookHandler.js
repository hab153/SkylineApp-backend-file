const crypto = require('crypto');
const EmailAccount = require('./EmailAccount');
const Lead = require('./Lead');
const User = require('./User');
const Message = require('./Message'); 
const ChatMessage = require('./ChatMessage');
const { generateAIReply } = require('./aiReplyGenerator');

exports.handleWebhook = async (req, res) => {
  const webhookSecret = process.env.NYLAS_WEBHOOK_SECRET;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔔 [WEBHOOK] Request received!');
  console.log('🔔 [WEBHOOK] Method:', req.method);
  console.log('🔔 [WEBHOOK] URL:', req.url);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Handle Nylas Challenge (Verification Step - GET Request)
  if (req.method === 'GET' && req.query.challenge) {
    console.log('🔔 [Nylas Webhook] Received GET challenge, responding...');
    return res.status(200).send(req.query.challenge);
  }

  // 2. Handle Actual Webhook Events (POST Request)
  if (req.method === 'POST') {
    // Parse event data
    let eventData = req.body;
    if (Buffer.isBuffer(eventData)) {
      try {
        eventData = JSON.parse(eventData.toString('utf8'));
      } catch (e) {
        console.error('❌ [Nylas Webhook] Failed to parse JSON body');
        return res.status(400).send('Invalid JSON');
      }
    } else if (typeof eventData === 'string') {
      try {
        eventData = JSON.parse(eventData);
      } catch (e) {
        console.error('❌ [Nylas Webhook] Failed to parse JSON string');
        return res.status(400).send('Invalid JSON');
      }
    }
    
    console.log('📨 [NYLAS WEBHOOK] Event received');
    console.log('📨 [NYLAS WEBHOOK] Event type:', eventData.type);

    try {
      switch (eventData.type) {
        case 'message.created':
        case 'message.updated':
        case 'thread.replied':
          console.log('✅ [WEBHOOK] Processing message');
          await handleMessageCreated(eventData);
          break;
        case 'message.sent':
          await handleMessageSent(eventData);
          break;
        case 'grant.expired':
          await handleGrantExpired(eventData);
          break;
        case 'grant.refreshed':
          await handleGrantRefreshed(eventData);
          break;
        default:
          console.log('ℹ️ [NYLAS WEBHOOK] Unhandled event type:', eventData.type);
      }
    } catch (error) {
      console.error('❌ [NYLAS WEBHOOK] Error processing event:', error.message);
    }

    return res.status(200).send('Webhook received');
  }

  res.status(405).send('Method Not Allowed');
};

// ──────────────────────────────────────────────────────────────
//  HANDLE: Message Created / Updated - FIXED EMAIL EXTRACTION
// ──────────────────────────────────────────────────────────────
async function handleMessageCreated(eventData) {
  console.log('📥 [WEBHOOK] Processing message');
  
  try {
    const data = eventData.data || {};
    const object = data.object || {};
    let message = object.message || data.message || data;
    
    if (message.data && typeof message.data === 'object') {
      message = message.data;
    }
    
    const grantId = data.grant_id || object.grant_id || message.grant_id || message.grantId;
    
    // ✅ FIXED: Extract from object.from (NOT message.from)
    let fromEmail = null;
    let fromName = null;
    
    // Check object.from (this is where Nylas puts the data)
    if (object.from) {
      if (Array.isArray(object.from) && object.from.length > 0) {
        fromEmail = object.from[0].email || object.from[0].address;
        fromName = object.from[0].name || '';
      } else if (typeof object.from === 'object') {
        fromEmail = object.from.email || object.from.address;
        fromName = object.from.name || '';
      }
    }
    
    // ✅ FIXED: Extract from object.to (NOT message.to)
    let toEmail = null;
    let toName = null;
    
    if (object.to) {
      if (Array.isArray(object.to) && object.to.length > 0) {
        toEmail = object.to[0].email || object.to[0].address;
        toName = object.to[0].name || '';
      } else if (typeof object.to === 'object') {
        toEmail = object.to.email || object.to.address;
        toName = object.to.name || '';
      }
    }
    
    // Fallback: Check message.from if object.from didn't work
    if (!fromEmail && message.from) {
      if (Array.isArray(message.from) && message.from.length > 0) {
        fromEmail = message.from[0]?.email || message.from[0]?.address;
        fromName = message.from[0]?.name || '';
      } else if (typeof message.from === 'object') {
        fromEmail = message.from.email || message.from.address;
        fromName = message.from.name || '';
      } else if (typeof message.from === 'string') {
        fromEmail = message.from;
      }
    }
    
    // Fallback: Check message.to if object.to didn't work
    if (!toEmail && message.to) {
      if (Array.isArray(message.to) && message.to.length > 0) {
        toEmail = message.to[0]?.email || message.to[0]?.address;
        toName = message.to[0]?.name || '';
      } else if (typeof message.to === 'object') {
        toEmail = message.to.email || message.to.address;
        toName = message.to.name || '';
      } else if (typeof message.to === 'string') {
        toEmail = message.to;
      }
    }
    
    const subject = message.subject || data.subject || object.subject || '(no subject)';
    const body = message.body || message.text || message.snippet || data.body || data.snippet || object.body || '';
    const snippet = message.snippet || data.snippet || object.snippet || '';
    const messageId = message.id || message.message_id || data.id || object.id || null;
    
    console.log('📩 [WEBHOOK] From:', fromEmail, fromName ? `(${fromName})` : '');
    console.log('📩 [WEBHOOK] To:', toEmail, toName ? `(${toName})` : '');
    console.log('📩 [WEBHOOK] Subject:', subject);

    if (!grantId) {
      console.log('⚠️ [WEBHOOK] Missing grantId');
      return;
    }

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: grantId });
    if (!emailAccount) {
      console.log('⚠️ [WEBHOOK] No email account found for grantId:', grantId);
      return;
    }

    const userId = emailAccount.userId;
    console.log('✅ [WEBHOOK] Found userId:', userId);

    // ✅ Try to find existing lead
    let lead = await findMatchingLead(userId, fromEmail, toEmail);

    // ✅ If no lead found, CREATE ONE
    if (!lead) {
      console.log('📭 [WEBHOOK] No matching lead found, creating new lead...');
      console.log('📭 [WEBHOOK] Creating lead for email:', fromEmail || toEmail);
      
      const leadEmail = fromEmail || toEmail || 'unknown@email.com';
      const displayName = fromName || leadEmail.split('@')[0] || 'Unknown Contact';
      
      lead = new Lead({
        userId: userId,
        name: displayName,
        email: leadEmail,
        company: '',
        status: 'New',
        replies: [{
          from: 'lead',
          content: body || snippet || '(No content)',
          subject: subject || '(no subject)',
          date: new Date(),
          read: false,
          messageId: messageId || null
        }],
        lastContactDate: new Date(),
        autoReplyEnabled: false
      });
      
      await lead.save();
      console.log('✅ [WEBHOOK] Created new lead with ID:', lead._id);
      console.log('✅ [WEBHOOK] Lead name:', lead.name);
      console.log('✅ [WEBHOOK] Lead email:', lead.email);
    }

    // ✅ Process the reply
    await processReply(lead, fromEmail, subject, body, snippet, messageId, userId);

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling message:', error.message);
    console.error('❌ [WEBHOOK] Error stack:', error.stack);
  }
}

// ──────────────────────────────────────────────────────────────
//  FIND MATCHING LEAD
// ──────────────────────────────────────────────────────────────
async function findMatchingLead(userId, fromEmail, toEmail) {
  console.log('🔍 [WEBHOOK] Looking for lead...');
  
  // Try fromEmail first (the person who replied)
  if (fromEmail) {
    let lead = await Lead.findOne({ 
      userId: userId,
      email: { $regex: new RegExp('^' + fromEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
    });
    if (lead) {
      console.log('✅ [WEBHOOK] Found lead by FROM email:', lead.name);
      return lead;
    }
  }
  
  // Try toEmail (the recipient)
  if (toEmail && toEmail !== fromEmail) {
    let lead = await Lead.findOne({ 
      userId: userId,
      email: { $regex: new RegExp('^' + toEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
    });
    if (lead) {
      console.log('✅ [WEBHOOK] Found lead by TO email:', lead.name);
      return lead;
    }
  }

  console.log('❌ [WEBHOOK] No matching lead found');
  return null;
}

// ──────────────────────────────────────────────────────────────
//  PROCESS REPLY
// ──────────────────────────────────────────────────────────────
async function processReply(lead, fromEmail, subject, body, snippet, messageId, userId) {
  console.log('📝 [WEBHOOK] Processing reply for lead:', lead.name);
  console.log('📝 [WEBHOOK] Lead ID:', lead._id);

  try {
    // ✅ Update lead status
    lead.status = 'Replied';
    lead.lastContactDate = new Date();
    
    // ✅ Initialize replies array if needed
    if (!lead.replies) lead.replies = [];
    
    // ✅ Add the reply to lead's conversation history
    const replyContent = body || snippet || '(No content)';
    const replySubject = subject || '(no subject)';
    
    lead.replies.push({
      from: 'lead',
      content: replyContent,
      subject: replySubject,
      date: new Date(),
      messageId: messageId || null,
      read: false
    });
    
    await lead.save();
    console.log('✅ [WEBHOOK] Reply saved to lead. Total replies:', lead.replies.length);

    // ✅ Save to ChatMessage for frontend
    try {
      const chatMessage = new ChatMessage({
        userId: userId,
        sessionId: lead._id.toString(),
        role: 'user',
        content: replyContent,
        title: replySubject,
        createdAt: new Date()
      });
      await chatMessage.save();
      console.log('✅ [WEBHOOK] Reply saved to ChatMessage');
    } catch (chatErr) {
      console.warn('⚠️ [WEBHOOK] Failed to save to ChatMessage:', chatErr.message);
    }

    // ✅ Create notification
    try {
      const notification = new Message({
        userId: userId,
        sessionId: 'lead-reply-notification',
        role: 'ai',
        title: `📨 ${lead.name} replied!`,
        content: `"${snippet ? snippet.substring(0, 200) : 'New reply from lead'}"`,
        notificationType: 'lead_reply',
        leadId: lead._id,
        isRead: false,
        createdAt: new Date()
      });
      await notification.save();
      console.log('✅ [WEBHOOK] Notification created');
    } catch (notifErr) {
      console.error('❌ [WEBHOOK] Failed to create notification:', notifErr.message);
    }

    console.log('✅ [WEBHOOK] Reply processing complete');

  } catch (error) {
    console.error('❌ [WEBHOOK] Error processing reply:', error.message);
  }
}

// ──────────────────────────────────────────────────────────────
//  HANDLE: Message Sent
// ──────────────────────────────────────────────────────────────
async function handleMessageSent(eventData) {
  console.log('📤 [WEBHOOK-SENT] Message sent event triggered');
  
  try {
    const data = eventData.data || {};
    const object = data.object || {};
    let message = object.message || data.message || data;
    
    const toEmail = message.to?.[0]?.email || data.to?.[0]?.email || message.recipients?.[0]?.email;
    const subject = message.subject || data.subject || '(no subject)';
    const body = message.body || data.body || '';
    const grantId = data.grant_id || message.grant_id || object.grant_id;
    
    console.log('📩 [WEBHOOK-SENT] To:', toEmail);
    console.log('📩 [WEBHOOK-SENT] Grant ID:', grantId);

    if (!toEmail || !grantId) return;

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: grantId });
    if (!emailAccount) {
        console.log('⚠️ [WEBHOOK-SENT] No email account found for grant:', grantId);
        return;
    }

    const userId = emailAccount.userId;
    console.log('👤 [WEBHOOK-SENT] Found User ID:', userId);

    // Find the lead
    const lead = await Lead.findOne({ 
      userId: userId,
      email: { $regex: new RegExp('^' + toEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
    });

    if (lead) {
      console.log('✅ [WEBHOOK-SENT] Matched existing lead:', lead.name, '(ID:', lead._id, ')');
      
      const lastReply = lead.replies && lead.replies.length > 0 ? lead.replies[lead.replies.length - 1] : null;
      const isDuplicate = lastReply && 
                          lastReply.content === body && 
                          (new Date() - new Date(lastReply.date)) < 5000;

      if (!isDuplicate) {
        lead.status = 'Contacted';
        lead.lastContactDate = new Date();
        
        if (!lead.replies) lead.replies = [];
        lead.replies.push({
          from: 'ai',
          content: body || '',
          subject: subject,
          date: new Date(),
          read: true
        });
        
        await lead.save();
        console.log('💾 [WEBHOOK-SENT] Updated lead status and replies.');
      } else {
        console.log('⚠️ [WEBHOOK-SENT] Duplicate sent message skipped.');
      }
    } else {
        console.log('❌ [WEBHOOK-SENT] NO LEAD FOUND for email:', toEmail);
    }

  } catch (error) {
    console.error('❌ [WEBHOOK-SENT] Error:', error.message);
  }
}

// ──────────────────────────────────────────────────────────────
//  HANDLE: Grant Expired
// ──────────────────────────────────────────────────────────────
async function handleGrantExpired(eventData) {
  console.log('⏰ [WEBHOOK] Grant expired');
  
  try {
    const data = eventData.data || {};
    const grantId = data.grant_id;
    if (!grantId) return;

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: grantId });
    
    if (emailAccount) {
      emailAccount.isConnected = false;
      emailAccount.lastRefreshError = 'Grant expired webhook';
      await emailAccount.save();

      try {
        const notification = new Message({
          userId: emailAccount.userId,
          sessionId: 'system-notification',
          role: 'ai',
          title: '⚠️ Email Connection Expired',
          content: 'Your email connection has expired. Please reconnect to continue sending emails.',
          notificationType: 'token_expired',
          leadId: null,
          isRead: false,
          createdAt: new Date()
        });
        await notification.save();
      } catch (notifErr) {
        console.error('❌ [WEBHOOK] Failed to create notification:', notifErr.message);
      }
    }

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling grant expired:', error.message);
  }
}

// ──────────────────────────────────────────────────────────────
//  HANDLE: Grant Refreshed
// ──────────────────────────────────────────────────────────────
async function handleGrantRefreshed(eventData) {
  console.log('🔄 [WEBHOOK] Grant refreshed');
  
  try {
    const data = eventData.data || {};
    const grantId = data.grant_id;
    if (!grantId) return;

    await EmailAccount.findOneAndUpdate(
      { nylasGrantId: grantId },
      {
        isConnected: true,
        refreshFailCount: 0,
        lastRefreshError: null
      }
    );

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling grant refreshed:', error.message);
  }
}

// ──────────────────────────────────────────────────────────────
//  HELPER: Generate and Send Auto-Reply
// ──────────────────────────────────────────────────────────────
async function generateAndSendAutoReply(lead, userId) {
  try {
    console.log('🤖 [AUTO-REPLY] Generating reply for:', lead.email);
    
    const user = await User.findById(userId);
    if (!user) return;

    const emailAccount = await EmailAccount.findOne({ 
      userId: userId,
      isConnected: true
    });

    if (!emailAccount || !emailAccount.accessToken) return;

    const aiResponse = await generateAIReply({
      leadName: lead.name,
      leadEmail: lead.email,
      leadCompany: lead.company || '',
      leadMessage: lead.replies?.[lead.replies.length - 1]?.content || '',
      instructions: lead.autoReplyInstructions || 'Write a professional and helpful reply.',
      userContext: {
        name: user.fullName || 'Skyline User',
        company: user.company || 'Skyline',
        businessType: user.businessType || 'B2B'
      }
    });

    if (!aiResponse) return;

    const nylas = require('./nylasClient');
    
    const result = await nylas.sendEmail({
      grantId: emailAccount.nylasGrantId,
      accessToken: emailAccount.accessToken,
      to: [lead.email],
      subject: `Re: ${lead.replies?.[lead.replies.length - 1]?.subject || 'Your inquiry'}`,
      body: aiResponse
    });

    if (result && result.success) {
      if (!lead.replies) lead.replies = [];
      lead.replies.push({
        from: 'ai',
        content: aiResponse,
        subject: `Re: ${lead.replies?.[lead.replies.length - 1]?.subject || 'Your inquiry'}`,
        date: new Date(),
        autoReply: true,
        read: true
      });
      
      await lead.save();
      console.log('✅ [AUTO-REPLY] Auto-reply sent to:', lead.email);
    }

  } catch (error) {
    console.error('❌ [AUTO-REPLY] Error:', error.message);
  }
            }
