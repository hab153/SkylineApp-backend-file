const Nylas = require('nylas');
require('dotenv').config();

// Initialize Nylas v6 Client
const nylas = new Nylas({
  apiKey: process.env.NYLAS_API_KEY,
});

module.exports = nylas;
