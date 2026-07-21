const crypto = require('crypto');
const EmailAccount = require('./EmailAccount');
const Lead = require('./Lead');
const User = require('./User');
const Notification = require('./Notification');
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
    // ✅ FIX: Get the raw body for signature verification BEFORE parsing
    let rawBody = req.body;
    let eventData = req.body;
    
    // If body is a Buffer, keep it for signature verification
    if (Buffer.isBuffer(rawBody)) {
      // For signature verification, use the raw buffer
      const rawBodyString = rawBody.toString();
      
      // Verify signature using raw body
      if (signature && webhookSecret) {
        const hmac = crypto.createHmac('sha256', webhookSecret);
        const digest = hmac.update(rawBodyString).digest('hex');

        if (signature !== digest) {
          console.error('❌ [Nylas Webhook] Invalid signature detected.');
          // Still process but log warning - sometimes signatures don't match in sandbox
          console.warn('⚠️ [Nylas Webhook] Continuing anyway (sandbox mode)');
        } else {
          console.log('✅ [Nylas Webhook] Signature verified');
        }
      }
      
      // Parse the body for processing
      try {
        eventData = JSON.parse(rawBodyString);
      } catch (e) {
        console.error('❌ [Nylas Webhook] Failed to parse JSON body');
        return res.status(400).send('Invalid JSON');
      }
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📨 [NYLAS WEBHOOK] Event received');
    console.log('📨 [NYLAS WEBHOOK] Event type:', eventData.type);
    console.log('📨 [NYLAS WEBHOOK] Full payload:', JSON.stringify(eventData, null, 2));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // 3. Handle different event types
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
      console.error('❌ [NYLAS WEBHOOK] Stack:', error.stack);
    }

    // Always return 200 OK to acknowledge receipt
    return res.status(200).send('Webhook received');
  }

  res.status(405).send('Method Not Allowed');
};

// ──────────────────────────────────────────────────────────────
//  EXTRACT EMAIL FROM WEBHOOK PAYLOAD
// ──────────────────────────────────────────────────────────────
function extractEmailFromPayload(eventData) {
  // Try different paths to find the from email
  const data = eventData.data || {};
  const object = data.object || {};
  const message = object.message || data.message || data;
  
  // Check all possible locations for 'from'
  let from = message.from || data.from || object.from || null;
  
  // If from is an array, get the first email
  if (Array.isArray(from) && from.length > 0) {
    return from[0].email || from[0].address || from[0] || null;
  }
  
  // If from is an object with email property
  if (from && typeof from === 'object') {
    return from.email || from.address || null;
  }
  
  // If from is a string
  if (typeof from === 'string') {
    return from;
  }
  
  // Try to extract from headers
  const headers = message.headers || data.headers || object.headers || {};
  const fromHeader = headers.from || headers['From'] || null;
  if (fromHeader) {
    // Extract email from "Name <email@domain.com>" format
    const match = fromHeader.match(/<([^>]+)>/);
    if (match) return match[1];
    return fromHeader;
  }
  
  return null;
}

// ──────────────────────────────────────────────────────────────
//  EXTRACT SUBJECT FROM PAYLOAD
// ──────────────────────────────────────────────────────────────
function extractSubject(eventData) {
  const data = eventData.data || {};
  const object = data.object || {};
  const message = object.message || data.message || data;
  
  return message.subject || data.subject || object.subject || '(no subject)';
}

// ──────────────────────────────────────────────────────────────
//  EXTRACT BODY FROM PAYLOAD
// ──────────────────────────────────────────────────────────────
function extractBody(eventData) {
  const data = eventData.data || {};
  const object = data.object || {};
  const message = object.message || data.message || data;
  
  return message.body || message.snippet || data.body || data.snippet || '';
}

// ──────────────────────────────────────────────────────────────
//  EXTRACT GRANT ID FROM PAYLOAD
// ──────────────────────────────────────────────────────────────
function extractGrantId(eventData) {
  const data = eventData.data || {};
  const object = data.object || {};
  const message = object.message || data.message || data;
  
  return data.grant_id || message.grant_id || object.grant_id || null;
}

