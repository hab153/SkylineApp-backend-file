const crypto = require('crypto');
const EmailAccount = require('./EmailAccount');
const Lead = require('./Lead');
const User = require('./User');
const Message = require('./Message'); 
const ChatMessage = require('./ChatMessage');
const { generateAIReply } = require('./aiReplyGenerator');

// ─── DEBUG CONFIG ───
const DEBUG_WEBHOOK = true;

function debugLog(...args) {
    if (DEBUG_WEBHOOK) {
        console.log('🔍 [WEBHOOK-DEBUG]', ...args);
    }
}

exports.handleWebhook = async (req, res) => {
  const webhookSecret = process.env.NYLAS_WEBHOOK_SECRET;

  // ─── DEBUG: Log EVERYTHING ───
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔔 [WEBHOOK] Request received!');
  console.log('🔔 [WEBHOOK] Method:', req.method);
  console.log('🔔 [WEBHOOK] URL:', req.url);
  console.log('🔔 [WEBHOOK] Headers:', JSON.stringify(req.headers, null, 2));
  console.log('🔔 [WEBHOOK] Query params:', req.query);
  console.log('🔔 [WEBHOOK] Body type:', typeof req.body);
  console.log('🔔 [WEBHOOK] Body is Buffer:', Buffer.isBuffer(req.body));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Handle Nylas Challenge (Verification Step - GET Request)
  if (req.method === 'GET' && req.query.challenge) {
    console.log('🔔 [Nylas Webhook] Received GET challenge, responding...');
    return res.status(200).send(req.query.challenge);
  }

  // 2. Handle Actual Webhook Events (POST Request)
  if (req.method === 'POST') {
    const signature = req.headers['x-nylas-signature'];
    console.log('🔔 [WEBHOOK] Signature present:', !!signature);
    
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
        } else {
          console.log('✅ [WEBHOOK] Signature verified');
        }
      } catch (sigErr) {
        console.warn('⚠️ [Nylas Webhook] Signature verification error:', sigErr.message);
      }
    }

    // Parse event data
    let eventData = req.body;
    console.log('🔔 [WEBHOOK] Raw body (first 500 chars):', JSON.stringify(eventData).substring(0, 500));
    
    if (Buffer.isBuffer(eventData)) {
      try {
        eventData = JSON.parse(eventData.toString('utf8'));
        console.log('✅ [WEBHOOK] Parsed from buffer');
      } catch (e) {
        console.error('❌ [Nylas Webhook] Failed to parse JSON body');
        return res.status(400).send('Invalid JSON');
      }
    } else if (typeof eventData === 'string') {
      try {
        eventData = JSON.parse(eventData);
        console.log('✅ [WEBHOOK] Parsed from string');
      } catch (e) {
        console.error('❌ [Nylas Webhook] Failed to parse JSON string');
        return res.status(400).send('Invalid JSON');
      }
    }
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📨 [NYLAS WEBHOOK] Event received');
    console.log('📨 [NYLAS WEBHOOK] Event type:', eventData.type);
    console.log('📨 [NYLAS WEBHOOK] Event data keys:', Object.keys(eventData));
    console.log('📨 [NYLAS WEBHOOK] Full event data:', JSON.stringify(eventData, null, 2));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      switch (eventData.type) {
        case 'message.created':
          console.log('✅ [WEBHOOK] Processing message.created');
          await handleMessageCreated(eventData);
          break;
        case 'thread.replied':
          console.log('✅ [WEBHOOK] Processing thread.replied');
          await handleMessageCreated(eventData);
          break;
        case 'message.sent':
          console.log('✅ [WEBHOOK] Processing message.sent');
          await handleMessageSent(eventData);
          break;
        case 'grant.expired':
          console.log('✅ [WEBHOOK] Processing grant.expired');
          await handleGrantExpired(eventData);
          break;
        case 'grant.refreshed':
          console.log('✅ [WEBHOOK] Processing grant.refreshed');
          await handleGrantRefreshed(eventData);
          break;
        default:
          console.log('ℹ️ [NYLAS WEBHOOK] Unhandled event type:', eventData.type);
      }
    } catch (error) {
      console.error('❌ [NYLAS WEBHOOK] Error processing event:', error.message);
      console.error('❌ [NYLAS WEBHOOK] Error stack:', error.stack);
    }

    console.log('✅ [WEBHOOK] Returning 200 OK');
    return res.status(200).send('Webhook received');
  }

  console.log('❌ [WEBHOOK] Method not allowed:', req.method);
  res.status(405).send('Method Not Allowed');
};

