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

const { errorHandler } = require('./middleware/errorHandler');
const { connectDB }    = require('./db/client');
const { connectRedis } = require('./db/redis');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── SECURITY & PARSING ──
app.use(helmet());
app.use(cors({ origin: process.env.NODE_ENV === 'production' ? false : '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ── HEALTH CHECK ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), env: process.env.NODE_ENV });
});

// ── API ROUTES ──
app.use('/api/v1/subscribers', subscriberRoutes);
app.use('/api/v1/campaigns',   campaignRoutes);
app.use('/api/v1/analytics',   analyticsRoutes);
app.use('/api/v1/admin',       adminRoutes);
app.use('/webhooks',           webhookRoutes);

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
