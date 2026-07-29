const crypto = require('crypto');
const EmailAccount = require('./EmailAccount');
const Lead = require('./Lead');
const User = require('./User');
const Message = require('./Message'); 
const ChatMessage = require('./ChatMessage');
const { generateAIReply } = require('./aiReplyGenerator');
// ✅ IMPORT ENCRYPTION MODULE TO MANUALLY DECRYPT
const { decrypt } = require('./encryption'); 

// ✅ HELPER: Strip HTML tags and decode entities BEFORE saving to DB
function sanitizeEmailBody(html) {
  if (!html) return '';
  // Decode common HTML entities first
  let decoded = html
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  
  // Strip ALL HTML tags completely
  return decoded.replace(/<[^>]*>/g, '').trim();
}

exports.handleWebhook = async (req, res) => {
  // ✅ FIXED: Match your Render environment variable name EXACTLY
  const webhookSecret = process.env.NYLAS_WEBHOOK_SECRET_SKYLINE;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔔 [WEBHOOK] Request received!');
  console.log(' [WEBHOOK] Method:', req.method);
  console.log(' [WEBHOOK] URL:', req.url);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (req.method === 'GET' && req.query.challenge) {
    console.log(' [Nylas Webhook] Received GET challenge, responding...');
    return res.status(200).send(req.query.challenge);
  }

  if (req.method === 'POST') {
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
    
    console.log('📨 [NYLAS WEBHOOK] Event received');
    console.log(' [NYLAS WEBHOOK] Event type:', eventData.type);

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
      console.error(' [NYLAS WEBHOOK] Error processing event:', error.message);
    }

    return res.status(200).send('Webhook received');
  }

  res.status(405).send('Method Not Allowed');
};

