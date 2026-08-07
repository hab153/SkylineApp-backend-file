const crypto = require('crypto');
const EmailAccount = require('./EmailAccount');
const Lead = require('./Lead');
const User = require('./User');
const Message = require('./Message'); 
const ChatMessage = require('./ChatMessage');
const { generateAIReply } = require('./aiReplyGenerator');
const { decrypt } = require('./encryption'); 
const { isValidObjectId, sanitizeString } = require('./sanitize');

function sanitizeEmailBody(html) {
  if (!html || typeof html !== 'string') return '';
  return html.substring(0, 10000);
}

function sanitizeEmailAddress(email) {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return null;
  if (!trimmed.includes('@')) return null;
  const parts = trimmed.split('@');
  if (parts.length !== 2) return null;
  if (parts[0].length === 0 || parts[1].length === 0) return null;
  if (parts[1].length > 253) return null;
  return trimmed.toLowerCase();
}

function validateWebhookSignature(req) {
  const webhookSecret = process.env.NYLAS_WEBHOOK_SECRET_SKYLINE;
  
  if (!webhookSecret) {
    console.error('❌ [WEBHOOK SECURITY] NYLAS_WEBHOOK_SECRET_SKYLINE is not configured!');
    return false;
  }
  
  const signature = req.headers['x-nylas-signature'] || req.headers['X-Nylas-Signature'];
  
  if (!signature || typeof signature !== 'string') {
    console.warn('⚠️ [WEBHOOK SECURITY] Missing X-Nylas-Signature header');
    return false;
  }
  
  let rawBody;
  if (Buffer.isBuffer(req.body)) {
    rawBody = req.body.toString('utf8');
  } else if (typeof req.body === 'string') {
    rawBody = req.body;
  } else {
    rawBody = JSON.stringify(req.body);
  }
  
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');
  
  try {
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    
    if (sigBuffer.length !== expectedBuffer.length) {
      console.warn('⚠️ [WEBHOOK SECURITY] Signature length mismatch');
      return false;
    }
    
    const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
    
    if (!isValid) {
      console.warn('⚠️ [WEBHOOK SECURITY] Invalid webhook signature - request rejected');
    }
    
    return isValid;
  } catch (err) {
    console.error('❌ [WEBHOOK SECURITY] Signature comparison error:', err.message);
    return false;
  }
}

