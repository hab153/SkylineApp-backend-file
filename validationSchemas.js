// validationSchemas.js
const Joi = require('joi');

// ============================================================
// AUTH VALIDATION SCHEMAS
// ============================================================

/**
 * Register validation schema
 * Validates: username, email, password
 */
const registerSchema = Joi.object({
    username: Joi.string()
        .min(3)
        .max(30)
        .pattern(/^[a-zA-Z0-9_]+$/)
        .required()
        .messages({
            'string.min': 'Username must be at least 3 characters',
            'string.max': 'Username cannot exceed 30 characters',
            'string.pattern.base': 'Username can only contain letters, numbers, and underscores',
            'any.required': 'Username is required'
        }),
    email: Joi.string()
        .email({ tlds: { allow: false } })
        .max(255)
        .required()
        .messages({
            'string.email': 'Please enter a valid email address',
            'string.max': 'Email cannot exceed 255 characters',
            'any.required': 'Email is required'
        }),
    password: Joi.string()
        .min(8)
        .max(100)
        .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .required()
        .messages({
            'string.min': 'Password must be at least 8 characters',
            'string.max': 'Password cannot exceed 100 characters',
            'string.pattern.base': 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
            'any.required': 'Password is required'
        })
});

/**
 * Login validation schema
 */
const loginSchema = Joi.object({
    identifier: Joi.string()
        .min(1)
        .max(255)
        .required()
        .messages({
            'string.min': 'Please enter your email or username',
            'any.required': 'Email or username is required'
        }),
    password: Joi.string()
        .min(1)
        .required()
        .messages({
            'string.min': 'Password is required',
            'any.required': 'Password is required'
        })
});

/**
 * Change email validation schema
 */
const changeEmailSchema = Joi.object({
    currentPassword: Joi.string()
        .min(1)
        .required()
        .messages({
            'any.required': 'Current password is required'
        }),
    newEmail: Joi.string()
        .email({ tlds: { allow: false } })
        .max(255)
        .required()
        .messages({
            'string.email': 'Please enter a valid email address',
            'any.required': 'New email is required'
        })
});

/**
 * Change password validation schema
 */
const changePasswordSchema = Joi.object({
    currentPassword: Joi.string()
        .min(1)
        .required()
        .messages({
            'any.required': 'Current password is required'
        }),
    newPassword: Joi.string()
        .min(8)
        .max(100)
        .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .required()
        .messages({
            'string.min': 'New password must be at least 8 characters',
            'string.max': 'New password cannot exceed 100 characters',
            'string.pattern.base': 'New password must contain at least one uppercase letter, one lowercase letter, and one number',
            'any.required': 'New password is required'
        })
});

/**
 * Reset password validation schema
 */
const resetPasswordSchema = Joi.object({
    token: Joi.string()
        .min(10)
        .required()
        .messages({
            'any.required': 'Reset token is required'
        }),
    newPassword: Joi.string()
        .min(8)
        .max(100)
        .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .required()
        .messages({
            'string.min': 'Password must be at least 8 characters',
            'string.max': 'Password cannot exceed 100 characters',
            'string.pattern.base': 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
            'any.required': 'New password is required'
        })
});

/**
 * Forgot password validation schema
 */
const forgotPasswordSchema = Joi.object({
    email: Joi.string()
        .email({ tlds: { allow: false } })
        .max(255)
        .required()
        .messages({
            'string.email': 'Please enter a valid email address',
            'any.required': 'Email is required'
        })
});

/**
 * Verify age validation schema
 */
const verifyAgeSchema = Joi.object({
    day: Joi.number()
        .integer()
        .min(1)
        .max(31)
        .required()
        .messages({
            'number.base': 'Day must be a number',
            'number.min': 'Day must be between 1 and 31',
            'number.max': 'Day must be between 1 and 31',
            'any.required': 'Day is required'
        }),
    month: Joi.number()
        .integer()
        .min(1)
        .max(12)
        .required()
        .messages({
            'number.base': 'Month must be a number',
            'number.min': 'Month must be between 1 and 12',
            'number.max': 'Month must be between 1 and 12',
            'any.required': 'Month is required'
        }),
    year: Joi.number()
        .integer()
        .min(1900)
        .max(new Date().getFullYear())
        .required()
        .messages({
            'number.base': 'Year must be a number',
            'number.min': 'Please enter a valid year',
            'number.max': 'Year cannot be in the future',
            'any.required': 'Year is required'
        })
});

