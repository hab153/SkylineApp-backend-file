const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
const User = require('./User');

// Load environment variables
dotenv.config();

async function initAdmin() {
    try {
        // 1. Connect to Database
        console.log('Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected successfully.');

        // 2. Define your Admin Details
        const adminEmail = 'HABEEBULLAHridwanullahAPAOKAGI@gmail.com';
        const adminPassword = 'qwertyuiopasdfghjklzxcvbnmqwerty'; // Exactly 32 chars

        // Layer 2 Answers
        const ans_dish = 'janna food';
        const ans_pn = '24434';
        const ans_mum = 'naimat';
        const ans_dm = 'roheemat';

        // Layer 3 Answers
        const ans_dad = 'ridwanullah';
        const ans_friend = 'Allah';
        const ans_enemy = 'khaafir';
        const ans_app = 'skyline';

        // 3. Find the user
        console.log(`Searching for user: ${adminEmail}...`);
        let user = await User.findOne({ email: adminEmail.toLowerCase() });

        if (!user) {
            console.error('❌ ERROR: User not found in database.');
            console.log('Please sign up with this email first using the app, then run this script again.');
            process.exit(1);
        }

        // 4. Hash the password and answers
        console.log('Hashing security keys...');
        const salt = await bcrypt.genSalt(10);

        const hashedPass = await bcrypt.hash(adminPassword, salt);
        const h_dish = await bcrypt.hash(ans_dish.toLowerCase(), salt);
        const h_pn = await bcrypt.hash(ans_pn.toLowerCase(), salt);
        const h_mum = await bcrypt.hash(ans_mum.toLowerCase(), salt);
        const h_dm = await bcrypt.hash(ans_dm.toLowerCase(), salt);
        const h_dad = await bcrypt.hash(ans_dad.toLowerCase(), salt);
        const h_friend = await bcrypt.hash(ans_friend.toLowerCase(), salt);
        const h_enemy = await bcrypt.hash(ans_enemy.toLowerCase(), salt);
        const h_app = await bcrypt.hash(ans_app.toLowerCase(), salt);

        // 5. Update the User Document
        user.isAdmin = true;
        user.password = hashedPass;

        user.adminAns_dish = h_dish;
        user.adminAns_pn = h_pn;
        user.adminAns_mum = h_mum;
        user.adminAns_dm = h_dm;

        user.adminAns_dad = h_dad;
        user.adminAns_friend = h_friend;
        user.adminAns_enemy = h_enemy;
        user.adminAns_app = h_app;

        await user.save();

        console.log('\n----------------------------------------');
        console.log('✅ SUCCESS! Admin Setup Complete.');
        console.log('----------------------------------------');
        console.log(`Email: ${adminEmail}`);
        console.log(`Password Length: ${adminPassword.length} chars`);
        console.log('You can now log in via login.html');
        console.log('----------------------------------------\n');

    } catch (err) {
        console.error('❌ An error occurred:', err.message);
    } finally {
        // Disconnect from database
        await mongoose.disconnect();
        process.exit(0);
    }
}

// Run the function
initAdmin();
