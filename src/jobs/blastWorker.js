/**
 * blastWorker.js
 * BullMQ worker that processes push blast batches via Firebase Cloud Messaging V1 API.
 * Run standalone: node src/jobs/blastWorker.js
 *
 * FCM V1 API uses OAuth2 access tokens from a Service Account JSON.
 * Much more secure than the legacy server key approach.
 */

require('dotenv').config();
const { Worker, Queue } = require('bullmq');
const axios  = require('axios');
const { query } = require('../db/client');
const { connectRedis, getRedis, incrementPushCount } = require('../db/redis');

const PUSH_CAP = 3; // max notifications per subscriber per day

// ── FCM V1 AUTH ──
// Generates a short-lived OAuth2 access token from the service account credentials
let cachedToken = null;
let tokenExpiry  = 0;

async function getFCMAccessToken() {
  // Return cached token if still valid (tokens last 1 hour, refresh at 55 mins)
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const { GoogleAuth } = require('google-auth-library');

  const auth = new GoogleAuth({
    credentials: {
      type: 'service_account',
      project_id:   process.env.FCM_PROJECT_ID,
      client_email: process.env.FCM_CLIENT_EMAIL,
      private_key:  process.env.FCM_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });

  const client      = await auth.getClient();
  const tokenRes    = await client.getAccessToken();
  cachedToken       = tokenRes.token;
  tokenExpiry       = Date.now() + (55 * 60 * 1000); // 55 minutes

  return cachedToken;
}

// ── SEND FCM V1 NOTIFICATION TO ONE TOKEN ──
async function sendFCMNotification(fcmToken, campaign) {
  const accessToken = await getFCMAccessToken();
  const projectId   = process.env.FCM_PROJECT_ID;

  const message = {
    message: {
      token: fcmToken,
      notification: {
        title: campaign.campaign_title,
        body:  campaign.campaign_message,
        image: campaign.campaign_icon || undefined,
      },
      webpush: {
        notification: {
          title: campaign.campaign_title,
          body:  campaign.campaign_message,
          icon:  campaign.campaign_icon || '/icon-192.png',
          click_action: campaign.campaign_url || 'https://vaspush.com.ng',
        },
        fcm_options: {
          link: campaign.campaign_url || 'https://vaspush.com.ng',
        },
      },
    },
  };

  const res = await axios.post(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    message,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );

  return res.data;
}

// ── SEND FCM BATCH (multicast via individual sends — FCM V1 has no batch endpoint) ──
// FCM V1 doesn't support multicast. We send individually but in parallel (chunked).
async function sendFCMBatch(subscribers, campaign) {
  const CHUNK_SIZE = 100; // send 100 in parallel at a time
  let sent = 0;
  let failed = 0;
  const failedTokens = [];

  for (let i = 0; i < subscribers.length; i += CHUNK_SIZE) {
    const chunk = subscribers.slice(i, i + CHUNK_SIZE);

    const results = await Promise.allSettled(
      chunk.map(sub => sendFCMNotification(sub.fcm_token, campaign))
    );

    results.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        sent++;
      } else {
        failed++;
        // Track invalid tokens for cleanup
        const errCode = result.reason?.response?.data?.error?.code;
        if (errCode === 404 || errCode === 'UNREGISTERED') {
          failedTokens.push(chunk[idx].id);
        }
      }
    });
  }

  // Mark invalid tokens as inactive in DB
  if (failedTokens.length > 0) {
    await query(
      'UPDATE subscribers SET is_active = FALSE WHERE id = ANY($1)',
      [failedTokens]
    ).catch(err => console.error('[FCM] Failed to mark invalid tokens:', err.message));
    console.log(`[FCM] Marked ${failedTokens.length} invalid tokens as inactive`);
  }

  return { sent, failed };
}

// ── PROCESS BLAST BATCH JOB ──
async function processBatch(job) {
  const { campaign_id, subscribers, batch_num, total_batches } = job.data;
  console.log(`[BLAST] Campaign ${campaign_id} — batch ${batch_num}/${total_batches} — ${subscribers.length} subscribers`);

  // Check campaign not paused
  const campRes = await query('SELECT status FROM campaigns WHERE id = $1', [campaign_id]);
  if (!campRes.rows.length || campRes.rows[0].status === 'PAUSED') {
    console.log(`[BLAST] Campaign ${campaign_id} paused — skipping batch ${batch_num}`);
    return { skipped: true };
  }

  // Apply frequency cap — filter out subscribers who've hit daily cap
  const eligible = [];
  for (const sub of subscribers) {
    if (!sub.fcm_token) continue; // skip subscribers without FCM token
    const count = await incrementPushCount(sub.id);
    if (count <= PUSH_CAP) {
      eligible.push(sub);
    }
  }

  const capped = subscribers.length - eligible.length;

  if (!eligible.length) {
    console.log(`[BLAST] Batch ${batch_num}: all ${subscribers.length} at frequency cap`);
    return { sent: 0, capped };
  }

  try {
    const { sent, failed } = await sendFCMBatch(eligible, job.data);

    // Update campaign sent counter
    await query(
      'UPDATE campaigns SET total_sent = total_sent + $1, updated_at = NOW() WHERE id = $2',
      [sent, campaign_id]
    );

    // Create campaign_send records for eligible subscribers
    const sendInserts = eligible.map(sub =>
      query(
        `INSERT INTO campaign_sends (campaign_id, subscriber_id, status, sent_at)
         VALUES ($1, $2, 'SENT', NOW())
         ON CONFLICT DO NOTHING`,
        [campaign_id, sub.id]
      )
    );
    await Promise.allSettled(sendInserts);

    console.log(`[BLAST] Batch ${batch_num}: sent=${sent}, failed=${failed}, capped=${capped}`);
    return { sent, failed, capped };

  } catch (err) {
    console.error(`[BLAST] Batch ${batch_num} failed:`, err.message);
    throw err; // BullMQ will retry
  }
}

// ── START WORKER ──
async function startWorker() {
  await connectRedis();

  const worker = new Worker('push-blast', processBatch, {
    connection: getRedis(),
    concurrency: 3, // 3 concurrent batch jobs
  });

  worker.on('completed', (job, result) => {
    console.log(`[BLAST] Job ${job.id} completed:`, JSON.stringify(result));
  });

  worker.on('failed', (job, err) => {
    console.error(`[BLAST] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', err => {
    console.error('[BLAST] Worker error:', err.message);
  });

  console.log('🚀 FCM Push blast worker started — listening for jobs...');
  console.log(`   Project: ${process.env.FCM_PROJECT_ID}`);
  console.log(`   Client:  ${process.env.FCM_CLIENT_EMAIL}`);
}

startWorker().catch(console.error);
