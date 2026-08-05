// flutterwaveWebhook.js
const User = require('./User');
const crypto = require('crypto');
const { isValidObjectId } = require('./sanitize');

// ─── PRICING CONFIG ───
const PRICING = {
    go: 9,
    pro: 20
};

const ALLOWED_CURRENCIES = ['USD', 'NGN', 'EUR', 'GBP', 'KES', 'GHS', 'ZAR'];

// ─── IDEMPOTENCY: MongoDB-based ───
let ProcessedTransaction;
try {
    const mongoose = require('mongoose');
    const processedTxSchema = new mongoose.Schema({
        txRef: { type: String, required: true, unique: true },
        userId: { type: String, default: 'unknown' },
        status: { type: String, default: 'pending' },
        plan: { type: String },
        amount: { type: Number },
        processedAt: { type: Date, default: Date.now, expires: 604800 }
    });
    ProcessedTransaction = mongoose.model('ProcessedTransaction', processedTxSchema);
} catch (e) {
    console.warn('⚠️ [FLUTTERWAVE] Could not initialize ProcessedTransaction model:', e.message);
}

async function isAlreadyProcessed(txRef) {
    if (!ProcessedTransaction || !txRef) return false;
    try {
        const existing = await ProcessedTransaction.findOne({ txRef: String(txRef) });
        return !!existing;
    } catch (err) {
        return false;
    }
}

async function markAsProcessed(txRef, data) {
    if (!ProcessedTransaction || !txRef) return;
    try {
        await ProcessedTransaction.findOneAndUpdate(
            { txRef: String(txRef) },
            {
                txRef: String(txRef),
                userId: String(data.userId || 'unknown'),
                status: String(data.status || 'success'),
                plan: data.plan ? String(data.plan) : null,
                amount: Number(data.amount) || 0,
                processedAt: new Date()
            },
            { upsert: true }
        );
    } catch (err) {
        if (err.code !== 11000) {
            console.warn('⚠️ [FLUTTERWAVE] Mark processed error:', err.message);
        }
    }
}

