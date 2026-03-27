require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./src/db');

const workspacesRouter = require('./src/routes/workspaces');
const unipileRouter    = require('./src/routes/unipile');
const campaignsRouter  = require('./src/routes/campaigns');
const contactsRouter   = require('./src/routes/contacts');
const webhooksRouter   = require('./src/routes/webhooks');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/workspaces', workspacesRouter);
app.use('/api/unipile',    unipileRouter);
app.use('/api/campaigns',  campaignsRouter);
app.use('/api/contacts',   contactsRouter);
app.use('/api/webhooks',   webhooksRouter);

// Auto-run full schema + migration on every startup (all IF NOT EXISTS — safe to run repeatedly)
(async () => {
  try {
    // Full schema
    await db.query(`CREATE TABLE IF NOT EXISTS workspaces (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS unipile_accounts (
      id SERIAL PRIMARY KEY,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
      account_id VARCHAR(255) NOT NULL UNIQUE,
      display_name VARCHAR(255),
      provider VARCHAR(50) DEFAULT 'linkedin',
      status VARCHAR(50),
      webhook_id VARCHAR(255),
      invite_sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
      account_id VARCHAR(255),
      name VARCHAR(255) NOT NULL,
      status VARCHAR(50) DEFAULT 'draft',
      audience_type VARCHAR(50),
      settings JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
      first_name VARCHAR(255),
      last_name VARCHAR(255),
      company VARCHAR(255),
      title VARCHAR(255),
      li_profile_url TEXT,
      li_company_url TEXT,
      email VARCHAR(255),
      website VARCHAR(255),
      location VARCHAR(255),
      profile_data JSONB DEFAULT '{}',
      invite_sent BOOLEAN DEFAULT FALSE,
      invite_approved BOOLEAN DEFAULT FALSE,
      msg_sent BOOLEAN DEFAULT FALSE,
      msg_replied BOOLEAN DEFAULT FALSE,
      positive_reply BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    // Indexes
    await db.query('CREATE INDEX IF NOT EXISTS idx_contacts_campaign ON contacts(campaign_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_contacts_workspace ON contacts(workspace_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_campaigns_workspace ON campaigns(workspace_id)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_contacts_li_profile ON contacts(li_profile_url)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_contacts_invite_sent ON contacts(invite_sent)');
    // Migration columns (safe — IF NOT EXISTS)
    await db.query('ALTER TABLE unipile_accounts ADD COLUMN IF NOT EXISTS webhook_id VARCHAR(255)');
    await db.query('ALTER TABLE unipile_accounts ADD COLUMN IF NOT EXISTS invite_sent_at TIMESTAMP');
    console.log('[DB] Schema and migrations applied successfully');
  } catch (err) {
    console.error('[DB] Migration error:', err.message);
  }
})();

// Catch-all: serve index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Webhook endpoint: ${process.env.SERVER_URL || 'http://localhost:' + PORT}/api/webhooks/unipile`);
});
