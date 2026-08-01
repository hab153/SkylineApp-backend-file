// flutterwaveWebhook.js
const User = require('./User');

/**
 * ✅ FIXED: Handle Flutterwave webhook with proper signature validation
 */
module.exports = async (req, res) => {
    console.log('🔔 [FLUTTERWAVE WEBHOOK] Received webhook notification');
    
    try {
        // ─── ✅ CRITICAL: Get and validate secret hash ───
        const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
        
        // ✅ If secret hash is not configured, REJECT the webhook
        if (!secretHash || secretHash.trim() === '') {
            console.error('❌ [FLUTTERWAVE WEBHOOK] FATAL: FLUTTERWAVE_SECRET_HASH is not configured');
            console.error('⚠️ [FLUTTERWAVE WEBHOOK] Please set FLUTTERWAVE_SECRET_HASH in environment variables');
            return res.status(500).send('Webhook not configured. Please contact support.');
        }

        // ─── ✅ VERIFY SIGNATURE ───
        const signature = req.headers['verif-hash'];
        
        if (!signature) {
            console.error('❌ [FLUTTERWAVE WEBHOOK] Missing verif-hash header');
            return res.status(401).send('Unauthorized: Missing signature');
        }

        if (signature !== secretHash) {
            console.error(`❌ [FLUTTERWAVE WEBHOOK] Invalid signature. Expected: ${secretHash.substring(0, 10)}..., Received: ${signature.substring(0, 10)}...`);
            return res.status(401).send('Unauthorized: Invalid signature');
        }

        console.log('✅ [FLUTTERWAVE WEBHOOK] Signature verified successfully');

        // ─── ✅ PARSE PAYLOAD ───
        let payload;
        try {
            // Handle both Buffer and string
            const rawBody = req.body ? req.body.toString('utf-8') : '';
            payload = JSON.parse(rawBody);
        } catch (e) {
            console.error('❌ [FLUTTERWAVE WEBHOOK] Invalid JSON payload:', e.message);
            return res.status(400).send('Invalid JSON');
        }

        console.log('📦 [FLUTTERWAVE WEBHOOK] Event:', payload.event);

        // ─── ✅ EXTRACT PAYMENT DATA ───
        let txRef, status, planType, amount, currency;
        
        // Handle different webhook formats
        if (payload.event === 'charge.completed') {
            const data = payload.data || {};
            status = data.status;
            txRef = data.tx_ref || data.txRef;
            planType = data.meta?.plan || data.plan;
            amount = data.amount;
            currency = data.currency;
        } else if (payload.status) {
            // Legacy format
            status = payload.status;
            txRef = payload.txRef || payload.tx_ref;
            planType = payload.meta?.plan || payload.plan;
            amount = payload.amount;
            currency = payload.currency;
        }

        console.log(`📊 [FLUTTERWAVE WEBHOOK] Status: ${status}, TxRef: ${txRef}, Plan: ${planType}`);

        // ─── ✅ VERIFY PAYMENT STATUS ───
        if (status !== 'successful') {
            console.log(`⏭️ [FLUTTERWAVE WEBHOOK] Payment not successful: ${status}`);
            return res.status(200).send('Payment not successful');
        }

        // ─── ✅ VERIFY REQUIRED FIELDS ───
        if (!txRef) {
            console.error('❌ [FLUTTERWAVE WEBHOOK] Missing txRef in webhook');
            return res.status(400).send('Missing transaction reference');
        }

        // ─── ✅ DETERMINE PLAN TYPE ───
        if (!planType) {
            if (txRef.includes('_go_') || txRef.includes('_go')) {
                planType = 'go';
            } else if (txRef.includes('_pro_') || txRef.includes('_pro')) {
                planType = 'pro';
            } else {
                // Fallback: try to extract from meta or default to go
                console.warn(`⚠️ [FLUTTERWAVE WEBHOOK] Could not determine plan from txRef: ${txRef}, defaulting to 'go'`);
                planType = 'go';
            }
        }

        // ─── ✅ FIND USER ───
        let user;
        try {
            // Try multiple ways to find the user
            user = await User.findOne({ lastTxRef: txRef });
            
            // If not found by txRef, try extracting userId from txRef
            if (!user) {
                const txRefParts = txRef.split('_');
                const userId = txRefParts[0];
                if (userId && userId.length === 24) {
                    user = await User.findById(userId);
                }
            }
        } catch (dbErr) {
            console.error('❌ [FLUTTERWAVE WEBHOOK] Database error:', dbErr.message);
            return res.status(500).send('Database error');
        }

        if (!user) {
            console.error(`❌ [FLUTTERWAVE WEBHOOK] User not found for txRef: ${txRef}`);
            return res.status(404).send('User not found');
        }

        console.log(`👤 [FLUTTERWAVE WEBHOOK] Found user: ${user.email} (${user._id})`);

        // ─── ✅ VERIFY PAYMENT AMOUNT (Optional but recommended) ───
        if (amount) {
            const expectedAmount = planType === 'pro' ? 20 : 9;
            const actualAmount = parseFloat(amount);
            
            if (actualAmount !== expectedAmount) {
                console.warn(`⚠️ [FLUTTERWAVE WEBHOOK] Payment amount mismatch. Expected: ${expectedAmount}, Actual: ${actualAmount}`);
                // Don't reject, just warn - sometimes Flutterwave includes fees
            }
        }

        // ─── ✅ UPGRADE USER ───
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + 30); // 30 days from now

        try {
            const updateData = {
                subscriptionTier: planType,
                subscriptionEndDate: endDate,
                lastTxRef: null // Clear the reference after processing
            };

            // Save payment history if field exists
            if (user.paymentHistory !== undefined) {
                if (!user.paymentHistory) {
                    user.paymentHistory = [];
                }
                user.paymentHistory.push({
                    amount: amount || 0,
                    currency: currency || 'USD',
                    plan: planType,
                    txRef: txRef,
                    status: status,
                    date: new Date(),
                    paymentData: payload.data || payload
                });
                updateData.paymentHistory = user.paymentHistory;
            }

            await User.findByIdAndUpdate(user._id, updateData);
            
            console.log(`✅ [FLUTTERWAVE WEBHOOK] User ${user.email} upgraded to ${planType.toUpperCase()} (30 days)`);
            if (amount) {
                console.log(`📊 [FLUTTERWAVE WEBHOOK] Payment amount: ${currency || 'USD'} ${amount}`);
            }

            // ─── ✅ SEND CONFIRMATION (Optional) ───
            try {
                const { sendEmail } = require('./nylasService');
                await sendEmail({
                    to: user.email,
                    subject: `Subscription Upgrade Confirmed - ${planType.toUpperCase()} Plan`,
                    body: `Your Skyline AA-1 subscription has been upgraded to the ${planType.toUpperCase()} plan.\n\nPlan details:\n- Tier: ${planType.toUpperCase()}\n- Expires: ${endDate.toLocaleDateString()}\n- Payment reference: ${txRef}\n\nThank you for your subscription!\n\nThe Skyline Team`,
                    userId: user._id
                });
                console.log(`📧 [FLUTTERWAVE WEBHOOK] Confirmation email sent to ${user.email}`);
            } catch (emailErr) {
                console.warn(`⚠️ [FLUTTERWAVE WEBHOOK] Failed to send confirmation email:`, emailErr.message);
                // Don't fail the webhook if email fails
            }

            return res.status(200).json({ 
                success: true, 
                message: `User upgraded to ${planType}`,
                userId: user._id,
                tier: planType,
                expires: endDate
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