// ──────────────────────────────────────────────────────────────
//  HANDLE: Message Created (Email Received) - FIXED
// ──────────────────────────────────────────────────────────────
async function handleMessageCreated(eventData) {
  console.log('📥 [WEBHOOK] New message received');
  console.log('📥 [WEBHOOK] Full eventData:', JSON.stringify(eventData, null, 2));
  
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
    console.log('📩 [WEBHOOK] Body length:', body?.length || 0);
    console.log('📩 [WEBHOOK] Grant ID:', grantId);

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

    // ✅ Find matching lead
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
        console.log('✅ [WEBHOOK] Unknown reply notification created');
      } catch (notifErr) {
        console.error('❌ [WEBHOOK] Failed to create notification:', notifErr.message);
      }
      return;
    }

    console.log('✅ [WEBHOOK] Found lead:', lead.name, '(ID:', lead._id, ')');
    console.log('✅ [WEBHOOK] Lead email:', lead.email);
    console.log('✅ [WEBHOOK] Lead replies count:', lead.replies?.length || 0);

    // ✅ Process the reply
    await processReply(lead, fromEmail, subject, body, snippet, messageId, userId);

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling message:', error.message);
    console.error('❌ [WEBHOOK] Error stack:', error.stack);
  }
}

// ──────────────────────────────────────────────────────────────
//  FIND MATCHING LEAD (FIXED - MORE AGGRESSIVE)
// ──────────────────────────────────────────────────────────────
async function findMatchingLead(userId, fromEmail) {
  if (!fromEmail) {
    console.log('⚠️ [WEBHOOK] No fromEmail provided');
    return null;
  }
  
  console.log('🔍 [WEBHOOK] Looking for lead with email:', fromEmail);
  
  // ✅ Try exact match first (case-insensitive)
  let lead = await Lead.findOne({ 
    userId: userId,
    email: { $regex: new RegExp('^' + fromEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
  });
  if (lead) {
    console.log('✅ [WEBHOOK] Found lead by exact email match:', lead.name);
    return lead;
  }

  // ✅ Try domain match (if user has multiple emails from same domain)
  const domain = fromEmail.split('@')[1];
  if (domain) {
    lead = await Lead.findOne({ 
      userId: userId,
      email: { $regex: new RegExp('@' + domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
    });
    if (lead) {
      console.log('✅ [WEBHOOK] Found lead by domain match:', lead.name);
      return lead;
    }
  }

  // ✅ Try name/username match (from email local part)
  const localPart = fromEmail.split('@')[0].toLowerCase();
  const nameVariations = localPart.split(/[._-]/);
  
  // Get all leads for this user (limited to reduce overhead)
  const leads = await Lead.find({ userId: userId }).limit(100);
  
  for (const l of leads) {
    if (l.name) {
      const leadNameLower = l.name.toLowerCase();
      // Check if any part of the email matches the lead name
      for (const part of nameVariations) {
        if (part.length > 2 && leadNameLower.includes(part)) {
          console.log('✅ [WEBHOOK] Found lead by name match:', l.name, '(matched:', part, ')');
          return l;
        }
      }
    }
  }

  console.log('❌ [WEBHOOK] No matching lead found for:', fromEmail);
  return null;
}

// ──────────────────────────────────────────────────────────────
//  PROCESS REPLY (FIXED)
// ──────────────────────────────────────────────────────────────
async function processReply(lead, fromEmail, subject, body, snippet, messageId, userId) {
  console.log('📝 [WEBHOOK] Processing reply for lead:', lead.name);
  console.log('📝 [WEBHOOK] Lead ID:', lead._id);
  console.log('📝 [WEBHOOK] From:', fromEmail);
  console.log('📝 [WEBHOOK] Subject:', subject);
  console.log('📝 [WEBHOOK] Body length:', body?.length || 0);
  console.log('📝 [WEBHOOK] Body preview:', body?.substring(0, 200) || '');

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
    
    // ✅ Save the lead with the new reply
    await lead.save();
    console.log('✅ [WEBHOOK] Reply saved to lead. Total replies:', lead.replies.length);
    console.log('✅ [WEBHOOK] Last reply:', JSON.stringify(lead.replies[lead.replies.length - 1]));

    // ✅ ALSO save to ChatMessage for consistency
    try {
      const chatMessage = new ChatMessage({
        userId: userId,
        sessionId: lead._id.toString(),
        role: 'user', // 'user' = lead message (matches frontend mapping)
        content: replyContent,
        title: replySubject,
        createdAt: new Date()
      });
      await chatMessage.save();
      console.log('✅ [WEBHOOK] Reply saved to ChatMessage');
    } catch (chatErr) {
      console.warn('⚠️ [WEBHOOK] Failed to save to ChatMessage:', chatErr.message);
    }

    // ✅ Create notification for the frontend
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

    // ✅ Handle auto-reply if enabled
    if (lead.autoReplyEnabled) {
      await generateAndSendAutoReply(lead, userId);
    }

    console.log('✅ [WEBHOOK] Reply processing complete for:', lead.name);

  } catch (error) {
    console.error('❌ [WEBHOOK] Error processing reply:', error.message);
    console.error('❌ [WEBHOOK] Error stack:', error.stack);
  }
}

// ──────────────────────────────────────────────────────────────
//  HANDLE: Message Sent (WITH TRACE LOGS)
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
      
      // ✅ FIX: Check if this message was already added by batchSend
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
