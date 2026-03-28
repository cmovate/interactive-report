require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./src/db');

const workspacesRouter         = require('./src/routes/workspaces');
const unipileRouter            = require('./src/routes/unipile');
const campaignsRouter          = require('./src/routes/campaigns');
const contactsRouter           = require('./src/routes/contacts');
const companiesRouter          = require('./src/routes/companies');
const webhooksRouter           = require('./src/routes/webhooks');
const followersRouter          = require('./src/routes/followers');
const statsRouter              = require('./src/routes/stats');
const invitationSender         = require('./src/invitationSender');
const withdrawSender           = require('./src/withdrawSender');
const companyFollowSender      = require('./src/companyFollowSender');
const followerScraper          = require('./src/followerScraper');
const statsSnapshotter         = require('./src/statsSnapshotter');
const profileViewer            = require('./src/profileViewer');
const engagementScraper        = require('./src/engagementScraper');
const companyEngagementScraper = require('./src/companyEngagementScraper');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/workspaces', workspacesRouter);
app.use('/api/unipile',    unipileRouter);
app.use('/api/campaigns',  campaignsRouter);
app.use('/api/contacts',   contactsRouter);
app.use('/api/companies',  companiesRouter);
app.use('/api/webhooks',   webhooksRouter);
app.use('/api/followers',  followersRouter);
app.use('/api/stats',      statsRouter);

async function s(label, fn) {
  try { await fn(); }
  catch (err) { console.error(`[DB] ${label}: ${err.message}`); }
}

