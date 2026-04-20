const fetch = require('node-fetch');
async function run() {
  const res = await fetch('http://localhost:3847/api/captcha/solve', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // We need a valid auth token. I will just create one for the test.
    },
  });
}
