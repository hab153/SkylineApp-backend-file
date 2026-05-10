const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const crypto = require('crypto'); // Required for signature verification

// IMPORT NEW AI FILES FOR TIERS
const freeAI = require('./Free');
const goAI = require('./Go');
const { generateBusinessResponse } = require('./businessAI'); 

// IMPORT MONTH 2 FILES
const Lead = require('./Lead');
// Import sendEmail along with other nylas functions
const { getAuthUrl, exchangeCodeForToken, getUserEmail, sendEmail } = require('./nylasService');

const authRoutes = require('./authRoutes');
const Message = require('./Message');
const User = require('./User');
const Report = require('./Report');
const requestQueue = require('./requestQueue');
const { verifyAge, changeEmail, verifyLayer2, verifyLayer3, deleteAccount } = require('./authController');

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(cors());

// ════════════════════════════════════════════
//  IN-MEMORY STATE STORE (For Nylas Auth)
// ════════════════════════════════════════════
const stateStore = {};

// ════════════════════════════════════════════
//  CHECK SUBSCRIPTION EXPIRY MIDDLEWARE
// ════════════════════════════════════════════
const checkSubscriptionExpiry = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        
        if (user.subscriptionTier && user.subscriptionTier !== 'free' && user.subscriptionEndDate) {            const now = new Date();
            const endDate = new Date(user.subscriptionEndDate);
            if (now > endDate) {
                user.subscriptionTier = 'free';
                user.subscriptionEndDate = null;
                await user.save();
                console.log(`⚠️ User ${user._id} downgraded to free - subscription expired`);
            }
        }
        next();
    } catch (err) {
        console.error('Error checking subscription expiry:', err);
        next();
    }
};

// ════════════════════════════════════════════
//  WEBHOOK ROUTE - UPDATED FOR 3 TIERS
// ════════════════════════════════════════════
app.post('/api/flutterwave-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    console.log("🔥 Webhook hit!");
    
    const sig = req.headers['verif-hash'];
    const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
    
    if (secretHash && sig !== secretHash) {
        console.log("⚠️ Hash mismatch - check your FLUTTERWAVE_SECRET_HASH");
        return res.status(401).send('Unauthorized');
    }

    try {
        const payload = JSON.parse(req.body.toString());
        let txRef, status, planType;
        
        if (payload.status) {
            status = payload.status;
            txRef = payload.txRef || payload.tx_ref;
            planType = payload.meta?.plan;
        } else if (payload.event === 'charge.completed') {
            status = payload.data?.status;
            txRef = payload.data?.tx_ref;
            planType = payload.data?.meta?.plan;
        }

        if (status === 'successful') {
            console.log(`✅ Payment successful for txRef: ${txRef}`);
            if (!txRef) return res.status(400).send('Missing txRef');
            
            if (!planType) {
                if (txRef.includes('_go_')) planType = 'go';                else if (txRef.includes('_pro_')) planType = 'pro';
                else planType = 'free';
            }

            const user = await User.findOne({ lastTxRef: txRef });
            if (user) {
                const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
                await User.findByIdAndUpdate(user._id, {
                    subscriptionTier: planType, 
                    subscriptionEndDate: endDate,
                    lastTxRef: null
                });
                console.log(`🎉 User ${user._id} upgraded to ${planType.toUpperCase()} Plan!`);
            } else {
                console.error(`❌ User not found for txRef: ${txRef}`);
            }
        } else {
            console.log(`ℹ️ Webhook received but payment not successful. Status: ${status || 'unknown'}`);
        }

        res.status(200).send('Webhook received');
    } catch (error) {
        console.error('❌ Webhook Error:', error);
        res.status(500).send('Webhook failed');
    }
});

// Now apply express.json() for all other routes
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Database Connection
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.log('❌ MongoDB Connection Error:', err));

// Auth Routes
app.use('/api/auth', authRoutes);

