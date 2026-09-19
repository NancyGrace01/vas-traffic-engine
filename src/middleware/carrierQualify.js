/**
 * carrierQualify.js
 * Carrier qualification middleware for WAP subscription pages.
 *
 * Checks (in order):
 * 1. Device is on mobile data (not WiFi/desktop) — via IP detection
 * 2. Carrier is MTN Nigeria
 * 3. MSISDN is present (from header enrichment)
 * 4. User is not already subscribed (Redis cache + DB)
 * 5. MSISDN is not on suppression list (Redis cache + DB)
 *
 * Sets req.qualification = { qualified, carrier, msisdn, state, reason }
 */

const axios = require('axios');
const { query } = require('../db/client');
const { isOnSuppression, isSubscribedCached, cacheSubscribedMsisdn } = require('../db/redis');
const crypto = require('crypto');

// Nigerian carrier IP prefixes (coarse — ip-api.com is primary)
const MTN_PREFIXES    = ['102.89','197.210','197.211','196.216','41.58'];
const GLO_PREFIXES    = ['197.255','196.201','41.56'];
const AIRTEL_PREFIXES = ['197.157','41.184','102.216','41.203'];
const NINEMOBILE_PREFIXES = ['197.162','196.196','41.63'];

function detectCarrierFromPrefix(ip) {
  if (MTN_PREFIXES.some(p => ip.startsWith(p)))         return 'MTN';
  if (GLO_PREFIXES.some(p => ip.startsWith(p)))         return 'GLO';
  if (AIRTEL_PREFIXES.some(p => ip.startsWith(p)))      return 'AIRTEL';
  if (NINEMOBILE_PREFIXES.some(p => ip.startsWith(p)))  return '9MOBILE';
  return null;
}

function isPrivateIP(ip) {
  return !ip ||
    ip === '127.0.0.1' ||
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    ip.startsWith('172.16.') ||
    ip === '::1';
}

// Read MSISDN from MTN header enrichment
function extractMSISDN(req) {
  const msisdn = (
    req.headers['x-up-calling-line-id'] ||
    req.headers['x-msisdn']             ||
    req.headers['msisdn']               ||
    req.headers['x-nokia-msisdn']       ||
    req.headers['x-ericsson-msisdn']    ||
    req.headers['x-mtn-msisdn']         ||
    req.query.msisdn                     ||
    null
  );

  if (!msisdn) return null;

  // Normalize to 234XXXXXXXXXX format
  let normalized = msisdn.replace(/\D/g, '');
  if (normalized.startsWith('0') && normalized.length === 11) {
    normalized = '234' + normalized.slice(1);
  }
  if (!normalized.startsWith('234') || normalized.length !== 13) return null;
  return normalized;
}

function hashMSISDN(msisdn) {
  return crypto.createHash('sha256').update(msisdn).digest('hex');
}

async function detectCarrierFromIP(ip) {
  // Try prefix map first (free, instant)
  const fromPrefix = detectCarrierFromPrefix(ip);
  if (fromPrefix) return { carrier: fromPrefix, state: null, isMobile: true };

  // Fall back to ip-api.com
  try {
    const res = await axios.get(
      `${process.env.IP_API_URL || 'http://ip-api.com/json'}/${ip}?fields=status,isp,regionName,mobile`,
      { timeout: 2000 }
    );
    const { status, isp = '', regionName, mobile } = res.data;
    if (status !== 'success') return { carrier: 'UNKNOWN', state: null, isMobile: false };

    const ispUpper = isp.toUpperCase();
    let carrier = 'UNKNOWN';
    if (ispUpper.includes('MTN'))                          carrier = 'MTN';
    else if (ispUpper.includes('GLO'))                     carrier = 'GLO';
    else if (ispUpper.includes('AIRTEL'))                  carrier = 'AIRTEL';
    else if (ispUpper.includes('9MOBILE') || ispUpper.includes('ETISALAT')) carrier = '9MOBILE';

    return { carrier, state: regionName || null, isMobile: !!mobile };
  } catch {
    return { carrier: 'UNKNOWN', state: null, isMobile: false };
  }
}

async function checkAlreadySubscribed(msisdn, gameSlug) {
  if (!msisdn) return false;

  const msisdnHash = hashMSISDN(msisdn);

  // Check Redis cache first
  const cached = await isSubscribedCached(`${msisdnHash}:${gameSlug}`);
  if (cached) return true;

  // Check DB
  try {
    const result = await query(
      `SELECT id FROM conversions
       WHERE msisdn_registry_id = (
         SELECT id FROM msisdn_registry WHERE msisdn_hash = $1
       )
       AND game_slug = $2
       AND event_type IN ('NEW_SUB','RENEWAL')
       AND billed_at >= NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [msisdnHash, gameSlug]
    );
    if (result.rows.length > 0) {
      await cacheSubscribedMsisdn(`${msisdnHash}:${gameSlug}`);
      return true;
    }
  } catch {
    // DB error — don't block qualification
  }
  return false;
}

/**
 * Main qualification middleware
 * Attaches req.qualification to every WAP page request
 */
async function qualifyCarrier(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const gameSlug = req.params.game || req.query.game || 'goalfest';

  // Default — not qualified
  req.qualification = {
    qualified: false,
    carrier: 'UNKNOWN',
    msisdn: null,
    msisdnDisplay: null,
    state: null,
    reason: 'unknown',
    ip,
  };

  // In development — skip strict checks
  if (process.env.NODE_ENV === 'development') {
    req.qualification = {
      qualified: true,
      carrier: 'MTN',
      msisdn: null,
      msisdnDisplay: null,
      state: 'Lagos',
      reason: 'dev_bypass',
      ip,
    };
    return next();
  }

  // ── CHECK 1: Not a private/local IP ──
  if (isPrivateIP(ip)) {
    req.qualification.reason = 'private_ip';
    return next();
  }

  // ── CHECK 2: Detect carrier from IP ──
  const { carrier, state, isMobile } = await detectCarrierFromIP(ip);
  req.qualification.carrier = carrier;
  req.qualification.state = state;

  if (!isMobile) {
    req.qualification.reason = 'not_mobile_data';
    return next();
  }

  // ── CHECK 3: Must be MTN (expand to other carriers in future) ──
  if (carrier !== 'MTN') {
    req.qualification.reason = `wrong_carrier:${carrier}`;
    return next();
  }

  // ── CHECK 4: Extract MSISDN from header enrichment ──
  const msisdn = extractMSISDN(req);
  req.qualification.msisdn = msisdn;

  if (msisdn) {
    // Mask for display: 0812****3456
    const local = '0' + msisdn.slice(3);
    req.qualification.msisdnDisplay = local.slice(0, 4) + '****' + local.slice(-4);
  }

  // ── CHECK 5: Not already subscribed ──
  const alreadySubscribed = await checkAlreadySubscribed(msisdn, gameSlug);
  if (alreadySubscribed) {
    req.qualification.reason = 'already_subscribed';
    return next();
  }

  // ── CHECK 6: Not on suppression list ──
  if (msisdn) {
    const msisdnHash = hashMSISDN(msisdn);
    const suppressed = await isOnSuppression(msisdnHash);
    if (suppressed) {
      req.qualification.reason = 'suppressed';
      return next();
    }
  }

  // ── QUALIFIED ──
  req.qualification.qualified = true;
  req.qualification.reason = 'qualified';
  next();
}

module.exports = { qualifyCarrier, extractMSISDN, hashMSISDN, detectCarrierFromIP };
