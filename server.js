const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

// IMPORT NEW AI FILES FOR TIERS
const freeAI = require('./Free');
const goAI = require('./Go');
const { generateBusinessResponse } = require('./businessAI'); 

// IMPORT MONTH 2 FILES
const Lead = require('./Lead');
const { getAuthUrl } = require('./nylasService');
const { handleIncomingReply } = require('./replyHandler');

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
//  CHECK SUBSCRIPTION EXPIRY MIDDLEWARE
// ════════════════════════════════════════════
const checkSubscriptionExpiry = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        
        if (user.subscriptionTier && user.subscriptionTier !== 'free' && user.subscriptionEndDate) {
            const now = new Date();                        
            const endDate = new Date(user.subscriptionEndDate);                        
            if (now > endDate) {
                user.subscriptionTier = 'free';
                user.subscriptionEndDate = null;
                await user.save();                console.log(`⚠️ User ${user._id} downgraded to free - subscription expired`);
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
                if (txRef.includes('_go_')) planType = 'go';                
                else if (txRef.includes('_pro_')) planType = 'pro';
                else planType = 'free';                                    }

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
        next();
    } catch (err) {
        console.error('Token Verification Failed:', err.message);        
        return res.status(401).json({ message: 'Invalid token' });                }
};

// ── Daily Usage Limit Middleware (UPDATED: FREE = 30) ──
const checkDailyLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) {
            user.usage = {
                dailyCallCount: 0,
                lastCallDate: new Date()
            };
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
            return res.status(429).json({ 
                message: `Daily limit reached (${limit}/${limit}). Upgrade your plan for more.` 
            });
        }

        user.usage.dailyCallCount += 1;                
        await user.save();

        next();

    } catch (err) {
        console.error('Error checking daily limit:', err);
        res.status(500).json({ message: 'Server Error checking usage limits' });
    }
};

// ════════════════════════════════════════════//  NYLAS AUTHENTICATION ROUTES (Month 2)
// ════════════════════════════════════════════

// 1. Get the Connection URL
app.get('/api/auth/nylas/url', verifyToken, (req, res) => {
    const url = getAuthUrl(req.userId);
    res.json({ url });
});

// 2. Handle the Callback (When user finishes connecting)
app.get('/api/auth/nylas/callback', async (req, res) => {
    const { code, state } = req.query; 
    
    try {
        // Exchange code for access token using Axios (Safe from SDK version issues)
        const response = await axios.post('https://api.nylas.com/oauth/token', {
            client_id: process.env.NYLAS_CLIENT_ID,
            client_secret: process.env.NYLAS_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: 'https://skylineai-app.vercel.app/api/auth/nylas/callback' // Must match Nylas Dashboard
        });

        const accessToken = response.data.access_token;
        
        // Get User Email Address from Nylas using Axios
        const accountRes = await axios.get('https://api.nylas.com/account', {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });
        
        const emailAddress = accountRes.data.email_address;

        // Save to Database
        await User.findByIdAndUpdate(state, { 
            'nylasIntegration.accessToken': accessToken,
            'nylasIntegration.emailAddress': emailAddress,
            'nylasIntegration.isConnected': true
        });

        res.redirect('https://skylineai-app.vercel.app/dashboard?connected=true');
    } catch (err) {
        console.error('❌ Nylas Callback Error:', err.response ? err.response.data : err.message);
        res.status(500).send('Connection Failed');
    }
});

// 3. Inbound Email Webhook (The Inbox Brain)
app.post('/api/webhooks/inbound-email', express.raw({ type: 'application/json' }), async (req, res) => {    try {
        const payload = req.body;
        // Nylas webhook structure varies, but usually contains 'from' and 'body'
        const userEmail = payload.from ? payload.from[0].email : null; 
        const bodyText = payload.body || payload.text;

        if (userEmail && bodyText) {
            // Fire and forget - don't block the webhook response
            handleIncomingReply(userEmail, bodyText);
        }
        
        res.status(200).send('Received');
    } catch (err) {
        console.error('❌ Webhook Error:', err);
        res.status(500).send('Error');
    }
});

