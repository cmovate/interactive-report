require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./src/db');

const workspacesRouter    = require('./src/routes/workspaces');
const unipileRouter       = require('./src/routes/unipile');
const campaignsRouter     = require('./src/routes/campaigns');
const contactsRouter      = require('./src/routes/contacts');
const webhooksRouter      = require('./src/routes/webhooks');
const followersRouter     = require('./src/routes/followers');
const statsRouter         = require('./src/routes/stats');
const invitationSender    = require('./src/invitationSender');
const companyFollowSender = require('./src/companyFollowSender');
const followerScraper     = require('./src/followerScraper');
const statsSnapshotter    = require('./src/statsSnapshotter');
const profileViewer       = require('./src/profileViewer');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/workspaces', workspacesRouter);
app.use('/api/unipile',    unipileRouter);
app.use('/api/campaigns',  campaignsRouter);
app.use('/api/contacts',   contactsRouter);
app.use('/api/webhooks',   webhooksRouter);
app.use('/api/followers',  followersRouter);
app.use('/api/stats',      statsRouter);

// Each migration step runs independently — one failure never blocks the rest
async function safeRun(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[DB] ${label}: ${err.message}`);
  }
}

(async () => {
  // ── Core tables ────────────────────────────────────────────────────────────
  await safeRun('workspaces', () => db.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `));

  await safeRun('unipile_accounts', () => db.query(`
    CREATE TABLE IF NOT EXISTS unipile_accounts (
      id SERIAL PRIMARY KEY,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
      account_id VARCHAR(255) NOT NULL UNIQUE,
      display_name VARCHAR(255),
      provider VARCHAR(50) DEFAULT 'linkedin',
      status VARCHAR(50),
      webhook_id VARCHAR(255),
      settings JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `));

  await safeRun('campaigns', () => db.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
      account_id VARCHAR(255),
      name VARCHAR(255) NOT NULL,
      status VARCHAR(50) DEFAULT 'active',
      audience_type VARCHAR(50),
      settings JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `));

  await safeRun('contacts', () => db.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
      first_name VARCHAR(255), last_name VARCHAR(255),
      company VARCHAR(255), title VARCHAR(255),
      li_profile_url TEXT, li_company_url TEXT,
      email VARCHAR(255), website VARCHAR(255), location VARCHAR(255),
      profile_data JSONB DEFAULT '{}',
      invite_sent              BOOLEAN DEFAULT FALSE,
      invite_approved          BOOLEAN DEFAULT FALSE,
      msg_sent                 BOOLEAN DEFAULT FALSE,
      msg_replied              BOOLEAN DEFAULT FALSE,
      positive_reply           BOOLEAN DEFAULT FALSE,
      company_follow_invited   BOOLEAN DEFAULT FALSE,
      company_follow_confirmed BOOLEAN DEFAULT FALSE,
      last_profile_view_at     TIMESTAMP,
      profile_view_count       INTEGER DEFAULT 0,
      invite_sent_at              TIMESTAMP,
      invite_approved_at          TIMESTAMP,
      msg_sent_at                 TIMESTAMP,
      msg_replied_at              TIMESTAMP,
      positive_reply_at           TIMESTAMP,
      company_follow_invited_at   TIMESTAMP,
      company_follow_confirmed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `));

  await safeRun('company_followers', () => db.query(`
    CREATE TABLE IF NOT EXISTS company_followers (
      id SERIAL PRIMARY KEY,
      account_id VARCHAR(255) NOT NULL,
      follower_id VARCHAR(255) NOT NULL,
      follower_urn VARCHAR(255),
      name VARCHAR(255),
      headline TEXT,
      profile_url TEXT,
      first_seen_at TIMESTAMP DEFAULT NOW(),
      first_seen_position INTEGER,
      scraped_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(account_id, follower_id)
    )
  `));

  await safeRun('campaign_daily_stats', () => db.query(`
    CREATE TABLE IF NOT EXISTS campaign_daily_stats (
      id SERIAL PRIMARY KEY,
      snapshot_date    DATE         NOT NULL,
      campaign_id      INTEGER      NOT NULL,
      workspace_id     INTEGER,
      account_id       VARCHAR(255),
      campaign_name    VARCHAR(255),
      campaign_status  VARCHAR(50),
      total_contacts   INTEGER DEFAULT 0,
      invites_sent     INTEGER DEFAULT 0,
      invites_approved INTEGER DEFAULT 0,
      messages_sent    INTEGER DEFAULT 0,
      messages_replied INTEGER DEFAULT 0,
      positive_replies INTEGER DEFAULT 0,
      follow_invited   INTEGER DEFAULT 0,
      follow_confirmed INTEGER DEFAULT 0,
      profile_views    INTEGER DEFAULT 0,
      updated_at       TIMESTAMP DEFAULT NOW(),
      UNIQUE(snapshot_date, campaign_id)
    )
  `));

  await safeRun('company_page_daily_stats', () => db.query(`
    CREATE TABLE IF NOT EXISTS company_page_daily_stats (
      id SERIAL PRIMARY KEY,
      snapshot_date   DATE          NOT NULL,
      account_id      VARCHAR(255)  NOT NULL,
      workspace_id    INTEGER,
      total_followers INTEGER DEFAULT 0,
      updated_at      TIMESTAMP DEFAULT NOW(),
      UNIQUE(snapshot_date, account_id)
    )
  `));

  // ── Indexes ────────────────────────────────────────────────────────────────
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_contacts_campaign         ON contacts(campaign_id)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_workspace        ON contacts(workspace_id)',
    'CREATE INDEX IF NOT EXISTS idx_campaigns_workspace       ON campaigns(workspace_id)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_li_profile       ON contacts(li_profile_url)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_invite_sent      ON contacts(invite_sent)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_approved         ON contacts(invite_approved)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_profile_view     ON contacts(last_profile_view_at)',
    'CREATE INDEX IF NOT EXISTS idx_followers_account         ON company_followers(account_id)',
    'CREATE INDEX IF NOT EXISTS idx_followers_profile         ON company_followers(profile_url)',
    'CREATE INDEX IF NOT EXISTS idx_followers_first_seen      ON company_followers(first_seen_at)',
    'CREATE INDEX IF NOT EXISTS idx_daily_stats_date          ON campaign_daily_stats(snapshot_date)',
    'CREATE INDEX IF NOT EXISTS idx_daily_stats_campaign      ON campaign_daily_stats(campaign_id)',
    'CREATE INDEX IF NOT EXISTS idx_daily_stats_workspace     ON campaign_daily_stats(workspace_id)',
    'CREATE INDEX IF NOT EXISTS idx_page_stats_date           ON company_page_daily_stats(snapshot_date)',
  ];
  for (const sql of indexes) {
    await safeRun(sql.split(' ')[6], () => db.query(sql));
  }

  // ── Migration columns — each independent ──────────────────────────────────
  const migrations = [
    ["ua.webhook_id",          "ALTER TABLE unipile_accounts ADD COLUMN IF NOT EXISTS webhook_id VARCHAR(255)"],
    ["ua.settings",            "ALTER TABLE unipile_accounts ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'"],
    ["campaigns.workspace_id", "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS workspace_id INTEGER"],
    ["campaigns.account_id",   "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS account_id VARCHAR(255)"],
    ["campaigns.settings",     "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'"],
    ["campaigns.status",       "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active'"],
    ["contacts.follow_invited",    "ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_follow_invited BOOLEAN DEFAULT FALSE"],
    ["contacts.follow_confirmed",  "ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_follow_confirmed BOOLEAN DEFAULT FALSE"],
    ["contacts.profile_view_at",   "ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_profile_view_at TIMESTAMP"],
    ["contacts.profile_view_count","ALTER TABLE contacts ADD COLUMN IF NOT EXISTS profile_view_count INTEGER DEFAULT 0"],
    ["contacts.invite_sent_at",    "ALTER TABLE contacts ADD COLUMN IF NOT EXISTS invite_sent_at TIMESTAMP"],
    ["contacts.invite_approved_at","ALTER TABLE contacts ADD COLUMN IF NOT EXISTS invite_approved_at TIMESTAMP"],
    ["contacts.msg_sent_at",       "ALTER TABLE contacts ADD COLUMN IF NOT EXISTS msg_sent_at TIMESTAMP"],
    ["contacts.msg_replied_at",    "ALTER TABLE contacts ADD COLUMN IF NOT EXISTS msg_replied_at TIMESTAMP"],
    ["contacts.positive_reply_at", "ALTER TABLE contacts ADD COLUMN IF NOT EXISTS positive_reply_at TIMESTAMP"],
    ["contacts.cf_invited_at",     "ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_follow_invited_at TIMESTAMP"],
    ["contacts.cf_confirmed_at",   "ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_follow_confirmed_at TIMESTAMP"],
    ["followers.first_seen_at",    "ALTER TABLE company_followers ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMP DEFAULT NOW()"],
    ["followers.first_seen_pos",   "ALTER TABLE company_followers ADD COLUMN IF NOT EXISTS first_seen_position INTEGER"],
    ["daily_stats.profile_views",  "ALTER TABLE campaign_daily_stats ADD COLUMN IF NOT EXISTS profile_views INTEGER DEFAULT 0"],
  ];
  for (const [label, sql] of migrations) {
    await safeRun(label, () => db.query(sql));
  }

  console.log('[DB] Schema and migrations complete');

  // ── Start scheduled services ────────────────────────────────────────────
  invitationSender.start();
  companyFollowSender.start();
  followerScraper.start();
  statsSnapshotter.start();
  profileViewer.start();
})();

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Webhook endpoint: ${process.env.SERVER_URL || 'http://localhost:' + PORT}/api/webhooks/unipile`);
});
