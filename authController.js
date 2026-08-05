const crypto = require('crypto');
const EmailAccount = require('./EmailAccount');
const Lead = require('./Lead');
const User = require('./User');
const Message = require('./Message'); 
const ChatMessage = require('./ChatMessage');
const { generateAIReply } = require('./aiReplyGenerator');
// ✅ IMPORT ENCRYPTION MODULE TO MANUALLY DECRYPT
const { decrypt } = require('./encryption'); 
const { isValidObjectId, sanitizeString } = require('./sanitize');

// ✅ FIX #37: Single-pass HTML sanitization (no double escaping)
function sanitizeEmailBody(html) {
  if (!html || typeof html !== 'string') return '';
  
  // Step 1: Strip ALL HTML tags first (prevents double-escaping issues)
  let stripped = html.replace(/<[^>]*>/g, '');
  
  // Step 2: Decode HTML entities ONCE after stripping tags
  let decoded = stripped
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  
  // Step 3: Strip any tags that may have been revealed by decoding
  decoded = decoded.replace(/<[^>]*>/g, '');
  
  return decoded.trim();
}

// ✅ FIX #40: Complete multi-character sanitization for email addresses
function sanitizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  // Remove all non-standard characters, keep only valid email chars
  let sanitized = email.replace(/[^\w@.\-+]/g, '').trim();
  // Validate basic email format
  if (!sanitized || !sanitized.includes('@') || sanitized.length > 254) return null;
  return sanitized.toLowerCase();
}