// ════════════════════════════════════════════
//  FLUTTERWAVE PAYMENT ROUTES
// ════════════════════════════════════════════
app.get('/api/verify-payment/:tx_ref', async (req, res) => {
    try {
        const tx_ref = req.params.tx_ref;
        
        console.log(`🔍 Verifying payment for tx_ref: ${tx_ref}`);

        const response = await axios.get(
            `${process.env.FLUTTERWAVE_BASE_URL}/transactions/verify_by_reference?tx_ref=${tx_ref}`,
            {
                headers: {
                    Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
                },
            }
        );

        const data = response.data.data;        
        console.log(`📊 Verification response status: ${data.status}`);

        if (data.status === "successful") {
            let userId = data.meta?.userId;
            
            if (!userId) {                
                const user = await User.findOne({ lastTxRef: tx_ref });
                if (user) {
                    userId = user._id;
                }            
            }
            
            if (!userId) {                console.error("❌ No userId found in verification response and no user found by txRef");
                return res.status(400).json({ success: false, message: "No userId found" });
            }
            
            console.log(`✅ Verifying payment for user: ${userId}`);

            let planType = 'pro'; 
            if (tx_ref.includes('_go_')) planType = 'go';
            else if (tx_ref.includes('_pro_')) planType = 'pro';

            const updatedUser = await User.findByIdAndUpdate(
                userId, 
                {
                    subscriptionTier: planType,                    
                    subscriptionEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                    lastTxRef: null                
                },
                { new: true }
            );                        
            if (updatedUser) {
                console.log(`✅ User ${userId} upgraded to ${planType.toUpperCase()} via manual verification.`);
                return res.json({ success: true, message: "Payment verified and account upgraded" });
            } else {
                console.error(`❌ User ${userId} not found!`);
                return res.status(404).json({ success: false, message: "User not found" });
            }
        }

        res.json({ success: false, message: "Payment not successful" });

    } catch (err) {
        console.error('❌ Verification Error:', err.response?.data || err.message);
        res.status(500).json({ message: "Verification failed", error: err.message });
    }
});

