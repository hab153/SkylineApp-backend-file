const { Nylas } = require('nylas'); // ✅ Import the Nylas class
require('dotenv').config();

// Initialize Nylas v8 Client with US API URI
const nylas = new Nylas({
  apiKey: process.env.NYLAS_API_KEY, // ✅ Use the API Key, not the Client Secret
  apiUri: 'https://api.us.nylas.com', 
});

module.exports = nylas;
