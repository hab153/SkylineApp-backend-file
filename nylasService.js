const nylas = require('./nylasClient');
const EmailAccount = require('./models/EmailAccount');

exports.sendEmail = async (userId, to, subject, body) => {
  try {
    const account = await EmailAccount.findOne({ userId, isConnected: true });
    if (!account) throw new Error('No connected email account found.');

    const message = {
      to: [{ email: to }],
      subject: subject,
      body: body,
    };

    // Send using the v3 SDK
    const sentMessage = await nylas.messages.send({
      identifier: account.nylasGrantId,
      requestBody: message,
    });

    return { success: true, messageId: sentMessage.id };
  } catch (error) {
    console.error('Nylas Send Error:', error);
    return { success: false, error: error.message };
  }
};

exports.getThreads = async (userId, limit = 10) => {
  try {
    const account = await EmailAccount.findOne({ userId, isConnected: true });
    if (!account) throw new Error('No connected email account found.');

    const threads = await nylas.threads.list({
      identifier: account.nylasGrantId,
      queryParams: { limit: limit },
    });

    return threads;
  } catch (error) {
    console.error('Nylas Fetch Threads Error:', error);
    return [];
  }
};
