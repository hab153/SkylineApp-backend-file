// paymentController.js
const axios = require('axios');
const User = require('./User'); // Assuming User model is in the same directory

// Initialize Flutterwave keys from .env
const FLW_SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY;
const FLW_BASE_URL = process.env.FLUTTERWAVE_BASE_URL || 'https://api.flutterwave.com/v3';

// 1. Initialize Payment Transaction
exports.initializePayment = async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        // Define payment details
        // For testing, we charge $10 (1000 cents if using USD, or equivalent NGN/KES)
        // Flutterwave accepts amount as a string or number. 
        // Note: If using NGN, 10 USD is approx 15,000 NGN. Adjust as needed.
        const amount = 1000; // Example: $10.00 (Flutterwave handles currency conversion if set to USD)
        const currency = 'USD'; 
        const email = user.email;
        const name = user.fullName || user.username;
        const txRef = `skyline_pro_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        const payload = {
            tx_ref: txRef,
            amount: amount,
            currency: currency,
            redirect_url: `${process.env.CLIENT_URL}/payment-success`, // Where user goes after payment
            customer: {
                email: email,
                phonenumber: user.phone || '08012345678', // Add phone field to User model if needed
                name: name,
            },
            customizations: {
                title: 'Skyline AA-1 Pro Plan',
                description: 'Monthly Subscription for Unlimited Access',
                logo: 'https://your-logo-url.com/logo.png', // Optional
            },
            meta: {
                userId: user._id.toString(), // Store userId to identify who paid
                plan: 'pro_monthly'
            }
        };

        // Call Flutterwave API
        const response = await axios.post(`${FLW_BASE_URL}/payments`, payload, {
            headers: {
                Authorization: `Bearer ${FLW_SECRET_KEY}`,
                'Content-Type': 'application/json',            },
        });

        if (response.data.status === 'success') {
            res.json({ link: response.data.data.link });
        } else {
            res.status(400).json({ message: 'Failed to initialize payment', error: response.data });
        }

    } catch (error) {
        console.error('Flutterwave Initialization Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Server Error initializing payment' });
    }
};

// 2. Verify Payment (Webhook or Redirect Verification)
// Note: For robust security, use Webhooks. For simplicity in testing, we can verify via redirect.
exports.verifyPayment = async (req, res) => {
    try {
        const { tx_ref, status, transaction_id } = req.query;

        if (status !== 'successful') {
            return res.redirect(`${process.env.CLIENT_URL}/dashboard?payment=failed`);
        }

        // Verify with Flutterwave API to ensure it's genuine
        const response = await axios.get(`${FLW_BASE_URL}/transactions/${transaction_id}/verify`, {
            headers: {
                Authorization: `Bearer ${FLW_SECRET_KEY}`,
            },
        });

        if (response.data.status === 'success' && response.data.data.status === 'successful') {
            const userId = response.data.data.meta.userId; // Retrieve userId from meta

            // Update User to Pro Plan
            await User.findByIdAndUpdate(userId, {
                subscriptionTier: 'pro',
                subscriptionEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
            });

            // Redirect to Dashboard with success message
            res.redirect(`${process.env.CLIENT_URL}/dashboard?payment=success`);
        } else {
            res.redirect(`${process.env.CLIENT_URL}/dashboard?payment=failed`);
        }

    } catch (error) {
        console.error('Payment Verification Error:', error);
        res.redirect(`${process.env.CLIENT_URL}/dashboard?payment=error`);    }
};
