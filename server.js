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

// Silent per-step runner
async function s(label, fn) {
  try { await fn(); }
  catch (err) { console.error(`[DB] ${label}: ${err.message}`); }
}

/**
 * Detect if the DB contains old Codex schema (UUID primary keys).
 * If yes — drop everything and start fresh.
 * This runs once on startup and is a no-op on a clean DB.
 */
async function nukeIfBroken() {
  try {
    const { rows } = await db.query(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_name = 'campaigns' AND column_name = 'id'
    `);
    const idType = rows[0]?.data_type || '';
    if (idType === 'uuid') {
      console.log('[DB] Detected old Codex UUID schema — dropping all tables and starting fresh...');
      await db.query(`
        DROP TABLE IF EXISTS
          contacts, campaigns, unipile_accounts,
          company_followers, company_page_daily_stats,
          campaign_daily_stats, workspaces
        CASCADE
      `);
      console.log('[DB] All old tables dropped.');
    } else if (idType) {
      console.log(`[DB] Schema OK (campaigns.id type: ${idType})`);
    }
    // If table doesn't exist yet — nothing to drop, proceed normally
  } catch (err) {
    console.log('[DB] nukeIfBroken check skipped:', err.message);
  }
}

(async () => {
  await nukeIfBroken();

  // ── Core tables (no FK constraints — keeps things clean on legacy DBs) ───
  await s('workspaces', () => db.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id   SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `));

  await s('unipile_accounts', () => db.query(`
    CREATE TABLE IF NOT EXISTS unipile_accounts (
      id           SERIAL PRIMARY KEY,
      workspace_id INTEGER,
      account_id   VARCHAR(255) NOT NULL UNIQUE,
      display_name VARCHAR(255),
      provider     VARCHAR(50)  DEFAULT 'linkedin',
      status       VARCHAR(50),
      webhook_id   VARCHAR(255),
      settings     JSONB DEFAULT '{}',
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `));

  await s('campaigns', () => db.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id            SERIAL PRIMARY KEY,
      workspace_id  INTEGER,
      account_id    VARCHAR(255),
      name          VARCHAR(255) NOT NULL,
      status        VARCHAR(50)  DEFAULT 'active',
      audience_type VARCHAR(50),
      settings      JSONB DEFAULT '{}',
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `));

  await s('contacts', () => db.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id           SERIAL PRIMARY KEY,
      campaign_id  INTEGER,
      workspace_id INTEGER,
      first_name   VARCHAR(255), last_name  VARCHAR(255),
      company      VARCHAR(255), title      VARCHAR(255),
      li_profile_url TEXT, li_company_url TEXT,
      email        VARCHAR(255), website    VARCHAR(255), location VARCHAR(255),
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

  await s('company_followers', () => db.query(`
    CREATE TABLE IF NOT EXISTS company_followers (
      id           SERIAL PRIMARY KEY,
      account_id   VARCHAR(255) NOT NULL,
      follower_id  VARCHAR(255) NOT NULL,
      follower_urn VARCHAR(255),
      name         VARCHAR(255),
      headline     TEXT,
      profile_url  TEXT,
      first_seen_at       TIMESTAMP DEFAULT NOW(),
      first_seen_position INTEGER,
      scraped_at   TIMESTAMP DEFAULT NOW(),
      UNIQUE(account_id, follower_id)
    )
  `));

  await s('campaign_daily_stats', () => db.query(`
    CREATE TABLE IF NOT EXISTS campaign_daily_stats (
      id               SERIAL PRIMARY KEY,
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

  await s('company_page_daily_stats', () => db.query(`
    CREATE TABLE IF NOT EXISTS company_page_daily_stats (
      id              SERIAL PRIMARY KEY,
      snapshot_date   DATE         NOT NULL,
      account_id      VARCHAR(255) NOT NULL,
      workspace_id    INTEGER,
      total_followers INTEGER DEFAULT 0,
      updated_at      TIMESTAMP DEFAULT NOW(),
      UNIQUE(snapshot_date, account_id)
    )
  `));

  // ── Indexes ──────────────────────────────────────────────────────────────
  const indexes = [
    ['idx_contacts_campaign',     'contacts(campaign_id)'],
    ['idx_contacts_workspace',    'contacts(workspace_id)'],
    ['idx_campaigns_workspace',   'campaigns(workspace_id)'],
    ['idx_contacts_li_profile',   'contacts(li_profile_url)'],
    ['idx_contacts_invite_sent',  'contacts(invite_sent)'],
    ['idx_contacts_approved',     'contacts(invite_approved)'],
    ['idx_contacts_profile_view', 'contacts(last_profile_view_at)'],
    ['idx_followers_account',     'company_followers(account_id)'],
    ['idx_followers_profile',     'company_followers(profile_url)'],
    ['idx_followers_first_seen',  'company_followers(first_seen_at)'],
    ['idx_daily_stats_date',      'campaign_daily_stats(snapshot_date)'],
    ['idx_daily_stats_campaign',  'campaign_daily_stats(campaign_id)'],
    ['idx_daily_stats_workspace', 'campaign_daily_stats(workspace_id)'],
    ['idx_page_stats_date',       'company_page_daily_stats(snapshot_date)'],
  ];
  for (const [name, col] of indexes) {
    await s(name, () => db.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${col}`));
  }

  // ── Add any missing columns (safe on existing tables) ───────────────────
  const cols = [
    ['ua.webhook_id',       'unipile_accounts',       'webhook_id',                'VARCHAR(255)'],
    ['ua.settings',         'unipile_accounts',       'settings',                  "JSONB DEFAULT '{}'"],
    ['c.workspace_id',      'campaigns',              'workspace_id',              'INTEGER'],
    ['c.account_id',        'campaigns',              'account_id',                'VARCHAR(255)'],
    ['c.settings',          'campaigns',              'settings',                  "JSONB DEFAULT '{}'"],
    ['c.status',            'campaigns',              'status',                    "VARCHAR(50) DEFAULT 'active'"],
    ['c.audience_type',     'campaigns',              'audience_type',             'VARCHAR(50)'],
    ['ct.campaign_id',      'contacts',               'campaign_id',               'INTEGER'],
    ['ct.workspace_id',     'contacts',               'workspace_id',              'INTEGER'],
    ['ct.follow_inv',       'contacts',               'company_follow_invited',    'BOOLEAN DEFAULT FALSE'],
    ['ct.follow_conf',      'contacts',               'company_follow_confirmed',  'BOOLEAN DEFAULT FALSE'],
    ['ct.pv_at',            'contacts',               'last_profile_view_at',      'TIMESTAMP'],
    ['ct.pv_count',         'contacts',               'profile_view_count',        'INTEGER DEFAULT 0'],
    ['ct.inv_sent_at',      'contacts',               'invite_sent_at',            'TIMESTAMP'],
    ['ct.inv_appr_at',      'contacts',               'invite_approved_at',        'TIMESTAMP'],
    ['ct.msg_sent_at',      'contacts',               'msg_sent_at',               'TIMESTAMP'],
    ['ct.msg_rep_at',       'contacts',               'msg_replied_at',            'TIMESTAMP'],
    ['ct.pos_rep_at',       'contacts',               'positive_reply_at',         'TIMESTAMP'],
    ['ct.cf_inv_at',        'contacts',               'company_follow_invited_at', 'TIMESTAMP'],
    ['ct.cf_conf_at',       'contacts',               'company_follow_confirmed_at','TIMESTAMP'],
    ['cf.fsa',              'company_followers',      'first_seen_at',             'TIMESTAMP DEFAULT NOW()'],
    ['cf.fsp',              'company_followers',      'first_seen_position',       'INTEGER'],
    ['ds.profile_views',    'campaign_daily_stats',   'profile_views',             'INTEGER DEFAULT 0'],
  ];
  for (const [label, table, col, type] of cols) {
    await s(label, () => db.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`
    ));
  }

  console.log('[DB] Schema ready');

  // ── Start scheduled services ─────────────────────────────────────────────
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
