const EmailAccount = require('./EmailAccount');
const Lead = require('./Lead');
const Message = require('./Message');
const User = require('./User');
const { generateAIReply } = require('./aiReplyGenerator');
const { refreshNylasToken } = require('./nylasTokenRefresh');
const { sendEmail } = require('./nylasService');

module.exports = async (req, res) => {
    if (req.method === 'GET') {
        const challenge = req.query.challenge;
        if (challenge) return res.status(200).send(challenge);
        return res.status(400).send('No challenge provided');
    }

    if (req.method === 'POST') {
        try {
            const payload = JSON.parse(req.body.toString('utf-8'));
            const messageData = payload.data?.object;

            if (messageData && (payload.type === 'message.created' || payload.event === 'message.created')) {
                const fromEmail = messageData.from?.[0]?.email;
                const toEmail = messageData.to?.[0]?.email;
                console.log(`📩 [WEBHOOK] Email from ${fromEmail} to ${toEmail}`);

                // 1. Find inbox owner
                const grantId = payload.grant_id || messageData.grant_id;
                let ownerUserId = null;
                if (grantId) {
                    const account = await EmailAccount.findOne({ nylasGrantId: grantId });
                    if (account) ownerUserId = account.userId;
                }
                if (!ownerUserId && toEmail) {
                    const account = await EmailAccount.findOne({ emailAddress: toEmail.toLowerCase() });
                    if (account) ownerUserId = account.userId;
                }
                if (!ownerUserId) {
                    console.warn(`⚠️ [WEBHOOK] Could not identify owner for To: ${toEmail}`);
                    return res.status(200).send('OK');
                }

                // 2. Find the Lead
                const lead = await Lead.findOne({ email: fromEmail, userId: ownerUserId });
                if (lead) {
                    // Reset follow‑up count and update lead
                    lead.status = 'Replied';
                    lead.lastContactDate = new Date();
                    lead.followUpCount = 0;
                    const bodyText = messageData.body || messageData.snippet || '';
                    lead.replies = lead.replies || [];
                    lead.replies.push({
                        date: new Date(),
                        content: bodyText,
                        from: 'lead',
                        subject: messageData.subject
                    });
                    await lead.save();

                    // 3. Create notification
                    await new Message({
                        userId: ownerUserId,
                        sessionId: 'reply-notification',
                        role: 'ai',
                        title: '📬 New Lead Reply',
                        content: `${lead.name} replied:\n\n"${bodyText.substring(0, 200)}..."`,
                        notificationType: 'reply',
                        leadId: lead._id,
                        isRead: false
                    }).save();
                    console.log(`🔔 Notification saved for User: ${ownerUserId}`);

                    // 4. Auto‑reply logic
                    console.log(`🤖 [AUTO-REPLY] Enabled: ${lead.autoReplyEnabled}`);
                    if (lead.autoReplyEnabled && lead.autoReplyInstructions) {
                        try {
                            const ownerUser = await User.findById(ownerUserId);
                            
                            // NEW AUTO-REPLY LIMITS: Free=0 (OFF), Go=20, Pro=100
                            let autoReplyLimit = 0; // Free
                            const tier = ownerUser.subscriptionTier;
                            if (tier === 'go') autoReplyLimit = 20;
                            if (tier === 'pro') autoReplyLimit = 100;

                            if (!ownerUser.usage) ownerUser.usage = { autoReplyCount: 0, lastAutoReplyDate: new Date() };
                            const todayStr = new Date().toDateString();
                            const lastAutoStr = ownerUser.usage.lastAutoReplyDate ? new Date(ownerUser.usage.lastAutoReplyDate).toDateString() : '';
                            if (lastAutoStr !== todayStr) {
                                ownerUser.usage.autoReplyCount = 0;
                                ownerUser.usage.lastAutoReplyDate = new Date();
                                await ownerUser.save();
                            }

                            if (ownerUser.usage.autoReplyCount >= autoReplyLimit) {
                                if (autoReplyLimit === 0) {
                                    console.log(`⚪ [AUTO-REPLY] Auto-reply is not available for Free plan.`);
                                } else {
                                    console.log(`🚫 [AUTO-REPLY] Limit reached for user ${ownerUserId} (${autoReplyLimit}/${autoReplyLimit})`);
                                }
                            } else {
                                ownerUser.usage.autoReplyCount += 1;
                                await ownerUser.save();

                                const history = lead.replies.slice(-4).map(msg => ({
                                    role: msg.from === 'lead' ? 'user' : 'assistant',
                                    content: msg.content
                                }));

                                const followUpCount = lead.followUpCount || 0;
                                console.log(`📊 [AUTO-REPLY] followUpCount: ${followUpCount}`);

                                const aiResult = await generateAIReply(
                                    bodyText,
                                    lead.autoReplyInstructions,
                                    lead.name,
                                    history,
                                    {
                                        mode: 'full',
                                        followUpCount: followUpCount
                                    }
                                );

                                console.log(`🧠 [AUTO-REPLY] AI result: action=${aiResult?.action} | risk=${aiResult?.riskLevel} | tokens=${aiResult?.tokensUsed}`);

                                if (aiResult && aiResult.action === 'REPLY' && aiResult.reply) {
                                    const emailAccount = await EmailAccount.findOne({ userId: ownerUserId });
                                    if (!emailAccount) {
                                        console.error('❌ [AUTO-REPLY] No email account found for user.');
                                    } else if (!emailAccount.refreshToken) {
                                        console.error('❌ [AUTO-REPLY] No refresh token — user must reconnect Nylas.');
                                    } else {
                                        let accessToken = emailAccount.accessToken;
                                        const isExpired = !emailAccount.tokenExpiry ||
                                            new Date() > new Date(emailAccount.tokenExpiry.getTime() - 5 * 60 * 1000);
                                        if (isExpired) {
                                            try {
                                                console.log('🔄 [AUTO-REPLY] Token expiring — refreshing...');
                                                accessToken = await refreshNylasToken(emailAccount);
                                            } catch (refreshErr) {
                                                console.error(`❌ [AUTO-REPLY] Token refresh failed: ${refreshErr.message}`);
                                                accessToken = null;
                                            }
                                        }
                                        if (accessToken) {
                                            // Check send limit before actually sending the email
                                            try {
                                                await checkAndIncrementSendLimit(ownerUserId);
                                            } catch (limitError) {
                                                console.warn(`Send limit reached, skipping auto-reply to ${lead.email}: ${limitError.message}`);
                                                return res.status(200).send('OK');
                                            }
                                            const result = await sendEmail(
                                                accessToken,
                                                lead.email,
                                                `Re: ${messageData.subject}`,
                                                aiResult.reply
                                            );
                                            if (result.success) {
                                                lead.replies.push({
                                                    date: new Date(),
                                                    content: aiResult.reply,
                                                    subject: `Re: ${messageData.subject}`,
                                                    from: 'ai',
                                                    status: 'sent'
                                                });
                                                lead.followUpCount = (lead.followUpCount || 0) + 1;
                                                await lead.save();
                                                console.log(`✅ [AUTO-REPLY] Sent to ${lead.email} | followUpCount now: ${lead.followUpCount}`);
                                            } else {
                                                console.error(`❌ [AUTO-REPLY] Send failed: ${result.error}`);
                                            }
                                        }
                                    }
                                } else {
                                    console.log(`🔇 [AUTO-REPLY] Skipped. Action: ${aiResult?.action || 'NULL'} | Reason: ${aiResult?.reasoning || 'No reply generated'}`);
                                }
                            }
                        } catch (aiErr) {
                            console.error('❌ [AUTO-REPLY] Generation error:', aiErr.message);
                        }
                    } else {
                        console.log(`⚪ [AUTO-REPLY] Disabled or no instructions set.`);
                    }
                } else {
                    console.warn(`⚠️ [WEBHOOK] No lead found for ${fromEmail} under User ${ownerUserId}`);
                }
            }
            return res.status(200).send('OK');
        } catch (err) {
            console.error('❌ Webhook Error:', err);
            return res.status(500).send('Error');
        }
    }
    res.status(405).send('Method Not Allowed');
};
