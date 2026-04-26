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
    adminAns_dish: { type: String, default: null },
    adminAns_pn: { type: String, default: null },
    adminAns_mum: { type: String, default: null },
    adminAns_dm: { type: String, default: null },
    adminAns_dad: { type: String, default: null },
    adminAns_friend: { type: String, default: null },
    adminAns_enemy: { type: String, default: null },
    adminAns_app: { type: String, default: null },

    // --- USAGE LIMITING FIELDS ---
    usage: {
        dailyCallCount: {
            type: Number,
            default: 0
        },
        lastCallDate: {
            type: Date,
            default: null
        },
        // ADDED FOR IMAGE UPLOAD LIMITS:
        dailyImageCount: { type: Number, default: 0 },
        lastImageUploadDate: { type: Date, default: null },
        // ADDED FOR FILE UPLOAD LIMITS:
        dailyFileCount: { type: Number, default: 0 },
        lastFileUploadDate: { type: Date, default: null }
    },

    // --- SUBSCRIPTION FIELDS (UPGRADED FOR 3 TIERS) ---
    subscriptionTier: {
        type: String,
        enum: ['free', 'go', 'pro'], // Added 'go'
        default: 'free'
    },
    subscriptionEndDate: {
        type: Date,
        default: null
    },
    
    // --- PAYMENT FIELDS (NEW) ---
    lastTxRef: {
        type: String,
        default: null,
        index: true  // Add index for faster lookups
    },
    
    // Optional: Track payment history    paymentHistory: [{
        txRef: { type: String, required: true },
        amount: { type: Number, required: true },        currency: { type: String, default: 'USD' },
        status: { type: String, enum: ['pending', 'successful', 'failed'], default: 'pending' },        paidAt: { type: Date, default: Date.now },
        subscriptionEndDate: { type: Date }
    }],

    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Update the updatedAt field on save
UserSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

// Method to check if user has active pro subscription
UserSchema.methods.hasActiveProSubscription = function() {
    if (this.subscriptionTier !== 'pro') return false;
    if (!this.subscriptionEndDate) return false;
    return new Date() <= this.subscriptionEndDate;
};

// Method to check if subscription is expired
UserSchema.methods.isSubscriptionExpired = function() {
    if (this.subscriptionTier !== 'pro') return false;
    if (!this.subscriptionEndDate) return true;
    return new Date() > this.subscriptionEndDate;
};

// Method to downgrade expired subscription
UserSchema.methods.downgradeIfExpired = async function() {
    if (this.isSubscriptionExpired()) {
        this.subscriptionTier = 'free';
        this.subscriptionEndDate = null;
        await this.save();
        return true;
    }
    return false;
};

// Method to upgrade to pro
UserSchema.methods.upgradeToPro = async function(days = 30) {    this.subscriptionTier = 'pro';
    this.subscriptionEndDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);    await this.save();    return this;
};

// Method to add payment record
UserSchema.methods.addPaymentRecord = async function(txRef, amount, currency = 'USD') {
    this.paymentHistory.push({
        txRef: txRef,
        amount: amount,
        currency: currency,
        status: 'successful',
        paidAt: new Date(),
        subscriptionEndDate: this.subscriptionEndDate
    });
    await this.save();
};

// Static method to find user by txRef
UserSchema.statics.findByTxRef = function(txRef) {
    return this.findOne({ lastTxRef: txRef });
};

// Static method to find expired pro users
UserSchema.statics.findExpiredProUsers = function() {
    const now = new Date();
    return this.find({
        subscriptionTier: 'pro',
        subscriptionEndDate: { $lt: now }
    });
};

// Index for faster subscription expiry queries
UserSchema.index({ subscriptionTier: 1, subscriptionEndDate: 1 });

module.exports = mongoose.model('User', UserSchema);
