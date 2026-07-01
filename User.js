const mongoose = require('mongoose');
const crypto = require('crypto');
const { encrypt, decrypt } = require('./encryption');

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
    adminAns_pn:   { type: String, default: null },
    adminAns_mum:  { type: String, default: null },
    adminAns_dm:   { type: String, default: null },
    adminAns_dad:  { type: String, default: null },
    adminAns_friend: { type: String, default: null },
    adminAns_enemy:  { type: String, default: null },
    adminAns_app:    { type: String, default: null },

    // Token version for revocation
    tokenVersion: {
        type: Number,
        default: 0
    },

    // Password reset fields
    resetToken: {
        type: String,
        default: null,
        index: true
    },
    resetTokenExpiry: {
        type: Date,
        default: null
    },

    // --- USAGE LIMITING FIELDS ---
    usage: {
        dailyCallCount: { type: Number, default: 0 },
        lastCallDate: { type: Date, default: null },
        dailyHintCount: { type: Number, default: 0 },
        lastHintDate: { type: Date, default: null },
        dailyImageCount: { type: Number, default: 0 },
        lastImageUploadDate: { type: Date, default: null },
        dailyFileCount: { type: Number, default: 0 },
        lastFileUploadDate: { type: Date, default: null },
        dailySentCount: { type: Number, default: 0 },
        lastSentDate: { type: Date, default: null },
        dailySuggestFollowUpCount: { type: Number, default: 0 },
        lastSuggestFollowUpDate: { type: Date, default: null },
        dailyAutoFollowUpCount: { type: Number, default: 0 },
        lastAutoFollowUpDate: { type: Date, default: null },
        assistantCount: { type: Number, default: 0 },
        assistantLastDate: { type: Date, default: null }
    },

    // --- SUBSCRIPTION FIELDS ---
    subscriptionTier: {
        type: String,
        enum: ['free', 'go', 'pro'],
        default: 'free'
    },
    subscriptionEndDate: {
        type: Date,
        default: null
    },
    
    // --- PAYMENT FIELDS ---
    lastTxRef: {
        type: String,
        default: null,
        index: true
    },
    
    paymentHistory: [{
        txRef: { type: String, required: true },
        amount: { type: Number, required: true },
        currency: { type: String, default: 'USD' },
        status: { type: String, enum: ['pending', 'successful', 'failed'], default: 'pending' },
        paidAt: { type: Date, default: Date.now },
        subscriptionEndDate: { type: Date }
    }],

    // --- NYLAS EMAIL INTEGRATION ---
    nylasIntegration: {
        accessToken: { 
            type: String, 
            default: null,
            // ✅ Encrypt when saving, decrypt when reading
            get: function(value) {
                if (!value) return null;
                try { return decrypt(value); } catch { return value; }
            },
            set: function(value) {
                if (!value) return null;
                try { return encrypt(value); } catch { return value; }
            }
        },
        emailAddress: { type: String, default: null },
        isConnected: { type: Boolean, default: false }
    },

    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    // Enable getters to automatically decrypt when reading
    toJSON: { getters: true },
    toObject: { getters: true }
});

// Pre-save hook
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
UserSchema.methods.upgradeToPro = async function(days = 30) {    
    this.subscriptionTier = 'pro';
    this.subscriptionEndDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);    
    await this.save();    
    return this;
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

// Method to revoke all tokens
UserSchema.methods.revokeTokens = async function() {
    this.tokenVersion += 1;
    await this.save();
    return this.tokenVersion;
};

// Generate password reset token
UserSchema.methods.generateResetToken = async function() {
    const resetToken = crypto.randomBytes(32).toString('hex');
    this.resetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    this.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000);
    await this.save();
    return resetToken;
};

// Verify reset token
UserSchema.methods.verifyResetToken = function(token) {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    if (this.resetToken !== hashedToken) return false;
    if (this.resetTokenExpiry < new Date()) return false;
    return true;
};

// Clear reset token
UserSchema.methods.clearResetToken = async function() {
    this.resetToken = null;
    this.resetTokenExpiry = null;
    await this.save();
};

// Static methods
UserSchema.statics.findByTxRef = function(txRef) {
    return this.findOne({ lastTxRef: txRef });
};

UserSchema.statics.findExpiredProUsers = function() {
    const now = new Date();
    return this.find({
        subscriptionTier: 'pro',
        subscriptionEndDate: { $lt: now }
    });
};

// Indexes
UserSchema.index({ subscriptionTier: 1, subscriptionEndDate: 1 });

module.exports = mongoose.model('User', UserSchema);
