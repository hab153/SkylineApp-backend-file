// validationSchemas.js
const Joi = require('joi');

// ============================================================
// AUTH VALIDATION SCHEMAS
// ============================================================

/**
 * Register validation schema
 */
const registerSchema = Joi.object({
    username: Joi.string().min(3).max(30).pattern(/^[a-zA-Z0-9_]+$/).required(),
    email: Joi.string().email({ tlds: { allow: false } }).max(255).required(),
    password: Joi.string().min(8).max(100).pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).required()
});

/**
 * Login validation schema
 */
const loginSchema = Joi.object({
    identifier: Joi.string().min(1).max(255).required(),
    password: Joi.string().min(1).required()
});

/**
 * Change email validation schema
 */
const changeEmailSchema = Joi.object({
    currentPassword: Joi.string().min(1).required(),
    newEmail: Joi.string().email({ tlds: { allow: false } }).max(255).required()
});

/**
 * Reset password validation schema
 */
const resetPasswordSchema = Joi.object({
    token: Joi.string().min(10).required(),
    newPassword: Joi.string().min(8).max(100).pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).required()
});

/**
 * Forgot password validation schema
 */
const forgotPasswordSchema = Joi.object({
    email: Joi.string().email({ tlds: { allow: false } }).max(255).required()
});

/**
 * Verify age validation schema
 */
const verifyAgeSchema = Joi.object({
    day: Joi.number().integer().min(1).max(31).required(),
    month: Joi.number().integer().min(1).max(12).required(),
    year: Joi.number().integer().min(1900).max(new Date().getFullYear()).required()
});

// ============================================================
// USER PROFILE VALIDATION
// ============================================================

const updateProfileSchema = Joi.object({
    fullName: Joi.string().max(100).allow(''),
    primaryGoal: Joi.string().max(500).allow(''),
    skillLevel: Joi.string().valid('Beginner', 'Intermediate', 'Advanced', 'Expert').allow(''),
    interests: Joi.string().max(500).allow(''),
    country: Joi.string().max(100).allow(''),
    bio: Joi.string().max(1000).allow('')
});

// ============================================================
// LEAD VALIDATION (UPDATED)
// ============================================================

const batchSendSchema = Joi.object({
    leads: Joi.array().items(
        Joi.object({
            name: Joi.string().min(1).max(100).required(),
            email: Joi.string().email({ tlds: { allow: false } }).max(255).required(),
            company: Joi.string().max(100).allow(''),
            messages: Joi.array().items(
                Joi.object({
                    subject: Joi.string().max(200).required(),
                    body: Joi.string().min(1).max(10000).required()
                })
            ).min(1).required()
        })
    ).min(1).max(100).required(),
    
    // ✅ ADDED: Allow leadId and allowNewLead to pass through validation
    leadId: Joi.string().allow(null, ''),
    allowNewLead: Joi.boolean().default(true)
});

const renameLeadSchema = Joi.object({
    newName: Joi.string().min(1).max(100).required()
});

const updateAutoReplySchema = Joi.object({
    enabled: Joi.boolean().required(),
    instructions: Joi.string().max(2000).allow('')
});

// ============================================================
// CHAT VALIDATION
// ============================================================

const chatSchema = Joi.object({
    message: Joi.string().min(1).max(10000).required(),
    history: Joi.array().items(
        Joi.object({
            role: Joi.string().valid('user', 'assistant').required(),
            content: Joi.string().max(10000).required()
        })
    ).max(100).default([]),
    sessionId: Joi.string().allow(null, '')
});

const feedbackSchema = Joi.object({
    messageId: Joi.string().required(),
    type: Joi.string().valid('like', 'dislike').required()
});

// ============================================================
// ADMIN VALIDATION
// ============================================================

const adminMessageSchema = Joi.object({
    message: Joi.string().min(1).max(2000).required()
});

// ============================================================
// REPORT VALIDATION
// ============================================================

const reportSchema = Joi.object({
    subject: Joi.string().min(1).max(200).required(),
    message: Joi.string().min(1).max(5000).required()
});

// ============================================================
// FOLLOW-UP VALIDATION
// ============================================================

const autoFollowUpSchema = Joi.object({
    enabled: Joi.boolean().required(),
    delayDays: Joi.number().integer().min(1).max(30).default(3)
});

// ============================================================
// ASSISTANT VALIDATION
// ============================================================

const assistantSchema = Joi.object({
    message: Joi.string().min(1).max(5000).required(),
    sessionId: Joi.string().allow(null, '')
});

// ============================================================
// DREAM VALIDATION
// ============================================================

const dreamSchema = Joi.object({
    dream: Joi.string().min(1).max(10000).required(),
    sessionId: Joi.string().allow(null, '')
});

const dreamRefineSchema = Joi.object({
    followUpAnswer: Joi.string().min(1).max(5000).required(),
    dreamDescription: Joi.string().min(1).max(10000).required(),
    sessionId: Joi.string().allow(null, '')
});

module.exports = {
    registerSchema,
    loginSchema,
    changeEmailSchema,
    resetPasswordSchema,
    forgotPasswordSchema,
    verifyAgeSchema,
    updateProfileSchema,
    batchSendSchema,
    renameLeadSchema,
    updateAutoReplySchema,
    chatSchema,
    feedbackSchema,
    adminMessageSchema,
    reportSchema,
    autoFollowUpSchema,
    assistantSchema,
    dreamSchema,
    dreamRefineSchema
};
