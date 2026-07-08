const crypto = require('crypto');
const Lead = require('./Lead');
const EmailAccount = require('./EmailAccount');

exports.handleWebhook = async (req, res) => {
  const signature = req.headers['x-nylas-signature'];
  const webhookSecret = process.env.NYLAS_WEBHOOK_SECRET;

  // 1. Handle Nylas Challenge (Verification Step)
  // Nylas sends a 'challenge' string during setup. We must return it exactly.
  if (req.body && req.body.challenge) {
    console.log('🔔 [Nylas Webhook] Received challenge, responding...');
    return res.status(200).send(req.body.challenge);
  }

  // 2. Verify the webhook signature for security
  // Only verify signature if it's not a challenge request
  if (signature && webhookSecret) {
    const hmac = crypto.createHmac('sha256', webhookSecret);
    // Note: req.body is already parsed as an object by express.raw/json depending on setup
    // For signature verification with express.raw, we usually need the raw buffer.
    // However, since we are using express.raw({type: 'application/json'}), req.body is a Buffer.
    // Let's handle both cases safely.
    let bodyContent;
    if (Buffer.isBuffer(req.body)) {
      bodyContent = req.body;
    } else {
      bodyContent = JSON.stringify(req.body);
    }
    
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
    
    // TODO: Add logic here to find the lead by email and update the conversation
  }

  // Always return 200 OK to acknowledge receipt
  res.status(200).send('Webhook received');
};
