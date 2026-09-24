const axios  = require('axios');
const { query } = require('../db/client');
const { addToSuppression, isOnSuppression } = require('../db/redis');

// Nigerian carrier IP range prefixes (coarse map — ip-api.com is primary)
const CARRIER_PREFIXES = {
  MTN:    ['102.89','197.210','197.211','196.216'],
  GLO:    ['197.255','196.201'],
  AIRTEL: ['197.157','41.184','102.216'],
  '9MOBILE': ['197.162','196.196'],
};

function detectCarrierFromPrefix(ip) {
  for (const [carrier, prefixes] of Object.entries(CARRIER_PREFIXES)) {
    if (prefixes.some(p => ip.startsWith(p))) return carrier;
  }
  return null;
}

async function detectCarrier(ip) {
  // Skip loopback/private IPs
  if (!ip || ip === '127.0.0.1' || ip.startsWith('192.168') || ip.startsWith('10.')) {
    return { carrier: 'UNKNOWN', state: null };
  }

  // Try prefix map first (free, instant)
  const fromPrefix = detectCarrierFromPrefix(ip);
  if (fromPrefix) return { carrier: fromPrefix, state: null };

  // Fall back to ip-api.com
  try {
    const res = await axios.get(`${process.env.IP_API_URL}/${ip}?fields=status,isp,regionName`, {
      timeout: 2000,
    });
    const { status, isp = '', regionName } = res.data;
    if (status !== 'success') return { carrier: 'UNKNOWN', state: null };

    const ispUpper = isp.toUpperCase();
    let carrier = 'UNKNOWN';
    if (ispUpper.includes('MTN'))     carrier = 'MTN';
    else if (ispUpper.includes('GLO')) carrier = 'GLO';
    else if (ispUpper.includes('AIRTEL')) carrier = 'AIRTEL';
    else if (ispUpper.includes('9MOBILE') || ispUpper.includes('ETISALAT')) carrier = '9MOBILE';

    return { carrier, state: regionName || null };
  } catch {
    return { carrier: 'UNKNOWN', state: null };
  }
}

/**
 * POST /api/v1/subscribers/collect
 * Called by push opt-in SDK on each content page when user clicks Allow
 * Body: { onesignal_player_id, push_token, page_slug, device_type, os, browser }
 */
async function collect(req, res) {
  const {
    fcm_token,           // FCM registration token (primary)
    onesignal_player_id, // legacy — kept for backwards compat
    push_token,
    page_slug,
    device_type = 'ANDROID',
    os,
    browser,
    traffic_source,
    website, // honeypot field — bots fill this, humans don't
  } = req.body;

  // Honeypot check — if this field is filled, it's a bot
  if (website) {
    return res.status(200).json({ success: true }); // silent reject
  }

  // Accept FCM token, OneSignal player ID, or raw push token
  const primaryToken = fcm_token || onesignal_player_id || push_token || null;
  if (!primaryToken) {
    return res.status(400).json({ error: 'fcm_token or push_token required' });
  }

  // Get real IP (behind proxy)
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

  try {
    // Detect carrier & state from IP
    const { carrier, state } = await detectCarrier(ip);

    // Resolve content page ID
    let sourcePageId = null;
    if (page_slug) {
      const pageRes = await query('SELECT id FROM content_pages WHERE slug = $1', [page_slug]);
      if (pageRes.rows.length) sourcePageId = pageRes.rows[0].id;
    }

    // Upsert subscriber — FCM token is the primary unique identifier
    // On conflict: update activity fields only; never overwrite source_page_id
    // (xmax = 0) is true only on INSERT, false on UPDATE — lets us know if this is a new subscriber
    const result = await query(
      `INSERT INTO subscribers
        (onesignal_player_id, push_token, carrier, state, device_type, os, browser,
          ip_address, source_page_id, traffic_source, is_active, opted_in_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::inet,$9,$10,TRUE,NOW())
      ON CONFLICT (onesignal_player_id)
      DO UPDATE SET
        last_active_at = NOW(),
        is_active      = TRUE,
        carrier        = EXCLUDED.carrier,
        state          = EXCLUDED.state,
        source_page_id = subscribers.source_page_id
      RETURNING id, carrier, state, (xmax = 0) AS is_new_row`,
      [primaryToken, push_token || primaryToken, carrier, state, device_type, os, browser, ip, sourcePageId, traffic_source || 'direct']
    );

    const sub = result.rows[0];

    // Only increment opt-in counter for genuinely new subscribers
    if (sourcePageId && sub.is_new_row) {
      await query(
        'UPDATE content_pages SET total_optins = total_optins + 1, updated_at = NOW() WHERE id = $1',
        [sourcePageId]
      );
    }

    console.log(`[SUBSCRIBER] ${sub.is_new_row ? 'New opt-in' : 'Returning visitor'}: ${sub.id} | carrier=${sub.carrier} | state=${sub.state} | page=${page_slug}`);

    return res.json({
      success: true,
      subscriber_id: sub.id,
      carrier: sub.carrier,
      is_mtn: sub.carrier === 'MTN',
    });

  } catch (err) {
    console.error('[SUBSCRIBER] collect error:', err.message);
    return res.status(500).json({ error: 'Failed to save subscriber' });
  }
}

/**
 * GET /api/v1/subscribers/stats
 * Overall subscriber stats for admin dashboard
 */
async function stats(req, res) {
  try {
    const [total, byCarrier, byPage, recent] = await Promise.all([
      query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active) as active FROM subscribers'),
      query('SELECT carrier, COUNT(*) as count FROM subscribers GROUP BY carrier ORDER BY count DESC'),
      query(`
        SELECT cp.name, cp.slug, COUNT(s.id) as optins
        FROM content_pages cp
        LEFT JOIN subscribers s ON s.source_page_id = cp.id
        GROUP BY cp.id, cp.name, cp.slug
        ORDER BY optins DESC
      `),
      query(`
        SELECT DATE(opted_in_at) as date, COUNT(*) as count
        FROM subscribers
        WHERE opted_in_at >= NOW() - INTERVAL '30 days'
        GROUP BY date ORDER BY date
      `),
    ]);

    return res.json({
      total: parseInt(total.rows[0].total),
      active: parseInt(total.rows[0].active),
      by_carrier: byCarrier.rows,
      by_page: byPage.rows,
      daily_trend: recent.rows,
    });
  } catch (err) {
    console.error('[SUBSCRIBER] stats error:', err.message);
    return res.status(500).json({ error: 'Failed to load stats' });
  }
}

/**
 * GET /api/v1/subscribers
 * Paginated subscriber list — includes source_page name
 */
async function list(req, res) {
  const page  = parseInt(req.query.page || 1);
  const limit = parseInt(req.query.limit || 50);
  const offset = (page - 1) * limit;
  const carrier = req.query.carrier;

  try {
    const where = carrier ? 'WHERE s.carrier = $3' : '';
    const params = carrier ? [limit, offset, carrier] : [limit, offset];
    const rows = await query(
      `SELECT s.id, s.carrier, s.state, s.device_type, s.is_active, s.opted_in_at,
              s.traffic_source,
              cp.name  AS source_page,
              cp.slug  AS source_page_slug
      FROM subscribers s
      LEFT JOIN content_pages cp ON cp.id = s.source_page_id
      ${where}
      ORDER BY s.opted_in_at DESC
      LIMIT $1 OFFSET $2`,
      params
    );
    return res.json({ subscribers: rows.rows, page, limit });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list subscribers' });
  }
}

module.exports = { collect, stats, list };