// ── Verify Token Middleware ──
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(403).json({ message: 'No token provided' });
    try {
        const secret = process.env.JWT_SECRET || 'secretkey';
        const decoded = jwt.verify(token, secret);
        req.userId = decoded.user.id;
        next();    } catch (err) {
        console.error('Token Verification Failed:', err.message);
        return res.status(401).json({ message: 'Invalid token' });
    }
};

// ── Daily Usage Limit Middleware ──
const checkDailyLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) {
            user.usage = { dailyCallCount: 0, lastCallDate: new Date() };
        }

        let limit = 30; // Free Limit
        if (user.subscriptionTier === 'go') limit = 18; 
        if (user.subscriptionTier === 'pro') limit = 40; 

        const now = new Date();
        const todayStr = now.toDateString();
        const lastCallDate = user.usage.lastCallDate ? new Date(user.usage.lastCallDate) : null;
        const lastCallStr = lastCallDate ? lastCallDate.toDateString() : '';

        if (lastCallStr !== todayStr) {
            user.usage.dailyCallCount = 0;
            user.usage.lastCallDate = now;
            await user.save();
        }

        if (user.usage.dailyCallCount >= limit) {
            return res.status(429).json({ message: `Daily limit reached (${limit}/${limit}). Upgrade your plan for more.` });
        }

        user.usage.dailyCallCount += 1;
        await user.save();
        next();
    } catch (err) {
        console.error('Error checking daily limit:', err);
        res.status(500).json({ message: 'Server Error checking usage limits' });
    }
};

// ════════════════════════════════════════════
//  NYLAS AUTHENTICATION ROUTES
// ════════════════════════════════════════════

app.get('/api/auth/nylas/url', verifyToken, (req, res) => {
    const userId = req.userId;    const randomState = uuidv4();
    stateStore[randomState] = userId;
    
    setTimeout(() => { delete stateStore[randomState]; }, 10 * 60 * 1000);

    const url = getAuthUrl(randomState);
    res.json({ url });
});

app.get('/api/auth/nylas/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
        return res.redirect('https://skylineai-app.vercel.app/dashboard.html?connected=false&error=' + oauthError);
    }

    if (!code || !state) {
        return res.status(400).send('Missing required parameters.');
    }

    const userId = stateStore[state];
    if (!userId) {
        return res.status(400).send('Session expired. Please try connecting again.');
    }
    
    delete stateStore[state];

    try {
        const tokenData = await exchangeCodeForToken(code);
        const accessToken = tokenData.access_token;

        if (!accessToken) throw new Error('No access token returned from Nylas');

        let emailAddress = 'unknown@nylas.com';
        try {
            emailAddress = await getUserEmail(accessToken);
        } catch (emailErr) {
            console.warn(`⚠️ Could not retrieve email: ${emailErr.message}`);
        }

        await User.findByIdAndUpdate(userId, { 
            'nylasIntegration.accessToken': accessToken,
            'nylasIntegration.emailAddress': emailAddress,
            'nylasIntegration.isConnected': true,
            'nylasIntegration.connectedAt': new Date()
        });

        res.redirect('https://skylineai-app.vercel.app/dashboard.html?connected=true');
    } catch (err) {
        console.error(`❌ Nylas Callback Error: ${err.message}`);        res.redirect(`https://skylineai-app.vercel.app/dashboard.html?connected=false&error=token_exchange_failed`);
    }
});

