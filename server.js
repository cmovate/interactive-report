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

(async () => {
  try {
    // ── Core tables ──────────────────────────────────────────────────────────
    await db.query(`CREATE TABLE IF NOT EXISTS workspaces (
      id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, created_at TIMESTAMP DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS unipile_accounts (
      id SERIAL PRIMARY KEY,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
      account_id VARCHAR(255) NOT NULL UNIQUE,
      display_name VARCHAR(255),
      provider VARCHAR(50) DEFAULT 'linkedin',
      status VARCHAR(50),
      webhook_id VARCHAR(255),
      settings JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
      account_id VARCHAR(255),
      name VARCHAR(255) NOT NULL,
      status VARCHAR(50) DEFAULT 'active',
      audience_type VARCHAR(50),
      settings JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
      first_name VARCHAR(255), last_name VARCHAR(255),
      company VARCHAR(255), title VARCHAR(255),
      li_profile_url TEXT, li_company_url TEXT,
      email VARCHAR(255), website VARCHAR(255), location VARCHAR(255),
      profile_data JSONB DEFAULT '{}',
      -- Status flags
      invite_sent              BOOLEAN DEFAULT FALSE,
      invite_approved          BOOLEAN DEFAULT FALSE,
      msg_sent                 BOOLEAN DEFAULT FALSE,
      msg_replied              BOOLEAN DEFAULT FALSE,
      positive_reply           BOOLEAN DEFAULT FALSE,
      company_follow_invited   BOOLEAN DEFAULT FALSE,
      company_follow_confirmed BOOLEAN DEFAULT FALSE,
      -- Profile view tracking
      last_profile_view_at     TIMESTAMP,
      profile_view_count       INTEGER DEFAULT 0,
      -- Event timestamps
      invite_sent_at              TIMESTAMP,
      invite_approved_at          TIMESTAMP,
      msg_sent_at                 TIMESTAMP,
      msg_replied_at              TIMESTAMP,
      positive_reply_at           TIMESTAMP,
      company_follow_invited_at   TIMESTAMP,
      company_follow_confirmed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // ── Company followers table ───────────────────────────────────────────────
    await db.query(`CREATE TABLE IF NOT EXISTS company_followers (
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
    )`);

    // ── Historical snapshots ─────────────────────────────────────────────────
    await db.query(`CREATE TABLE IF NOT EXISTS campaign_daily_stats (
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
    )`);

    await db.query(`CREATE TABLE IF NOT EXISTS company_page_daily_stats (
      id SERIAL PRIMARY KEY,
      snapshot_date   DATE          NOT NULL,
      account_id      VARCHAR(255)  NOT NULL,
      workspace_id    INTEGER,
      total_followers INTEGER DEFAULT 0,
      updated_at      TIMESTAMP DEFAULT NOW(),
      UNIQUE(snapshot_date, account_id)
    )`);

    // ── Indexes ───────────────────────────────────────────────────────────────
    await db.query('CREATE INDEX IF NOT EXISTS idx_contacts_campaign         ON contacts(campaign_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_contacts_workspace        ON contacts(workspace_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_campaigns_workspace       ON campaigns(workspace_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_contacts_li_profile       ON contacts(li_profile_url)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_contacts_invite_sent      ON contacts(invite_sent)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_contacts_approved         ON contacts(invite_approved)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_contacts_profile_view     ON contacts(last_profile_view_at)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_followers_account         ON company_followers(account_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_followers_profile         ON company_followers(profile_url)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_followers_first_seen      ON company_followers(first_seen_at)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_daily_stats_date          ON campaign_daily_stats(snapshot_date)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_daily_stats_campaign      ON campaign_daily_stats(campaign_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_daily_stats_workspace     ON campaign_daily_stats(workspace_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_page_stats_date           ON company_page_daily_stats(snapshot_date)');

    // ── Migration columns (safe — IF NOT EXISTS) ──────────────────────────
    await db.query("ALTER TABLE unipile_accounts ADD COLUMN IF NOT EXISTS webhook_id VARCHAR(255)");
    await db.query("ALTER TABLE unipile_accounts ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'");
    await db.query("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_follow_invited   BOOLEAN DEFAULT FALSE");
    await db.query("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_follow_confirmed BOOLEAN DEFAULT FALSE");
    await db.query("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_profile_view_at     TIMESTAMP");
    await db.query("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS profile_view_count       INTEGER DEFAULT 0");
    await db.query("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS invite_sent_at              TIMESTAMP");
    await db.query("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS invite_approved_at          TIMESTAMP");
    await db.query("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS msg_sent_at                 TIMESTAMP");
    await db.query("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS msg_replied_at              TIMESTAMP");
    await db.query("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS positive_reply_at           TIMESTAMP");
    await db.query("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_follow_invited_at   TIMESTAMP");
    await db.query("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_follow_confirmed_at TIMESTAMP");
    await db.query("ALTER TABLE company_followers ADD COLUMN IF NOT EXISTS first_seen_at       TIMESTAMP DEFAULT NOW()");
    await db.query("ALTER TABLE company_followers ADD COLUMN IF NOT EXISTS first_seen_position INTEGER");
    await db.query("ALTER TABLE campaign_daily_stats ADD COLUMN IF NOT EXISTS profile_views INTEGER DEFAULT 0");

    console.log('[DB] Schema and migrations applied successfully');
  } catch (err) {
    console.error('[DB] Migration error:', err.message);
  }

  // ── Start scheduled services ──────────────────────────────────────────────
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
