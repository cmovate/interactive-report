require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

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

// Catch-all: serve index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Webhook endpoint: ${process.env.SERVER_URL || 'http://localhost:' + PORT}/api/webhooks/unipile`);
});
