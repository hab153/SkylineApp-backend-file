const Nylas = require('nylas');
require('dotenv').config();

const nylas = new Nylas({
  apiKey: process.env.NYLAS_API_KEY,
  apiUri: 'https://api.us.nylas.com', 
});

module.exports = nylas;