app.post('/api/create-flutterwave-payment', verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const { planType } = req.body; 
        let amount = 0;
        let planName = '';
        if (planType === 'go') {
            amount = 9; 
            planName = 'Skyline AA-1 GO Plan';
        } else if (planType === 'pro') {
            amount = 20; 
            planName = 'Skyline AA-1 PRO Plan';        } else {
            return res.status(400).json({ message: 'Invalid plan type' });
        }

        const vercelUrl = process.env.VERCEL_URL || 'https://skylineai-app.vercel.app';                         
        const txRef = `skyline_${planType}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

        user.lastTxRef = txRef;
        await user.save();
        console.log(`💾 Saved txRef ${txRef} to user ${user._id} for plan ${planType}`);
        const payload = {
            tx_ref: txRef,
            amount: amount,            
            currency: "USD", 
            redirect_url: `${vercelUrl}/payment-success.html?tx_ref=${txRef}`,            
            customer: {                
                email: user.email,
                phonenumber: user.phone || "08012345678",
                name: user.fullName || user.username,
            },
            customizations: {
                title: planName,
                description: 'Monthly Subscription',
                logo: 'https://your-logo-url.com/logo.png',
            },
            meta: {
                userId: user._id.toString(),
                plan: planType
            }
        };

        console.log(`💰 Creating payment for user ${user._id}, tx_ref: ${txRef}`);

        const response = await axios.post(`${process.env.FLUTTERWAVE_BASE_URL}/payments`, payload, {
            headers: {
                Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
                'Content-Type': 'application/json',
            },
        });

        if (response.data.status === 'success') {
            console.log(`✅ Payment link created for user ${user._id}`);
            res.json({ link: response.data.data.link, tx_ref: txRef });
        } else {
            console.error('❌ Failed to initialize payment:', response.data);            
            res.status(400).json({ message: 'Failed to initialize payment', error: response.data });
        }    
    } catch (error) {
        console.error('❌ Flutterwave Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Server Error initializing payment' });    }
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
        // --- MONTH 2: CHECK FOR SEQUENCE COMMAND ---
        if (message.startsWith('START_SEQUENCE')) {
            // Extract lead info (Simple parsing: "START_SEQUENCE for: Name at Company")
            const leadInfo = message.replace('START_SEQUENCE for:', '').trim();
            const parts = leadInfo.split(' at ');
            
            if (parts.length >= 2) {
                const name = parts[0].trim();
                const company = parts[1].trim();

                // Create a new Lead in the Database
                const newLead = new Lead({
                    userId: userId,
                    name: name,
                    company: company,
                    // Simple email guesser for testing
                    email: `${name.toLowerCase().replace(/\s/g, '.')}@${company.toLowerCase()}.com`,
                    status: 'Queued',
                    nextActionDate: new Date() // Run immediately in next engine cycle
                });
                await newLead.save();

                return res.json({ 
                    reply: `✅ Sequence Initiated for ${name} at ${company}. The engine will pick this up shortly.`,
                    sessionId: currentSessionId,
                    history: [...(history || []), { role: 'user', content: message }, { role: 'assistant', content: `✅ Sequence Initiated for ${name} at ${company}.` }]
                });
            }
        }
        // -------------------------------------------

        await new Message({
            userId,            sessionId: currentSessionId,
            role: 'user',
            content: message,
            title: message.substring(0, 30) + '...'
        }).save();

        let aiReply, updatedHistory;

        if (plan === 'free') {
            console.log("🟢 Routing to Free AI");
            const result = await freeAI.generateFreeResponse(message, history || [], user);
            aiReply = result.reply;
            updatedHistory = result.updatedHistory;
        } 
        else if (plan === 'go') {
            console.log("🟡 Routing to Go AI");
            try {
                const result = await goAI.generateGoResponse(message, history || [], user);
                
                if (result && result.reply) {
                    aiReply = result.reply;
                    updatedHistory = result.updatedHistory || [];
                } else {
                    console.error("❌ Go AI returned empty result");
                    aiReply = "⚠️ Sorry, I encountered an internal error. Please try again.";
                }
            } catch (goError) {
                console.error("❌ Go AI Route Error:", goError);
                aiReply = "⚠️ Go AI Service is currently unavailable.";
            }
        } 
        else {
            console.log("🔴 Routing to Pro/Business AI");
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
            content: aiReply                }).save();
        res.json({ reply: aiReply, sessionId: currentSessionId, history: updatedHistory });
    } catch (error) {
        console.error('Chat route error:', error);
        res.status(500).json({ message: error.message || 'Server Error' });
    }
});

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
        
        if (!message) {
            return res.status(404).json({ message: 'Message not found' });
        }

        if (message.userId.toString() !== req.userId) {
            return res.status(403).json({ message: 'Unauthorized' });
        }
        
        if (message.feedback === type) {
            message.feedback = null;
        } else {
            message.feedback = type;
        }
        
        await message.save();

        res.json({ success: true, feedback: message.feedback });

    } catch (err) {        
        console.error('Feedback Error:', err);
        res.status(500).json({ message: 'Server Error saving feedback' });
    }
});

// ════════════════════════════════════════════
//  OTHER PROTECTED API ROUTES
// ════════════════════════════════════════════

app.get('/api/sessions', verifyToken, checkSubscriptionExpiry, async (req, res) => {    try {        
        const sessions = await Message.aggregate([
            { $match: { userId: new mongoose.Types.ObjectId(req.userId) } },
            { $sort: { createdAt: -1 } },
            {
                $group: {
                    _id: '$sessionId',
                    title: { $first: '$title' },
                    lastUpdated: { $first: '$createdAt' }
                }
            },
            { $sort: { lastUpdated: -1 } }
        ]);
        res.json(sessions);
    } catch (error) {
        res.status(500).json({ message: 'Server Error fetching sessions' });
    }
});

app.get('/api/history/:sessionId', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {
        const messages = await Message.find({
            userId: req.userId,
            sessionId: req.params.sessionId
        }).sort({ createdAt: 1 });        
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
        await new Message({
            userId,
            sessionId: currentSessionId,            
            role: 'user',
            content: dream,            
            title: dream.substring(0, 30) + '...'
        }).save();

        const user = await User.findById(userId);        
        const userProfile = {
            fullName:    user.fullName,            country:     user.country,
            skillLevel:  user.skillLevel,            
            primaryGoal: user.primaryGoal,
            interests:   user.interests,
            bio:         user.bio,
            userId:      user._id.toString()
        };

        const result = await requestQueue.enqueue(async () => {
            return await generateBusinessResponse(dream, [], userProfile);
        });

        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'ai',
            content: result.reply
        }).save();

        res.json({ 
            plan: result.reply, 
            audit: {}, 
            sessionId: currentSessionId         
        });
    } catch (error) {
        console.error('Dream analyze error:', error);
        res.status(500).json({ message: error.message || 'Server Error' });
    }
});

app.post('/api/dreams/refine', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {
    const { originalPlan, followUpAnswer, dreamDescription, sessionId } = req.body;    
    const userId = req.userId;    
    
    if (!followUpAnswer || !dreamDescription) {
        return res.status(400).json({
            message: 'followUpAnswer and dreamDescription are required'        
        });
    }

    const currentSessionId = sessionId || uuidv4();        
    try {
        await new Message({
            userId,            
            sessionId: currentSessionId,
            role: 'user',
            content: followUpAnswer        
        }).save();

        const user = await User.findById(userId);        const userProfile = {
            fullName:    user.fullName,
            country:     user.country,
            skillLevel:  user.skillLevel,
            primaryGoal: user.primaryGoal,            
            interests:   user.interests,
            bio:         user.bio,
            userId:      user._id.toString()
        };

        const result = await requestQueue.enqueue(async () => {
            return await generateBusinessResponse(followUpAnswer, [], userProfile);
        });

        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'ai',
            content: result.reply        
        }).save();
        res.json({ 
            plan: result.reply, 
            audit: {}, 
            sessionId: currentSessionId 
        });

    } catch (error) {
        console.error('Plan refinement error:', error);
        res.status(500).json({ message: error.message || 'Server Error' });
    }
});

app.get('/api/users/me', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {
        const user = await User.findById(req.userId).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

app.put('/api/users/me', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {        
        const { fullName, primaryGoal, skillLevel, interests, country, bio, profilePicture } = req.body;

        let user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        if (fullName)       user.fullName       = fullName;
        if (primaryGoal)    user.primaryGoal    = primaryGoal;        
        if (skillLevel)     user.skillLevel     = skillLevel;
        if (interests)      user.interests      = interests;
        if (country)        user.country        = country;
        if (bio)            user.bio            = bio;
        if (profilePicture) user.profilePicture = profilePicture;
        await user.save();
        res.json(user);
    } catch (err) {
        console.error(err.message);
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

        if (newPassword.length < 8)
            return res.status(400).json({ message: 'New password must be at least 8 characters' });
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();

        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

app.put('/api/auth/change-email', verifyToken, changeEmail);
app.put('/api/users/verify-age', verifyToken, verifyAge);
app.delete('/api/users/me', verifyToken, async (req, res) => {
    await deleteAccount(req, res);
});

// ════════════════════════════════════════════
//  ADMIN LAYER ROUTES
// ════════════════════════════════════════════

app.post('/api/admin/verify-layer-2', verifyToken, verifyLayer2);
app.post('/api/admin/verify-layer-3', verifyToken, verifyLayer3);
app.get('/api/admin/users', verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user || !user.isAdmin)
            return res.status(403).json({ message: 'Access denied. Admins only.' });

        const users = await User.find().select('-password');
        res.json(users);
    } catch (err) {        
        console.error(err);        
        res.status(500).json({ message: 'Server Error' });
    }
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
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.delete('/api/admin/users/:id', verifyToken, async (req, res) => {    
    try {
        const admin = await User.findById(req.userId);        
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });        
        await User.findByIdAndDelete(req.params.id);
        res.json({ message: 'User deleted' });
    } catch (err) {        
        res.status(500).json({ message: 'Server Error' });
    }
});

app.get('/api/admin/users/:id/details', verifyToken, async (req, res) => {    
    try {        
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const targetUser = await User.findById(req.params.id).select('-password');
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        const messages = await Message.find({ userId: req.params.id }).sort({ createdAt: 1 });
        res.json({ user: targetUser, history: messages });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
});

app.get('/api/admin/users/:id/chat-view', verifyToken, async (req, res) => {    
    try {        
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });

        const targetUser = await User.findById(req.params.id).select('-password');
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        const chatMessages = await Message.find({ userId: req.params.id }).sort({ createdAt: 1 });
        res.json({ user: targetUser, messages: chatMessages });
    } catch (err) {
        console.error('Chat View Error:', err);
        res.status(500).json({ message: 'Server Error' });    
    }
});

app.post('/api/admin/users/:id/message', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const { messageContent } = req.body;
        if (!messageContent) return res.status(400).json({ message: 'Message content is required' });

        const targetUser = await User.findById(req.params.id);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });        
        const newMessage = new Message({
            userId: req.params.id,
            sessionId: 'admin-direct-message',             
            role: 'ai', 
            content: `[ADMIN MESSAGE]: ${messageContent}`,            
            title: 'Direct Message from Admin'
        });

        await newMessage.save();
        res.json({ message: 'Message sent successfully' });
    } catch (err) {
        console.error(err);        
        res.status(500).json({ message: 'Server Error' });
    }
});

// ════════════════════════════════════════════//  REPORT ROUTES
// ════════════════════════════════════════════

app.post('/api/reports', verifyToken, async (req, res) => {
    try {
        const { subject, message } = req.body;
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const newReport = new Report({            
            userId: req.userId,            
            username: user.username,
            subject,
            message
        });
        await newReport.save();
        res.json({ message: 'Report submitted successfully' });
    } catch (err) {
        console.error(err);        
        res.status(500).json({ message: 'Server Error' });
    }
});

app.get('/api/admin/reports', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });

        const reports = await Report.find().sort({ createdAt: -1 });
        res.json(reports);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });        
    }
});

// ════════════════════════════════════════════
//  NOTIFICATION ROUTES (USER)
// ════════════════════════════════════════════
app.get('/api/notifications', verifyToken, async (req, res) => {
    try {
        const notifications = await Message.find({ 
            userId: req.userId,             
            sessionId: 'admin-direct-message'         
        }).sort({ createdAt: -1 });
        res.json(notifications);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error fetching notifications' });
    }
});
app.get('/api/notifications/count', verifyToken, async (req, res) => {    
    try {        
        const count = await Message.countDocuments({ 
            userId: req.userId, 
            sessionId: 'admin-direct-message' 
        });
        
        res.json({ count });
    } catch (err) {        
        console.error(err);        
        res.status(500).json({ message: 'Server Error counting notifications' });
    }
});

// Scheduled expiry check (runs daily at midnight)
const scheduleExpiryCheck = async () => {
    try {
        const now = new Date();
        const result = await User.updateMany(
            {                
                subscriptionTier: { $ne: 'free' },                 
                subscriptionEndDate: { $lt: now }
            },
            {
                subscriptionTier: 'free',
                subscriptionEndDate: null
            }
        );
        if (result.modifiedCount > 0) {
            console.log(`🔄 Downgraded ${result.modifiedCount} expired users`);
        }    
    } catch (err) {
        console.error('Error in expiry check:', err);
    }
};

// Run expiry check on startup and every 24 hours
setTimeout(() => {    
    scheduleExpiryCheck();
    setInterval(scheduleExpiryCheck, 24 * 60 * 60 * 1000);
}, 5000);

// ════════════════════════════════════════════
//  INITIALIZE SEQUENCE ENGINE
// ════════════════════════════════════════════
require('./sequenceEngine');

// ════════════════════════════════════════════
const PORT = process.env.PORT || 5001;app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
