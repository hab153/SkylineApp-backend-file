// flutterwaveWebhook.js
const User = require('./User');

// ─── PRICING CONFIG ───
const PRICING = {
    go: 9,    // $9 USD per month
    pro: 20   // $20 USD per month
};

// ─── IDEMPOTENCY CACHE ───
const processedTransactions = new Map();
const TRANSACTION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── HELPER: Clean up expired transaction records ───
function cleanupProcessedTransactions() {
    const now = Date.now();
    for (const [key, value] of processedTransactions.entries()) {
        if (now - value.timestamp > TRANSACTION_TTL) {
            processedTransactions.delete(key);
        }
    }
}

setInterval(cleanupProcessedTransactions, 60 * 60 * 1000);

/**
 * ✅ FIXED: Handle Flutterwave webhook with amount verification
 */
module.exports = async (req, res) => {
    console.log('🔔 [FLUTTERWAVE WEBHOOK] Received webhook notification');
    
    try {
        // ─── ✅ CRITICAL: Get and validate secret hash ───
        const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
        
        if (!secretHash || secretHash.trim() === '') {
            console.error('❌ [FLUTTERWAVE WEBHOOK] FATAL: FLUTTERWAVE_SECRET_HASH is not configured');
            return res.status(500).send('Webhook not configured. Please contact support.');
        }

        // ─── ✅ VERIFY SIGNATURE ───
        const signature = req.headers['verif-hash'];
        
        if (!signature) {
            console.error('❌ [FLUTTERWAVE WEBHOOK] Missing verif-hash header');
            return res.status(401).send('Unauthorized: Missing signature');
        }

        if (signature !== secretHash) {
            console.error(`❌ [FLUTTERWAVE WEBHOOK] Invalid signature`);
            return res.status(401).send('Unauthorized: Invalid signature');
        }

        console.log('✅ [FLUTTERWAVE WEBHOOK] Signature verified successfully');

        // ─── ✅ PARSE PAYLOAD ───
        let payload;
        try {
            const rawBody = req.body ? req.body.toString('utf-8') : '';
            payload = JSON.parse(rawBody);
        } catch (e) {
            console.error('❌ [FLUTTERWAVE WEBHOOK] Invalid JSON payload:', e.message);
            return res.status(400).send('Invalid JSON');
        }

        console.log('📦 [FLUTTERWAVE WEBHOOK] Event:', payload.event);

        // ─── ✅ EXTRACT PAYMENT DATA ───
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

        // ─── ✅ VERIFY PAYMENT STATUS ───
        if (status !== 'successful') {
            console.log(`⏭️ [FLUTTERWAVE WEBHOOK] Payment not successful: ${status}`);
            return res.status(200).send('Payment not successful');
        }

        if (!txRef) {
            console.error('❌ [FLUTTERWAVE WEBHOOK] Missing txRef');
            return res.status(400).send('Missing transaction reference');
        }

        // ─── ✅ IDEMPOTENCY CHECK ───
        const cacheKey = txRef;
        const cached = processedTransactions.get(cacheKey);
        
        if (cached) {
            console.log(`⏭️ [FLUTTERWAVE WEBHOOK] Transaction ${txRef} already processed at ${new Date(cached.timestamp).toISOString()}`);
            return res.status(200).json({
                success: true,
                alreadyProcessed: true,
                message: 'Transaction already processed',
                processedAt: cached.timestamp,
                userId: cached.userId
            });
        }

        console.log(`🔍 [FLUTTERWAVE WEBHOOK] Processing new transaction: ${txRef}`);

        // ─── ✅ DETERMINE PLAN TYPE ───
        if (!planType) {
            if (txRef.includes('_go_') || txRef.includes('_go')) {
                planType = 'go';
            } else if (txRef.includes('_pro_') || txRef.includes('_pro')) {
                planType = 'pro';
            } else {
                console.warn(`⚠️ [FLUTTERWAVE WEBHOOK] Could not determine plan from txRef: ${txRef}, defaulting to 'go'`);
                planType = 'go';
            }
        }

        // ─── ✅ FIND USER ───
        let user;
        try {
            user = await User.findOne({ lastTxRef: txRef });
            
            if (!user) {
                const txRefParts = txRef.split('_');
                const userId = txRefParts[0];
                if (userId && userId.length === 24) {
                    user = await User.findById(userId);
                }
            }
            
            if (!user) {
                user = await User.findOne({ 'paymentHistory.txRef': txRef });
            }
        } catch (dbErr) {
            console.error('❌ [FLUTTERWAVE WEBHOOK] Database error:', dbErr.message);
            return res.status(500).send('Database error');
        }

        if (!user) {
            console.error(`❌ [FLUTTERWAVE WEBHOOK] User not found for txRef: ${txRef}`);
            processedTransactions.set(cacheKey, {
                timestamp: Date.now(),
                userId: 'unknown',
                status: 'failed_user_not_found'
            });
            return res.status(404).send('User not found');
        }

        console.log(`👤 [FLUTTERWAVE WEBHOOK] Found user: ${user.email} (${user._id})`);

        // ─── ✅ CRITICAL: VERIFY PAYMENT AMOUNT ───
        const expectedAmount = PRICING[planType] || 9;
        
        if (isNaN(amount) || amount <= 0) {
            console.error(`❌ [FLUTTERWAVE WEBHOOK] Invalid amount: ${amount}`);
            return res.status(400).send('Invalid payment amount');
        }

        // ✅ Check if amount matches expected price
        if (amount < expectedAmount) {
            console.error(`❌ [FLUTTERWAVE WEBHOOK] ⚠️ FRAUD DETECTED: Payment amount mismatch for user ${user.email}`);
            console.error(`❌ [FLUTTERWAVE WEBHOOK] Expected: ${expectedAmount}, Actual: ${amount}, Plan: ${planType}`);
            
            // ✅ Log fraud attempt for monitoring
            try {
                const Report = require('./Report');
                await Report.create({
                    userId: user._id,
                    subject: `FRAUD ALERT: Payment amount mismatch - ${planType}`,
                    message: `Fraudulent payment detected for user ${user.email} (${user._id}).\nExpected: ${expectedAmount}\nActual: ${amount}\nPlan: ${planType}\nTxRef: ${txRef}`,
                    type: 'fraud'
                });
                console.log(`📊 [FLUTTERWAVE WEBHOOK] Fraud report created for user ${user.email}`);
            } catch (reportErr) {
                console.warn('⚠️ [FLUTTERWAVE WEBHOOK] Failed to create fraud report:', reportErr.message);
            }

            // ✅ Still store to prevent retry spam
            processedTransactions.set(cacheKey, {
                timestamp: Date.now(),
                userId: user._id.toString(),
                status: 'failed_amount_mismatch'
            });

            return res.status(400).json({
                success: false,
                message: `Payment amount mismatch. Expected: ${expectedAmount}, Received: ${amount}`,
                expected: expectedAmount,
                received: amount
            });
        }

        // ✅ If amount is more than expected (overpayment), still upgrade but log it
        if (amount > expectedAmount) {
            console.warn(`⚠️ [FLUTTERWAVE WEBHOOK] Overpayment detected for user ${user.email}: Expected ${expectedAmount}, Received ${amount}`);
        }

        console.log(`✅ [FLUTTERWAVE WEBHOOK] Amount verified: ${currency} ${amount} (expected: ${expectedAmount})`);

        // ─── ✅ UPGRADE USER ───
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + 30);

        try {
            // ✅ If overpayment, maybe give bonus days?
            let bonusDays = 0;
            if (amount > expectedAmount * 2) {
                bonusDays = 30; // Double payment = double subscription time
                endDate.setDate(endDate.getDate() + 30);
                console.log(`🎁 [FLUTTERWAVE WEBHOOK] Overpayment bonus: +30 days for user ${user.email}`);
            }

            const updateData = {
                subscriptionTier: planType,
                subscriptionEndDate: endDate,
                lastTxRef: null
            };

            if (!user.paymentHistory) {
                user.paymentHistory = [];
            }
            user.paymentHistory.push({
                amount: amount,
                currency: currency || 'USD',
                plan: planType,
                txRef: txRef,
                status: status,
                date: new Date(),
                paymentData: payload.data || payload,
                bonusDays: bonusDays
            });
            updateData.paymentHistory = user.paymentHistory;

            await User.findByIdAndUpdate(user._id, updateData);
            
            processedTransactions.set(cacheKey, {
                timestamp: Date.now(),
                userId: user._id.toString(),
                plan: planType,
                amount: amount,
                status: 'success'
            });
            
            console.log(`✅ [FLUTTERWAVE WEBHOOK] User ${user.email} upgraded to ${planType.toUpperCase()} (30 days)`);
            if (bonusDays > 0) {
                console.log(`🎁 [FLUTTERWAVE WEBHOOK] Bonus days applied: +${bonusDays} days`);
            }
            console.log(`📊 [FLUTTERWAVE WEBHOOK] Payment: ${currency} ${amount}`);

            // ─── ✅ SEND CONFIRMATION ───
            try {
                const { sendEmail } = require('./nylasService');
                let emailBody = `Your Skyline AA-1 subscription has been upgraded to the ${planType.toUpperCase()} plan.\n\nPlan details:\n- Tier: ${planType.toUpperCase()}\n- Expires: ${endDate.toLocaleDateString()}\n- Payment reference: ${txRef}\n- Amount: ${currency} ${amount}`;
                
                if (bonusDays > 0) {
                    emailBody += `\n\n🎁 Bonus: ${bonusDays} extra days added due to overpayment.`;
                }
                
                emailBody += `\n\nThank you for your subscription!\n\nThe Skyline Team`;

                await sendEmail({
                    to: user.email,
                    subject: `Subscription Upgrade Confirmed - ${planType.toUpperCase()} Plan`,
                    body: emailBody,
                    userId: user._id
                });
                console.log(`📧 [FLUTTERWAVE WEBHOOK] Confirmation email sent to ${user.email}`);
            } catch (emailErr) {
                console.warn(`⚠️ [FLUTTERWAVE WEBHOOK] Failed to send confirmation email:`, emailErr.message);
            }

            return res.status(200).json({ 
                success: true, 
                message: `User upgraded to ${planType}`,
                userId: user._id,
                tier: planType,
                expires: endDate,
                amount: amount,
                expected: expectedAmount,
                processed: true,
                bonusDays: bonusDays
            });

        } catch (updateErr) {
            console.error('❌ [FLUTTERWAVE WEBHOOK] Failed to update user:', updateErr.message);
            return res.status(500).send('Failed to update user');
        }

    } catch (error) {
        console.error('❌ [FLUTTERWAVE WEBHOOK] Fatal error:', error.message);
        console.error('❌ [FLUTTERWAVE WEBHOOK] Stack:', error.stack);
        return res.status(500).send('Server error processing webhook');
    }
};