exports.handleWebhook = async (req, res) => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔔 [WEBHOOK] Request received!');
  console.log(' [WEBHOOK] Method:', req.method);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (req.method === 'GET' && req.query.challenge) {
    const raw = String(req.query.challenge);
    if (raw.length === 0 || raw.length > 128) {
      return res.status(400).json({ error: 'Invalid challenge' });
    }
    console.log(' [Nylas Webhook] Received GET challenge, responding...');
    return res.status(200).json({ status: 'ok' });
  }

  if (req.method === 'POST') {
    if (!validateWebhookSignature(req)) {
      console.error('❌ [WEBHOOK SECURITY] Rejected unsigned/invalid webhook request');
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    
    console.log('✅ [WEBHOOK SECURITY] Signature validated successfully');

    let eventData = req.body;
    if (Buffer.isBuffer(eventData)) {
      try {
        eventData = JSON.parse(eventData.toString('utf8'));
      } catch (e) {
        console.error(' [Nylas Webhook] Failed to parse JSON body');
        return res.status(400).send('Invalid JSON');
      }
    } else if (typeof eventData === 'string') {
      try {
        eventData = JSON.parse(eventData);
      } catch (e) {
        console.error(' [Nylas Webhook] Failed to parse JSON string');
        return res.status(400).send('Invalid JSON');
      }
    }
    
    console.log('📨 [NYLAS WEBHOOK] Event type:', eventData.type);

    try {
      switch (eventData.type) {
        case 'message.created':
        case 'message.updated':
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
      console.error(' [NYLAS WEBHOOK] Error processing event:', error.message);
    }

    return res.status(200).send('Webhook received');
  }

  res.status(405).send('Method Not Allowed');
};

async function handleMessageCreated(eventData) {
  console.log(' [WEBHOOK] Processing message created/updated');
  
  try {
    const data = eventData.data || {};
    const object = data.object || {};
    let message = object.message || data.message || data;
    
    if (message.data && typeof message.data === 'object') {
      message = message.data;
    }
    
    const grantId = data.grant_id || object.grant_id || message.grant_id || message.grantId;
    const threadId = message.thread_id || data.thread_id || object.thread_id || null;
    
    let fromEmail = null;
    let fromName = null;
    if (object.from) {
      if (Array.isArray(object.from) && object.from.length > 0) {
        fromEmail = object.from[0].email || object.from[0].address;
        fromName = object.from[0].name || '';
      } else if (typeof object.from === 'object') {
        fromEmail = object.from.email || object.from.address;
        fromName = object.from.name || '';
      }
    }
    
    let toEmail = null;
    if (object.to) {
      if (Array.isArray(object.to) && object.to.length > 0) {
        toEmail = object.to[0].email || object.to[0].address;
      } else if (typeof object.to === 'object') {
        toEmail = object.to.email || object.to.address;
      }
    }
    
    if (!fromEmail && message.from) {
      if (Array.isArray(message.from) && message.from.length > 0) {
        fromEmail = message.from[0]?.email || message.from[0]?.address;
        fromName = message.from[0]?.name || '';
      } else if (typeof message.from === 'object') {
        fromEmail = message.from.email || message.from.address;
        fromName = message.from.name || '';
      }
    }
    
    if (!toEmail && message.to) {
      if (Array.isArray(message.to) && message.to.length > 0) {
        toEmail = message.to[0]?.email || message.to[0]?.address;
      } else if (typeof message.to === 'object') {
        toEmail = message.to.email || message.to.address;
      }
    }
    
    const subject = message.subject || data.subject || object.subject || '(no subject)';
    const rawBody = message.body || message.text || message.snippet || data.body || data.snippet || object.body || '';
    const body = sanitizeEmailBody(rawBody); 
    const snippet = message.snippet || data.snippet || object.snippet || '';
    const messageId = message.id || message.message_id || data.id || object.id || null;
    
    const safeFromEmail = sanitizeEmailAddress(fromEmail);
    const safeToEmail = sanitizeEmailAddress(toEmail);

    if (!grantId || typeof grantId !== 'string') {
      console.log('️ [WEBHOOK] Missing or invalid grantId');
      return;
    }
    const cappedGrantId = grantId.substring(0, 128);
    let safeGrantId = '';
    for (let i = 0; i < cappedGrantId.length; i++) {
      const c = cappedGrantId.charCodeAt(i);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95) {
        safeGrantId += cappedGrantId[i];
      }
    }

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: safeGrantId });
    if (!emailAccount) {
      console.log('️ [WEBHOOK] No email account found for grantId');
      return;
    }

    if (safeFromEmail && emailAccount.emailAddress && 
        safeFromEmail.toLowerCase() === String(emailAccount.emailAddress).toLowerCase()) {
      console.log('️ [WEBHOOK] Skipping own sent message');
      return;
    }

    const userId = String(emailAccount.userId);
    if (!isValidObjectId(userId)) {
      console.error('❌ [WEBHOOK] Invalid userId from email account');
      return;
    }

    let lead = null;
    if (threadId && typeof threadId === 'string') {
      const cappedThreadId = threadId.substring(0, 128);
      let safeThreadId = '';
      for (let i = 0; i < cappedThreadId.length; i++) {
        const c = cappedThreadId.charCodeAt(i);
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95) {
          safeThreadId += cappedThreadId[i];
        }
      }
      if (safeThreadId) {
        lead = await Lead.findOne({ userId: userId, threadId: safeThreadId });
        if (lead) {
          console.log('✅ [WEBHOOK] Found lead by thread_id:', lead._id);
        }
      }
    }

    if (!lead && (safeFromEmail || safeToEmail)) {
      lead = await findMatchingLead(userId, safeFromEmail, safeToEmail);
    }

    if (!lead) {
      const leadEmail = safeFromEmail || safeToEmail || 'unknown@email.com';
      const displayName = (fromName && typeof fromName === 'string') 
        ? sanitizeString(fromName.substring(0, 100)) 
        : leadEmail.split('@')[0] || 'Unknown Contact';
      
      let safeThreadIdForStorage = null;
      if (threadId && typeof threadId === 'string') {
        const capped = threadId.substring(0, 128);
        let s = '';
        for (let i = 0; i < capped.length; i++) {
          const c = capped.charCodeAt(i);
          if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95) s += capped[i];
        }
        safeThreadIdForStorage = s || null;
      }
      
      lead = new Lead({
        userId: userId,
        name: displayName,
        email: leadEmail,
        company: '',
        status: 'New',
        threadId: safeThreadIdForStorage,
        replies: [{
          from: 'customer',
          content: body || snippet || '(No content)',
          subject: typeof subject === 'string' ? subject.substring(0, 200) : '(no subject)',
          date: new Date(),
          read: false,
          messageId: (messageId && typeof messageId === 'string') ? String(messageId).substring(0, 100) : null
        }],
        lastContactDate: new Date(),
        autoReplyEnabled: false
      });
      
      await lead.save();
      console.log('✅ [WEBHOOK] Created new lead:', lead._id);
    }

    await processReply(lead, safeFromEmail, subject, body, snippet, messageId, userId);

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling message:', error.message);
  }
}

