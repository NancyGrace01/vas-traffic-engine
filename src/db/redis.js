const { createClient } = require('redis');

let redisClient;

async function connectRedis() {
  redisClient = createClient({ url: process.env.REDIS_URL });

  redisClient.on('error', (err) => console.error('Redis error:', err));
  redisClient.on('reconnecting', () => console.log('Redis reconnecting...'));

  await redisClient.connect();
  console.log('✅ Redis connected');
  return redisClient;
}

function getRedis() {
  if (!redisClient) throw new Error('Redis not connected');
  return redisClient;
}

// ── SUPPRESSION LIST HELPERS ──
async function addToSuppression(msisdn) {
  const r = getRedis();
  await r.set(`suppress:${msisdn}`, '1', { EX: 60 * 60 * 24 * 365 }); // 1 year
}

async function isOnSuppression(msisdn) {
  const r = getRedis();
  return !!(await r.get(`suppress:${msisdn}`));
}

// ── FREQUENCY CAP HELPERS (max 3 pushes per subscriber per 24h) ──
async function incrementPushCount(playerId) {
  const r = getRedis();
  const key = `pushcap:${playerId}:${new Date().toISOString().split('T')[0]}`;
  const count = await r.incr(key);
  if (count === 1) await r.expire(key, 86400); // expires at end of day
  return count;
}

async function getPushCount(playerId) {
  const r = getRedis();
  const key = `pushcap:${playerId}:${new Date().toISOString().split('T')[0]}`;
  return parseInt(await r.get(key) || '0');
}

// ── MSISDN CACHE HELPERS ──
async function cacheSubscribedMsisdn(msisdn) {
  const r = getRedis();
  await r.set(`subscribed:${msisdn}`, '1', { EX: 60 * 60 * 24 }); // 24h cache
}

async function isSubscribedCached(msisdn) {
  const r = getRedis();
  return !!(await r.get(`subscribed:${msisdn}`));
}

// ── IP-API USAGE COUNTERS ──
// Tracks how often the prefix map resolves vs ip-api fallback is hit.
// Keys reset daily. Use GET /api/v1/analytics/ip-api-stats to view.
const today = () => new Date().toISOString().split('T')[0];

async function trackIPResolution(method) {
  // method: 'prefix_hit' | 'ipapi_hit' | 'ipapi_error'
  const r = getRedis();
  const key = `ipapi_stats:${today()}:${method}`;
  await r.incr(key);
  await r.expire(key, 60 * 60 * 24 * 30); // keep 30 days of history
}

async function getIPAPIStats(days = 7) {
  const r = getRedis();
  const results = [];

  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = d.toISOString().split('T')[0];

    const [prefix_hit, ipapi_hit, ipapi_error] = await Promise.all([
      r.get(`ipapi_stats:${date}:prefix_hit`),
      r.get(`ipapi_stats:${date}:ipapi_hit`),
      r.get(`ipapi_stats:${date}:ipapi_error`),
    ]);

    results.push({
      date,
      prefix_hit:  parseInt(prefix_hit  || '0'),
      ipapi_hit:   parseInt(ipapi_hit   || '0'),
      ipapi_error: parseInt(ipapi_error || '0'),
    });
  }

  return results;
}

module.exports = {
  connectRedis, getRedis,
  addToSuppression, isOnSuppression,
  incrementPushCount, getPushCount,
  cacheSubscribedMsisdn, isSubscribedCached,
  trackIPResolution, getIPAPIStats,
};
