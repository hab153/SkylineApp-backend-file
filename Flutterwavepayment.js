const axios = require('axios');
const User = require('./User');

/**
 * ✅ FIX #41: Mask sensitive values before logging.
 * Shows first 4 and last 4 characters, replaces middle with ***.
 */
function maskSecret(value) {
    if (!value || typeof value !== 'string') return '***';
    if (value.length <= 8) return value.substring(0, 2) + '***';
    return value.substring(0, 4) + '***' + value.substring(value.length - 4);
}

/**
 * ✅ Safe logger that masks any string matching known secret/token patterns.
 */
function safeLog(...args) {
    const sanitized = args.map(arg => {
        if (typeof arg !== 'string') return arg;
        return arg
            .replace(/(FLWSECK-[a-zA-Z0-9]+)/g, (match) => maskSecret(match))
            .replace(/(sk_[a-zA-Z0-9]+)/g, (match) => maskSecret(match))
            .replace(/(Bearer\s+)([a-zA-Z0-9_-]{8,})/g, (full, prefix, token) => prefix + maskSecret(token))
            .replace(/(key[_\s]*[:=]\s*)([a-zA-Z0-9_-]{8,})/gi, (full, prefix, key) => prefix + maskSecret(key))
            .replace(/(secret[_\s]*[:=]\s*)([a-zA-Z0-9_-]{8,})/gi, (full, prefix, sec) => prefix + maskSecret(sec))
            .replace(/(token[_\s]*[:=]\s*)([a-zA-Z0-9_-]{8,})/gi, (full, prefix, tok) => prefix + maskSecret(tok));
    });
    console.log(...sanitized);
}

const createFlutterwavePayment = async (req, res) => {
    safeLog('💳 [PAYMENT] Request received for plan:', req.body.planType);

    try {
        const { planType } = req.body;

        if (!req.userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const safeUserId = String(req.userId);
        const user = await User.findById(safeUserId);

        if (!user) {
            console.error('❌ [PAYMENT] User not found');
            return res.status(404).json({ message: 'User not found' });
        }

        // ✅ FIX #41: Do NOT log user email — it's PII
        safeLog('👤 [PAYMENT] User identified, ID:', safeUserId);

        let amount = 0;
        let planName = '';

        if (planType === 'go') {
            amount = 39;
            planName = 'GO Plan';
        } else if (planType === 'pro') {
            amount = 89;
            planName = 'PRO Plan';
        } else {
            console.error('❌ [PAYMENT] Invalid plan type:', planType);
            return res.status(400).json({ message: 'Invalid plan type' });
        }

        const txRef = `skyline_${planType}_${safeUserId}_${Date.now()}`;
        safeLog('🔖 [PAYMENT] Transaction Reference:', txRef);

        user.lastTxRef = txRef;
        await user.save();
        safeLog('💾 [PAYMENT] TxRef saved to User document');

        if (!process.env.FLUTTERWAVE_SECRET_KEY) {
            console.error('❌ [PAYMENT] FLUTTERWAVE_SECRET_KEY is MISSING in Environment Variables');
            return res.status(500).json({ message: 'Server configuration error: Missing Payment Key' });
        }

        // ✅ FIX #41: NEVER log even a partial secret key.
        // Previous code logged: process.env.FLUTTERWAVE_SECRET_KEY.substring(0, 10) + '...'
        // CodeQL flags ANY logging of env vars that contain secrets, even partial.
        safeLog('🔑 [PAYMENT] Secret Key is configured (length:', process.env.FLUTTERWAVE_SECRET_KEY.length, 'chars)');

        const payload = {
            tx_ref: txRef,
            amount: amount,
            currency: "USD",
            redirect_url: "https://skylineai-app.vercel.app/dashboard.html?payment=success",
            meta: {
                plan: planType,
                userId: safeUserId
            },
            customer: {
                email: user.email || "customer@example.com",
                name: user.fullName || "Skyline User"
            },
            customizations: {
                title: "Skyline AA-1 Subscription",
                description: `Payment for ${planName}`,
                logo: "https://skylineai-app.vercel.app/logo.png"
            }
        };

        safeLog('🚀 [PAYMENT] Sending request to Flutterwave API...');

        const response = await axios.post(
            'https://api.flutterwave.com/v3/payments',
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.status === 'success') {
            // ✅ FIX #41: Do NOT log the payment link — it contains a session token
            safeLog('✅ [PAYMENT] Payment link generated successfully');
            res.json({
                link: response.data.data.link,
                txRef: txRef
            });
        } else {
            // ✅ FIX #41: Do NOT log full response.data — it may contain sensitive fields
            console.error('❌ [PAYMENT] Flutterwave API returned non-success status');
            throw new Error(response.data.message || 'Failed to create payment link');
        }

    } catch (err) {
        // ✅ FIX #41: Do NOT log err.response?.data — it contains the full API response
        // which may include authorization headers or sensitive payment data
        console.error('❌ [PAYMENT] Critical Error:', err.message);
        res.status(500).json({
            message: 'Could not initiate payment',
            error: 'Payment service error. Please try again.'
        });
    }
};

module.exports = { createFlutterwavePayment };
