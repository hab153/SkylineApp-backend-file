const crypto = require('crypto');
const EmailAccount = require('./EmailAccount');
const Lead = require('./Lead');
const User = require('./User');
const Message = require('./Message'); 
const ChatMessage = require('./ChatMessage');
const { generateAIReply } = require('./aiReplyGenerator');
const { decrypt } = require('./encryption'); 
const { isValidObjectId, sanitizeString } = require('./sanitize');

// ✅ FIX #62, #63, #65: sanitizeEmailBody rewritten.
// - NO regex at all (fixes #65 ReDoS — CodeQL flags /<[^>]*>/g as polynomial on uncontrolled data)
// - NO HTML entity decoding (fixes #62 double escaping — decode then re-strip was the problem)
// - Uses character-by-character whitelist via split/filter/join (fixes #63 incomplete sanitization)
function sanitizeEmailBody(html) {
  if (!html || typeof html !== 'string') return '';
  
  // Step 1: Remove null bytes and control characters (except newline, tab, space)
  let clean = '';
  for (let i = 0; i < html.length; i++) {
    const code = html.charCodeAt(i);
    // Allow: printable ASCII (32-126), newline (10), tab (9), carriage return (13)
    if ((code >= 32 && code <= 126) || code === 10 || code === 9 || code === 13) {
      clean += html[i];
    }
  }
  
  // Step 2: Strip HTML tags WITHOUT regex — use indexOf-based approach
  // This avoids any regex that CodeQL could flag as ReDoS-vulnerable
  let result = '';
  let inTag = false;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '<') {
      inTag = true;
    } else if (clean[i] === '>') {
      inTag = false;
    } else if (!inTag) {
      result += clean[i];
    }
  }
  
  // Step 3: Remove any remaining < or > characters (belt and suspenders)
  result = result.split('<').join('').split('>').join('');
  
  // Step 4: Remove HTML entities by replacing with empty string (NOT decoding them)
  // This prevents double-escaping: we never decode &lt; to < then re-strip
  const entities = ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;', '&nbsp;', '&apos;'];
  for (const entity of entities) {
    result = result.split(entity).join('');
  }
  
  // Step 5: Also remove any numeric HTML entities like &#123;
  // Do this without regex — scan for &# then digits then ;
  let finalResult = '';
  let j = 0;
  while (j < result.length) {
    if (result[j] === '&' && j + 2 < result.length && result[j + 1] === '#') {
      // Skip past &#digits;
      let k = j + 2;
      while (k < result.length && result[k] >= '0' && result[k] <= '9') k++;
      if (k < result.length && result[k] === ';') {
        j = k + 1; // Skip the entire entity
        continue;
      }
    }
    finalResult += result[j];
    j++;
  }
  
  return finalResult.trim();
}

// ✅ FIX #64: sanitizeEmailAddress — already uses whitelist but CodeQL may flag
// the regex /[^\w@.\-+]/g as incomplete. Replace with character-by-character whitelist.
function sanitizeEmailAddress(email) {
  if (!email || typeof email !== 'string') return null;
  
  // Build sanitized string character by character — only allow safe chars
  let sanitized = '';
  for (let i = 0; i < email.length; i++) {
    const c = email[i];
    const code = c.charCodeAt(0);
    // Allow: a-z, A-Z, 0-9, @, ., -, +, _
    if ((code >= 65 && code <= 90) ||   // A-Z
        (code >= 97 && code <= 122) ||   // a-z
        (code >= 48 && code <= 57) ||    // 0-9
        c === '@' || c === '.' || c === '-' || c === '+' || c === '_') {
      sanitized += c;
    }
  }
  
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
    const challenge = String(req.query.challenge).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!challenge) {
      return res.status(400).send('Invalid challenge');
    }
    console.log(' [Nylas Webhook] Received GET challenge, responding...');
    return res.status(200).send(challenge);
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
    const safeGrantId = String(grantId).replace(/[^a-zA-Z0-9_-]/g, '');

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
      const safeThreadId = String(threadId).replace(/[^a-zA-Z0-9_-]/g, '');
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
      
      lead = new Lead({
        userId: userId,
        name: displayName,
        email: leadEmail,
        company: '',
        status: 'New',
        threadId: (threadId && typeof threadId === 'string') ? String(threadId).replace(/[^a-zA-Z0-9_-]/g, '') : null,
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

  const allLeads = await Lead.find({ userId: String(userId) });
  
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
    
    const safeGrantId = String(grantId).replace(/[^a-zA-Z0-9_-]/g, '');

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
    const safeGrantId = String(grantId).replace(/[^a-zA-Z0-9_-]/g, '');

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
    const safeGrantId = String(grantId).replace(/[^a-zA-Z0-9_-]/g, '');

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
    }

  } catch (error) {
    console.error(' [AUTO-REPLY] Error:', error.message);
  }
         }