async function nukeIfBroken() {
  try {
    const { rows } = await db.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'campaigns' AND column_name = 'id'
    `);
    const idType = rows[0]?.data_type || '';
    if (idType === 'uuid') {
      console.log('[DB] Detected old UUID schema — dropping and rebuilding...');
      await db.query(`DROP TABLE IF EXISTS
        contacts, campaigns, unipile_accounts,
        company_followers, company_page_daily_stats,
        campaign_daily_stats, workspaces, campaign_companies CASCADE`);
    } else if (idType) {
      console.log(`[DB] Schema OK (id type: ${idType})`);
    }
  } catch (err) {
    console.log('[DB] nukeIfBroken skipped:', err.message);
  }
}

(async () => {
  await nukeIfBroken();

  await s('workspaces', () => db.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, created_at TIMESTAMP DEFAULT NOW()
    )
  `));

  await s('unipile_accounts', () => db.query(`
    CREATE TABLE IF NOT EXISTS unipile_accounts (
      id SERIAL PRIMARY KEY, workspace_id INTEGER,
      account_id VARCHAR(255) NOT NULL UNIQUE, display_name VARCHAR(255),
      provider VARCHAR(50) DEFAULT 'linkedin', status VARCHAR(50),
      webhook_id VARCHAR(255), settings JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `));

  await s('campaigns', () => db.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY, workspace_id INTEGER, account_id VARCHAR(255),
      name VARCHAR(255) NOT NULL, status VARCHAR(50) DEFAULT 'active',
      audience_type VARCHAR(50), settings JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `));

  await s('contacts', () => db.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY, campaign_id INTEGER, workspace_id INTEGER,
      first_name VARCHAR(255), last_name VARCHAR(255),
      company VARCHAR(255), title VARCHAR(255),
      li_profile_url TEXT, li_company_url TEXT,
      email VARCHAR(255), website VARCHAR(255), location VARCHAR(255),
      profile_data JSONB DEFAULT '{}',
      provider_id  VARCHAR(255),
      member_urn   VARCHAR(255),
      already_connected BOOLEAN DEFAULT FALSE,
      has_chat_history  BOOLEAN DEFAULT FALSE,
      chat_id           VARCHAR(255),
      invite_sent BOOLEAN DEFAULT FALSE, invite_approved BOOLEAN DEFAULT FALSE,
      invite_withdrawn BOOLEAN DEFAULT FALSE, invite_withdrawn_at TIMESTAMP,
      msg_sent BOOLEAN DEFAULT FALSE, msg_replied BOOLEAN DEFAULT FALSE,
      positive_reply BOOLEAN DEFAULT FALSE,
      company_follow_invited BOOLEAN DEFAULT FALSE,
      company_follow_confirmed BOOLEAN DEFAULT FALSE,
      last_profile_view_at TIMESTAMP, profile_view_count INTEGER DEFAULT 0,
      invite_sent_at TIMESTAMP, invite_approved_at TIMESTAMP,
      msg_sent_at TIMESTAMP, msg_replied_at TIMESTAMP,
      positive_reply_at TIMESTAMP,
      company_follow_invited_at TIMESTAMP, company_follow_confirmed_at TIMESTAMP,
      engagement_level      VARCHAR(30),
      engagement_scraped_at TIMESTAMP,
      engagement_data       JSONB,
      post_likes_sent       INTEGER DEFAULT 0,
      comment_likes_sent    INTEGER DEFAULT 0,
      likes_sent_at         TIMESTAMP,
      liked_ids             JSONB DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `));

  await s('campaign_companies', () => db.query(`
    CREATE TABLE IF NOT EXISTS campaign_companies (
      id                   SERIAL PRIMARY KEY,
      campaign_id          INTEGER NOT NULL,
      workspace_id         INTEGER,
      company_name         VARCHAR(255),
      li_company_url       TEXT,
      company_linkedin_id  VARCHAR(50),
      contact_count        INTEGER DEFAULT 1,
      engagement_level      VARCHAR(30),
      engagement_scraped_at TIMESTAMP,
      engagement_data       JSONB,
      post_likes_sent      INTEGER DEFAULT 0,
      likes_sent_at        TIMESTAMP,
      liked_ids            JSONB DEFAULT '[]',
      created_at           TIMESTAMP DEFAULT NOW(),
      UNIQUE(campaign_id, company_linkedin_id)
    )
  `));

  await s('company_followers', () => db.query(`
    CREATE TABLE IF NOT EXISTS company_followers (
      id SERIAL PRIMARY KEY, account_id VARCHAR(255) NOT NULL,
      follower_id VARCHAR(255) NOT NULL, follower_urn VARCHAR(255),
      name VARCHAR(255), headline TEXT, profile_url TEXT,
      first_seen_at TIMESTAMP DEFAULT NOW(), first_seen_position INTEGER,
      scraped_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(account_id, follower_id)
    )
  `));

  await s('campaign_daily_stats', () => db.query(`
    CREATE TABLE IF NOT EXISTS campaign_daily_stats (
      id SERIAL PRIMARY KEY, snapshot_date DATE NOT NULL,
      campaign_id INTEGER NOT NULL, workspace_id INTEGER, account_id VARCHAR(255),
      campaign_name VARCHAR(255), campaign_status VARCHAR(50),
      total_contacts INTEGER DEFAULT 0, invites_sent INTEGER DEFAULT 0,
      invites_approved INTEGER DEFAULT 0, messages_sent INTEGER DEFAULT 0,
      messages_replied INTEGER DEFAULT 0, positive_replies INTEGER DEFAULT 0,
      follow_invited INTEGER DEFAULT 0, follow_confirmed INTEGER DEFAULT 0,
      profile_views INTEGER DEFAULT 0, updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(snapshot_date, campaign_id)
    )
  `));

  await s('company_page_daily_stats', () => db.query(`
    CREATE TABLE IF NOT EXISTS company_page_daily_stats (
      id SERIAL PRIMARY KEY, snapshot_date DATE NOT NULL,
      account_id VARCHAR(255) NOT NULL, workspace_id INTEGER,
      total_followers INTEGER DEFAULT 0, updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(snapshot_date, account_id)
    )
  `));

  const indexes = [
    ['idx_contacts_campaign',          'contacts(campaign_id)'],
    ['idx_contacts_workspace',         'contacts(workspace_id)'],
    ['idx_campaigns_workspace',        'campaigns(workspace_id)'],
    ['idx_contacts_li_profile',        'contacts(li_profile_url)'],
    ['idx_contacts_provider_id',       'contacts(provider_id)'],
    ['idx_contacts_invite_sent',       'contacts(invite_sent)'],
    ['idx_contacts_approved',          'contacts(invite_approved)'],
    ['idx_contacts_withdrawn',         'contacts(invite_withdrawn)'],
    ['idx_contacts_connected',         'contacts(already_connected)'],
    ['idx_contacts_chat_history',      'contacts(has_chat_history)'],
    ['idx_contacts_profile_view',      'contacts(last_profile_view_at)'],
    ['idx_contacts_engagement',        'contacts(engagement_level)'],
    ['idx_contacts_likes_sent_at',     'contacts(likes_sent_at)'],
    ['idx_camp_companies_campaign',    'campaign_companies(campaign_id)'],
    ['idx_camp_companies_workspace',   'campaign_companies(workspace_id)'],
    ['idx_camp_companies_linkedin_id', 'campaign_companies(company_linkedin_id)'],
    ['idx_camp_companies_engagement',  'campaign_companies(engagement_level)'],
    ['idx_followers_account',          'company_followers(account_id)'],
    ['idx_followers_profile',          'company_followers(profile_url)'],
    ['idx_followers_first_seen',       'company_followers(first_seen_at)'],
    ['idx_daily_stats_date',           'campaign_daily_stats(snapshot_date)'],
    ['idx_daily_stats_campaign',       'campaign_daily_stats(campaign_id)'],
    ['idx_daily_stats_workspace',      'campaign_daily_stats(workspace_id)'],
    ['idx_page_stats_date',            'company_page_daily_stats(snapshot_date)'],
  ];
  for (const [name, col] of indexes) {
    await s(name, () => db.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${col}`));
  }

  const cols = [
    ['ua.webhook_id',          'unipile_accounts',    'webhook_id',                  'VARCHAR(255)'],
    ['ua.settings',            'unipile_accounts',    'settings',                    "JSONB DEFAULT '{}'"],
    ['c.workspace_id',         'campaigns',           'workspace_id',                'INTEGER'],
    ['c.account_id',           'campaigns',           'account_id',                  'VARCHAR(255)'],
    ['c.settings',             'campaigns',           'settings',                    "JSONB DEFAULT '{}'"],
    ['c.status',               'campaigns',           'status',                      "VARCHAR(50) DEFAULT 'active'"],
    ['c.audience_type',        'campaigns',           'audience_type',               'VARCHAR(50)'],
    ['ct.campaign_id',         'contacts',            'campaign_id',                 'INTEGER'],
    ['ct.workspace_id',        'contacts',            'workspace_id',                'INTEGER'],
    ['ct.provider_id',         'contacts',            'provider_id',                 'VARCHAR(255)'],
    ['ct.member_urn',          'contacts',            'member_urn',                  'VARCHAR(255)'],
    ['ct.already_connected',   'contacts',            'already_connected',           'BOOLEAN DEFAULT FALSE'],
    ['ct.has_chat_history',    'contacts',            'has_chat_history',            'BOOLEAN DEFAULT FALSE'],
    ['ct.chat_id',             'contacts',            'chat_id',                     'VARCHAR(255)'],
    ['ct.follow_inv',          'contacts',            'company_follow_invited',      'BOOLEAN DEFAULT FALSE'],
    ['ct.follow_conf',         'contacts',            'company_follow_confirmed',    'BOOLEAN DEFAULT FALSE'],
    ['ct.pv_at',               'contacts',            'last_profile_view_at',        'TIMESTAMP'],
    ['ct.pv_count',            'contacts',            'profile_view_count',          'INTEGER DEFAULT 0'],
    ['ct.inv_sent_at',         'contacts',            'invite_sent_at',              'TIMESTAMP'],
    ['ct.inv_appr_at',         'contacts',            'invite_approved_at',          'TIMESTAMP'],
    ['ct.inv_withdrawn',       'contacts',            'invite_withdrawn',            'BOOLEAN DEFAULT FALSE'],
    ['ct.inv_wdn_at',          'contacts',            'invite_withdrawn_at',         'TIMESTAMP'],
    ['ct.msg_sent_at',         'contacts',            'msg_sent_at',                 'TIMESTAMP'],
    ['ct.msg_rep_at',          'contacts',            'msg_replied_at',              'TIMESTAMP'],
    ['ct.pos_rep_at',          'contacts',            'positive_reply_at',           'TIMESTAMP'],
    ['ct.cf_inv_at',           'contacts',            'company_follow_invited_at',   'TIMESTAMP'],
    ['ct.cf_conf_at',          'contacts',            'company_follow_confirmed_at', 'TIMESTAMP'],
    ['cf.fsa',                 'company_followers',   'first_seen_at',               'TIMESTAMP DEFAULT NOW()'],
    ['cf.fsp',                 'company_followers',   'first_seen_position',         'INTEGER'],
    ['ds.profile_views',       'campaign_daily_stats','profile_views',               'INTEGER DEFAULT 0'],
    ['ct.eng_level',           'contacts',            'engagement_level',            'VARCHAR(30)'],
    ['ct.eng_scraped_at',      'contacts',            'engagement_scraped_at',       'TIMESTAMP'],
    ['ct.eng_data',            'contacts',            'engagement_data',             'JSONB'],
    ['ct.post_likes',          'contacts',            'post_likes_sent',             'INTEGER DEFAULT 0'],
    ['ct.comment_likes',       'contacts',            'comment_likes_sent',          'INTEGER DEFAULT 0'],
    ['ct.likes_sent_at',       'contacts',            'likes_sent_at',               'TIMESTAMP'],
    ['ct.liked_ids',           'contacts',            'liked_ids',                   "JSONB DEFAULT '[]'"],
    ['cc.eng_level',           'campaign_companies',  'engagement_level',            'VARCHAR(30)'],
    ['cc.eng_scraped_at',      'campaign_companies',  'engagement_scraped_at',       'TIMESTAMP'],
    ['cc.eng_data',            'campaign_companies',  'engagement_data',             'JSONB'],
    ['cc.post_likes',          'campaign_companies',  'post_likes_sent',             'INTEGER DEFAULT 0'],
    ['cc.likes_sent_at',       'campaign_companies',  'likes_sent_at',               'TIMESTAMP'],
    ['cc.liked_ids',           'campaign_companies',  'liked_ids',                   "JSONB DEFAULT '[]'"],
    ['cc.contact_count',       'campaign_companies',  'contact_count',               'INTEGER DEFAULT 1'],
  ];
  for (const [label, table, col, type] of cols) {
    await s(label, () => db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`));
  }

  // Repair likes_sent_at + liked_ids for contacts liked before columns existed
  await s('repair.likes_sent_at', async () => {
    const { rowCount } = await db.query(`
      UPDATE contacts SET likes_sent_at = NOW()
      WHERE (post_likes_sent > 0 OR comment_likes_sent > 0) AND likes_sent_at IS NULL
    `);
    if (rowCount > 0) console.log(`[DB] Repaired likes_sent_at for ${rowCount} contact(s)`);
  });

  await s('repair.liked_ids', async () => {
    const { rows } = await db.query(`
      SELECT id, post_likes_sent, comment_likes_sent, engagement_data FROM contacts
      WHERE (post_likes_sent > 0 OR comment_likes_sent > 0)
        AND (liked_ids IS NULL OR liked_ids::text = '[]' OR liked_ids::text = 'null')
        AND engagement_data IS NOT NULL
    `);
    for (const row of rows) {
      const d = typeof row.engagement_data === 'string' ? JSON.parse(row.engagement_data) : row.engagement_data;
      const ids = [];
      const posts = d.non_employer_posts_14d_data || d.posts_14d_data || [];
      for (let i = 0; i < Math.min(row.post_likes_sent, posts.length); i++) {
        const sid = String(posts[i].social_id || posts[i].id || posts[i].post_id || '');
        if (sid) ids.push(sid);
      }
      const comments = d.non_employer_comments_14d_data || d.comments_14d_data || [];
      for (let i = 0; i < Math.min(row.comment_likes_sent, comments.length); i++) {
        const cid = String(comments[i].id || comments[i].comment_id || '');
        if (cid) ids.push(`comment:${cid}`);
      }
      if (ids.length > 0) {
        await db.query('UPDATE contacts SET liked_ids = $1::jsonb WHERE id = $2', [JSON.stringify(ids), row.id]);
      }
    }
  });

  // Auto-backfill campaign_companies on every startup
  await s('backfill.campaign_companies', async () => {
    const { rows: contacts } = await db.query(`
      SELECT
        id, campaign_id, workspace_id, company, li_company_url,
        profile_data->'work_experience'->0->>'company_id' AS company_linkedin_id,
        profile_data->'work_experience'->0->>'company'    AS company_from_exp
      FROM contacts
      WHERE profile_data IS NOT NULL
        AND profile_data::text != '{}'
        AND profile_data::text != 'null'
        AND profile_data->'work_experience'->0->>'company_id' IS NOT NULL
        AND campaign_id IS NOT NULL
      ORDER BY campaign_id, profile_data->'work_experience'->0->>'company_id'
    `);
    if (!contacts.length) return;
    const groups = {};
    for (const c of contacts) {
      const key = `${c.campaign_id}:${c.company_linkedin_id}`;
      if (!groups[key]) {
        groups[key] = {
          campaign_id: c.campaign_id, workspace_id: c.workspace_id,
          company_name: c.company_from_exp || c.company || '',
          li_company_url: c.li_company_url || `https://www.linkedin.com/company/${c.company_linkedin_id}`,
          company_linkedin_id: c.company_linkedin_id, count: 0,
        };
      }
      groups[key].count++;
    }
    let upserted = 0;
    for (const g of Object.values(groups)) {
      await db.query(
        `INSERT INTO campaign_companies
           (campaign_id, workspace_id, company_name, li_company_url, company_linkedin_id, contact_count)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (campaign_id, company_linkedin_id)
         DO UPDATE SET company_name = EXCLUDED.company_name,
                       li_company_url = EXCLUDED.li_company_url,
                       contact_count  = EXCLUDED.contact_count`,
        [g.campaign_id, g.workspace_id, g.company_name, g.li_company_url, g.company_linkedin_id, g.count]
      );
      upserted++;
    }
    console.log(`[DB] campaign_companies backfill: ${upserted} companies from ${contacts.length} contacts`);
  });

  console.log('[DB] Schema ready');

  invitationSender.start();
  withdrawSender.start();
  companyFollowSender.start();
  followerScraper.start();
  statsSnapshotter.start();
  profileViewer.start();
  engagementScraper.start();
  companyEngagementScraper.start();
})();

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Webhook endpoint: ${process.env.SERVER_URL || 'http://localhost:' + PORT}/api/webhooks/unipile`);
});
