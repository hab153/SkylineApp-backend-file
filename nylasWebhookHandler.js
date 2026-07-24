const crypto = require('crypto');
const EmailAccount = require('./EmailAccount');
const Lead = require('./Lead');
const User = require('./User');
const Message = require('./Message'); 
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
      
      // Create notification for unknown reply
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
  
  // Try exact match first
  let lead = await Lead.findOne({ 
    userId: userId,
    email: { $regex: new RegExp('^' + fromEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
  });
  if (lead) return lead;

  // Try domain match
  const domain = fromEmail.split('@')[1];
  if (domain) {
    lead = await Lead.findOne({ 
      userId: userId,
      email: { $regex: new RegExp('@' + domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
    });
    if (lead) return lead;
  }

  // Try name match
  const leads = await Lead.find({ userId: userId }).limit(30);
  const nameParts = fromEmail.split('@')[0].toLowerCase().split(/[._-]/);
  for (const l of leads) {
    if (l.name) {
      const leadNameLower = l.name.toLowerCase();
      for (const part of nameParts) {
        if (part.length > 2 && leadNameLower.includes(part)) {
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

    // Save to ChatMessage
    try {
      const chatMessage = new ChatMessage({
        userId: userId,
        sessionId: lead._id.toString(),
        role: 'user', // In ChatMessage, 'user' means the lead (counter-intuitive but consistent with your frontend mapping)
        content: body || snippet || '(No content)',
        title: subject || '(no subject)',
        createdAt: new Date()
      });
      await chatMessage.save();
    } catch (chatErr) {
      console.warn('⚠️ [WEBHOOK] Failed to save to ChatMessage:', chatErr.message);
    }

    // Create notification
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
    } catch (notifErr) {
      console.error('❌ [WEBHOOK] Failed to create notification:', notifErr.message);
    }

    if (lead.autoReplyEnabled) {
      await generateAndSendAutoReply(lead, userId);
    }

  } catch (error) {
    console.error('❌ [WEBHOOK] Error processing reply:', error.message);
  }
}

// ──────────────────────────────────────────────────────────────
//  HANDLE: Message Sent (FIXED)
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

    // Find the lead
    const lead = await Lead.findOne({ 
      userId: userId,
      email: { $regex: new RegExp('^' + toEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
    });

    if (lead) {
      // ✅ FIX: Check if this message was already added by batchSend to avoid duplicates
      const lastReply = lead.replies && lead.replies.length > 0 ? lead.replies[lead.replies.length - 1] : null;
      const isDuplicate = lastReply && 
                          lastReply.content === body && 
                          (new Date() - new Date(lastReply.date)) < 5000;

      if (!isDuplicate) {
        lead.status = 'Contacted';
        lead.lastContactDate = new Date();
        
        if (!lead.replies) lead.replies = [];
        lead.replies.push({
          from: 'ai', // ✅ FIX: Changed from 'you' to 'ai' to match Lead.js schema
          content: body || '',
          subject: subject,
          date: new Date(),
          read: true
        });
        
        await lead.save();
        console.log('✅ [WEBHOOK] Lead status updated to Contacted:', lead.name);
      } else {
        console.log('⚠️ [WEBHOOK] Duplicate sent message skipped');
      }
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
