const User = require('./User');
const ChatMessage = require('./ChatMessage'); // NEW: for chat history
const Notification = require('./Notification'); // NEW: for notifications
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Report = require('./Report');

// Register a new user
const register = async (req, res) => {
    const { username, email, password } = req.body;

    try {
        let user = await User.findOne({ $or: [{ email }, { username }] });
        if (user) {
            return res.status(400).json({ message: 'User with this email or username already exists' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        user = new User({
            username,
            email,
            password: hashedPassword
        });

        await user.save();

        const payload = { user: { id: user.id } };
        
        // ✅ JWT expires in 30 days
        jwt.sign(
            payload, 
            process.env.JWT_SECRET || 'secretkey', 
            { expiresIn: '30d' }, 
            (err, token) => {
                if (err) {
                    console.error("JWT Error:", err);
                    return res.status(500).json({ message: 'Token generation failed' });
                }
                res.json({ token, message: 'Registration successful' });
            }
        );

    } catch (err) {
        console.error("Registration Error:", err.message);
        if (err.code === 11000) {
            return res.status(400).json({ message: 'Duplicate field value entered' });
        }
        res.status(500).json({ message: 'Server Error during registration' });
    }
};

// Login user (Upgraded for Admin Detection)
const login = async (req, res) => {
    const { identifier, password } = req.body;

    try {
        let user = await User.findOne({
            $or: [{ email: identifier }, { username: identifier }]
        });

        if (!user) {
            return res.status(400).json({ message: 'Invalid Credentials' });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid Credentials' });
        }

        // Check for Age Suspension
        if (user.isSuspended) {
            const now = new Date();
            const suspensionEnd = new Date(user.suspensionEnds);
            
            // If suspension period is over, auto-unlock
            if (now >= suspensionEnd) {
                user.isSuspended = false;
                user.suspensionEnds = null;
                await user.save();
            } else {
                // Still suspended
                return res.status(403).json({ 
                    message: 'Account Suspended', 
                    suspensionEnds: suspensionEnd,
                    reason: 'Underage account. Access restricted until 13th birthday.'
                });
            }
        }

        // --- ADMIN LAYER 1 CHECK ---
        // If user is Admin AND password is exactly 32 chars, trigger Layer 2
        if (user.isAdmin && password.length === 32) {
            // Create a temporary token just for Layer 2 verification
            const layerToken = jwt.sign(
                { user: { id: user.id }, step: 'layer2' }, 
                process.env.JWT_SECRET || 'secretkey', 
                { expiresIn: '10m' } // Short expiry for security
            );
            return res.json({ 
                token: layerToken, 
                message: 'Layer 1 Passed', 
                nextStep: 'admin-layer2.html' 
            });
        }

        // Normal User Login
        const payload = { user: { id: user.id } };
        
        // ✅ JWT expires in 30 days
        jwt.sign(
            payload, 
            process.env.JWT_SECRET || 'secretkey', 
            { expiresIn: '30d' }, 
            (err, token) => {
                if (err) {
                    console.error("JWT Error:", err);
                    return res.status(500).json({ message: 'Token generation failed' });
                }
                res.json({ token, message: 'Login successful' });
            }
        );

    } catch (err) {
        console.error("Login Error:", err.message);
        res.status(500).json({ message: 'Server Error during login' });
    }
};

// Verify Layer 2 (Personal Questions)
const verifyLayer2 = async (req, res) => {
    const { dish, pn, mum, dm } = req.body;
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        // Compare answers (case-insensitive)
        const d1 = await bcrypt.compare(dish.toLowerCase(), user.adminAns_dish);
        const d2 = await bcrypt.compare(pn.toLowerCase(), user.adminAns_pn);
        const d3 = await bcrypt.compare(mum.toLowerCase(), user.adminAns_mum);
        const d4 = await bcrypt.compare(dm.toLowerCase(), user.adminAns_dm);

        if (d1 && d2 && d3 && d4) {
            // Pass to Layer 3
            const layerToken = jwt.sign(
                { user: { id: user.id }, step: 'layer3' }, 
                process.env.JWT_SECRET || 'secretkey', 
                { expiresIn: '10m' }
            );
            return res.json({ token: layerToken, nextStep: 'admin-layer3.html' });
        }
        res.status(400).json({ message: 'Incorrect answers' });
    } catch (err) {        
        res.status(500).json({ message: 'Server Error' });
    }
};

// Verify Layer 3 (Security Questions)
const verifyLayer3 = async (req, res) => {
    const { dad, friend, enemy, app } = req.body;
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const d1 = await bcrypt.compare(dad.toLowerCase(), user.adminAns_dad);
        const d2 = await bcrypt.compare(friend.toLowerCase(), user.adminAns_friend);
        const d3 = await bcrypt.compare(enemy.toLowerCase(), user.adminAns_enemy);
        const d4 = await bcrypt.compare(app.toLowerCase(), user.adminAns_app);

        if (d1 && d2 && d3 && d4) {
            // Final Admin Token
            const payload = { user: { id: user.id }, isAdmin: true };
            // Admin token lasts 7 days
            const token = jwt.sign(payload, process.env.JWT_SECRET || 'secretkey', { expiresIn: '7d' });
            return res.json({ token, message: 'Admin Access Granted', nextStep: 'admin-dashboard.html' });
        }
        res.status(400).json({ message: 'Incorrect answers' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// Verify Age
const verifyAge = async (req, res) => {
    const { day, month, year } = req.body;
    
    try {
        let user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Calculate Age
        const birthDate = new Date(year, month - 1, day);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
            age--;
        }
        user.dateOfBirth = birthDate;
        if (age < 13) {
            // Suspend Account until 13th birthday
            user.isSuspended = true;
            const thirteenthBirthday = new Date(birthDate);
            thirteenthBirthday.setFullYear(birthDate.getFullYear() + 13);
            user.suspensionEnds = thirteenthBirthday;
            await user.save();
            
            return res.status(403).json({ 
                message: 'Underage', 
                suspensionEnds: thirteenthBirthday,
                reason: 'You must be at least 13 years old to use Skyline AA-1.'
            });
        } else {
            // Allow Access
            user.isSuspended = false;
            user.suspensionEnds = null;
            await user.save();
            return res.json({ message: 'Age verified. Access granted.' });
        }

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// Change Email
const changeEmail = async (req, res) => {
    const { currentPassword, newEmail } = req.body;

    try {
        let user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Current password is incorrect' });
        }

        const existingUser = await User.findOne({ email: newEmail });
        if (existingUser && existingUser._id.toString() !== user._id.toString()) {
            return res.status(400).json({ message: 'Email is already in use' });
        }
        user.email = newEmail.toLowerCase().trim();
        await user.save();

        res.json({ message: 'Email updated successfully' });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// Delete Account – now removes ChatMessage and Notification instead of old Message model
const deleteAccount = async (req, res) => {
    const { password } = req.body;

    try {
        let user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Incorrect password. Account not deleted.' });
        }

        // Delete all chat messages for this user
        await ChatMessage.deleteMany({ userId: req.userId });
        
        // Delete all notifications for this user
        await Notification.deleteMany({ userId: req.userId });
        
        // Delete all reports for this user
        await Report.deleteMany({ userId: req.userId });

        // Delete the user
        await User.findByIdAndDelete(req.userId);

        res.json({ message: 'Account permanently deleted.' });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = { 
    register, 
    login, 
    verifyAge, 
    changeEmail, 
    verifyLayer2, 
    verifyLayer3,
    deleteAccount 
};
