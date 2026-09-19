/**
 * migrate.js — VAS Traffic Engine Database Schema
 * Run: node src/db/migrate.js
 *
 * Tables:
 *  content_pages       — Collection landing pages (football, gospel, quiz etc.)
 *  subscribers         — Web push opt-in records (one per device/browser)
 *  campaigns           — Push notification campaigns
 *  campaign_sends      — Individual notification send records
 *  msisdn_registry     — Known phone numbers and subscription status
 *  conversions         — Successful subscription + billing records
 *  suppression_list    — MSISDNs that must never be targeted
 *  events              — All tracked actions (open, click, subscribe, bill, churn)
 *  traffic_sources     — External traffic source configurations (PropellerAds)
 *  billing_events      — Raw MTN billing webhook payloads (audit log)
 */

require('dotenv').config();
const { pool } = require('./client');

const SCHEMA = `

-- ── ENABLE EXTENSION ──
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ══════════════════════════════════════════════
-- content_pages
-- Collection landing pages that drive push opt-ins
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS content_pages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(100) NOT NULL,                       -- "Football Score Tracker"
  slug            VARCHAR(60)  NOT NULL UNIQUE,                -- "football"
  niche           VARCHAR(40)  NOT NULL,                       -- "sports" | "gospel" | "entertainment" | "finance" | "ai-tools"
  url             TEXT,                                        -- deployed URL of the page
  optin_rate      NUMERIC(5,2) DEFAULT 0,                     -- % of visitors who allow push (updated by analytics job)
  total_visitors  INT         DEFAULT 0,
  total_optins    INT         DEFAULT 0,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ══════════════════════════════════════════════
-- subscribers
-- Every web push opt-in. One record per browser/device.
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS subscribers (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  onesignal_player_id VARCHAR(100) UNIQUE,                    -- OneSignal device identifier (set after OneSignal integration)
  push_token          TEXT,                                   -- Raw browser push endpoint (for direct sends if needed)
  carrier             VARCHAR(30) NOT NULL DEFAULT 'UNKNOWN', -- MTN | GLO | AIRTEL | 9MOBILE | UNKNOWN
  country_code        CHAR(2)     NOT NULL DEFAULT 'NG',
  state               VARCHAR(60),                            -- Nigerian state from IP geolocation
  device_type         VARCHAR(20) NOT NULL DEFAULT 'ANDROID', -- ANDROID | IOS | DESKTOP
  os                  VARCHAR(200),
  browser             VARCHAR(200),
  ip_address          INET,                                   -- IP at opt-in (audit only, not used for billing)
  source_page_id      UUID        REFERENCES content_pages(id) ON DELETE SET NULL,
  source_campaign_id  UUID,                                   -- FK to traffic_sources.id (set after that table exists)
  is_active           BOOLEAN     NOT NULL DEFAULT TRUE,      -- FALSE if push token invalid / unsubscribed from push
  last_active_at      TIMESTAMPTZ,
  opted_in_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscribers_carrier     ON subscribers(carrier);
CREATE INDEX IF NOT EXISTS idx_subscribers_is_active   ON subscribers(is_active);
CREATE INDEX IF NOT EXISTS idx_subscribers_opted_in_at ON subscribers(opted_in_at);
CREATE INDEX IF NOT EXISTS idx_subscribers_page        ON subscribers(source_page_id);

-- ══════════════════════════════════════════════
-- msisdn_registry
-- Every MTN phone number the system has ever seen.
-- MSISDN stored as SHA-256 hash for privacy.
-- Plaintext only decryptable via pgcrypto with DB key.
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS msisdn_registry (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  msisdn_hash         CHAR(64)    NOT NULL UNIQUE,            -- SHA-256 of E.164 number e.g. 2348012345678
  msisdn_encrypted    BYTEA       NOT NULL,                   -- pgcrypto encrypted MSISDN
  carrier             VARCHAR(30) NOT NULL DEFAULT 'MTN',
  subscription_status VARCHAR(20) NOT NULL DEFAULT 'NEVER_SUBSCRIBED',
                                                              -- NEVER_SUBSCRIBED | ACTIVE | CHURNED | SUPPRESSED
  current_offer_id    UUID,                                   -- FK to offers/games (Phase 2)
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_billed_at      TIMESTAMPTZ,
  billing_cycle_count INT         NOT NULL DEFAULT 0,         -- total successful billing events
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_msisdn_hash   ON msisdn_registry(msisdn_hash);
CREATE INDEX IF NOT EXISTS idx_msisdn_status ON msisdn_registry(subscription_status);

-- ══════════════════════════════════════════════
-- campaigns
-- Push notification campaigns
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS campaigns (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title             VARCHAR(200) NOT NULL,
  message           TEXT        NOT NULL,                     -- notification body
  icon_url          TEXT,                                     -- notification icon
  target_url        TEXT,                                     -- where to land on click (WAP page URL)
  target_carrier    VARCHAR(30) DEFAULT 'MTN',
  target_page_ids   UUID[],                                   -- limit to subscribers from specific content pages
  target_state      VARCHAR(60),                              -- optional geo filter (Lagos, Abuja etc.)
  status            VARCHAR(20) NOT NULL DEFAULT 'DRAFT',     -- DRAFT | QUEUED | SENDING | SENT | PAUSED | CANCELLED
  scheduled_at      TIMESTAMPTZ,                              -- NULL = send immediately
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  -- Counters (updated by BullMQ worker)
  total_targeted    INT         DEFAULT 0,
  total_sent        INT         DEFAULT 0,
  total_delivered   INT         DEFAULT 0,
  total_opened      INT         DEFAULT 0,
  total_clicked     INT         DEFAULT 0,
  total_converted   INT         DEFAULT 0,
  total_revenue     NUMERIC(12,2) DEFAULT 0,
  -- A/B testing (Phase 4)
  is_ab_test        BOOLEAN     DEFAULT FALSE,
  ab_variant        CHAR(1),                                  -- 'A' or 'B'
  ab_parent_id      UUID        REFERENCES campaigns(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled ON campaigns(scheduled_at);

-- ══════════════════════════════════════════════
-- campaign_sends
-- Individual notification send record (one per subscriber per campaign)
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS campaign_sends (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  subscriber_id   UUID        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  status          VARCHAR(20) NOT NULL DEFAULT 'PENDING',   -- PENDING | SENT | DELIVERED | OPENED | CLICKED | FAILED
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  opened_at       TIMESTAMPTZ,
  clicked_at      TIMESTAMPTZ,
  onesignal_id    VARCHAR(100),                              -- OneSignal notification ID
  error           TEXT,                                      -- error message if FAILED
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sends_campaign    ON campaign_sends(campaign_id);
CREATE INDEX IF NOT EXISTS idx_sends_subscriber  ON campaign_sends(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_sends_status      ON campaign_sends(status);

-- ══════════════════════════════════════════════
-- conversions
-- Successful subscription + billing records
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS conversions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  msisdn_registry_id  UUID        NOT NULL REFERENCES msisdn_registry(id),
  subscriber_id       UUID        REFERENCES subscribers(id),      -- NULL if subscriber not identified
  campaign_id         UUID        REFERENCES campaigns(id),        -- which campaign drove this
  campaign_send_id    UUID        REFERENCES campaign_sends(id),
  game_slug           VARCHAR(30) NOT NULL,                        -- goalfest | naijaiq | skillup | mathsolve
  amount_naira        NUMERIC(10,2) NOT NULL,
  billing_cycle       INT         NOT NULL DEFAULT 1,              -- 1=first charge, 2=first renewal, etc.
  event_type          VARCHAR(20) NOT NULL DEFAULT 'NEW_SUB',      -- NEW_SUB | RENEWAL | CANCELLATION
  mtn_transaction_id  VARCHAR(100),                                -- MTN's internal trx ID
  attributed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),          -- when we linked to campaign
  billed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()           -- when MTN confirmed billing
);

CREATE INDEX IF NOT EXISTS idx_conversions_campaign ON conversions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_conversions_msisdn   ON conversions(msisdn_registry_id);
CREATE INDEX IF NOT EXISTS idx_conversions_billed   ON conversions(billed_at);
CREATE INDEX IF NOT EXISTS idx_conversions_game     ON conversions(game_slug);

-- ══════════════════════════════════════════════
-- suppression_list
-- MSISDNs that must never receive a subscription offer
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS suppression_list (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  msisdn_hash CHAR(64)    NOT NULL UNIQUE,
  reason      VARCHAR(40) NOT NULL DEFAULT 'UNSUBSCRIBED', -- UNSUBSCRIBED | COMPLAINED | MANUAL | TEST
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suppression_hash ON suppression_list(msisdn_hash);

-- ══════════════════════════════════════════════
-- events
-- Immutable event log — every tracked action
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      VARCHAR(40) NOT NULL,   -- PUSH_SENT | PUSH_OPENED | PUSH_CLICKED | WAP_VISIT | SUBSCRIBE_START | SUBSCRIBE_CONFIRM | BILL_SUCCESS | BILL_FAIL | CHURN
  subscriber_id   UUID        REFERENCES subscribers(id),
  campaign_id     UUID        REFERENCES campaigns(id),
  send_id         UUID        REFERENCES campaign_sends(id),
  conversion_id   UUID        REFERENCES conversions(id),
  msisdn_hash     CHAR(64),               -- hashed MSISDN if known at event time
  metadata        JSONB,                  -- any extra context (IP, user-agent, etc.)
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_type         ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_campaign     ON events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_events_subscriber   ON events(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_events_occurred     ON events(occurred_at);

-- ══════════════════════════════════════════════
-- traffic_sources
-- External traffic configurations (PropellerAds campaigns)
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS traffic_sources (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  VARCHAR(100) NOT NULL,             -- "PropellerAds Oct 2025 Football"
  platform              VARCHAR(40)  NOT NULL,             -- PROPELLERADS | MANUAL | ORGANIC
  external_campaign_id  VARCHAR(100),                      -- PropellerAds campaign ID
  target_page_id        UUID        REFERENCES content_pages(id),
  budget_usd            NUMERIC(10,2),
  spend_usd             NUMERIC(10,2) DEFAULT 0,
  clicks                INT         DEFAULT 0,
  optins                INT         DEFAULT 0,
  conversions           INT         DEFAULT 0,
  revenue_ngn           NUMERIC(12,2) DEFAULT 0,
  status                VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | PAUSED | COMPLETED
  started_at            TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ══════════════════════════════════════════════
-- billing_events
-- Raw MTN billing webhook payloads (append-only audit log)
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS billing_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_payload     JSONB       NOT NULL,
  msisdn_hash     CHAR(64),
  event_type      VARCHAR(20),            -- NEW_SUB | RENEWAL | CANCELLATION | FAILED
  game_slug       VARCHAR(30),
  amount_naira    NUMERIC(10,2),
  mtn_trx_id      VARCHAR(100),
  processed       BOOLEAN     NOT NULL DEFAULT FALSE,
  processed_at    TIMESTAMPTZ,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_processed ON billing_events(processed);
CREATE INDEX IF NOT EXISTS idx_billing_msisdn    ON billing_events(msisdn_hash);
CREATE INDEX IF NOT EXISTS idx_billing_received  ON billing_events(received_at);

-- ══════════════════════════════════════════════
-- Seed initial content pages
-- ══════════════════════════════════════════════
INSERT INTO content_pages (name, slug, niche, is_active) VALUES
  ('Football Score Tracker',      'football',     'sports',         TRUE),
  ('AI Name Meaning Generator',   'ai-name',      'ai-tools',       TRUE),
  ('Naija Salary Calculator',     'salary',       'finance',        TRUE),
  ('WhatsApp Status Quotes',      'quotes',       'entertainment',  TRUE),
  ('Afrobeats Lyrics Guesser',    'afrobeats',    'entertainment',  TRUE),
  ('Gospel Lyrics Finder',        'gospel',       'gospel',         TRUE)
ON CONFLICT (slug) DO NOTHING;

`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Running migrations...');
    await client.query(SCHEMA);
    console.log('✅ Migration complete — all tables created');
    console.log('✅ Seeded 6 content pages');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