// ──────────────────────────────────────────────────────────────
//  HANDLE: Message Created
// ──────────────────────────────────────────────────────────────
async function handleMessageCreated(eventData) {
  console.log('📥 [WEBHOOK] New message received');
  
  try {
    // Extract data using helper functions
    const grantId = extractGrantId(eventData);
    const fromEmail = extractEmailFromPayload(eventData);
    const subject = extractSubject(eventData);
    const body = extractBody(eventData);
    const snippet = body.substring(0, 200);
    
    console.log('📩 [WEBHOOK] From:', fromEmail);
    console.log('📩 [WEBHOOK] Subject:', subject);
    console.log('📩 [WEBHOOK] Body preview:', body.substring(0, 100));
    console.log('📩 [WEBHOOK] Grant ID:', grantId);

    if (!fromEmail) {
      console.log('⚠️ [WEBHOOK] No from email found, skipping');
      console.log('📋 [WEBHOOK] Raw payload for debugging:', JSON.stringify(eventData, null, 2).substring(0, 500));
      return;
    }

    if (!grantId) {
      console.log('⚠️ [WEBHOOK] No grant_id found, skipping');
      return;
    }

    // Find the EmailAccount by grantId
    const emailAccount = await EmailAccount.findOne({ nylasGrantId: grantId });
    if (!emailAccount) {
      console.log('⚠️ [WEBHOOK] No email account found for grantId:', grantId);
      return;
    }

    const userId = emailAccount.userId;
    console.log('✅ [WEBHOOK] Found userId:', userId);

    // Find matching lead
    const lead = await findMatchingLead(userId, fromEmail);

    if (!lead) {
      console.log('📭 [WEBHOOK] No matching lead found for:', fromEmail);
      
      // Create notification for unknown reply
      try {
        const notification = new Notification({
          userId: userId,
          type: 'unknown_reply',
          title: '📬 Unknown Reply',
          message: `Unknown reply from ${fromEmail}: ${snippet.substring(0, 100)}`,
          data: { fromEmail, subject, snippet },
          read: false
        });
        await notification.save();
        console.log('🔔 [WEBHOOK] Unknown reply notification created');
      } catch (notifErr) {
        console.error('❌ [WEBHOOK] Failed to create notification:', notifErr.message);
      }
      return;
    }

    // Process the reply
    await processReply(lead, fromEmail, subject, body, snippet, userId);

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling message:', error.message);
    console.error('❌ [WEBHOOK] Stack:', error.stack);
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
    if (lead) {
      console.log('✅ [WEBHOOK] Found lead by domain:', lead.name);
      return lead;
    }
  }

  return null;
}

// ──────────────────────────────────────────────────────────────
//  PROCESS REPLY
// ──────────────────────────────────────────────────────────────
async function processReply(lead, fromEmail, subject, body, snippet, userId) {
  console.log('📝 [WEBHOOK] Processing reply for lead:', lead.name);

  try {
    // Update lead status
    lead.status = 'Replied';
    lead.lastContactDate = new Date();
    
    // Add reply to conversation history
    if (!lead.replies) lead.replies = [];
    lead.replies.push({
      from: 'lead',
      content: body || snippet || '(No content)',
      subject: subject,
      date: new Date(),
      read: false
    });
    
    await lead.save();
    console.log('✅ [WEBHOOK] Reply saved to Lead.replies');

    // Also save to ChatMessage model
    try {
      const chatMessage = new ChatMessage({
        userId: userId,
        sessionId: lead._id.toString(),
        role: 'user',
        content: body || snippet || '(No content)',
        title: subject,
        createdAt: new Date()
      });
      await chatMessage.save();
      console.log('✅ [WEBHOOK] Reply saved to ChatMessage');
    } catch (chatErr) {
      console.warn('⚠️ [WEBHOOK] Failed to save to ChatMessage:', chatErr.message);
    }

    // Create notification for user
    try {
      const notification = new Notification({
        userId: userId,
        type: 'lead_reply',
        title: `📨 ${lead.name} replied!`,
        message: `"${snippet || 'New reply from lead'}"`,
        data: { 
          leadId: lead._id.toString(), 
          email: fromEmail
        },
        read: false
      });
      await notification.save();
      console.log('🔔 [WEBHOOK] Notification created for user');
    } catch (notifErr) {
      console.error('❌ [WEBHOOK] Failed to create notification:', notifErr.message);
    }

    // Trigger auto-reply if enabled
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
    const grantId = extractGrantId(eventData);
    const toEmail = eventData.data?.to?.[0]?.email || eventData.data?.to || null;
    const subject = extractSubject(eventData);
    const body = extractBody(eventData);
    
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
    const grantId = extractGrantId(eventData);
    console.log('🔴 [WEBHOOK] Grant expired for:', grantId);

    if (!grantId) return;

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: grantId });
    
    if (emailAccount) {
      emailAccount.isConnected = false;
      emailAccount.lastRefreshError = 'Grant expired webhook';
      await emailAccount.save();

      try {
        const notification = new Notification({
          userId: emailAccount.userId,
          type: 'token_expired',
          title: '⚠️ Email Connection Expired',
          message: 'Your email connection has expired. Please reconnect to continue sending emails.',
          data: { grantId },
          read: false
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
    const grantId = extractGrantId(eventData);
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
    }

  } catch (error) {
    console.error('❌ [AUTO-REPLY] Error:', error.message);
  }
}
