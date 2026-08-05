const axios = require('axios');
const User = require('./User');

/**
 * ✅ FIX #71: maskSecret now returns ONLY '***' — never shows any characters.
 * CodeQL flags ANY partial reveal of a secret value, even first/last 4 chars.
 */
function maskSecret() {
    return '***';
}

/**
 * ✅ FIX #71: safeLog redacts entire strings that match secret patterns.
 * Does NOT attempt to partially mask — just replaces with [REDACTED].
 * This eliminates the data flow from secret → console.log that CodeQL detects.
 */
function safeLog(...args) {
    const sanitized = args.map(arg => {
        if (typeof arg !== 'string') return arg;
        // If string matches any secret pattern, replace entirely
        if (/FLWSECK|sk_|Bearer|api.key|secret|token|password/i.test(arg)) {
            return '[REDACTED]';
        }
        return arg;
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

        // ✅ FIX #71: Do NOT reference process.env.FLUTTERWAVE_SECRET_KEY at all in log.
        // Not even .length — CodeQL flags any access to a secret env var near console.log.
        safeLog('🔑 [PAYMENT] Secret Key is configured and validated');

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
            safeLog('✅ [PAYMENT] Payment link generated successfully');
            res.json({
                link: response.data.data.link,
                txRef: txRef
            });
        } else {
            console.error('❌ [PAYMENT] Flutterwave API returned non-success status');
            throw new Error(response.data.message || 'Failed to create payment link');
        }

    } catch (err) {
        console.error('❌ [PAYMENT] Critical Error:', err.message);
        res.status(500).json({
            message: 'Could not initiate payment',
            error: 'Payment service error. Please try again.'
        });
    }
};

module.exports = { createFlutterwavePayment };
