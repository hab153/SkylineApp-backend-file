const User = require('./User');

module.exports = async (req, res) => {
    console.log("🔥 Webhook hit!");
    const sig        = req.headers['verif-hash'];
    const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
    if (secretHash && sig !== secretHash) {
        console.log("⚠️ Hash mismatch");
        return res.status(401).send('Unauthorized');
    }
    let payload;
    try {
        payload = JSON.parse(req.body.toString('utf-8'));
    } catch (e) {
        return res.status(400).send('Invalid JSON');
    }
    try {
        let txRef, status, planType;
        if (payload.status) {
            status   = payload.status;
            txRef    = payload.txRef || payload.tx_ref;
            planType = payload.meta?.plan;
        } else if (payload.event === 'charge.completed') {
            status   = payload.data?.status;
            txRef    = payload.data?.tx_ref;
            planType = payload.data?.meta?.plan;
        }
        if (status === 'successful') {
            if (!txRef) return res.status(400).send('Missing txRef');
            if (!planType) {
                if (txRef.includes('_go_'))       planType = 'go';
                else if (txRef.includes('_pro_')) planType = 'pro';
                else                              planType = 'free';
            }
            const user = await User.findOne({ lastTxRef: txRef });
            if (user) {
                const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
                await User.findByIdAndUpdate(user._id, {
                    subscriptionTier:    planType,
                    subscriptionEndDate: endDate,
                    lastTxRef:           null
                });
                console.log(`🎉 User ${user._id} upgraded to ${planType.toUpperCase()}!`);
            } else {
                console.error(`❌ User not found for txRef: ${txRef}`);
            }
        }
        res.status(200).send('Webhook received');
    } catch (error) {
        console.error('❌ Webhook Error:', error);
        res.status(500).send('Webhook failed');
    }
};
