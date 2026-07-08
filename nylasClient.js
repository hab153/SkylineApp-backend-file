const Nylas = require('nylas');
require('dotenv').config();

// Initialize Nylas v8 Client with US API URI
const nylas = new Nylas({
  apiKey: process.env.NYLAS_API_KEY,
  apiUri: 'https://api.us.nylas.com', 
});

module.exports = nylas;
