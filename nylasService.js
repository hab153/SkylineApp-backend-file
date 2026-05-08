// nylasService.js
const Nylas = require('nylas');

Nylas.config({
    clientId: process.env.NYLAS_CLIENT_ID,
    clientSecret: process.env.NYLAS_CLIENT_SECRET,
});

function getAuthUrl(userId) {
    return Nylas.urlForAuthentication({
        redirectUri: 'https://skylineai-app.vercel.app/api/auth/nylas/callback',
        loginHint: userId,
        scopes: ['email.send', 'email.read_only']
    });
}

async function sendEmail(accessToken, to, subject, body) {
    const nylas = Nylas.with(accessToken);
    try {
        const draft = nylas.drafts.build({
            subject: subject,
            to: [{ email: to }],
            body: body,
        });
        await draft.send();
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

module.exports = { getAuthUrl, sendEmail };
