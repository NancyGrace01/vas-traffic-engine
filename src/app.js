require('dotenv').config();
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const morgan  = require('morgan');

const subscriberRoutes  = require('./routes/subscribers');
const campaignRoutes    = require('./routes/campaigns');
const analyticsRoutes   = require('./routes/analytics');
const webhookRoutes     = require('./routes/webhooks');
const adminRoutes       = require('./routes/admin');
const eventRoutes       = require('./routes/events');
const footballRoutes = require('./routes/football');

const { errorHandler }  = require('./middleware/errorHandler');
const { extractMSISDN, hashMSISDN, detectCarrierFromIP } = require('./middleware/carrierQualify'); // NEW
const { connectDB, query } = require('./db/client');           // NEW: query for msisdn upsert
const { connectRedis }  = require('./db/redis');

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust Railway's proxy so X-Forwarded-For is read correctly
// and express-rate-limit can identify real client IPs
app.set('trust proxy', 1);

// ── SECURITY & PARSING ──
app.use(helmet());
app.use(cors({ origin: process.env.NODE_ENV === 'production' ? ['https://vaspush.com.ng', 'https://www.vaspush.com.ng'] : '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ── GLOBAL MSISDN CAPTURE MIDDLEWARE ──────────────────────────────────────
// Runs on every request. Extracts MSISDN from carrier header enrichment
// (MTN, Glo, Airtel, 9mobile all inject the subscriber's number when
// traffic passes through their WAP gateway). Stores it immediately to
// msisdn_registry so even a page load with no further action captures
// the number. Works for ALL carriers, not just MTN.
app.use(async (req, res, next) => {
  const ip     = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const msisdn = extractMSISDN(req);

  req.msisdn   = msisdn;
  req.clientIp = ip;

  if (msisdn) {
    // MSISDN present (carrier WAP gateway traffic) — detect carrier from prefix
    const prefix = msisdn.slice(3, 6);
    const prefixMap = {
      '803':'MTN','806':'MTN','813':'MTN','816':'MTN','810':'MTN','814':'MTN','903':'MTN','906':'MTN',
      '805':'GLO','807':'GLO','811':'GLO','815':'GLO','705':'GLO',
      '802':'AIRTEL','808':'AIRTEL','812':'AIRTEL','701':'AIRTEL','902':'AIRTEL','901':'AIRTEL','904':'AIRTEL','907':'AIRTEL',
      '809':'9MOBILE','817':'9MOBILE','818':'9MOBILE','908':'9MOBILE','909':'9MOBILE',
    };
    const carrier = prefixMap[prefix] || req.headers['x-carrier'] || req.headers['x-operator'] || 'UNKNOWN';
    req.detectedCarrier = carrier;

    const msisdnHash = hashMSISDN(msisdn);
    query(`
      INSERT INTO msisdn_registry
        (msisdn_hash, msisdn_encrypted, carrier, first_seen_at, updated_at)
      VALUES
        ($1, pgp_sym_encrypt($2, $3), $4, NOW(), NOW())
      ON CONFLICT (msisdn_hash) DO UPDATE
        SET carrier     = EXCLUDED.carrier,
            updated_at  = NOW()
    `, [
      msisdnHash,
      msisdn,
      process.env.DB_ENCRYPTION_KEY || 'vaspush-default-key',
      carrier
    ]).catch(err => console.error('[MSISDN] registry upsert failed:', err.message));

  } else {
    // No MSISDN (PropellerAds / direct traffic) — detect carrier from IP via ip-api
    // Must await before next() so req.detectedCarrier is set when route handlers run
    try {
      const { carrier } = await detectCarrierFromIP(ip);
      req.detectedCarrier = carrier || null;
    } catch {
      req.detectedCarrier = null;
    }
  }

  next();
});

// ── HEALTH CHECK ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), env: process.env.NODE_ENV });
});

// ── API ROUTES ──
app.use('/api/v1/subscribers', subscriberRoutes);
app.use('/api/v1/campaigns',   campaignRoutes);
app.use('/api/v1/analytics',   analyticsRoutes);
app.use('/api/v1/admin',       adminRoutes);
app.use('/api/v1/events',      eventRoutes);
app.use('/api/v1/football', footballRoutes);
app.use('/webhooks',           webhookRoutes);

// ── POSTBACK ROUTE ──
const PLATFORM_POSTBACKS = {
  clickadu: ({ click_id }) => {
    const accountId = process.env.CLICKADU_ACCOUNT_ID || '';
    const aid       = process.env.CLICKADU_AID || '';
    if (!accountId || !aid) return null;
    return `https://sconvtrk.com/conversion/${accountId}/?visitor_id=${encodeURIComponent(click_id)}&aid=${aid}`;
  },
  propellerads: ({ click_id }) => {
    if (!click_id) return null;
    return `https://ad.propellerads.com/conversion.php?aid=3687423&pid=&tid=159926&visitor_id=${encodeURIComponent(click_id)}&payout=0`;
  },
  adsterra: ({ click_id }) => {
    if (!click_id) return null;
    return `https://www.pbterra.com/name/Kings_101/at?subid_short=${encodeURIComponent(click_id)}`;
  },
};

app.post('/api/v1/postback', async (req, res) => {
  const { click_id, page_slug, traffic_source } = req.body;
  if (!click_id) return res.json({ ok: false, reason: 'no click_id' });

  try {
    const platformKey = (traffic_source || '').toLowerCase().trim();
    const buildUrl    = PLATFORM_POSTBACKS[platformKey];

    if (buildUrl) {
      const pbUrl = buildUrl({ click_id });
      if (pbUrl) {
        fetch(pbUrl).catch(err => console.error(`[POSTBACK] ${platformKey} fetch error:`, err.message));
        console.log(`[POSTBACK] fired ${platformKey} | click_id=${click_id} | page=${page_slug}`);
      } else {
        console.warn(`[POSTBACK] ${platformKey} — missing env vars, skipped`);
      }
    } else {
      console.warn(`[POSTBACK] unknown traffic_source="${platformKey}" — no postback fired`);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[POSTBACK] error:', e.message);
    res.json({ ok: false });
  }
});

// ── 404 ──
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── ERROR HANDLER ──
app.use(errorHandler);

// ── START ──
async function start() {
  try {
    await connectDB();
    await connectRedis();
    app.listen(PORT, () => {
      console.log(`\n🚀 VAS Traffic Engine running on port ${PORT}`);
      console.log(`   ENV: ${process.env.NODE_ENV}`);
      console.log(`   Health: http://localhost:${PORT}/health\n`);
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

start();