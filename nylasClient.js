require('dotenv').config();
const nylas = new Nylas({
  apiKey: process.env.NYLAS_CLIENT_SECRET,  // ✅ CORRECTED
  apiUri: 'https://api.us.nylas.com', 
});
