/**
 * events.js
 * POST /api/v1/events
 *
 * Called by content pages (betting, health, afrobeats-quiz) on any
 * meaningful user interaction — first tap, Allow push, Deny push.
 * We don't care WHAT they clicked. We care WHO is on the page.
 *
 * The global MSISDN middleware in app.js will have already:
 *   1. Extracted the MSISDN from carrier headers (if on mobile data)
 *   2. Upserted it into msisdn_registry
 *
 * This route logs the event and links the MSISDN to the content page
 * and traffic source so the admin knows: "2348012345678 (MTN) landed on
 * /betting from mtn_push_blast_03 and tapped Allow."
 */

const express = require('express');
const router  = express.Router();
const { query } = require('../db/client');
const { hashMSISDN } = require('../middleware/carrierQualify');

// POST /api/v1/events
router.post('/', async (req, res) => {
  const {
    page_slug,       // 'betting' | 'health' | 'afrobeats-quiz' etc.
    event_type,      // 'page_interaction' | 'push_allow' | 'push_deny'
    traffic_source,  // value of ?source= URL param e.g. 'mtn_push_blast_01'
    session_id,      // random ID generated client-side per session
  } = req.body;

  if (!page_slug || !event_type) {
    return res.status(400).json({ error: 'page_slug and event_type required' });
  }

  // MSISDN already extracted by global middleware in app.js
  const msisdn  = req.msisdn || null;
  const carrier = req.detectedCarrier || null;
  const ip      = req.clientIp;

  try {
    // Log to events table
    await query(`
      INSERT INTO events
        (event_type, msisdn_hash, metadata, occurred_at)
      VALUES ($1, $2, $3, NOW())
    `, [
      event_type,
      msisdn ? hashMSISDN(msisdn) : null,
      JSON.stringify({
        page_slug,
        traffic_source: traffic_source || 'direct',
        session_id:     session_id     || null,
        carrier:        carrier        || null,
        ip,
        has_msisdn:     !!msisdn,
      })
    ]);

    // Update content page visitor counter
    await query(`
      UPDATE content_pages
      SET total_visitors = total_visitors + 1, updated_at = NOW()
      WHERE slug = $1
    `, [page_slug]);

    return res.json({
      success:    true,
      has_msisdn: !!msisdn,
      carrier:    carrier || null,
    });

  } catch (err) {
    console.error('[EVENTS] log error:', err.message);
    // Always return 200 — never break the content page over a tracking failure
    return res.json({ success: false });
  }
});

module.exports = router;
