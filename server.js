require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const workspacesRouter = require('./src/routes/workspaces');
const unipileRouter = require('./src/routes/unipile');
const campaignsRouter = require('./src/routes/campaigns');
const contactsRouter = require('./src/routes/contacts');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/workspaces', workspacesRouter);
app.use('/api/unipile', unipileRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/contacts', contactsRouter);

// Catch-all: serve index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
