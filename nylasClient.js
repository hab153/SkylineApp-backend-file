const Nylas = require('nylas');
require('dotenv').config();

// Initialize Nylas v8 Client
const nylas = new Nylas({
  apiKey: process.env.NYLAS_API_KEY,
  apiUri: 'https://api.us.nylas.com', // Ensure this matches your region (us or eu)
});

module.exports = nylas;
