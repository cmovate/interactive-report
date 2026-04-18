/**
 * syncSignals.js — runs every 15 minutes
 *
 * Polls Unipile /api/v1/chats for each workspace account.
 * Finds chats where the other person's last message is unread/recent.
 * Enriches them, calls Claude Haiku for AI scoring, saves to signals table.
 */

const db = require('../db');
const https = require('https');

async function fetchChats(accountId, limit) {
  const { request } = require('../unipile');
  try {
    const d = await request('/api/v1/chats?account_id=' + accountId + '&limit=' + limit);
    return Array.isArray(d && d.items) ? d.items : [];
  } catch(e) { console.warn('[SyncSignals] fetchChats: ' + e.message); return []; }
}

async function fetchMessages(accountId, chatId) {
  const { request } = require('../unipile');
  try {
    const d = await request('/api/v1/chats/' + chatId + '/messages?account_id=' + accountId + '&limit=5');
    return Array.isArray(d && d.items) ? d.items : [];
  } catch(e) { return []; }
}

async function enrichPerson(accountId, providerId) {
  const { enrichProfile } = require('../unipile');
  try {
    const url = 'https://www.linkedin.com/in/' + providerId;
    const d = await enrichProfile(accountId, url);
    return {
      name: ([d && d.first_name, d && d.last_name].filter(Boolean).join(' ')) || (d && d.full_name) || null,
      title: (d && d.occupation) || (d && d.headline) || null,
      company: (d && d.company && d.company.name) || null,
      li_url: url,
    };
  } catch(e) { return { li_url: 'https://www.linkedin.com/in/' + providerId }; }
}

async function aiScore(person, message, workspace) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system: 'You analyze LinkedIn inbound signals for B2B outreach. Return JSON only: {"priority":"HOT"|"WARM"|"COLD","action":"reply_now"|"add_to_campaign"|"ignore","reason":"one sentence","fit_score":1-10}. HOT=decision maker who initiated contact. WARM=relevant but unclear intent. COLD=spam/irrelevant.',
    messages: [{ role: 'user', content: 'Person: ' + JSON.stringify(person) + '\nMessage: "' + (message || '').slice(0, 300) + '"' }]
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY,
                   'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req.on('error', reject); req.write(body); req.end();
    });
    const text = (result.content && result.content[0] && result.content[0].text) || '';
    return JSON.parse(text.trim());
  } catch(e) { return null; }
}

async function handler() {
  const { rows: accounts } = await db.query(
    'SELECT ua.account_id, ua.display_name, ua.workspace_id, w.name AS workspace_name' +
    ' FROM unipile_accounts ua JOIN workspaces w ON w.id = ua.workspace_id' +
    ' WHERE ua.status IS NULL OR ua.status = $1', ['active']
  );

  if (!accounts.length) { console.log('[SyncSignals] No accounts'); return; }
  console.log('[SyncSignals] Scanning ' + accounts.length + ' accounts');

  let totalNew = 0;

  for (const acc of accounts) {
    try {
      const chats = await fetchChats(acc.account_id, 50);
      console.log('[SyncSignals] ' + acc.display_name + ': ' + chats.length + ' chats');

      for (const chat of chats) {
        if (chat.type !== 0) continue;
        const otherProviderId = chat.attendee_provider_id;
        if (!otherProviderId) continue;

        // Get messages — check if last message is FROM THEM
        const msgs = await fetchMessages(acc.account_id, chat.id);
        if (!msgs.length) continue;

        const lastMsg = msgs[0]; // newest first
        const fromThem = lastMsg.is_sender === 0 || lastMsg.is_sender === false;
        if (!fromThem) continue;

        const msgText = (lastMsg.text || '').trim();
        if (!msgText) continue;

        // Message must be within 30 days
        const ts = new Date(lastMsg.timestamp || chat.timestamp || 0).getTime();
        if (Date.now() - ts > 30 * 24 * 60 * 60 * 1000) continue;

        // Skip if already saved
        const { rows: dup } = await db.query(
          'SELECT id FROM signals WHERE workspace_id=$1 AND actor_provider_id=$2 AND created_at > NOW() - interval \'30 days\' LIMIT 1',
          [acc.workspace_id, otherProviderId]
        );
        if (dup.length) continue;

        // Known contact?
        const { rows: known } = await db.query(
          'SELECT c.id, c.first_name, c.last_name, c.title, c.company' +
          ' FROM contacts c JOIN enrollments e ON e.contact_id = c.id' +
          ' JOIN campaigns camp ON camp.id = e.campaign_id' +
          ' WHERE camp.workspace_id=$1 AND c.provider_id=$2 LIMIT 1',
          [acc.workspace_id, otherProviderId]
        );
        const knownContact = known[0] || null;

        // Enrich if unknown
        const person = knownContact ? {
          name: [knownContact.first_name, knownContact.last_name].filter(Boolean).join(' '),
          title: knownContact.title,
          company: knownContact.company,
        } : await enrichPerson(acc.account_id, otherProviderId);

        await new Promise(r => setTimeout(r, 200));

        // AI score
        const score = await aiScore(person, msgText, acc.workspace_name);
        await new Promise(r => setTimeout(r, 300));

        // Save signal
        const signalType = knownContact ? 'inbound_message' : 'unsolicited_message';
        await db.query(
          'INSERT INTO signals' +
          ' (workspace_id, type, actor_contact_id, actor_provider_id, actor_name,' +
          '  actor_li_url, actor_headline, subject_li_account_id, content, raw_data,' +
          '  is_known, ai_priority, ai_action, ai_reason, ai_fit_score, occurred_at)' +
          ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())' +
          ' ON CONFLICT DO NOTHING',
          [
            acc.workspace_id, signalType,
            knownContact ? knownContact.id : null,
            otherProviderId,
            person.name || null,
            person.li_url || ('https://www.linkedin.com/in/' + otherProviderId),
            person.title || null,
            acc.account_id,
            msgText.slice(0, 500),
            JSON.stringify({ chat_id: chat.id, score, person, last_message: msgText.slice(0, 500) }),
            !!knownContact,
            (score && score.priority) || null,
            (score && score.action) || null,
            (score && score.reason) || null,
            (score && typeof score.fit_score === 'number') ? score.fit_score : null,
          ]
        );

        console.log('[SyncSignals] ✅ ' + signalType + ': ' + (person.name || otherProviderId) + ' → ' + ((score && score.priority) || 'unscored'));
        totalNew++;
      }
    } catch(e) {
      console.warn('[SyncSignals] Error for ' + acc.display_name + ': ' + e.message);
    }
  }

  console.log('[SyncSignals] Done — ' + totalNew + ' new signals');
}

module.exports = { handler };
