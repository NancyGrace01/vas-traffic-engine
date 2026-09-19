/**
 * webhooks.js — Phase 4 (Sprint 7)
 * MTN billing webhook + OneSignal event webhook
 * Full implementation in Sprint 7
 */
const express = require('express');
const { query } = require('../db/client');
const router  = express.Router();

// MTN Billing Webhook — Sprint 7
router.post('/mtn/billing', async (req, res) => {
  // TODO Sprint 7: HMAC-SHA256 validation, MSISDN hashing, conversion creation
  console.log('[WEBHOOK] MTN billing payload received:', JSON.stringify(req.body).slice(0, 200));

  // Log raw payload for now
  try {
    await query(
      'INSERT INTO billing_events (raw_payload, received_at) VALUES ($1, NOW())',
      [JSON.stringify(req.body)]
    );
  } catch (err) {
    console.error('[WEBHOOK] Failed to log billing event:', err.message);
  }

  return res.status(200).json({ status: 'received' });
});

// OneSignal Event Webhook — Sprint 7
router.post('/onesignal/events', (req, res) => {
  // TODO Sprint 7: update campaign_sends status, increment counters
  console.log('[WEBHOOK] OneSignal event:', req.body?.event, req.body?.player_id);
  return res.status(200).json({ status: 'received' });
});

// PropellerAds Postback — Sprint 9
router.get('/propellerads/postback', (req, res) => {
  // TODO Sprint 9: log spend, update traffic_sources
  console.log('[WEBHOOK] PropellerAds postback:', req.query);
  return res.status(200).send('OK');
});

module.exports = router;
