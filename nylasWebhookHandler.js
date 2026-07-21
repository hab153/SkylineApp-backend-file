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
    const signature = req.headers['x-nylas-signature'];
    
    // Verify the webhook signature for security
    if (signature && webhookSecret) {
      let bodyContent;
      if (Buffer.isBuffer(req.body)) {
        bodyContent = req.body;
      } else {
        bodyContent = JSON.stringify(req.body);
      }
      
      const hmac = crypto.createHmac('sha256', webhookSecret);
      const digest = hmac.update(bodyContent).digest('hex');

      if (signature !== digest) {
        console.error('❌ [Nylas Webhook] Invalid signature detected.');
        return res.status(401).json({ message: 'Invalid webhook signature.' });
      }
    }

    // Parse event data
    let eventData = req.body;
    if (Buffer.isBuffer(eventData)) {
      try {
        eventData = JSON.parse(eventData.toString());
      } catch (e) {
        console.error('❌ [Nylas Webhook] Failed to parse JSON body');
        return res.status(400).send('Invalid JSON');
      }
    }
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📨 [NYLAS WEBHOOK] Event received');
    console.log('📨 [NYLAS WEBHOOK] Event type:', eventData.type);
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
//  HANDLE: Message Created (Email Received - REPLIES!)
// ──────────────────────────────────────────────────────────────
async function handleMessageCreated(eventData) {
  console.log('📥 [WEBHOOK] New message received');
  
  try {
    // Extract message data from Nylas webhook payload
    const data = eventData.data || {};
    const object = data.object || {};
    const message = object.message || data;
    
    // Get the grant_id from the webhook
    const grantId = data.grant_id || message.grant_id || object.grant_id;
    const fromEmail = message.from?.[0]?.email || data.from?.[0]?.email;
    const subject = message.subject || data.subject || '(no subject)';
    const body = message.body || message.snippet || data.body || data.snippet || '';
    const snippet = message.snippet || data.snippet || '';
    const messageId = message.id || data.id || null;
    
    console.log('📩 [WEBHOOK] From:', fromEmail);
    console.log('📩 [WEBHOOK] Subject:', subject);
    console.log('📩 [WEBHOOK] Body preview:', body.substring(0, 100));
    console.log('📩 [WEBHOOK] Message ID:', messageId);

    if (!fromEmail) {
      console.log('⚠️ [WEBHOOK] No from email found, skipping');
      return;
    }

    if (!grantId) {
      console.log('⚠️ [WEBHOOK] No grant_id found, skipping');
      return;
    }

    // ✅ Find the EmailAccount by grantId to get userId
    const emailAccount = await EmailAccount.findOne({ nylasGrantId: grantId });
    if (!emailAccount) {
      console.log('⚠️ [WEBHOOK] No email account found for grantId:', grantId);
      return;
    }

    const userId = emailAccount.userId;
    console.log('✅ [WEBHOOK] Found userId:', userId);

    // ✅ Find if this email belongs to a lead
    const lead = await findMatchingLead(userId, fromEmail);

    if (!lead) {
      console.log('📭 [WEBHOOK] No matching lead found for:', fromEmail);
      
      // ✅ Create a notification for unknown replies
      try {
        const notification = new Notification({
          userId: userId,
          type: 'unknown_reply',
          title: '📬 Unknown Reply',
          message: `Unknown reply from ${fromEmail}: ${snippet.substring(0, 100)}`,
          data: { fromEmail, subject, snippet, messageId },
          read: false
        });
        await notification.save();
        console.log('🔔 [WEBHOOK] Unknown reply notification created');
      } catch (notifErr) {
        console.error('❌ [WEBHOOK] Failed to create notification:', notifErr.message);
      }
      return;
    }

    // ✅ Process the reply
    await processReply(lead, fromEmail, subject, body, snippet, messageId, userId);

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling message:', error.message);
    console.error('❌ [WEBHOOK] Stack:', error.stack);
  }
}

// ──────────────────────────────────────────────────────────────
//  FIND MATCHING LEAD
// ──────────────────────────────────────────────────────────────
async function findMatchingLead(userId, fromEmail) {
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

  // Try name in subject match (look for common patterns)
  // This is a fallback for leads where email might not match exactly
  const leads = await Lead.find({ userId: userId }).limit(20);
  for (const l of leads) {
    if (l.name && fromEmail.toLowerCase().includes(l.name.toLowerCase().split(' ')[0])) {
      console.log('✅ [WEBHOOK] Found lead by name match:', l.name);
      return l;
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
    // ✅ Update lead status
    lead.status = 'Replied';
    lead.lastContactDate = new Date();
    
    // ✅ Add reply to conversation history
    if (!lead.replies) lead.replies = [];
    lead.replies.push({
      from: 'lead',
      content: body || snippet || '(No content)',
      subject: subject,
      date: new Date(),
      messageId: messageId,
      read: false
    });
    
    await lead.save();
    console.log('✅ [WEBHOOK] Reply saved to Lead.replies');

    // ✅ ALSO save to ChatMessage model
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

    // ✅ Create notification for user
    try {
      const notification = new Notification({
        userId: userId,
        type: 'lead_reply',
        title: `📨 ${lead.name} replied!`,
        message: `"${snippet || 'New reply from lead'}"`,
        data: { 
          leadId: lead._id.toString(), 
          email: fromEmail,
          messageId: messageId
        },
        read: false
      });
      await notification.save();
      console.log('🔔 [WEBHOOK] Notification created for user');
    } catch (notifErr) {
      console.error('❌ [WEBHOOK] Failed to create notification:', notifErr.message);
    }

    // ✅ Trigger auto-reply if enabled
    if (lead.autoReplyEnabled) {
      console.log('🤖 [WEBHOOK] Auto-reply enabled, generating reply...');
      await generateAndSendAutoReply(lead, userId);
    }

  } catch (error) {
    console.error('❌ [WEBHOOK] Error processing reply:', error.message);
  }
}

// ──────────────────────────────────────────────────────────────
//  HANDLE: Message Sent (Outgoing Email)
// ──────────────────────────────────────────────────────────────
async function handleMessageSent(eventData) {
  console.log('📤 [WEBHOOK] Message sent');
  
  try {
    const data = eventData.data || {};
    const object = data.object || {};
    const message = object.message || data;
    
    const toEmail = message.to?.[0]?.email || data.to?.[0]?.email;
    const subject = message.subject || data.subject || '(no subject)';
    const body = message.body || data.body || '';
    const grantId = data.grant_id || message.grant_id || object.grant_id;
    
    if (!toEmail || !grantId) return;

    const emailAccount = await EmailAccount.findOne({ nylasGrantId: grantId });
    if (!emailAccount) return;

    const userId = emailAccount.userId;

    // Update lead status
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

    // Generate AI reply
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

    // Send the email using Nylas
    const nylas = require('./nylasClient');
    
    const result = await nylas.sendEmail({
      grantId: emailAccount.nylasGrantId,
      accessToken: emailAccount.accessToken,
      to: [lead.email],
      subject: `Re: ${lead.replies?.[lead.replies.length - 1]?.subject || 'Your inquiry'}`,
      body: aiResponse
    });

    if (result && result.success) {
      // Update lead with auto-reply sent
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
