# VAS Traffic Engine — API

In-house VAS subscriber acquisition platform for MTN Nigeria.

## Quick Start (Local Dev)

### 1. Install dependencies
```bash
npm install
```

### 2. Start PostgreSQL + Redis (Docker)
```bash
docker-compose up -d
```

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env with your values
```

### 4. Run database migration
```bash
npm run migrate
```

### 5. Start the API
```bash
npm run dev
```

### 6. Start the blast worker (separate terminal)
```bash
node src/jobs/blastWorker.js
```

### Check health
```
GET http://localhost:3000/health
```

---

## API Endpoints

### Subscribers
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/subscribers/collect` | Public | Push opt-in from content pages |
| GET | `/api/v1/subscribers/stats` | Admin | Overall subscriber stats |
| GET | `/api/v1/subscribers` | Admin | Paginated subscriber list |

### Campaigns
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/campaigns` | Admin | Create campaign |
| GET | `/api/v1/campaigns` | Admin | List campaigns |
| GET | `/api/v1/campaigns/:id` | Admin | Get single campaign |
| POST | `/api/v1/campaigns/:id/send` | Admin | Enqueue blast |
| POST | `/api/v1/campaigns/:id/pause` | Admin | Pause blast |

### Analytics
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/analytics/dashboard` | Admin | KPI dashboard |
| GET | `/api/v1/analytics/content-pages` | Admin | Page performance |
| GET | `/api/v1/analytics/funnel/:id` | Admin | Campaign funnel (Sprint 8) |
| GET | `/api/v1/analytics/retention` | Admin | Cohort table (Sprint 8) |

### Admin
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/admin/login` | Public | Get JWT token |

### Webhooks
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/webhooks/mtn/billing` | HMAC | MTN billing event (Sprint 7) |
| POST | `/webhooks/onesignal/events` | None | Push delivery events (Sprint 7) |
| GET | `/webhooks/propellerads/postback` | None | Spend tracking (Sprint 9) |

---

## Project Structure
```
api/
├── src/
│   ├── app.js                  # Express app entry point
│   ├── routes/
│   │   ├── subscribers.js      # Push opt-in collection
│   │   ├── campaigns.js        # Campaign management + blast
│   │   ├── analytics.js        # Analytics endpoints
│   │   ├── webhooks.js         # MTN + OneSignal + PropellerAds
│   │   └── admin.js            # Auth
│   ├── controllers/
│   │   └── subscriberController.js
│   ├── middleware/
│   │   ├── auth.js             # JWT admin auth
│   │   └── errorHandler.js
│   ├── db/
│   │   ├── client.js           # PostgreSQL pool
│   │   ├── redis.js            # Redis client + helpers
│   │   └── migrate.js          # Full DB schema + seed
│   └── jobs/
│       └── blastWorker.js      # BullMQ push blast worker
├── docker-compose.yml
├── package.json
├── .env.example
└── README.md
```

---

## Build Phases

| Phase | Sprints | Status |
|-------|---------|--------|
| 1: Content Pages + Push SDK | S1–S2 | ✅ In Progress |
| 2: Carrier Qualification + WAP Pages | S3–S4 | ⏳ Next |
| 3: OneSignal + Campaign Blast | S5–S6 | ⏳ Planned |
| 4: Conversion Tracking + Analytics | S7–S9 | ⏳ Planned |
| 5: Hardening + Launch | S10 | ⏳ Planned |
