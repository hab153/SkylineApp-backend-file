const nylas = require('./nylasClient');
const EmailAccount = require('./EmailAccount');

exports.sendEmail = async (userId, to, subject, body) => {
  try {
    // ✅ Verify email account is connected
    const account = await EmailAccount.findOne({ userId, isConnected: true });
    if (!account) {
      console.error('❌ [Nylas Send] No connected email account for user:', userId);
      return { success: false, error: 'No connected email account found.' };
    }

    if (!account.nylasGrantId) {
      console.error('❌ [Nylas Send] Missing grant ID for user:', userId);
      return { success: false, error: 'Grant ID not found.' };
    }

    console.log('📧 [Nylas Send] Sending email to:', to);
    console.log('📧 [Nylas Send] Using grant ID:', account.nylasGrantId);

    const message = {
      to: [{ email: to }],
      subject: subject,
      body: body,
    };

    // ✅ Send using v8 SDK with proper identifier
    const sentMessage = await nylas.messages.send({
      identifier: account.nylasGrantId,
      requestBody: message,
    });

    console.log('✅ [Nylas Send] Email sent successfully. Message ID:', sentMessage.id);
    return { success: true, messageId: sentMessage.id };
  } catch (error) {
    console.error('❌ [Nylas Send] Error:', error.message);
    console.error('❌ [Nylas Send] Full error:', error);
    return { success: false, error: error.message };
  }
};

exports.getThreads = async (userId, limit = 10) => {
  try {
    const account = await EmailAccount.findOne({ userId, isConnected: true });
    if (!account) {
      console.error('❌ [Nylas Threads] No connected email account for user:', userId);
      return [];
    }

    console.log('📬 [Nylas Threads] Fetching threads for grant:', account.nylasGrantId);

    const threads = await nylas.threads.list({
      identifier: account.nylasGrantId,
      queryParams: { limit: limit },
    });

    console.log('✅ [Nylas Threads] Fetched', threads.length, 'threads');
    return threads;
  } catch (error) {
    console.error('❌ [Nylas Threads] Error:', error.message);
    return [];
  }
};
