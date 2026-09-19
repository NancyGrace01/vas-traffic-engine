const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { query } = require('../db/client');
const { Queue } = require('bullmq');
const { getRedis } = require('../db/redis');

const router = express.Router();

// All campaign routes require admin auth
router.use(requireAdmin);

// ── CREATE CAMPAIGN ──
router.post('/', async (req, res) => {
  const { title, message, icon_url, target_url, target_carrier, target_page_ids, scheduled_at } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'title and message required' });

  try {
    const result = await query(
      `INSERT INTO campaigns (title, message, icon_url, target_url, target_carrier, target_page_ids, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title, message, icon_url, target_url, target_carrier || 'MTN', target_page_ids || null, scheduled_at || null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[CAMPAIGN] create error:', err.message);
    return res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// ── LIST CAMPAIGNS ──
router.get('/', async (req, res) => {
  try {
    const result = await query('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 50');
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list campaigns' });
  }
});

// ── GET SINGLE CAMPAIGN ──
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get campaign' });
  }
});

// ── SEND CAMPAIGN (enqueue BullMQ blast) ──
router.post('/:id/send', async (req, res) => {
  const { id } = req.params;

  try {
    // Get campaign
    const campRes = await query('SELECT * FROM campaigns WHERE id = $1', [id]);
    if (!campRes.rows.length) return res.status(404).json({ error: 'Campaign not found' });

    const camp = campRes.rows[0];
    if (['SENDING','SENT'].includes(camp.status)) {
      return res.status(400).json({ error: 'Campaign already sent or sending' });
    }

    // Count eligible subscribers
    // onesignal_player_id column stores FCM token (reused for compat)
    let subsQuery = 'SELECT id, onesignal_player_id AS fcm_token FROM subscribers WHERE is_active = TRUE AND onesignal_player_id IS NOT NULL';
    const params = [];
    if (camp.target_carrier) { params.push(camp.target_carrier); subsQuery += ` AND carrier = $${params.length}`; }
    const subs = await query(subsQuery, params);

    if (!subs.rows.length) return res.status(400).json({ error: 'No eligible subscribers found' });

    // Update campaign status
    await query('UPDATE campaigns SET status = $1, started_at = NOW(), total_targeted = $2, updated_at = NOW() WHERE id = $3',
      ['SENDING', subs.rows.length, id]);

    // Enqueue BullMQ blast jobs in batches of 10,000
    const blastQueue = new Queue('push-blast', { connection: getRedis() });
    const BATCH_SIZE = 10000;
    const batches = [];
    for (let i = 0; i < subs.rows.length; i += BATCH_SIZE) {
      batches.push(subs.rows.slice(i, i + BATCH_SIZE));
    }

    for (let i = 0; i < batches.length; i++) {
      await blastQueue.add('blast-batch', {
        campaign_id: id,
        campaign_title: camp.title,
        campaign_message: camp.message,
        campaign_icon: camp.icon_url,
        campaign_url: camp.target_url,
        subscribers: batches[i],
        batch_num: i + 1,
        total_batches: batches.length,
      });
    }

    console.log(`[CAMPAIGN] ${id} enqueued: ${subs.rows.length} subscribers in ${batches.length} batches`);

    return res.json({
      success: true,
      campaign_id: id,
      total_targeted: subs.rows.length,
      batches: batches.length,
    });
  } catch (err) {
    console.error('[CAMPAIGN] send error:', err.message);
    return res.status(500).json({ error: 'Failed to enqueue campaign' });
  }
});

// ── PAUSE CAMPAIGN ──
router.post('/:id/pause', async (req, res) => {
  try {
    await query('UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2', ['PAUSED', req.params.id]);
    return res.json({ success: true, status: 'PAUSED' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to pause campaign' });
  }
});

module.exports = router;
