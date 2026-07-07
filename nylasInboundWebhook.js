const User = require('./User');
const Lead = require('./Lead');
const Notification = require('./Notification');
const { sendNylasEmail, isNylasConnected, refreshNylasToken } = require('./nylasService');
const { generateAIReply } = require('./aiReplyGenerator');

/**
 * Handle Nylas webhook for incoming emails
 */
async function handleNylasWebhook(req, res) {
    try {
        console.log('📩 [NYLAS WEBHOOK] Received notification from Nylas');

        // Verify webhook secret
        const secret = req.headers['x-nylas-webhook-secret'];
        if (secret !== process.env.NYLAS_WEBHOOK_SECRET) {
            console.error('❌ [NYLAS WEBHOOK] Invalid webhook secret');
            return res.status(401).send('Unauthorized');
        }

        const data = req.body;
        console.log('📩 [NYLAS WEBHOOK] Webhook data received');

        // Handle different webhook events
        if (data.object === 'event') {
            if (data.type === 'message.created') {
                await processNewMessage(data.data);
            } else {
                console.log(`⚠️ [NYLAS WEBHOOK] Unhandled event type: ${data.type}`);
            }
        } else {
            console.log(`⚠️ [NYLAS WEBHOOK] Unhandled object type: ${data.object}`);
        }

        res.status(200).send('OK');

    } catch (error) {
        console.error('❌ [NYLAS WEBHOOK] Error:', error.message);
        // Always return 200 to Nylas
        res.status(200).send('OK');
    }
}

/**
 * Process a new email message from webhook
 */
async function processNewMessage(messageData) {
    try {
        // Extract email details
        const toEmail = messageData.to?.[0]?.email;
        const fromEmail = messageData.from?.[0]?.email;
        const fromName = messageData.from?.[0]?.name || fromEmail;
        const subject = messageData.subject || '';
        const body = messageData.body || '';
        const messageId = messageData.id;

        console.log(`📧 [NYLAS WEBHOOK] New message from ${fromEmail} to ${toEmail}`);

        if (!toEmail || !fromEmail) {
            console.log('⚠️ [NYLAS WEBHOOK] Missing email addresses');
            return;
        }

        // Find user by receiving email
        const user = await User.findOne({
            'nylasIntegration.emailAddress': toEmail
        });

        if (!user) {
            console.log(`⚠️ [NYLAS WEBHOOK] No user found for email: ${toEmail}`);
            return;
        }

        // Check if user has Nylas connected
        const isConnected = await isNylasConnected(user._id);
        if (!isConnected) {
            console.log(`⚠️ [NYLAS WEBHOOK] User ${user.email} has no Nylas connection`);
            return;
        }

        // Find the lead by email
        const lead = await Lead.findOne({
            userId: user._id,
            email: fromEmail
        });

        if (!lead) {
            console.log(`⚠️ [NYLAS WEBHOOK] No lead found for email: ${fromEmail}`);
            return;
        }

        // Check for duplicate message
        const exists = lead.replies?.some(r => r.messageId === messageId);
        if (exists) {
            console.log(`⚠️ [NYLAS WEBHOOK] Duplicate message: ${messageId}`);
            return;
        }

        // Add reply to lead
        lead.replies = lead.replies || [];
        lead.replies.push({
            from: `${fromName} <${fromEmail}>`,
            subject: subject,
            content: body,
            receivedAt: new Date(),
            isRead: false,
            messageId: messageId
        });
        lead.lastContactDate = new Date();
        lead.status = 'Replied';
        await lead.save();

        // Create notification
        await Notification.create({
            userId: user._id,
            type: 'lead_reply',
            content: `📨 New reply from ${fromName}: ${subject.substring(0, 50)}`,
            leadId: lead._id,
            isRead: false,
            createdAt: new Date()
        });

        console.log(`✅ [NYLAS WEBHOOK] Processed reply from ${fromEmail} for lead ${lead.name}`);

        // Trigger auto-reply if enabled
        if (lead.autoReplyEnabled) {
            await triggerAutoReply(user._id, lead, fromEmail, subject, body);
        }

    } catch (error) {
        console.error('❌ [NYLAS WEBHOOK] Process message error:', error.message);
    }
}

/**
 * Trigger auto-reply for a lead
 */
async function triggerAutoReply(userId, lead, to, originalSubject, originalBody) {
    try {
        console.log(`🤖 [NYLAS WEBHOOK] Triggering auto-reply for lead ${lead.email}`);

        const user = await User.findById(userId);
        if (!user) {
            console.error('❌ [NYLAS WEBHOOK] User not found');
            return;
        }

        // Check auto-reply limit
        const tier = user.subscriptionTier || 'free';
        const limits = { free: 0, go: 20, pro: 100 };
        const limit = limits[tier] || 0;

        if (limit === 0) {
            console.log(`⚠️ [NYLAS WEBHOOK] Auto-reply not available for ${tier} plan`);
            return;
        }

        // Check daily limit
        if (!user.usage) user.usage = {};
        if (user.usage.dailyAutoReplyCount === undefined) user.usage.dailyAutoReplyCount = 0;
        if (!user.usage.lastAutoReplyDate) user.usage.lastAutoReplyDate = null;

        const today = new Date().toDateString();
        const lastDateStr = user.usage.lastAutoReplyDate ? new Date(user.usage.lastAutoReplyDate).toDateString() : null;
        if (lastDateStr !== today) {
            user.usage.dailyAutoReplyCount = 0;
            user.usage.lastAutoReplyDate = new Date();
            await user.save();
        }

        if (user.usage.dailyAutoReplyCount >= limit) {
            console.log(`⚠️ [NYLAS WEBHOOK] Auto-reply limit reached (${limit}) for user ${user.email}`);
            return;
        }

        // Generate AI reply
        const reply = await generateAIReply(originalSubject, originalBody, lead.autoReplyInstructions);
        if (!reply) {
            console.log(`⚠️ [NYLAS WEBHOOK] No auto-reply generated for ${lead.email}`);
            return;
        }

        // Send the auto-reply
        const newSubject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;
        await sendNylasEmail(
            userId,
            to,
            newSubject,
            reply
        );

        // Increment counter
        user.usage.dailyAutoReplyCount += 1;
        await user.save();

        // Add auto-reply to lead history
        lead.replies = lead.replies || [];
        lead.replies.push({
            from: 'ai',
            content: reply,
            subject: newSubject,
            receivedAt: new Date(),
            isRead: true,
            status: 'sent'
        });
        await lead.save();

        console.log(`✅ [NYLAS WEBHOOK] Auto-reply sent to ${lead.email}`);

    } catch (error) {
        console.error('❌ [NYLAS WEBHOOK] Auto-reply error:', error.message);
    }
}

module.exports = { 
    handleNylasWebhook,
    processNewMessage,
    triggerAutoReply 
};
