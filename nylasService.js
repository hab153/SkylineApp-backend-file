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

    // ✅ Check token expiry
    if (account.tokenExpiry && new Date(account.tokenExpiry) < new Date()) {
      console.error('❌ [Nylas Send] Token expired for user:', userId);
      return { success: false, error: 'Token expired. Please reconnect your email.' };
    }

    console.log('📧 [Nylas Send] Sending email to:', to);
    console.log('📧 [Nylas Send] Using grant ID:', account.nylasGrantId);
    console.log('📧 [Nylas Send] Subject:', subject);
    console.log('📧 [Nylas Send] Body length:', body?.length || 0);

    // ✅ CORRECT v8 SDK syntax - identifier as first argument, requestBody as second
    const message = {
      to: [{ email: to }],
      subject: subject,
      body: body,
    };

    // ✅ Send using v8 SDK - CORRECT syntax
    const sentMessage = await nylas.messages.send(
      account.nylasGrantId,  // identifier (grantId)
      message                // requestBody
    );

    console.log('✅ [Nylas Send] Email sent successfully. Message ID:', sentMessage?.id || 'unknown');
    return { success: true, messageId: sentMessage?.id };
    
  } catch (error) {
    console.error('❌ [Nylas Send] Error:', error.message);
    console.error('❌ [Nylas Send] Error details:', error.response?.data || error);
    return { success: false, error: error.message, details: error.response?.data };
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

    // ✅ CORRECT v8 SDK syntax
    const threads = await nylas.threads.list(
      account.nylasGrantId,  // identifier
      { limit: limit }       // queryParams
    );

    console.log('✅ [Nylas Threads] Fetched', threads?.length || 0, 'threads');
    return threads || [];
  } catch (error) {
    console.error('❌ [Nylas Threads] Error:', error.message);
    console.error('❌ [Nylas Threads] Error details:', error.response?.data || error);
    return [];
  }
};
