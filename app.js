// Local entrypoint. The Express app lives in api/index.js so the same code
// runs both locally (node app.js) and on Vercel (serverless function).
const app = require('./api/index');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