// ============================================================
// USER PROFILE VALIDATION
// ============================================================

const updateProfileSchema = Joi.object({
    fullName: Joi.string()
        .min(1)
        .max(100)
        .allow('')
        .messages({
            'string.max': 'Full name cannot exceed 100 characters'
        }),
    primaryGoal: Joi.string()
        .max(500)
        .allow('')
        .messages({
            'string.max': 'Primary goal cannot exceed 500 characters'
        }),
    skillLevel: Joi.string()
        .valid('Beginner', 'Intermediate', 'Advanced', 'Expert')
        .allow('')
        .messages({
            'any.only': 'Skill level must be Beginner, Intermediate, Advanced, or Expert'
        }),
    interests: Joi.string()
        .max(500)
        .allow('')
        .messages({
            'string.max': 'Interests cannot exceed 500 characters'
        }),
    country: Joi.string()
        .max(100)
        .allow('')
        .messages({
            'string.max': 'Country cannot exceed 100 characters'
        }),
    bio: Joi.string()
        .max(1000)
        .allow('')
        .messages({
            'string.max': 'Bio cannot exceed 1000 characters'
        })
});

// ============================================================
// LEAD VALIDATION
// ============================================================

const batchSendSchema = Joi.object({
    leads: Joi.array()
        .items(
            Joi.object({
                name: Joi.string()
                    .min(1)
                    .max(100)
                    .required()
                    .messages({
                        'any.required': 'Lead name is required'
                    }),
                email: Joi.string()
                    .email({ tlds: { allow: false } })
                    .max(255)
                    .required()
                    .messages({
                        'string.email': 'Please enter a valid email address',
                        'any.required': 'Lead email is required'
                    }),
                company: Joi.string()
                    .max(100)
                    .allow('')
                    .messages({
                        'string.max': 'Company name cannot exceed 100 characters'
                    }),
                messages: Joi.array()
                    .items(
                        Joi.object({
                            subject: Joi.string()
                                .max(200)
                                .required()
                                .messages({
                                    'any.required': 'Subject is required'
                                }),
                            body: Joi.string()
                                .min(1)
                                .max(10000)
                                .required()
                                .messages({
                                    'any.required': 'Message body is required',
                                    'string.max': 'Message body cannot exceed 10000 characters'
                                })
                        })
                    )
                    .min(1)
                    .required()
                    .messages({
                        'array.min': 'At least one message is required'
                    })
            })
        )
        .min(1)
        .max(100)
        .required()
        .messages({
            'array.min': 'At least one lead is required',
            'array.max': 'Cannot send more than 100 leads at once',
            'any.required': 'Leads are required'
        })
});

const renameLeadSchema = Joi.object({
    name: Joi.string()
        .min(1)
        .max(100)
        .required()
        .messages({
            'string.min': 'Name is required',
            'string.max': 'Name cannot exceed 100 characters',
            'any.required': 'Name is required'
        })
});

const updateAutoReplySchema = Joi.object({
    enabled: Joi.boolean()
        .required()
        .messages({
            'any.required': 'Enabled status is required'
        }),
    instructions: Joi.string()
        .max(2000)
        .allow('')
        .messages({
            'string.max': 'Instructions cannot exceed 2000 characters'
        })
});

// ============================================================
// CHAT VALIDATION
// ============================================================

const chatSchema = Joi.object({
    message: Joi.string()
        .min(1)
        .max(10000)
        .required()
        .messages({
            'string.min': 'Message is required',
            'string.max': 'Message cannot exceed 10000 characters',
            'any.required': 'Message is required'
        }),
    history: Joi.array()
        .items(
            Joi.object({
                role: Joi.string()
                    .valid('user', 'assistant')
                    .required(),
                content: Joi.string()
                    .max(10000)
                    .required()
            })
        )
        .max(100)
        .default([])
        .messages({
            'array.max': 'History cannot exceed 100 messages'
        }),
    sessionId: Joi.string()
        .allow(null, '')
        .messages({
            'string.base': 'Session ID must be a string'
        })
});

