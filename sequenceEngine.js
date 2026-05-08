// sequenceEngine.js
const cron = require('node-cron');
const Lead = require('./Lead');
const User = require('./User');
const { sendEmail } = require('./nylasService');

// Import all 3 AI Tiers
const freeAI = require('./Free');
const goAI = require('./Go');
const { generateBusinessResponse } = require('./businessAI');

// Run every hour
cron.schedule('0 * * * *', async () => {
    console.log('🤖 Sequence Engine: Checking for pending actions...');
    
    const now = new Date();
    const leads = await Lead.find({
        nextActionDate: { $lte: now },
        status: { $nin: ['Interested', 'Not Interested', 'Closed'] }
    }).populate('userId');

    for (const lead of leads) {
        try {
            const user = lead.userId;
            if (!user.nylasIntegration.isConnected) continue;

            let subject = "";
            let body = "";

            // --- ROUTE TO CORRECT AI FILE BASED ON PLAN ---
            if (user.subscriptionTier === 'free') {
                // FREE: Simple, low-token usage
                const prompt = `Write a very short cold email to ${lead.name} at ${lead.company}. Under 40 words.`;
                const result = await freeAI.generateFreeResponse(prompt, [], user);
                subject = `Quick question`;
                body = result.reply;

            } else if (user.subscriptionTier === 'go') {
                // GO: More personality, better structure
                const prompt = `Write a personalized outreach email to ${lead.name}, ${lead.jobTitle} at ${lead.company}. Focus on their industry.`;
                const result = await goAI.generateGoResponse(prompt, [], user);
                subject = `Ideas for ${lead.company}`;
                body = result.reply;

            } else {
                // PRO: Deep research, strategic tone
                const prompt = `Act as a senior strategist. Write a hyper-personalized email to ${lead.name} at ${lead.company}. Context: Job Title is ${lead.jobTitle}.`;
                const userProfile = { fullName: user.fullName, userId: user._id.toString() };
                const result = await generateBusinessResponse(prompt, [], userProfile);
                subject = `Strategic partnership with ${lead.company}`;
                body = result.reply;
            }

            // --- EXECUTE SEQUENCE STEP ---
            if (lead.sequenceStep === 0) {
                // Step 1: Day 1 Email
                const result = await sendEmail(user.nylasIntegration.accessToken, lead.email, subject, body);
                if (result.success) {
                    lead.sequenceStep = 1;
                    lead.lastContactDate = now;
                    lead.nextActionDate = new Date(now.getTime() + (3 * 24 * 60 * 60 * 1000)); // 3 days later
                    lead.status = 'Contacted';
                    lead.replies.push({ date: now, content: body, from: 'ai' });
                    await lead.save();
                }

            } else if (lead.sequenceStep === 1) {
                // Step 2: Day 3 Follow-up
                const bumpBody = `Hi ${lead.name}, just floating this to the top of your inbox regarding ${lead.company}.`;
                await sendEmail(user.nylasIntegration.accessToken, lead.email, `Re: ${subject}`, bumpBody);
                
                lead.sequenceStep = 2;
                lead.nextActionDate = new Date(now.getTime() + (3 * 24 * 60 * 60 * 1000));
                lead.replies.push({ date: now, content: bumpBody, from: 'ai' });
                await lead.save();

            } else if (lead.sequenceStep === 2) {
                // Step 3: Day 6 Break-up
                const breakBody = `Hi ${lead.name}, assuming this isn't a priority. I'll close my file for now.`;
                await sendEmail(user.nylasIntegration.accessToken, lead.email, `Should I close this?`, breakBody);
                
                lead.sequenceStep = 3;
                lead.status = 'Completed Sequence';
                await lead.save();
            }

        } catch (err) {
            console.error(`❌ Error processing lead ${lead._id}:`, err);
        }
    }
});

console.log('✅ Sequence Engine Initialized');
