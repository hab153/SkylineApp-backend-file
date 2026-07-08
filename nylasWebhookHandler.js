const crypto = require('crypto');
const Lead = require('./Lead');

exports.handleWebhook = async (req, res) => {
  const signature = req.headers['x-nylas-signature'];
  const webhookSecret = process.env.NYLAS_WEBHOOK_SECRET;

  // Verify the webhook signature for security
  const hmac = crypto.createHmac('sha256', webhookSecret);
  const digest = hmac.update(JSON.stringify(req.body)).digest('hex');

  if (signature !== digest) {
    return res.status(401).json({ message: 'Invalid webhook signature.' });
  }

  const eventData = req.body;
  
  // Handle different event types
  if (eventData.type === 'message.created' || eventData.type === 'thread.replied') {
    // Logic to find the lead by email and update the conversation
    // This is a placeholder for the complex matching logic we will refine later
    console.log('New email received from Nylas:', eventData.data);
  }

  res.status(200).send('Webhook received');
};