async function findMatchingLead(userId, fromEmail, toEmail) {
  const normalizedFrom = fromEmail?.toLowerCase()?.trim();
  const normalizedTo = toEmail?.toLowerCase()?.trim();
  
  if (!normalizedFrom && !normalizedTo) return null;

  const allLeads = await Lead.find({ userId: String(userId) }).limit(500).lean();
  
  for (const lead of allLeads) {
    let decryptedEmail = lead.email;
    try {
      if (decryptedEmail && /^[A-Za-z0-9+/=]{20,}$/.test(decryptedEmail)) {
        decryptedEmail = decrypt(decryptedEmail);
      }
    } catch (err) {
      continue;
    }
    
    const cleanEmail = decryptedEmail?.toLowerCase()?.trim();
    if (!cleanEmail) continue;
    
    if (normalizedFrom && cleanEmail === normalizedFrom) return lead;
    if (normalizedTo && cleanEmail === normalizedTo) return lead;
  }

  return null;
}

// ✅ SSE: processReply now pushes new messages to the user's browser instantly
async function processReply(lead, fromEmail, subject, body, snippet, messageId, userId) {
  try {
    lead.status = 'Replied';
    lead.lastContactDate = new Date();
    
    if (!lead.replies) lead.replies = [];
    
    const replyContent = body || snippet || '(No content)';
    const replySubject = (typeof subject === 'string') ? subject.substring(0, 200) : '(no subject)';
    
    lead.replies.push({
      from: 'customer',
      content: replyContent,
      subject: replySubject,
      date: new Date(),
      messageId: (messageId && typeof messageId === 'string') ? String(messageId).substring(0, 100) : null,
      read: false
    });
    
    await lead.save();

    try {
      const chatMessage = new ChatMessage({
        userId: String(userId),
        sessionId: String(lead._id),
        role: 'user',
        content: replyContent,
        title: replySubject,
        createdAt: new Date()
      });
      await chatMessage.save();
    } catch (chatErr) {
      console.warn('️ [WEBHOOK] Failed to save ChatMessage:', chatErr.message);
    }

    try {
      const notification = new Message({
        userId: String(userId),
        sessionId: 'lead-reply-notification',
        role: 'system',
        title: `${sanitizeString(String(lead.name || 'Lead'))} replied`,
        content: snippet ? String(snippet).substring(0, 200) : 'New reply from lead',
        notificationType: 'lead_reply',
        leadId: String(lead._id),
        isRead: false,
        createdAt: new Date()
      });
      await notification.save();
    } catch (notifErr) {
      console.warn('⚠️ [WEBHOOK] Failed to create notification:', notifErr.message);
    }

    // ✅ SSE: Push new message to user's browser INSTANTLY (< 1 second)
    try {
      const serverModule = require('./server');
      if (serverModule && typeof serverModule.notifyUser === 'function') {
        serverModule.notifyUser(userId, {
          type: 'new_message',
          leadId: String(lead._id),
          leadName: lead.name || 'Unknown',
          leadEmail: lead.email || '',
          fromEmail: fromEmail || '',
          subject: replySubject,
          content: replyContent,
          snippet: snippet ? String(snippet).substring(0, 200) : '',
          date: new Date().toISOString(),
          messageId: messageId || ''
        });
        console.log('📡 [SSE] Pushed new_message to user ' + userId + ' for lead ' + lead._id);
      }
    } catch (sseErr) {
      // SSE push failed — not critical, message is already saved in DB
      console.warn('⚠️ [SSE] Failed to push notification:', sseErr.message);
    }

  } catch (error) {
    console.error('❌ [WEBHOOK] Error processing reply:', error.message);
  }
}