const feedbackSchema = Joi.object({
    messageId: Joi.string()
        .required()
        .messages({
            'any.required': 'Message ID is required'
        }),
    type: Joi.string()
        .valid('like', 'dislike')
        .required()
        .messages({
            'any.only': 'Feedback type must be "like" or "dislike"',
            'any.required': 'Feedback type is required'
        })
});

// ============================================================
// ADMIN VALIDATION
// ============================================================

const adminMessageSchema = Joi.object({
    message: Joi.string()
        .min(1)
        .max(2000)
        .required()
        .messages({
            'string.min': 'Message is required',
            'string.max': 'Message cannot exceed 2000 characters',
            'any.required': 'Message is required'
        })
});

const adminSuspendSchema = Joi.object({
    days: Joi.number()
        .integer()
        .min(1)
        .max(365)
        .default(30)
        .messages({
            'number.base': 'Days must be a number',
            'number.min': 'Suspension must be at least 1 day',
            'number.max': 'Suspension cannot exceed 365 days'
        })
});

// ============================================================
// REPORT VALIDATION
// ============================================================

const reportSchema = Joi.object({
    subject: Joi.string()
        .min(1)
        .max(200)
        .required()
        .messages({
            'string.min': 'Subject is required',
            'string.max': 'Subject cannot exceed 200 characters',
            'any.required': 'Subject is required'
        }),
    message: Joi.string()
        .min(1)
        .max(5000)
        .required()
        .messages({
            'string.min': 'Message is required',
            'string.max': 'Message cannot exceed 5000 characters',
            'any.required': 'Message is required'
        })
});

// ============================================================
// FOLLOW-UP VALIDATION
// ============================================================

const autoFollowUpSchema = Joi.object({
    enabled: Joi.boolean()
        .required()
        .messages({
            'any.required': 'Enabled status is required'
        }),
    delayDays: Joi.number()
        .integer()
        .min(1)
        .max(30)
        .default(3)
        .messages({
            'number.base': 'Delay days must be a number',
            'number.min': 'Delay must be at least 1 day',
            'number.max': 'Delay cannot exceed 30 days'
        })
});

// ============================================================
// ASSISTANT VALIDATION
// ============================================================

const assistantSchema = Joi.object({
    message: Joi.string()
        .min(1)
        .max(5000)
        .required()
        .messages({
            'string.min': 'Message is required',
            'string.max': 'Message cannot exceed 5000 characters',
            'any.required': 'Message is required'
        }),
    sessionId: Joi.string()
        .allow(null, '')
        .messages({
            'string.base': 'Session ID must be a string'
        })
});

// ============================================================
// DREAM VALIDATION
// ============================================================

const dreamSchema = Joi.object({
    dream: Joi.string()
        .min(1)
        .max(10000)
        .required()
        .messages({
            'string.min': 'Dream description is required',
            'string.max': 'Dream description cannot exceed 10000 characters',
            'any.required': 'Dream description is required'
        }),
    sessionId: Joi.string()
        .allow(null, '')
});

const dreamRefineSchema = Joi.object({
    followUpAnswer: Joi.string()
        .min(1)
        .max(5000)
        .required()
        .messages({
            'string.min': 'Answer is required',
            'any.required': 'Answer is required'
        }),
    dreamDescription: Joi.string()
        .min(1)
        .max(10000)
        .required()
        .messages({
            'string.min': 'Dream description is required',
            'any.required': 'Dream description is required'
        }),
    sessionId: Joi.string()
        .allow(null, '')
});

// ============================================================
// EXPORT ALL SCHEMAS
// ============================================================

module.exports = {
    // Auth
    registerSchema,
    loginSchema,
    changeEmailSchema,
    changePasswordSchema,
    resetPasswordSchema,
    forgotPasswordSchema,
    verifyAgeSchema,

    // Profile
    updateProfileSchema,

    // Leads
    batchSendSchema,
    renameLeadSchema,
    updateAutoReplySchema,

    // Chat
    chatSchema,
    feedbackSchema,

    // Admin
    adminMessageSchema,
    adminSuspendSchema,

    // Reports
    reportSchema,

    // Follow-up
    autoFollowUpSchema,

    // Assistant
    assistantSchema,

    // Dreams
    dreamSchema,
    dreamRefineSchema
};
