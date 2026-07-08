const Nylas = require('nylas');
require('dotenv').config();

// Initialize Nylas v6 Client
const nylas = new Nylas({
  apiKey: process.env.NYLAS_API_KEY,
});

// Debug: Check if auth property exists
console.log('🔍 [Nylas Client] Initialized. Auth property:', typeof nylas.auth);

module.exports = nylas;
