const axios = require('axios');
const User = require('./User');

const createFlutterwavePayment = async (req, res) => {
    console.log('💳 [PAYMENT] Request received for plan:', req.body.planType);
    
    try {
        const { planType } = req.body;
        const user = await User.findById(req.userId);
        
        if (!user) {
            console.error('❌ [PAYMENT] User not found for ID:', req.userId);
            return res.status(404).json({ message: 'User not found' });
        }

        console.log('👤 [PAYMENT] User identified:', user.email);

        let amount = 0;
        let planName = '';

        if (planType === 'go') {
            amount = 39;      // Updated from 49 to 39
            planName = 'GO Plan';
        } else if (planType === 'pro') {
            amount = 89;      // Updated from 129 to 89
            planName = 'PRO Plan';
        } else {
            console.error('❌ [PAYMENT] Invalid plan type:', planType);
            return res.status(400).json({ message: 'Invalid plan type' });
        }

        const txRef = `skyline_${planType}_${user._id}_${Date.now()}`;
        console.log('🔖 [PAYMENT] Transaction Reference:', txRef);

        user.lastTxRef = txRef;
        await user.save();
        console.log('💾 [PAYMENT] TxRef saved to User document');

        if (!process.env.FLUTTERWAVE_SECRET_KEY) {
            console.error('❌ [PAYMENT] FLUTTERWAVE_SECRET_KEY is MISSING in Environment Variables');
            return res.status(500).json({ message: 'Server configuration error: Missing Payment Key' });
        }
        console.log('🔑 [PAYMENT] Secret Key found (starts with):', process.env.FLUTTERWAVE_SECRET_KEY.substring(0, 10) + '...');

        const payload = {
            tx_ref: txRef,
            amount: amount,
            currency: "USD",
            redirect_url: "https://skylineai-app.vercel.app/dashboard.html?payment=success",
            meta: {
                plan: planType,
                userId: user._id.toString()
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

        console.log('🚀 [PAYMENT] Sending request to Flutterwave API...');

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
            console.log('✅ [PAYMENT] Link Generated:', response.data.data.link);
            res.json({ 
                link: response.data.data.link,
                txRef: txRef
            });
        } else {
            console.error('❌ [PAYMENT] Flutterwave API Error:', response.data);
            throw new Error(response.data.message || 'Failed to create payment link');
        }

    } catch (err) {
        console.error('❌ [PAYMENT] Critical Error:', err.response?.data || err.message);
        res.status(500).json({ 
            message: 'Could not initiate payment', 
            error: err.response?.data?.message || err.message 
        });
    }
};

module.exports = { createFlutterwavePayment };
