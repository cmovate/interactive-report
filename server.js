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

// ONE-TIME migration endpoint — auto-runs on startup then removes itself
(async () => {
  try {
    await db.query('ALTER TABLE unipile_accounts ADD COLUMN IF NOT EXISTS webhook_id VARCHAR(255)');
    await db.query('ALTER TABLE unipile_accounts ADD COLUMN IF NOT EXISTS invite_sent_at TIMESTAMP');
    await db.query('CREATE INDEX IF NOT EXISTS idx_contacts_li_profile ON contacts(li_profile_url)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_contacts_invite_sent ON contacts(invite_sent)');
    console.log('[Migration] schema_migration.sql applied successfully');
  } catch (err) {
    console.error('[Migration] Error:', err.message);
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
