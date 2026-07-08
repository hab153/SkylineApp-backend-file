const Nylas = require('nylas');
require('dotenv').config();

// Initialize Nylas v5 Client
Nylas.config({
  apiKey: process.env.NYLAS_API_KEY,
});

module.exports = Nylas;