// ─────────────────────────────────────────────────────────────
//  HANDLE: Message Created / Updated - WITH THREAD ID
// ────────────────────────────────────────────────────────────
async function handleMessageCreated(eventData) {
  console.log(' [WEBHOOK] Processing message');
  
  try {
    const data = eventData.data || {};
    const object = data.object || {};
    let message = object.message || data.message || data;
    
    if (message.data && typeof message.data === 'object') {
      message = message.data;
    }
    
    const grantId = data.grant_id || object.grant_id || message.grant_id || message.grantId;
    
    // ✅ Extract thread_id from message
    const threadId = message.thread_id || data.thread_id || object.thread_id || null;
    console.log(' [WEBHOOK] Thread ID:', threadId);
    
    // ✅ Extract from object.from (where Nylas puts the data)
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
      }
    }
    
    if (!toEmail && message.to) {
      if (Array.isArray(message.to) && message.to.length > 0) {
        toEmail = message.to[0]?.email || message.to[0]?.address;
        toName = message.to[0]?.name || '';
      } else if (typeof message.to === 'object') {
        toEmail = message.to.email || message.to.address;
        toName = message.to.name || '';
      }
    }
    
    const subject = message.subject || data.subject || object.subject || '(no subject)';
    
    // ✅ FIX: Sanitize body BEFORE saving to prevent HTML pollution in DB
    const rawBody = message.body || message.text || message.snippet || data.body || data.snippet || object.body || '';
    const body = sanitizeEmailBody(rawBody); 
    
    const snippet = message.snippet || data.snippet || object.snippet || '';
    const messageId = message.id || message.message_id || data.id || object.id || null;
    
    console.log(' [WEBHOOK] From:', fromEmail, fromName ? `(${fromName})` : '');
    console.log(' [WEBHOOK] To:', toEmail, toName ? `(${toName})` : '');
    console.log(' [WEBHOOK] Subject:', subject);

    if (!grantId) {
      console.log('️ [WEBHOOK] Missing grantId');
      return;
    }

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: grantId });
    if (!emailAccount) {
      console.log('️ [WEBHOOK] No email account found for grantId:', grantId);
      return;
    }

    // ✅ CRITICAL FIX: Skip processing if this message was sent FROM our own email
    // This prevents your sent messages from being processed as incoming customer replies
    if (fromEmail && emailAccount.emailAddress && 
        fromEmail.toLowerCase() === emailAccount.emailAddress.toLowerCase()) {
      console.log('️ [WEBHOOK] Skipping - this is OUR sent message, not a customer reply');
      return;
    }

    const userId = emailAccount.userId;
    console.log('✅ [WEBHOOK] Found userId:', userId);

    // ✅ STEP 1: Try to find lead by thread_id (MOST ACCURATE)
    let lead = null;
    if (threadId) {
      lead = await Lead.findOne({ 
        userId: userId,
        threadId: threadId
      });
      if (lead) {
        console.log('✅ [WEBHOOK] Found lead by thread_id:', lead.name);
        console.log('✅ [WEBHOOK] Lead ID:', lead._id);
      } else {
        console.log('️ [WEBHOOK] No lead found with thread_id:', threadId);
      }
    }

    // ✅ STEP 2: If not found by thread_id, try email match (fallback)
    if (!lead && (fromEmail || toEmail)) {
      console.log(' [WEBHOOK] Thread ID not found, trying email match...');
      lead = await findMatchingLead(userId, fromEmail, toEmail);
    }

    // ✅ STEP 3: If no lead found, CREATE ONE
    if (!lead) {
      console.log(' [WEBHOOK] No matching lead found, creating new lead...');
      console.log(' [WEBHOOK] Creating lead for email:', fromEmail || toEmail);
      
      const leadEmail = fromEmail || toEmail || 'unknown@email.com';
      // ✅ FIX: Use fromName if available, otherwise use local part of email
      const displayName = fromName || leadEmail.split('@')[0] || 'Unknown Contact';
      
      lead = new Lead({
        userId: userId,
        name: displayName,
        email: leadEmail,
        company: '',
        status: 'New',
        // ✅ Save thread_id if available
        threadId: threadId || null,
        replies: [{
          from: 'ai', // ✅ FIXED: Customer messages = LEFT SIDE
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
      if (threadId) {
        console.log('✅ [WEBHOOK] Thread ID saved:', threadId);
      }
    }

    // ✅ Process the reply
    await processReply(lead, fromEmail, subject, body, snippet, messageId, userId);

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling message:', error.message);
    console.error('❌ [WEBHOOK] Error stack:', error.stack);
  }
}

// ───────────────────────────────────────────────────────────
//  FIND MATCHING LEAD - FIXED ENCRYPTION HANDLING
// ────────────────────────────────────────────────────────────
async function findMatchingLead(userId, fromEmail, toEmail) {
  console.log(' [WEBHOOK] Looking for lead...');
  console.log(' [WEBHOOK] Searching by FROM email:', fromEmail);
  console.log(' [WEBHOOK] Searching by TO email:', toEmail);
  
  // Normalize search emails
  const normalizedFrom = fromEmail?.toLowerCase()?.trim();
  const normalizedTo = toEmail?.toLowerCase()?.trim();
  
  if (!normalizedFrom && !normalizedTo) {
    console.log(' [WEBHOOK] No valid email to search for');
    return null;
  }

  // ✅ FIX: Fetch ALL leads once and compare decrypted emails in memory
  // This avoids multiple DB queries and handles encryption correctly
  const allLeads = await Lead.find({ userId: userId });
  console.log(`🔍 [WEBHOOK] Checking ${allLeads.length} leads for matching email`);
  
  for (const lead of allLeads) {
    // ✅ CRITICAL FIX: Manually decrypt the email since Mongoose getters 
    // don't fire on raw document properties in loops
    let decryptedEmail = lead.email;
    try {
      // Check if it looks encrypted (base64 format)
      if (decryptedEmail && /^[A-Za-z0-9+/=]{20,}$/.test(decryptedEmail)) {
        decryptedEmail = decrypt(decryptedEmail);
      }
    } catch (err) {
      console.warn('⚠️ [WEBHOOK] Failed to decrypt email for lead:', lead._id);
      continue;
    }
    
    const cleanEmail = decryptedEmail?.toLowerCase()?.trim();
    
    if (!cleanEmail) continue;
    
    // Exact match check
    if (normalizedFrom && cleanEmail === normalizedFrom) {
      console.log('✅ [WEBHOOK] Found lead by exact FROM email match:', lead.name);
      return lead;
    }
    
    if (normalizedTo && cleanEmail === normalizedTo) {
      console.log('✅ [WEBHOOK] Found lead by exact TO email match:', lead.name);
      return lead;
    }
    
    // Domain fallback match (if exact fails)
    if (normalizedFrom?.includes('@') && cleanEmail.includes('@')) {
      const fromDomain = normalizedFrom.split('@')[1];
      const leadDomain = cleanEmail.split('@')[1];
      if (fromDomain === leadDomain) {
        console.log('✅ [WEBHOOK] Found lead by domain match:', lead.name);
        return lead;
      }
    }
  }

  console.log('❌ [WEBHOOK] No matching lead found after checking all leads');
  return null;
}

// ──────────────────────────────────────────────────────────────
//  PROCESS REPLY
// ──────────────────────────────────────────────────────────────
async function processReply(lead, fromEmail, subject, body, snippet, messageId, userId) {
  console.log('📝 [WEBHOOK] Processing reply for lead:', lead.name);
  console.log(' [WEBHOOK] Lead ID:', lead._id);

  try {
    lead.status = 'Replied';
    lead.lastContactDate = new Date();
    
    if (!lead.replies) lead.replies = [];
    
    const replyContent = body || snippet || '(No content)';
    const replySubject = subject || '(no subject)';
    
    lead.replies.push({
      from: 'ai', // ✅ CUSTOMER REPLY = LEFT SIDE
      content: replyContent,
      subject: replySubject,
      date: new Date(),
      messageId: messageId || null,
      read: false
    });
    
    await lead.save();
    console.log('✅ [WEBHOOK] Reply saved to lead. Total replies:', lead.replies.length);

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
      console.warn('️ [WEBHOOK] Failed to save to ChatMessage:', chatErr.message);
    }

    try {
      const notification = new Message({
        userId: userId,
        sessionId: 'lead-reply-notification',
        role: 'ai',
        title: ` ${lead.name} replied!`,
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

// ────────────────────────────────────────────────────────────
//  HANDLE: Message Sent - FIXED DUPLICATE PREVENTION
// ──────────────────────────────────────────────────────────────
async function handleMessageSent(eventData) {
  console.log(' [WEBHOOK-SENT] Message sent event triggered');
  
  try {
    const data = eventData.data || {};
    const object = data.object || {};
    let message = object.message || data.message || data;
    
    const toEmail = message.to?.[0]?.email || data.to?.[0]?.email || message.recipients?.[0]?.email;
    const subject = message.subject || data.subject || '(no subject)';
    const body = message.body || data.body || '';
    const grantId = data.grant_id || message.grant_id || object.grant_id;
    
    console.log(' [WEBHOOK-SENT] To:', toEmail);
    console.log('📩 [WEBHOOK-SENT] Grant ID:', grantId);

    if (!toEmail || !grantId) return;

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: grantId });
    if (!emailAccount) {
        console.log('️ [WEBHOOK-SENT] No email account found for grant:', grantId);
        return;
    }

    const userId = emailAccount.userId;
    console.log(' [WEBHOOK-SENT] Found User ID:', userId);

    // ✅ Use optimized findMatchingLead instead of regex on encrypted field
    const lead = await findMatchingLead(userId, null, toEmail);

    if (lead) {
      console.log('✅ [WEBHOOK-SENT] Matched existing lead:', lead.name, '(ID:', lead._id, ')');
      
      // ✅ ROBUST DUPLICATE CHECK: 
      // Check last 5 messages for identical content within 60 seconds
      // This prevents double-saving when batchSend already saved it
      const recentReplies = lead.replies.slice(-5);
      const isDuplicate = recentReplies.some(r => 
        r.from === 'lead' && 
        r.content.trim() === body.trim() && 
        Math.abs(new Date() - new Date(r.date)) < 60000 // 60 second window
      );

      if (!isDuplicate) {
        lead.status = 'Contacted';
        lead.lastContactDate = new Date();
        
        if (!lead.replies) lead.replies = [];
        lead.replies.push({
          from: 'lead', // ✅ USER SENT MESSAGE = RIGHT SIDE
          content: body || '',
          subject: subject,
          date: new Date(),
          read: true
        });
        
        await lead.save();
        console.log('💾 [WEBHOOK-SENT] Updated lead status and replies.');
      } else {
        console.log('️ [WEBHOOK-SENT] Duplicate sent message skipped (already saved by batchSend).');
      }
    } else {
        console.log(' [WEBHOOK-SENT] NO LEAD FOUND for email:', toEmail);
    }

  } catch (error) {
    console.error('❌ [WEBHOOK-SENT] Error:', error.message);
  }
}

// ────────────────────────────────────────────────────────────
//  HANDLE: Grant Expired
// ─────────────────────────────────────────────────────────────
async function handleGrantExpired(eventData) {
  console.log(' [WEBHOOK] Grant expired');
  
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
          title: '️ Email Connection Expired',
          content: 'Your email connection has expired. Please reconnect to continue sending emails.',
          notificationType: 'token_expired',
          leadId: null,
          isRead: false,
          createdAt: new Date()
        });
        await notification.save();
      } catch (notifErr) {
        console.error(' [WEBHOOK] Failed to create notification:', notifErr.message);
      }
    }

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling grant expired:', error.message);
  }
}

// ──────────────────────────────────────────────────────────────
//  HANDLE: Grant Refreshed
// ──────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
//  HELPER: Generate and Send Auto-Reply
// ─────────────────────────────────────────────────────────────
async function generateAndSendAutoReply(lead, userId) {
  try {
    console.log(' [AUTO-REPLY] Generating reply for:', lead.email);
    
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
        from: 'lead', // ✅ AUTO-REPLIES ARE USER-SIDE = RIGHT ALIGNMENT
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
    console.error(' [AUTO-REPLY] Error:', error.message);
  }
                      }