// ════════════════════════════════════════════
//  BATCH SEND ROUTE (Human-in-the-Loop)
// ════════════════════════════════════════════
app.post('/api/leads/batch-send', verifyToken, async (req, res) => {
    try {
        const { leads } = req.body;
        const user = await User.findById(req.userId);

        if (!user.nylasIntegration || !user.nylasIntegration.isConnected) {
            return res.status(400).json({ message: 'Please connect your email first.' });
        }

        const accessToken = user.nylasIntegration.accessToken;
        let sentCount = 0;
        let errors = [];
        const now = new Date();

        for (const leadData of leads) {
            try {
                let lead = await Lead.findOne({ email: leadData.email, userId: req.userId });
                
                if (!lead) {
                    lead = new Lead({
                        userId: req.userId,
                        name: leadData.name,
                        email: leadData.email,
                        company: leadData.company,
                        status: 'Contacted',
                        lastContactDate: now
                    });
                } else {
                    lead.status = 'Contacted';
                    lead.lastContactDate = now;
                }
                
                if (leadData.messages && leadData.messages.length > 0) {
                    lead.replies.push({
                        date: now,
                        content: leadData.messages[0].body,
                        from: 'ai'
                    });
                }
                await lead.save();

                if (leadData.messages && leadData.messages.length > 0) {
                    const result = await sendEmail(                        accessToken, 
                        leadData.email, 
                        leadData.messages[0].subject, 
                        leadData.messages[0].body
                    );

                    if (result.success) {
                        sentCount++;
                    } else {
                        lead.status = 'Failed';
                        await lead.save();
                        errors.push({ email: leadData.email, error: result.error });
                    }
                }
            } catch (err) {
                console.error(`Failed to send to ${leadData.email}:`, err.message);
                errors.push({ email: leadData.email, error: err.message });
            }
        }

        res.json({ 
            success: true, 
            message: `Sent ${sentCount} emails.`, 
            errors: errors 
        });

    } catch (err) {
        console.error('Batch Send Error:', err);
        res.status(500).json({ message: 'Server Error during batch send' });
    }
});

// ════════════════════════════════════════════
//  INBOUND EMAIL WEBHOOK (FINAL ROBUST VERSION)
// ════════════════════════════════════════════
const webhookMiddleware = express.raw({ type: 'application/json' });

app.all('/api/webhooks/inbound-email', webhookMiddleware, async (req, res) => {
    
    // 1. HANDLE NYLAS VERIFICATION CHALLENGE (GET Request)
    if (req.method === 'GET') {
        const challenge = req.query.challenge;
        console.log(`🔔 [WEBHOOK] Verification challenge received: ${challenge}`);
        if (challenge) {
            return res.status(200).send(challenge); 
        }
        return res.status(400).send('No challenge provided');
    }

    // 2. HANDLE INCOMING EMAILS (POST Request)    
    if (req.method === 'POST') {
        try {
            // --- SIGNATURE VERIFICATION ---
            const signature = req.headers['x-nylas-signature'];
            const secret = process.env.NYLAS_WEBHOOK_SECRET;

            if (signature && secret) {
                const hmac = crypto.createHmac('sha256', secret);
                // req.body is a Buffer here because of express.raw()
                hmac.update(req.body); 
                const digest = hmac.digest('hex');
                
                if (signature !== digest) {
                    console.warn('⚠️ [WEBHOOK] Invalid signature detected.');
                    // In production, uncomment this to reject fake requests:
                    // return res.status(401).send('Invalid Signature');
                } else {
                    console.log('✅ [WEBHOOK] Signature verified successfully.');
                }
            }

            // Parse the Buffer into JSON so we can use it
            let payload;
            try {
                // Convert Buffer to UTF-8 String, then parse
                const rawBody = req.body.toString('utf-8');
                payload = JSON.parse(rawBody);
            } catch (e) {
                console.error('❌ [WEBHOOK] Failed to parse JSON from buffer:', e.message);
                return res.status(400).send('Invalid JSON');
            }

            const fromEmail = payload.from ? payload.from[0].email : null;
            const bodyText = payload.body || payload.text_plain || '';

            if (!fromEmail) {
                console.log('ℹ️ [WEBHOOK] No from email found.');
                return res.status(200).send('OK');
            }

            console.log(`📨 [WEBHOOK] Reply received from: ${fromEmail}`);

            // Find the Lead
            const lead = await Lead.findOne({ email: fromEmail });

            if (lead) {
                lead.status = 'Replied';
                lead.replies.push({
                    date: new Date(),
                    content: bodyText,                    from: 'lead' 
                });
                await lead.save();
                console.log(`✅ [WEBHOOK] Saved reply for Lead: ${lead.name}`);
            } else {
                console.warn(`⚠️ [WEBHOOK] No lead found for: ${fromEmail}`);
            }

            return res.status(200).send('OK');

        } catch (err) {
            console.error('❌ [WEBHOOK] Critical Error:', err.message);
            return res.status(500).send('Error');
        }
    }

    res.status(405).send('Method Not Allowed');
});

