const crypto = require('crypto');
const EmailAccount = require('./EmailAccount');
const Lead = require('./Lead');
const User = require('./User');
const Message = require('./Message'); // ✅ FIXED: Use Message model instead of Notification
const ChatMessage = require('./ChatMessage');
const { generateAIReply } = require('./aiReplyGenerator');

exports.handleWebhook = async (req, res) => {
  const webhookSecret = process.env.NYLAS_WEBHOOK_SECRET;

  // 1. Handle Nylas Challenge (Verification Step - GET Request)
  if (req.method === 'GET' && req.query.challenge) {
    console.log('🔔 [Nylas Webhook] Received GET challenge, responding...');
    return res.status(200).send(req.query.challenge);
  }

  // 2. Handle Actual Webhook Events (POST Request)
  if (req.method === 'POST') {
    const signature = req.headers['x-nylas-signature'];
    
    if (signature && webhookSecret && webhookSecret !== 'your-webhook-secret-here') {
      try {
        let bodyContent;
        if (Buffer.isBuffer(req.body)) {
          bodyContent = req.body;
        } else if (typeof req.body === 'string') {
          bodyContent = Buffer.from(req.body);
        } else {
          bodyContent = Buffer.from(JSON.stringify(req.body));
        }
        
        const hmac = crypto.createHmac('sha256', webhookSecret);
        const digest = hmac.update(bodyContent).digest('hex');

        if (signature !== digest) {
          console.warn('⚠️ [Nylas Webhook] Invalid signature detected.');
        }
      } catch (sigErr) {
        console.warn('⚠️ [Nylas Webhook] Signature verification error:', sigErr.message);
      }
    }

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
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📨 [NYLAS WEBHOOK] Event received');
    console.log('📨 [NYLAS WEBHOOK] Event type:', eventData.type);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      switch (eventData.type) {
        case 'message.created':
          await handleMessageCreated(eventData);
          break;
        case 'thread.replied':
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
//  HANDLE: Message Created (Email Received)
// ──────────────────────────────────────────────────────────────
async function handleMessageCreated(eventData) {
  console.log('📥 [WEBHOOK] New message received');
  
  try {
    const data = eventData.data || {};
    const object = data.object || {};
    let message = object.message || data.message || data;
    
    if (message.data && typeof message.data === 'object') {
      message = message.data;
    }
    
    const grantId = data.grant_id || object.grant_id || message.grant_id || message.grantId;
    
    let fromEmail = null;
    if (message.from) {
      if (Array.isArray(message.from)) {
        fromEmail = message.from[0]?.email || message.from[0]?.address;
      } else if (typeof message.from === 'object') {
        fromEmail = message.from.email || message.from.address;
      } else if (typeof message.from === 'string') {
        fromEmail = message.from;
      }
    }
    if (!fromEmail) fromEmail = data.from?.[0]?.email || data.from?.[0]?.address;
    if (!fromEmail) fromEmail = object.from?.[0]?.email || object.from?.[0]?.address;
    if (!fromEmail) fromEmail = message.sender?.email || message.sender?.address;
    
    const subject = message.subject || data.subject || object.subject || '(no subject)';
    const body = message.body || message.text || message.snippet || data.body || data.snippet || object.body || '';
    const snippet = message.snippet || data.snippet || object.snippet || '';
    const messageId = message.id || message.message_id || data.id || object.id || null;
    
    console.log('📩 [WEBHOOK] From:', fromEmail);
    console.log('📩 [WEBHOOK] Subject:', subject);
    console.log('📩 [WEBHOOK] Snippet:', snippet ? snippet.substring(0, 100) : '(empty)');

    if (!fromEmail || !grantId) {
      console.log('⚠️ [WEBHOOK] Missing fromEmail or grantId');
      return;
    }

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: grantId });
    if (!emailAccount) {
      console.log('⚠️ [WEBHOOK] No email account found for grantId:', grantId);
      return;
    }

    const userId = emailAccount.userId;
    console.log('✅ [WEBHOOK] Found userId:', userId);

    const lead = await findMatchingLead(userId, fromEmail);

    if (!lead) {
      console.log('📭 [WEBHOOK] No matching lead found for:', fromEmail);
      
      // ✅ FIXED: Create notification using Message model with proper fields
      try {
        const notification = new Message({
          userId: userId,
          sessionId: 'unknown-reply-notification',
          role: 'ai',
          title: '📬 Unknown Reply',
          content: `Unknown reply from ${fromEmail}: ${snippet ? snippet.substring(0, 200) : 'No content'}`,
          notificationType: 'unknown_reply',
          leadId: null,
          isRead: false,
          createdAt: new Date()
        });
        await notification.save();
        console.log('🔔 [WEBHOOK] Unknown reply notification created');
      } catch (notifErr) {
        console.error('❌ [WEBHOOK] Failed to create notification:', notifErr.message);
      }
      return;
    }

    await processReply(lead, fromEmail, subject, body, snippet, messageId, userId);

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling message:', error.message);
  }
}

// ──────────────────────────────────────────────────────────────
//  FIND MATCHING LEAD
// ──────────────────────────────────────────────────────────────
async function findMatchingLead(userId, fromEmail) {
  if (!fromEmail) return null;
  
  let lead = await Lead.findOne({ 
    userId: userId,
    email: { $regex: new RegExp('^' + fromEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
  });
  if (lead) return lead;

  const domain = fromEmail.split('@')[1];
  if (domain) {
    lead = await Lead.findOne({ 
      userId: userId,
      email: { $regex: new RegExp('@' + domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
    });
    if (lead) {
      console.log('✅ [WEBHOOK] Found lead by domain:', lead.name);
      return lead;
    }
  }

  const leads = await Lead.find({ userId: userId }).limit(30);
  const nameParts = fromEmail.split('@')[0].toLowerCase().split(/[._-]/);
  for (const l of leads) {
    if (l.name) {
      const leadNameLower = l.name.toLowerCase();
      for (const part of nameParts) {
        if (part.length > 2 && leadNameLower.includes(part)) {
          console.log('✅ [WEBHOOK] Found lead by name match:', l.name);
          return l;
        }
      }
    }
  }

  return null;
}

// ──────────────────────────────────────────────────────────────
//  PROCESS REPLY
// ──────────────────────────────────────────────────────────────
async function processReply(lead, fromEmail, subject, body, snippet, messageId, userId) {
  console.log('📝 [WEBHOOK] Processing reply for lead:', lead.name);

  try {
    lead.status = 'Replied';
    lead.lastContactDate = new Date();
    
    if (!lead.replies) lead.replies = [];
    lead.replies.push({
      from: 'lead',
      content: body || snippet || '(No content)',
      subject: subject || '(no subject)',
      date: new Date(),
      messageId: messageId,
      read: false
    });
    
    await lead.save();
    console.log('✅ [WEBHOOK] Reply saved to Lead.replies');

    try {
      const chatMessage = new ChatMessage({
        userId: userId,
        sessionId: lead._id.toString(),
        role: 'user',
        content: body || snippet || '(No content)',
        title: subject || '(no subject)',
        createdAt: new Date()
      });
      await chatMessage.save();
      console.log('✅ [WEBHOOK] Reply saved to ChatMessage');
    } catch (chatErr) {
      console.warn('⚠️ [WEBHOOK] Failed to save to ChatMessage:', chatErr.message);
    }

    // ✅ FIXED: Create notification using Message model with proper fields
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
      console.log('🔔 [WEBHOOK] Notification created for user');
    } catch (notifErr) {
      console.error('❌ [WEBHOOK] Failed to create notification:', notifErr.message);
    }

    if (lead.autoReplyEnabled) {
      console.log('🤖 [WEBHOOK] Auto-reply enabled, generating reply...');
      await generateAndSendAutoReply(lead, userId);
    }

  } catch (error) {
    console.error('❌ [WEBHOOK] Error processing reply:', error.message);
  }
}

// ──────────────────────────────────────────────────────────────
//  HANDLE: Message Sent
// ──────────────────────────────────────────────────────────────
async function handleMessageSent(eventData) {
  console.log('📤 [WEBHOOK] Message sent');
  
  try {
    const data = eventData.data || {};
    const object = data.object || {};
    let message = object.message || data.message || data;
    
    const toEmail = message.to?.[0]?.email || data.to?.[0]?.email || message.recipients?.[0]?.email;
    const subject = message.subject || data.subject || '(no subject)';
    const body = message.body || data.body || '';
    const grantId = data.grant_id || message.grant_id || object.grant_id;
    
    if (!toEmail || !grantId) return;

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: grantId });
    if (!emailAccount) return;

    const userId = emailAccount.userId;

    const lead = await Lead.findOne({ 
      userId: userId,
      email: { $regex: new RegExp('^' + toEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
    });

    if (lead) {
      lead.status = 'Contacted';
      lead.lastContactDate = new Date();
      
      if (!lead.replies) lead.replies = [];
      lead.replies.push({
        from: 'you',
        content: body || '',
        subject: subject,
        date: new Date(),
        read: true
      });
      
      await lead.save();
      console.log('✅ [WEBHOOK] Lead status updated to Contacted:', lead.name);
    }

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling message sent:', error.message);
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
    console.log('🔴 [WEBHOOK] Grant expired for:', grantId);

    if (!grantId) return;

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: grantId });
    
    if (emailAccount) {
      emailAccount.isConnected = false;
      emailAccount.lastRefreshError = 'Grant expired webhook';
      await emailAccount.save();

      // ✅ FIXED: Create notification using Message model
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
        console.log('🔔 [WEBHOOK] Token expiry notification created');
      } catch (notifErr) {
        console.error('❌ [WEBHOOK] Failed to create notification:', notifErr.message);
      }

      console.log('✅ [WEBHOOK] Grant marked as expired for user:', emailAccount.userId);
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

    const emailAccount = await EmailAccount.findOneAndUpdate(
      { nylasGrantId: grantId },
      {
        isConnected: true,
        refreshFailCount: 0,
        lastRefreshError: null
      },
      { new: true }
    );

    if (emailAccount) {
      console.log('✅ [WEBHOOK] Grant refreshed successfully for user:', emailAccount.userId);
    }

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
    if (!user) {
      console.log('❌ [AUTO-REPLY] User not found');
      return;
    }

    const emailAccount = await EmailAccount.findOne({ 
      userId: userId,
      isConnected: true
    });

    if (!emailAccount || !emailAccount.accessToken) {
      console.log('❌ [AUTO-REPLY] No connected email found');
      return;
    }

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

    if (!aiResponse) {
      console.log('❌ [AUTO-REPLY] No AI response generated');
      return;
    }

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
        from: 'you',
        content: aiResponse,
        subject: `Re: ${lead.replies?.[lead.replies.length - 1]?.subject || 'Your inquiry'}`,
        date: new Date(),
        autoReply: true,
        read: true
      });
      
      await lead.save();
      console.log('✅ [AUTO-REPLY] Auto-reply sent to:', lead.email);
    } else {
      console.log('❌ [AUTO-REPLY] Failed to send auto-reply:', result?.error || 'Unknown error');
    }

  } catch (error) {
    console.error('❌ [AUTO-REPLY] Error:', error.message);
  }
    }
