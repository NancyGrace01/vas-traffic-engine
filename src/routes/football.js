const express = require('express');
const router  = express.Router();

const FD_BASE    = 'https://api.football-data.org/v4';
const FD_HEADERS = {
  'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY,
};

// Generic proxy — forwards any path to football-data.org
// e.g. GET /api/v1/football/competitions/2021/standings
//   → GET https://api.football-data.org/v4/competitions/2021/standings
router.get('/*', async (req, res) => {
  const path = req.params[0];
  const query = new URLSearchParams(req.query).toString();
  const url = `${FD_BASE}/${path}${query ? '?' + query : ''}`;

  try {
    const upstream = await fetch(url, { headers: FD_HEADERS });
    const data = await upstream.json();

    // Pass through the upstream status code (handles 429 rate limit, 403, etc.)
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Football data proxy error', detail: err.message });
  }
});

module.exports = router;