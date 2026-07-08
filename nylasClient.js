const Nylas = require('nylas');
require('dotenv').config();

// Initialize Nylas with your v3 API Key
Nylas.config({
  apiKey: process.env.NYLAS_API_KEY,
});

module.exports = Nylas;
