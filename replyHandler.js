// replyHandler.js
const Lead = require('./Lead');
const User = require('./User');

// Import all 3 AI Tiers
const freeAI = require('./Free');
const goAI = require('./Go');
const { generateBusinessResponse } = require('./businessAI');

/**
 * Processes an incoming reply from a lead using the user's specific AI tier.
 */
async function handleIncomingReply(userEmail, bodyText) {
    try {
        // 1. Find the Lead and the User who owns them
        const lead = await Lead.findOne({ email: userEmail });
        if (!lead) {
            console.log(`⚠️ Reply received from unknown lead: ${userEmail}`);
            return;
        }

        const user = await User.findById(lead.userId);
        if (!user) return;

        // 2. Save the reply to the Lead's history
        lead.replies.push({
            date: new Date(),
            content: bodyText,
            from: 'lead'
        });

        // 3. AI Sentiment Analysis (Routed by Plan)
        const prompt = `
        Analyze this email reply from a potential lead: "${bodyText}"
        
        Classify it into one of these categories:
        1. INTERESTED: They want to meet, buy, or learn more.
        2. NOT_INTERESTED: They said no, unsubscribe, or not now.
        3. QUESTION: They asked a specific question about the product/service.
        4. OUT_OF_OFFICE: An automated auto-reply.

        Return ONLY the category name.
        `;

        let aiResult;

        if (user.subscriptionTier === 'free') {
            // FREE: Fast, basic classification
            aiResult = await freeAI.generateFreeResponse(prompt, [], user);
        } else if (user.subscriptionTier === 'go') {
            // GO: More nuanced classification
            aiResult = await goAI.generateGoResponse(prompt, [], user);
        } else {
            // PRO: Strategic classification + Drafting a response
            const userProfile = {
                fullName: user.fullName,
                userId: user._id.toString()
            };
            aiResult = await generateBusinessResponse(prompt, [], userProfile);
        }

        const sentiment = aiResult.reply.trim().toUpperCase();
        console.log(`🧠 [${user.subscriptionTier.toUpperCase()}] AI Analysis for ${lead.name}: ${sentiment}`);

        // 4. Update Lead Status based on AI Decision
        if (sentiment.includes('INTERESTED')) {
            lead.status = 'Interested';
            lead.sentiment = 'Positive';
            // TODO: Trigger Push Notification to User here
        } else if (sentiment.includes('NOT_INTERESTED')) {
            lead.status = 'Not Interested';
            lead.sentiment = 'Negative';
        } else if (sentiment.includes('QUESTION')) {
            lead.status = 'Replied';
            lead.sentiment = 'Neutral';
            // For Pro users, you could also save a drafted response here
        } else if (sentiment.includes('OUT_OF_OFFICE')) {
            // Do nothing, just log it. The sequence should pause.
            console.log('📅 Auto-reply detected. Sequence paused.');
        }

        await lead.save();

    } catch (err) {
        console.error('❌ Error in Reply Handler:', err);
    }
}

module.exports = { handleIncomingReply };