// ════════════════════════════════════════════
//  CHECK FOR NEW REPLIES (For Frontend Notification)
// ════════════════════════════════════════════
app.get('/api/notifications/replies', verifyToken, async (req, res) => {
    try {
        // Find leads belonging to this user that have status 'Replied'
        const repliedLeads = await Lead.find({ 
            userId: req.userId, 
            status: 'Replied' 
        }).sort({ lastContactDate: -1 });
        res.json({ 
            count: repliedLeads.length,
            leads: repliedLeads 
        });
    } catch (err) {
        console.error('Error fetching replies:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ════════════════════════════════════════════
//  CHAT ROUTE (THE AI ROUTER)
// ════════════════════════════════════════════
app.post('/api/chat', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {
    const { message, history, sessionId } = req.body;
    const userId = req.userId;
    if (!message) return res.status(400).json({ message: 'Message is required' });
    const currentSessionId = sessionId || uuidv4();
    const user = await User.findById(userId);
    const plan = user.subscriptionTier || 'free';
        try {
        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'user',
            content: message,
            title: message.substring(0, 30) + '...'
        }).save();

        let aiReply, updatedHistory;
        if (plan === 'free') {
            const result = await freeAI.generateFreeResponse(message, history || [], user);
            aiReply = result.reply;
            updatedHistory = result.updatedHistory;
        } 
        else if (plan === 'go') {
            try {
                const result = await goAI.generateGoResponse(message, history || [], user);
                aiReply = result ? result.reply : "⚠️ Go AI Service unavailable.";
                updatedHistory = result ? (result.updatedHistory || []) : [];
            } catch (goError) {
                aiReply = "⚠️ Go AI Service currently unavailable.";
            }
        } 
        else {
            const userProfile = {
                fullName: user.fullName, country: user.country, skillLevel: user.skillLevel,
                primaryGoal: user.primaryGoal, interests: user.interests, bio: user.bio,
                userId: user._id.toString()
            };
            const result = await requestQueue.enqueue(async () => {
                return await generateBusinessResponse(message, history || [], userProfile);
            });
            aiReply = result.reply;
            updatedHistory = result.updatedHistory;
        }

        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'ai',
            content: aiReply
        }).save();

        res.json({ reply: aiReply, sessionId: currentSessionId, history: updatedHistory });

    } catch (error) {
        console.error('Chat route error:', error);
        res.status(500).json({ message: error.message || 'Server Error' });
    }});

