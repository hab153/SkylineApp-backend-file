const crypto = require('crypto');
const Lead = require('./Lead');
const EmailAccount = require('./EmailAccount'); // Added for future use in matching replies

exports.handleWebhook = async (req, res) => {
  const signature = req.headers['x-nylas-signature'];
  const webhookSecret = process.env.NYLAS_WEBHOOK_SECRET;

  // 1. Handle Nylas Challenge (Verification Step)
  if (req.body.challenge) {
    console.log('🔔 [Nylas Webhook] Received challenge, responding...');
    return res.status(200).send(req.body.challenge);
  }

  // 2. Verify the webhook signature for security
  const hmac = crypto.createHmac('sha256', webhookSecret);
  const digest = hmac.update(JSON.stringify(req.body)).digest('hex');

  if (signature !== digest) {
    console.error('❌ [Nylas Webhook] Invalid signature detected.');
    return res.status(401).json({ message: 'Invalid webhook signature.' });
  }

  const eventData = req.body;
  
  // 3. Handle different event types
  if (eventData.type === 'message.created' || eventData.type === 'thread.replied') {
    console.log('📩 [Nylas Webhook] New email event received:', eventData.data?.object?.subject);
    
    // TODO: Add logic here to find the lead by email and update the conversation
    // This will be our next major step after we get the OAuth flow working.
  }

  // Always return 200 OK to acknowledge receipt
  res.status(200).send('Webhook received');
};
