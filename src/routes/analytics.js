/**
 * analytics.js — Phase 4 (Sprint 8)
 * Stub routes — full implementation in Sprint 8
 */
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { query } = require('../db/client');
const { getIPAPIStats } = require('../db/redis');
const router = express.Router();

router.use(requireAdmin);

// KPI dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const [subs, convs, revenue] = await Promise.all([
      query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active) as active FROM subscribers'),
      query('SELECT COUNT(*) as total FROM conversions WHERE event_type = $1', ['NEW_SUB']),
      query('SELECT COALESCE(SUM(amount_naira),0) as total FROM conversions'),
    ]);
    return res.json({
      total_subscribers: parseInt(subs.rows[0].total),
      active_subscribers: parseInt(subs.rows[0].active),
      total_conversions: parseInt(convs.rows[0].total),
      total_revenue_ngn: parseFloat(revenue.rows[0].total),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Placeholder routes — implemented in Sprint 8
router.get('/funnel/:id',  (req, res) => res.json({ message: 'Coming in Sprint 8' }));
router.get('/retention',   (req, res) => res.json({ message: 'Coming in Sprint 8' }));
router.get('/content-pages', async (req, res) => {
  try {
    const r = await query(`
      SELECT
        cp.name,
        cp.slug,
        cp.total_visitors,
        COUNT(s.id)                                        AS total_optins,
        CASE WHEN cp.total_visitors > 0
             THEN ROUND(COUNT(s.id)::numeric / cp.total_visitors * 100, 2)
             ELSE 0 END                                    AS optin_rate
      FROM content_pages cp
      LEFT JOIN subscribers s ON s.source_page_id = cp.id
      GROUP BY cp.id, cp.name, cp.slug, cp.total_visitors
      ORDER BY total_optins DESC
    `);
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router.get('/geo',         (req, res) => res.json({ message: 'Coming in Sprint 8' }));

// IP resolution stats — prefix map hits vs ip-api fallback hits vs errors
// Useful for monitoring ip-api free tier usage (45 req/min limit)
router.get('/ip-api-stats', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const stats = await getIPAPIStats(days);

    // Summarise totals across the requested period
    const totals = stats.reduce((acc, row) => ({
      prefix_hit:  acc.prefix_hit  + row.prefix_hit,
      ipapi_hit:   acc.ipapi_hit   + row.ipapi_hit,
      ipapi_error: acc.ipapi_error + row.ipapi_error,
    }), { prefix_hit: 0, ipapi_hit: 0, ipapi_error: 0 });

    const totalResolutions = totals.prefix_hit + totals.ipapi_hit;
    totals.ipapi_hit_pct = totalResolutions > 0
      ? ((totals.ipapi_hit / totalResolutions) * 100).toFixed(1) + '%'
      : '0%';

    return res.json({ period_days: days, totals, daily: stats });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;