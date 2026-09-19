const express     = require('express');
const rateLimit   = require('express-rate-limit');
const { collect, stats, list } = require('../controllers/subscriberController');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Rate limit: 100 requests per 15 minutes per IP
const optinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── PUBLIC ──
router.post('/collect', optinLimiter, collect);   // push opt-in from content pages

// ── ADMIN PROTECTED ──
router.get('/stats', requireAdmin, stats);         // dashboard stats
router.get('/',      requireAdmin, list);           // paginated list

module.exports = router;
