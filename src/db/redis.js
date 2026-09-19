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

module.exports = {
  connectRedis, getRedis,
  addToSuppression, isOnSuppression,
  incrementPushCount, getPushCount,
  cacheSubscribedMsisdn, isSubscribedCached,
};
