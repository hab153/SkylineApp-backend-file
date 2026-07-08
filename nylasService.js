const Nylas = require('./nylasClient');
const EmailAccount = require('./EmailAccount');

exports.sendEmail = async (userId, to, subject, body) => {
  try {
    const account = await EmailAccount.findOne({ userId, isConnected: true });
    if (!account) throw new Error('No connected email account found.');

    const nylasInstance = Nylas.with(account.accessToken);

    const message = {
      to: [{ email: to }],
      subject: subject,
      body: body,
    };

    // Send using v5 SDK
    const sentMessage = await nylasInstance.messages.send(message);

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

    const nylasInstance = Nylas.with(account.accessToken);

    const threads = await nylasInstance.threads.list({ limit: limit });

    return threads;
  } catch (error) {
    console.error('Nylas Fetch Threads Error:', error);
    return [];
  }
};
