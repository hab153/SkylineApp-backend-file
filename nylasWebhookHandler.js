const crypto = require('crypto');

exports.handleWebhook = async (req, res) => {
  const webhookSecret = process.env.NYLAS_WEBHOOK_SECRET;

  // 1. Handle Nylas Challenge (Verification Step - GET Request)
  if (req.method === 'GET' && req.query.challenge) {
    console.log('🔔 [Nylas Webhook] Received GET challenge, responding...');
    return res.status(200).type('text/plain').send(req.query.challenge);
  }

  // 2. Handle Actual Webhook Events (POST Request)
  if (req.method === 'POST') {
    const signature = req.headers['x-nylas-signature'];
    
    // Verify the webhook signature for security
    if (signature && webhookSecret) {
      let bodyContent;
      if (Buffer.isBuffer(req.body)) {
        bodyContent = req.body;
      } else {
        bodyContent = JSON.stringify(req.body);
      }
      
      const hmac = crypto.createHmac('sha256', webhookSecret);
      const digest = hmac.update(bodyContent).digest('hex');

      if (signature !== digest) {
        console.error('❌ [Nylas Webhook] Invalid signature detected.');
        return res.status(401).json({ message: 'Invalid webhook signature.' });
      }
    }

    // If req.body is a Buffer (from express.raw), parse it now for logic
    let eventData = req.body;
    if (Buffer.isBuffer(eventData)) {
      try {
        eventData = JSON.parse(eventData.toString());
      } catch (e) {
        console.error('❌ [Nylas Webhook] Failed to parse JSON body');
        return res.status(400).send('Invalid JSON');
      }
    }
    
    // 3. Handle different event types
    if (eventData.type === 'message.created' || eventData.type === 'thread.replied') {
      console.log('📩 [Nylas Webhook] New email event received:', eventData.data?.object?.subject);
    }

    // Always return 200 OK to acknowledge receipt
    return res.status(200).send('Webhook received');
  }

  res.status(405).send('Method Not Allowed');
};