async function handleMessageSent(eventData) {
  try {
    const data = eventData.data || {};
    const object = data.object || {};
    let message = object.message || data.message || data;
    
    const toEmail = message.to?.[0]?.email || data.to?.[0]?.email || message.recipients?.[0]?.email;
    const subject = message.subject || data.subject || '(no subject)';
    const body = message.body || data.body || '';
    const grantId = data.grant_id || message.grant_id || object.grant_id;
    
    const safeToEmail = sanitizeEmailAddress(toEmail);
    
    if (!safeToEmail || !grantId || typeof grantId !== 'string') return;
    
    const cappedGrantId = grantId.substring(0, 128);
    let safeGrantId = '';
    for (let i = 0; i < cappedGrantId.length; i++) {
      const c = cappedGrantId.charCodeAt(i);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95) {
        safeGrantId += cappedGrantId[i];
      }
    }

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: safeGrantId });
    if (!emailAccount) return;

    const userId = String(emailAccount.userId);
    if (!isValidObjectId(userId)) return;

    const lead = await findMatchingLead(userId, null, safeToEmail);

    if (lead) {
      const recentReplies = lead.replies.slice(-5);
      const safeBody = typeof body === 'string' ? body.trim() : '';
      const isDuplicate = recentReplies.some(r => 
        r.from === 'lead' && 
        String(r.content || '').trim() === safeBody && 
        Math.abs(new Date() - new Date(r.date)) < 60000
      );

      if (!isDuplicate) {
        lead.status = 'Contacted';
        lead.lastContactDate = new Date();
        
        if (!lead.replies) lead.replies = [];
        lead.replies.push({
          from: 'lead',
          content: safeBody,
          subject: (typeof subject === 'string') ? subject.substring(0, 200) : '(no subject)',
          date: new Date(),
          read: true
        });
        
        await lead.save();

        // ✅ SSE: Also push sent messages so the user sees their own sent email instantly
        try {
          const serverModule = require('./server');
          if (serverModule && typeof serverModule.notifyUser === 'function') {
            serverModule.notifyUser(userId, {
              type: 'new_message',
              leadId: String(lead._id),
              leadName: lead.name || 'Unknown',
              leadEmail: lead.email || '',
              fromEmail: '',
              subject: (typeof subject === 'string') ? subject.substring(0, 200) : '(no subject)',
              content: safeBody,
              snippet: safeBody.substring(0, 200),
              date: new Date().toISOString(),
              messageId: '',
              sent: true
            });
            console.log('📡 [SSE] Pushed sent_message to user ' + userId + ' for lead ' + lead._id);
          }
        } catch (sseErr) {
          console.warn('⚠️ [SSE] Failed to push sent notification:', sseErr.message);
        }
      }
    }

  } catch (error) {
    console.error('❌ [WEBHOOK-SENT] Error:', error.message);
  }
}