async function verifyWithFlutterwave(txRef) {
    try {
        const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
        if (!secretKey) return null;

        const axios = require('axios');
        const safeRef = encodeURIComponent(String(txRef));
        const response = await axios.get(
            `https://api.flutterwave.com/v3/transactions/${safeRef}/verify`,
            {
                headers: {
                    'Authorization': `Bearer ${secretKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        if (response.data && response.data.status === 'success') {
            return response.data.data;
        }
        return null;
    } catch (err) {
        console.error('❌ [FLUTTERWAVE] Verification API error:', err.message);
        return null;
    }
}

/**
 * ✅ Handle Flutterwave webhook
 */
module.exports = async (req, res) => {
    console.log('🔔 [FLUTTERWAVE WEBHOOK] Received');

    try {
        const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;

        if (!secretHash || secretHash.trim() === '') {
            console.error('❌ [FLUTTERWAVE] FLUTTERWAVE_SECRET_HASH not configured');
            return res.status(500).send('Webhook not configured.');
        }

        const signature = req.headers['verif-hash'];

        if (!signature || typeof signature !== 'string') {
            return res.status(401).send('Unauthorized: Missing signature');
        }

        const sigBuffer = Buffer.from(String(signature));
        const hashBuffer = Buffer.from(String(secretHash));

        if (sigBuffer.length !== hashBuffer.length || !crypto.timingSafeEqual(sigBuffer, hashBuffer)) {
            console.error('❌ [FLUTTERWAVE] Invalid signature');
            return res.status(401).send('Unauthorized: Invalid signature');
        }

        console.log('✅ [FLUTTERWAVE] Signature verified');

        let payload;
        try {
            const rawBody = req.body ? req.body.toString('utf-8') : '';
            payload = JSON.parse(rawBody);
        } catch (e) {
            return res.status(400).send('Invalid JSON');
        }

        // Extract payment data
        let txRef, status, planType, amount, currency;

        if (payload.event === 'charge.completed') {
            const data = payload.data || {};
            status = data.status;
            txRef = data.tx_ref || data.txRef;
            planType = data.meta?.plan || data.plan;
            amount = parseFloat(data.amount);
            currency = data.currency || 'USD';
        } else if (payload.status) {
            status = payload.status;
            txRef = payload.txRef || payload.tx_ref;
            planType = payload.meta?.plan || payload.plan;
            amount = parseFloat(payload.amount);
            currency = payload.currency || 'USD';
        }

        if (status !== 'successful') {
            return res.status(200).send('Payment not successful');
        }

        if (!txRef || typeof txRef !== 'string' || txRef.trim() === '') {
            return res.status(400).send('Missing transaction reference');
        }

        // Sanitize txRef — only allow safe characters
        const safeTxRef = String(txRef).replace(/[^a-zA-Z0-9_-]/g, '');
        if (!safeTxRef || safeTxRef.length < 5) {
            return res.status(400).send('Invalid transaction reference');
        }

        // Idempotency check
        const alreadyProcessed = await isAlreadyProcessed(safeTxRef);
        if (alreadyProcessed) {
            return res.status(200).json({ success: true, alreadyProcessed: true });
        }

        // Server-side verification
        const verifiedData = await verifyWithFlutterwave(safeTxRef);
        if (!verifiedData) {
            return res.status(400).send('Transaction verification failed');
        }

        const verifiedStatus = verifiedData.status;
        const verifiedAmount = parseFloat(verifiedData.amount);
        const verifiedCurrency = verifiedData.currency || 'USD';

        if (verifiedStatus !== 'successful') {
            return res.status(400).send('Transaction not successful per verification');
        }

        // Determine plan type
        if (!planType || typeof planType !== 'string') {
            if (safeTxRef.includes('_go')) {
                planType = 'go';
            } else if (safeTxRef.includes('_pro')) {
                planType = 'pro';
            } else {
                planType = 'go';
            }
        }

        if (!['go', 'pro'].includes(planType)) {
            return res.status(400).send('Invalid plan type');
        }

        if (!ALLOWED_CURRENCIES.includes(String(verifiedCurrency).toUpperCase())) {
            return res.status(400).send('Unsupported currency');
        }

        // ─── FIND USER ───
        // ✅ FIX #21: All DB queries use explicitly String()-typed variables.
        // safeTxRef is already sanitized above. potentialUserId is validated with isValidObjectId.
        let user = null;

        try {
            // Query 1: Find by lastTxRef
            user = await User.findOne({ lastTxRef: safeTxRef });

            if (!user) {
                // Query 2: Extract userId from txRef and validate before querying
                const txRefParts = safeTxRef.split('_');
                const potentialUserId = txRefParts[0];

                if (potentialUserId && isValidObjectId(potentialUserId)) {
                    const safePotentialId = String(potentialUserId);
                    user = await User.findById(safePotentialId);
                }
            }

            if (!user) {
                // ✅ FIX #22: Query 3 uses safeTxRef (sanitized string, not raw user input)
                user = await User.findOne({ 'paymentHistory.txRef': safeTxRef });
            }
        } catch (dbErr) {
            console.error('❌ [FLUTTERWAVE] Database error:', dbErr.message);
            return res.status(500).send('Database error');
        }

        if (!user) {
            await markAsProcessed(safeTxRef, { status: 'failed_user_not_found' });
            return res.status(404).send('User not found');
        }

        // ✅ FIX #23: Cast user._id to String IMMEDIATELY — before ANY update query.
        const safeUserId = String(user._id);

        console.log(`👤 [FLUTTERWAVE] Found user ID: ${safeUserId}`);

        // Verify amount
        const expectedAmount = PRICING[planType] || 9;

        if (isNaN(verifiedAmount) || verifiedAmount <= 0) {
            return res.status(400).send('Invalid payment amount');
        }

        if (verifiedAmount < expectedAmount) {
            console.error(`❌ [FLUTTERWAVE] FRAUD: amount mismatch for user ${safeUserId}`);

            try {
                const Report = require('./Report');
                await Report.create({
                    userId: safeUserId,
                    subject: `FRAUD ALERT: Payment mismatch - ${planType}`,
                    message: `Expected: ${expectedAmount}, Actual: ${verifiedAmount}, TxRef: ${safeTxRef}`,
                    type: 'fraud'
                });
            } catch (reportErr) {
                console.warn('⚠️ [FLUTTERWAVE] Failed to create fraud report:', reportErr.message);
            }

            await markAsProcessed(safeTxRef, {
                userId: safeUserId,
                status: 'failed_amount_mismatch'
            });

            return res.status(400).json({
                success: false,
                message: `Payment amount mismatch. Expected: ${expectedAmount}, Received: ${verifiedAmount}`
            });
        }

        if (verifiedAmount > expectedAmount) {
            console.warn(`⚠️ [FLUTTERWAVE] Overpayment for user ${safeUserId}`);
        }

        // Upgrade user
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + 30);

        try {
            let bonusDays = 0;
            if (verifiedAmount > expectedAmount * 2) {
                bonusDays = 30;
                endDate.setDate(endDate.getDate() + 30);
            }

            const updateData = {
                subscriptionTier: String(planType),
                subscriptionEndDate: endDate,
                lastTxRef: null
            };

            if (!user.paymentHistory) {
                user.paymentHistory = [];
            }

            user.paymentHistory.push({
                amount: Number(verifiedAmount),
                currency: String(verifiedCurrency).toUpperCase(),
                plan: String(planType),
                txRef: safeTxRef,
                status: String(verifiedStatus),
                date: new Date(),
                bonusDays: Number(bonusDays)
            });

            updateData.paymentHistory = user.paymentHistory;

            // ✅ FIX #23: findByIdAndUpdate uses safeUserId (explicitly String-typed above)
            await User.findByIdAndUpdate(safeUserId, updateData);

            await markAsProcessed(safeTxRef, {
                userId: safeUserId,
                status: 'success',
                plan: planType,
                amount: verifiedAmount
            });

            console.log(`✅ [FLUTTERWAVE] User ${safeUserId} upgraded to ${planType.toUpperCase()}`);

            // Send confirmation email
            try {
                const { sendEmail } = require('./nylasService');
                const emailBody = `Your Skyline AA-1 subscription has been upgraded to ${planType.toUpperCase()}.\n\nExpires: ${endDate.toLocaleDateString()}\nReference: ${safeTxRef}\nAmount: ${verifiedCurrency} ${verifiedAmount}\n\nThank you!`;

                await sendEmail({
                    to: user.email,
                    subject: `Subscription Upgraded - ${planType.toUpperCase()}`,
                    body: emailBody,
                    userId: safeUserId
                });
            } catch (emailErr) {
                console.warn('⚠️ [FLUTTERWAVE] Failed to send email:', emailErr.message);
            }

            return res.status(200).json({
                success: true,
                message: `User upgraded to ${planType}`,
                tier: planType,
                processed: true
            });

        } catch (updateErr) {
            console.error('❌ [FLUTTERWAVE] Update error:', updateErr.message);
            return res.status(500).send('Failed to update user');
        }

    } catch (error) {
        console.error('❌ [FLUTTERWAVE] Fatal error:', error.message);
        return res.status(500).send('Server error');
    }
};
