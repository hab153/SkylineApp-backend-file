// User.js

const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    password: {
        type: String,
        required: true,
        minlength: 8
    },
    // Profile Fields
    fullName: { type: String, default: '' },
    primaryGoal: { type: String, default: '' },
    skillLevel: { 
        type: String, 
        enum: ['Beginner', 'Intermediate', 'Advanced', 'Expert'], 
        default: 'Beginner' 
    },
    interests: { type: String, default: '' },
    country: { type: String, default: '' },
    bio: { type: String, default: '' },
    profilePicture: { type: String, default: '' },
    
    // Age Verification & Suspension Fields
    dateOfBirth: {
        type: Date,
        default: null
    },
    isSuspended: {
        type: Boolean,
        default: false
    },
    suspensionEnds: {
        type: Date,
        default: null
    },

    // --- ADMIN SECURITY FIELDS ---
    isAdmin: {
        type: Boolean,
        default: false
    },
    // Layer 2 Answers (Hashed)
    adminAns_dish: { type: String, default: null },
    adminAns_pn: { type: String, default: null },
    adminAns_mum: { type: String, default: null },
    adminAns_dm: { type: String, default: null },
    
    // Layer 3 Answers (Hashed)
    adminAns_dad: { type: String, default: null },
    adminAns_friend: { type: String, default: null },
    adminAns_enemy: { type: String, default: null },
    adminAns_app: { type: String, default: null },

    // --- USAGE LIMITING FIELDS (New) ---
    usage: {
        dailyCallCount: {
            type: Number,
            default: 0
        },
        lastCallDate: {
            type: Date,
            default: null
        }
    },

    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('User', UserSchema);
