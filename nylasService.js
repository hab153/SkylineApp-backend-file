// nylasService.js
const { Nylas } = require("nylas");

const nylas = new Nylas({
    apiKey: process.env.NYLAS_API_KEY,
    apiUri: "https://api.us.nylas.com",
});

function getAuthUrl(userId) {
    return nylas.auth.urlForOAuth2({
        clientId: process.env.NYLAS_CLIENT_ID,
        redirectUri: "https://skylineai-app.vercel.app/api/auth/nylas/callback",
        loginHint: userId,
        scopes: [
            "email.send",
            "email.read_only"
        ]
    });
}

async function sendEmail(grantId, to, subject, body) {
    try {
        await nylas.messages.send({
            identifier: grantId,
            requestBody: {
                to: [{ email: to }],
                subject: subject,
                body: body,
            },
        });

        return { success: true };

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

module.exports = {
    getAuthUrl,
    sendEmail
};
