/**
 * syncSignals.js — pg-boss job, every 15 minutes
 *
 * Scans Unipile chats for inbound messages:
 *   - Chats where the LAST message is FROM THEM (is_sender=0)
 *   - Within the last 30 days
 *   - Not yet saved as a signal
 *
 * AI scoring (Claude Haiku): HOT / WARM / COLD + recommended action
 */

const db    = require('../db');
const https = require('https');

async function fetchChats(accountId, limit = 50) {
  const { request } = require('../unipile');
  try {
    const data = await request(`/api/v1/chats?account_id=${accountId}&limit=${limit}`);
    return Array.isArray(data?.items) ? data.items : [];
  } catch(e) {
    console.warn(`[SyncSignals] fetchChats error: ${e.message}`);
    return [];
  }
}

async function fetchMessages(accountId, chatId, limit = 5) {
  const { request } = require('../unipile');
  try {
    const data = await request(`/api/v1/chats/${chatId}/messages?account_id=${accountId}&limit=${limit}`);
    return Array.isArray(data?.items) ? data.items : [];
  } catch(e) { return []; }
}

async function isKnownContact(providerIdOrUrl, workspaceId) {
  const { rows } = await db.query(`
    SELECT c.id, c.first_name, c.last_name, c.title, c.company, e.status AS enrollment_status
    FROM contacts c
    LEFT JOIN enrollments e ON e.contact_id = c.id
    JOIN campaigns camp ON camp.id = e.campaign_id
    WHERE camp.workspace_id = $1
      AND (c.provider_id = $2 OR c.li_profile_url ILIKE '%' || $2 || '%')
    ORDER BY e.updated_at DESC NULLS LAST
    LIMIT 1
  `, [workspaceId, providerIdOrUrl]);
  return rows[0] || null;
}

async function enrichPerson(accountId, providerId) {
  const { enrichProfile } = require('../unipile');
  try {
    const url = `https://www.linkedin.com/in/${providerId}`;
    const data = await enrichProfile(accountId, url);
    return {
      name: [data?.first_name, data?.last_name].filter(Boolean).join(' ') || data?.full_name || null,
      title: data?.occupation || data?.headline || null,
      company: data?.company?.name || null,
      li_url: url,
    };
  } catch(e) { return { li_url: `https://www.linkedin.com/in/${providerId}` }; }
}

async function aiScore(personData, messageText, workspaceName) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system: `You classify LinkedIn inbound messages for a B2B company. Return ONLY a JSON object (no markdown):
{"priority":"HOT|WARM|COLD","reason":"one sentence","action":"reply_now|add_to_campaign|ignore|schedule_call","fit_score":1-10}
HOT = decision maker who initiated contact or shows clear buying intent
WARM = relevant title/company, some engagement  
COLD = irrelevant, spam, wrong fit, or out-of-office`,
    messages: [{ role: 'user', content: `Company: ${workspaceName}\nPerson: ${JSON.stringify(personData)}\nMessage: "${messageText?.slice(0,300)}"` }]
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
    return JSON.parse(result.content?.[0]?.text?.trim() || 'null');
  } catch(e) { return null; }
}

async function handler() {
  const { rows: accounts } = await db.query(`
    SELECT ua.account_id, ua.display_name, ua.workspace_id, w.name AS workspace_name
    FROM unipile_accounts ua
    JOIN workspaces w ON w.id = ua.workspace_id
  `);
  if (!accounts.length) return;
  console.log(`[SyncSignals] Scanning ${accounts.length} accounts`);

  let totalNew = 0;

  for (const acc of accounts) {
    try {
      const chats = await fetchChats(acc.account_id, 50);
      console.log(`[SyncSignals] ${acc.display_name}: ${chats.length} chats`);

      for (const chat of chats) {
        if (chat.type !== 0) continue; // skip group chats

        const otherProviderId = chat.attendee_provider_id;
        if (!otherProviderId) continue;

        // Get last 5 messages
        const msgs = await fetchMessages(acc.account_id, chat.id, 5);
        if (!msgs.length) continue;

        // Most recent message — is it from them?
        const mostRecent = msgs[0];
        const fromThem = mostRecent && (mostRecent.is_sender === 0 || mostRecent.is_sender === false);
        if (!fromThem) continue;

        // Recent enough? (30 days)
        const ts = chat.timestamp ? new Date(chat.timestamp) : new Date(0);
        if (Date.now() - ts.getTime() > 30 * 24 * 60 * 60 * 1000) continue;

        const messageText = (mostRecent.text || '').trim();
        if (!messageText) continue;

        // Already saved this person recently?
        const { rows: exists } = await db.query(
          `SELECT id FROM signals WHERE workspace_id=$1 AND actor_provider_id=$2 AND created_at > NOW()-'30 days'::interval LIMIT 1`,
          [acc.workspace_id, otherProviderId]
        );
        if (exists.length) continue;

        // Known contact?
        const known = await isKnownContact(otherProviderId, acc.workspace_id);

        // Enrich if unknown
        let person = known
          ? { name: [known.first_name, known.last_name].filter(Boolean).join(' '), title: known.title, company: known.company, li_url: `https://www.linkedin.com/in/${otherProviderId}` }
          : await enrichPerson(acc.account_id, otherProviderId);

        await new Promise(r => setTimeout(r, 200));

        // AI score
        const score = await aiScore(person, messageText, acc.workspace_name);
        await new Promise(r => setTimeout(r, 300));

        // Save signal
        const type = known ? 'inbound_message' : 'unsolicited_message';
        await db.query(`
          INSERT INTO signals (
            workspace_id, type, actor_contact_id, actor_provider_id,
            actor_name, actor_li_url, actor_headline,
            subject_li_account_id, content, raw_data, is_known,
            ai_priority, ai_action, ai_reason, ai_fit_score, occurred_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        `, [
          acc.workspace_id, type, known?.id || null, otherProviderId,
          person.name || null, person.li_url || null, person.title || null,
          acc.account_id, messageText.slice(0, 500),
          JSON.stringify({ chat_id: chat.id, score, person }),
          !!known,
          score?.priority || null, score?.action || null,
          score?.reason || null, score?.fit_score || null,
          ts,
        ]);

        console.log(`[SyncSignals] ✅ ${type}: ${person.name || otherProviderId} → ${score?.priority || '?'}`);
        totalNew++;
      }
    } catch(e) {
      console.warn(`[SyncSignals] Error for ${acc.display_name}: ${e.message}`);
    }
  }

  console.log(`[SyncSignals] Done — ${totalNew} new signals`);
}

module.exports = { handler };