// ✅ SECURITY: Validate Nylas webhook signature
function validateWebhookSignature(req) {
  const webhookSecret = process.env.NYLAS_WEBHOOK_SECRET_SKYLINE;
  
  if (!webhookSecret) {
    console.error('❌ [WEBHOOK SECURITY] NYLAS_WEBHOOK_SECRET_SKYLINE is not configured!');
    return false;
  }
  
  // Nylas V3 sends signature in X-Nylas-Signature header
  const signature = req.headers['x-nylas-signature'] || req.headers['X-Nylas-Signature'];
  
  if (!signature || typeof signature !== 'string') {
    console.warn('⚠️ [WEBHOOK SECURITY] Missing X-Nylas-Signature header');
    return false;
  }
  
  // Get raw body for signature verification
  let rawBody;
  if (Buffer.isBuffer(req.body)) {
    rawBody = req.body.toString('utf8');
  } else if (typeof req.body === 'string') {
    rawBody = req.body;
  } else {
    rawBody = JSON.stringify(req.body);
  }
  
  // Compute expected HMAC-SHA256 signature
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');
  
  // Constant-time comparison to prevent timing attacks
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

  // ✅ GET challenge requests don't need signature validation (Nylas verification step)
  if (req.method === 'GET' && req.query.challenge) {
    // ✅ FIX #34: Sanitize challenge value before reflecting in response
    const challenge = String(req.query.challenge).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!challenge) {
      return res.status(400).send('Invalid challenge');
    }
    console.log(' [Nylas Webhook] Received GET challenge, responding...');
    return res.status(200).send(challenge);
  }

  if (req.method === 'POST') {
    // ✅ CRITICAL SECURITY: Validate webhook signature BEFORE processing
    if (!validateWebhookSignature(req)) {
      console.error('❌ [WEBHOOK SECURITY] Rejected unsigned/invalid webhook request from IP:', req.ip);
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
    console.log(' [WEBHOOK] Thread ID present:', !!threadId);
    
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
    
    // ✅ FIX #40: Use complete sanitization for email body
    const rawBody = message.body || message.text || message.snippet || data.body || data.snippet || object.body || '';
    const body = sanitizeEmailBody(rawBody); 
    
    const snippet = message.snippet || data.snippet || object.snippet || '';
    const messageId = message.id || message.message_id || data.id || object.id || null;
    
    // ✅ FIX #40: Sanitize emails with complete multi-character sanitization
    const safeFromEmail = sanitizeEmail(fromEmail);
    const safeToEmail = sanitizeEmail(toEmail);
    
    console.log(' [WEBHOOK] From:', safeFromEmail ? 'present' : 'missing');
    console.log(' [WEBHOOK] To:', safeToEmail ? 'present' : 'missing');

    if (!grantId || typeof grantId !== 'string') {
      console.log('️ [WEBHOOK] Missing or invalid grantId');
      return;
    }

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: String(grantId) });
    if (!emailAccount) {
      console.log('️ [WEBHOOK] No email account found for grantId');
      return;
    }

    // ✅ CRITICAL FIX: Skip processing if this message was sent FROM our own email
    if (safeFromEmail && emailAccount.emailAddress && 
        safeFromEmail.toLowerCase() === String(emailAccount.emailAddress).toLowerCase()) {
      console.log('️ [WEBHOOK] Skipping - this is OUR sent message, not a customer reply');
      return;
    }

    // ✅ FIX #27: Cast userId to string for query safety
    const userId = String(emailAccount.userId);
    if (!isValidObjectId(userId)) {
      console.error('❌ [WEBHOOK] Invalid userId from email account');
      return;
    }
    
    console.log('✅ [WEBHOOK] Found userId:', userId);

    // ✅ STEP 1: Try to find lead by thread_id (MOST ACCURATE)
    let lead = null;
    if (threadId && typeof threadId === 'string') {
      // ✅ FIX #27: Use String() cast and sanitizeQuery for thread_id lookup
      const safeThreadId = String(threadId).replace(/[^a-zA-Z0-9_-]/g, '');
      if (safeThreadId) {
        lead = await Lead.findOne({ 
          userId: userId,
          threadId: safeThreadId
        });
        if (lead) {
          console.log('✅ [WEBHOOK] Found lead by thread_id:', lead._id);
        }
      }
    }

    // ✅ STEP 2: If not found by thread_id, try email match (fallback)
    if (!lead && (safeFromEmail || safeToEmail)) {
      console.log(' [WEBHOOK] Thread ID not found, trying email match...');
      lead = await findMatchingLead(userId, safeFromEmail, safeToEmail);
    }

    // ✅ STEP 3: If no lead found, CREATE ONE
    if (!lead) {
      console.log(' [WEBHOOK] No matching lead found, creating new lead...');
      
      const leadEmail = safeFromEmail || safeToEmail || 'unknown@email.com';
      // ✅ FIX: Use fromName if available, otherwise use local part of email
      const displayName = (fromName && typeof fromName === 'string') ? fromName.substring(0, 100) : leadEmail.split('@')[0] || 'Unknown Contact';
      
      lead = new Lead({
        userId: userId,
        name: sanitizeString(displayName),
        email: leadEmail,
        company: '',
        status: 'New',
        // ✅ Save thread_id if available
        threadId: (threadId && typeof threadId === 'string') ? String(threadId).replace(/[^a-zA-Z0-9_-]/g, '') : null,
        replies: [{
          from: 'ai',
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
      console.log('✅ [WEBHOOK] Created new lead with ID:', lead._id);
    }

    // ✅ Process the reply
    await processReply(lead, safeFromEmail, subject, body, snippet, messageId, userId);

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling message:', error.message);
  }
}

// ───────────────────────────────────────────────────────────
//  FIND MATCHING LEAD - FIXED: NO DOMAIN-ONLY FALLBACK
// ────────────────────────────────────────────────────────────
async function findMatchingLead(userId, fromEmail, toEmail) {
  console.log(' [WEBHOOK] Looking for lead by exact email match...');
  
  // Normalize search emails
  const normalizedFrom = fromEmail?.toLowerCase()?.trim();
  const normalizedTo = toEmail?.toLowerCase()?.trim();
  
  if (!normalizedFrom && !normalizedTo) {
    console.log(' [WEBHOOK] No valid email to search for');
    return null;
  }

  // ✅ FIX: Fetch ALL leads once and compare decrypted emails in memory
  const allLeads = await Lead.find({ userId: String(userId) });
  console.log(`🔍 [WEBHOOK] Checking ${allLeads.length} leads for matching email`);
  
  for (const lead of allLeads) {
    // ✅ CRITICAL FIX: Manually decrypt the email
    let decryptedEmail = lead.email;
    try {
      if (decryptedEmail && /^[A-Za-z0-9+/=]{20,}$/.test(decryptedEmail)) {
        decryptedEmail = decrypt(decryptedEmail);
      }
    } catch (err) {
      console.warn('⚠️ [WEBHOOK] Failed to decrypt email for lead:', lead._id);
      continue;
    }
    
    const cleanEmail = decryptedEmail?.toLowerCase()?.trim();
    
    if (!cleanEmail) continue;
    
    // ✅ Exact match check ONLY (removed domain-only fallback per H.I.S.V. recommendation)
    if (normalizedFrom && cleanEmail === normalizedFrom) {
      console.log('✅ [WEBHOOK] Found lead by exact FROM email match:', lead._id);
      return lead;
    }
    
    if (normalizedTo && cleanEmail === normalizedTo) {
      console.log('✅ [WEBHOOK] Found lead by exact TO email match:', lead._id);
      return lead;
    }
  }

  console.log('❌ [WEBHOOK] No matching lead found after checking all leads');
  return null;
}

// ──────────────────────────────────────────────────────────────
//  PROCESS REPLY
// ──────────────────────────────────────────────────────────────
async function processReply(lead, fromEmail, subject, body, snippet, messageId, userId) {
  console.log('📝 [WEBHOOK] Processing reply for lead:', lead._id);

  try {
    lead.status = 'Replied';
    lead.lastContactDate = new Date();
    
    if (!lead.replies) lead.replies = [];
    
    const replyContent = body || snippet || '(No content)';
    const replySubject = (typeof subject === 'string') ? subject.substring(0, 200) : '(no subject)';
    
    lead.replies.push({
      from: 'ai',
      content: replyContent,
      subject: replySubject,
      date: new Date(),
      messageId: (messageId && typeof messageId === 'string') ? String(messageId).substring(0, 100) : null,
      read: false
    });
    
    await lead.save();
    console.log('✅ [WEBHOOK] Reply saved to lead. Total replies:', lead.replies.length);

    try {
      // ✅ FIX #28: Use String() casts for all query/create values
      const chatMessage = new ChatMessage({
        userId: String(userId),
        sessionId: String(lead._id),
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
      // ✅ FIX #29: Use String() casts for notification creation
      const notification = new Message({
        userId: String(userId),
        sessionId: 'lead-reply-notification',
        role: 'ai',
        title: `${sanitizeString(String(lead.name || 'Lead'))} replied!`,
        content: `"${snippet ? String(snippet).substring(0, 200) : 'New reply from lead'}"`,
        notificationType: 'lead_reply',
        leadId: String(lead._id),
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
    
    // ✅ FIX #30: Validate and sanitize inputs
    const safeToEmail = sanitizeEmail(toEmail);
    
    if (!safeToEmail || !grantId || typeof grantId !== 'string') {
      console.log('️ [WEBHOOK-SENT] Missing required fields');
      return;
    }

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: String(grantId) });
    if (!emailAccount) {
        console.log('️ [WEBHOOK-SENT] No email account found for grant');
        return;
    }

    // ✅ FIX #30: Cast userId to string
    const userId = String(emailAccount.userId);
    if (!isValidObjectId(userId)) {
      console.error('❌ [WEBHOOK-SENT] Invalid userId');
      return;
    }

    // ✅ Use optimized findMatchingLead instead of regex on encrypted field
    const lead = await findMatchingLead(userId, null, safeToEmail);

    if (lead) {
      console.log('✅ [WEBHOOK-SENT] Matched existing lead:', lead._id);
      
      // ✅ ROBUST DUPLICATE CHECK
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
        console.log('💾 [WEBHOOK-SENT] Updated lead status and replies.');
      } else {
        console.log('️ [WEBHOOK-SENT] Duplicate sent message skipped.');
      }
    } else {
        console.log(' [WEBHOOK-SENT] NO LEAD FOUND for email');
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
    
    // ✅ FIX #31: Validate grantId type
    if (!grantId || typeof grantId !== 'string') return;

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: String(grantId) });
    
    if (emailAccount) {
      emailAccount.isConnected = false;
      emailAccount.lastRefreshError = 'Grant expired webhook';
      await emailAccount.save();

      try {
        // ✅ FIX #31: Use String() cast for userId
        const notification = new Message({
          userId: String(emailAccount.userId),
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
    
    // ✅ Validate grantId type
    if (!grantId || typeof grantId !== 'string') return;

    await EmailAccount.findOneAndUpdate(
      { nylasGrantId: String(grantId) },
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
    console.log(' [AUTO-REPLY] Generating reply for lead:', lead._id);
    
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
      console.log('✅ [AUTO-REPLY] Auto-reply sent');
    }

  } catch (error) {
    console.error(' [AUTO-REPLY] Error:', error.message);
  }
      }