// ════════════════════════════════════════════
//  GET LEADS FOR DASHBOARD
// ════════════════════════════════════════════
app.get('/api/leads', verifyToken, async (req, res) => {
    try {
        const leads = await Lead.find({ userId: req.userId }).sort({ createdAt: -1 });
        res.json(leads);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// ... [Keep all other routes like Feedback, Sessions, Admin, etc. exactly as they were] ...

// ════════════════════════════════════════════
//  FEEDBACK ROUTE
// ════════════════════════════════════════════
app.post('/api/feedback', verifyToken, async (req, res) => {
    try {
        const { messageId, type } = req.body;
        if (!messageId || !['like', 'dislike'].includes(type)) {
            return res.status(400).json({ message: 'Invalid feedback data' });
        }
        const message = await Message.findById(messageId);
        if (!message) return res.status(404).json({ message: 'Message not found' });
        if (message.userId.toString() !== req.userId) {
            return res.status(403).json({ message: 'Unauthorized' });
        }
        message.feedback = message.feedback === type ? null : type;
        await message.save();
        res.json({ success: true, feedback: message.feedback });
    } catch (err) {
        res.status(500).json({ message: 'Server Error saving feedback' });
    }
});

// ════════════════════════════════════════════
//  OTHER PROTECTED API ROUTES (Sessions, History, Dreams, Users, Admin, Reports, Notifications)
//  ... [KEEP ALL EXISTING CODE HERE] ...
app.get('/api/sessions', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {
        const sessions = await Message.aggregate([
            { $match: { userId: new mongoose.Types.ObjectId(req.userId) } },
            { $sort: { createdAt: -1 } },
            { $group: { _id: '$sessionId', title: { $first: '$title' }, lastUpdated: { $first: '$createdAt' } } },
            { $sort: { lastUpdated: -1 } }
        ]);
        res.json(sessions);    } catch (error) {
        res.status(500).json({ message: 'Server Error fetching sessions' });
    }
});

app.get('/api/history/:sessionId', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {
        const messages = await Message.find({ userId: req.userId, sessionId: req.params.sessionId }).sort({ createdAt: 1 });
        res.json(messages);
    } catch (error) {
        res.status(500).json({ message: 'Server Error fetching history' });
    }
});

app.post('/api/dreams/analyze', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {
    const { dream, sessionId } = req.body;
    const userId = req.userId;
    if (!dream) return res.status(400).json({ message: 'Dream description is required' });
    const currentSessionId = sessionId || uuidv4();
    try {
        await new Message({ userId, sessionId: currentSessionId, role: 'user', content: dream, title: dream.substring(0, 30) + '...' }).save();
        const user = await User.findById(userId);
        const userProfile = { fullName: user.fullName, country: user.country, skillLevel: user.skillLevel, primaryGoal: user.primaryGoal, interests: user.interests, bio: user.bio, userId: user._id.toString() };
        const result = await requestQueue.enqueue(async () => { return await generateBusinessResponse(dream, [], userProfile); });
        await new Message({ userId, sessionId: currentSessionId, role: 'ai', content: result.reply }).save();
        res.json({ plan: result.reply, audit: {}, sessionId: currentSessionId });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Server Error' });
    }
});

app.post('/api/dreams/refine', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {
    const { originalPlan, followUpAnswer, dreamDescription, sessionId } = req.body;
    const userId = req.userId;
    if (!followUpAnswer || !dreamDescription) { return res.status(400).json({ message: 'followUpAnswer and dreamDescription are required' }); }
    const currentSessionId = sessionId || uuidv4();
    try {
        await new Message({ userId, sessionId: currentSessionId, role: 'user', content: followUpAnswer }).save();
        const user = await User.findById(userId);
        const userProfile = { fullName: user.fullName, country: user.country, skillLevel: user.skillLevel, primaryGoal: user.primaryGoal, interests: user.interests, bio: user.bio, userId: user._id.toString() };
        const result = await requestQueue.enqueue(async () => { return await generateBusinessResponse(followUpAnswer, [], userProfile); });
        await new Message({ userId, sessionId: currentSessionId, role: 'ai', content: result.reply }).save();
        res.json({ plan: result.reply, audit: {}, sessionId: currentSessionId });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Server Error' });
    }
});

app.get('/api/users/me', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {        const user = await User.findById(req.userId).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.put('/api/users/me', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {
        const { fullName, primaryGoal, skillLevel, interests, country, bio, profilePicture } = req.body;
        let user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        if (fullName) user.fullName = fullName;
        if (primaryGoal) user.primaryGoal = primaryGoal;
        if (skillLevel) user.skillLevel = skillLevel;
        if (interests) user.interests = interests;
        if (country) user.country = country;
        if (bio) user.bio = bio;
        if (profilePicture) user.profilePicture = profilePicture;
        await user.save();
        res.json(user);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.put('/api/auth/change-password', verifyToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    try {
        let user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Current password is incorrect' });
        if (newPassword.length < 8) return res.status(400).json({ message: 'New password must be at least 8 characters' });
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();
        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.put('/api/auth/change-email', verifyToken, changeEmail);
app.put('/api/users/verify-age', verifyToken, verifyAge);
app.delete('/api/users/me', verifyToken, async (req, res) => { await deleteAccount(req, res); });

// ADMIN ROUTES
app.post('/api/admin/verify-layer-2', verifyToken, verifyLayer2);app.post('/api/admin/verify-layer-3', verifyToken, verifyLayer3);
app.get('/api/admin/users', verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user || !user.isAdmin) return res.status(403).json({ message: 'Access denied. Admins only.' });
        const users = await User.find().select('-password');
        res.json(users);
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});
app.put('/api/admin/users/:id/suspend', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        targetUser.isSuspended = !targetUser.isSuspended;
        targetUser.suspensionEnds = targetUser.isSuspended ? new Date('2099-12-31') : null;
        await targetUser.save();
        res.json({ message: 'Status updated' });
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});
app.delete('/api/admin/users/:id', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        await User.findByIdAndDelete(req.params.id);
        res.json({ message: 'User deleted' });
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});
app.get('/api/admin/users/:id/details', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const targetUser = await User.findById(req.params.id).select('-password');
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        const messages = await Message.find({ userId: req.params.id }).sort({ createdAt: 1 });
        res.json({ user: targetUser, history: messages });
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});
app.get('/api/admin/users/:id/chat-view', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const targetUser = await User.findById(req.params.id).select('-password');
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        const chatMessages = await Message.find({ userId: req.params.id }).sort({ createdAt: 1 });
        res.json({ user: targetUser, messages: chatMessages });
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});
app.post('/api/admin/users/:id/message', verifyToken, async (req, res) => {    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const { messageContent } = req.body;
        if (!messageContent) return res.status(400).json({ message: 'Message content is required' });
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        const newMessage = new Message({ userId: req.params.id, sessionId: 'admin-direct-message', role: 'ai', content: `[ADMIN MESSAGE]: ${messageContent}`, title: 'Direct Message from Admin' });
        await newMessage.save();
        res.json({ message: 'Message sent successfully' });
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

// REPORTS
app.post('/api/reports', verifyToken, async (req, res) => {
    try {
        const { subject, message } = req.body;
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        const newReport = new Report({ userId: req.userId, username: user.username, subject, message });
        await newReport.save();
        res.json({ message: 'Report submitted successfully' });
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});
app.get('/api/admin/reports', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const reports = await Report.find().sort({ createdAt: -1 });
        res.json(reports);
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

// NOTIFICATIONS
app.get('/api/notifications', verifyToken, async (req, res) => {
    try {
        const notifications = await Message.find({ userId: req.userId, sessionId: 'admin-direct-message' }).sort({ createdAt: -1 });
        res.json(notifications);
    } catch (err) { res.status(500).json({ message: 'Server Error fetching notifications' }); }
});
app.get('/api/notifications/count', verifyToken, async (req, res) => {
    try {
        const count = await Message.countDocuments({ userId: req.userId, sessionId: 'admin-direct-message' });
        res.json({ count });
    } catch (err) { res.status(500).json({ message: 'Server Error counting notifications' }); }
});

// EXPIRY CHECK
const scheduleExpiryCheck = async () => {
    try {        const now = new Date();
        const result = await User.updateMany({ subscriptionTier: { $ne: 'free' }, subscriptionEndDate: { $lt: now } }, { subscriptionTier: 'free', subscriptionEndDate: null });
        if (result.modifiedCount > 0) { console.log(`🔄 Downgraded ${result.modifiedCount} expired users`); }
    } catch (err) { console.error('Error in expiry check:', err); }
};
setTimeout(() => { scheduleExpiryCheck(); setInterval(scheduleExpiryCheck, 24 * 60 * 60 * 1000); }, 5000);

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => { console.log(`🚀 Server running on port ${PORT}`); });