async function handleGrantExpired(eventData) {
  try {
    const data = eventData.data || {};
    const grantId = data.grant_id;
    
    if (!grantId || typeof grantId !== 'string') return;
    const cappedGrantId = grantId.substring(0, 128);
    let safeGrantId = '';
    for (let i = 0; i < cappedGrantId.length; i++) {
      const c = cappedGrantId.charCodeAt(i);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95) {
        safeGrantId += cappedGrantId[i];
      }
    }

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: safeGrantId });
    
    if (emailAccount) {
      emailAccount.isConnected = false;
      emailAccount.lastRefreshError = 'Grant expired';
      await emailAccount.save();

      try {
        const notification = new Message({
          userId: String(emailAccount.userId),
          sessionId: 'system-notification',
          role: 'system',
          title: 'Email Connection Expired',
          content: 'Your email connection has expired. Please reconnect.',
          notificationType: 'token_expired',
          leadId: null,
          isRead: false,
          createdAt: new Date()
        });
        await notification.save();
      } catch (notifErr) {
        console.warn('⚠️ [WEBHOOK] Failed to create expiry notification:', notifErr.message);
      }

      // ✅ SSE: Notify user that their email connection expired
      try {
        const serverModule = require('./server');
        if (serverModule && typeof serverModule.notifyUser === 'function') {
          serverModule.notifyUser(emailAccount.userId, {
            type: 'connection_expired',
            message: 'Your email connection has expired. Please reconnect.'
          });
          console.log('📡 [SSE] Pushed connection_expired to user ' + emailAccount.userId);
        }
      } catch (sseErr) {
        console.warn('⚠️ [SSE] Failed to push expiry notification:', sseErr.message);
      }
    }

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling grant expired:', error.message);
  }
}

async function handleGrantRefreshed(eventData) {
  try {
    const data = eventData.data || {};
    const grantId = data.grant_id;
    
    if (!grantId || typeof grantId !== 'string') return;
    const cappedGrantId = grantId.substring(0, 128);
    let safeGrantId = '';
    for (let i = 0; i < cappedGrantId.length; i++) {
      const c = cappedGrantId.charCodeAt(i);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95) {
        safeGrantId += cappedGrantId[i];
      }
    }

    await EmailAccount.findOneAndUpdate(
      { nylasGrantId: safeGrantId },
      { isConnected: true, refreshFailCount: 0, lastRefreshError: null }
    );

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling grant refreshed:', error.message);
  }
}

async function generateAndSendAutoReply(lead, userId) {
  try {
    const user = await User.findById(String(userId));
    if (!user) return;

    const emailAccount = await EmailAccount.findOne({ 
      userId: String(userId),
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
        from: 'lead',
        content: aiResponse,
        subject: `Re: ${lead.replies?.[lead.replies.length - 1]?.subject || 'Your inquiry'}`,
        date: new Date(),
        autoReply: true,
        read: true
      });
      
      await lead.save();

      // ✅ SSE: Push auto-reply to user's browser so they see it instantly
      try {
        const serverModule = require('./server');
        if (serverModule && typeof serverModule.notifyUser === 'function') {
          serverModule.notifyUser(userId, {
            type: 'new_message',
            leadId: String(lead._id),
            leadName: lead.name || 'Unknown',
            leadEmail: lead.email || '',
            fromEmail: '',
            subject: `Re: ${lead.replies?.[lead.replies.length - 1]?.subject || 'Your inquiry'}`,
            content: aiResponse,
            snippet: aiResponse.substring(0, 200),
            date: new Date().toISOString(),
            messageId: '',
            sent: true,
            autoReply: true
          });
          console.log('📡 [SSE] Pushed auto_reply to user ' + userId + ' for lead ' + lead._id);
        }
      } catch (sseErr) {
        console.warn('⚠️ [SSE] Failed to push auto-reply notification:', sseErr.message);
      }
    }

  } catch (error) {
    console.error(' [AUTO-REPLY] Error:', error.message);
  }
      }
