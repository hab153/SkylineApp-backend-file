const { Nylas } = require('nylas');
require('dotenv').config();

// Initialize Nylas v6 Client using the named export
const nylas = new Nylas({
  apiKey: process.env.NYLAS_API_KEY,
});

// Debug: Check if auth property exists now
console.log('🔍 [Nylas Client] Initialized. Auth property:', typeof nylas.auth);
console.log('🔍 [Nylas Client] Nylas object keys:', Object.keys(nylas));

module.exports = nylas;
