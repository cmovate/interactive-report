/**
 * syncSignals.js — runs every 15 minutes
 *
 * Detects inbound LinkedIn signals by scanning chats for:
 *   1. Messages from people NOT in any campaign (unsolicited outreach)
 *   2. New first-degree connections NOT initiated by us
 *
 * For each signal: enriches the person, runs AI scoring, saves to signals table.
 *
 * AI Scoring (Claude Haiku) decides:
 *   - Is this person relevant? (title/company fit)
 *   - Priority: HOT / WARM / COLD
 *   - Recommended action
 */

const db    = require('../db');
const https = require('https');

// ── Fetch chats from Unipile ──────────────────────────────────────────────────
async function fetchChats(accountId, limit = 50) {
  const { request } = require('../unipile');
  try {
    const data = await request(`/api/v1/chats?account_id=${accountId}&limit=${limit}`);
    return Array.isArray(data?.items) ? data.items : [];
  } catch(e) {
    console.warn(`[SyncSignals] fetchChats error for ${accountId}: ${e.message}`);
    return [];
  }
}

// ── Fetch messages in a chat ─────────────────────────────────────────────────
async function fetchLastMessages(accountId, chatId, limit = 5) {
  const { request } = require('../unipile');
  try {
    const data = await request(`/api/v1/chats/${chatId}/messages?account_id=${accountId}&limit=${limit}`);
    return Array.isArray(data?.items) ? data.items : [];
  } catch(e) { return []; }
}

// ── AI Score a signal ─────────────────────────────────────────────────────────
async function aiScoreSignal(person, messageText, workspaceName) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: `You analyze LinkedIn inbound signals for a B2B company. Given a person's info and their message, return a JSON object with:
- priority: "HOT" | "WARM" | "COLD"
- reason: one sentence explaining why (in English)
- action: "reply_now" | "add_to_campaign" | "ignore" | "schedule_call"
- fit_score: 1-10

HOT = decision maker at relevant company who initiated contact
WARM = relevant person, some interest
COLD = irrelevant, spam, or wrong fit

Return ONLY valid JSON, no markdown.`,
    messages: [{ role: 'user', content: `Person: ${JSON.stringify(person)}\nMessage: "${messageText?.slice(0,300) || 'no message'}"` }]
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
    const text = result.content?.[0]?.text?.trim() || '';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch(e) {
    console.warn(`[SyncSignals] AI score error: ${e.message}`);
    return null;
  }
}

// ── Check if chat participant is in our workspace ─────────────────────────────
async function isKnownContact(providerIdOrUrl, workspaceId) {
  const { rows } = await db.query(`
    SELECT c.id, c.first_name, c.last_name, c.title, c.company,
           e.id AS enrollment_id, e.status AS enrollment_status
    FROM contacts c
    LEFT JOIN enrollments e ON e.contact_id = c.id
    JOIN campaigns camp ON camp.id = e.campaign_id
    WHERE camp.workspace_id = $1
      AND (c.provider_id = $2 OR c.li_profile_url ILIKE '%' || $2 || '%')
    LIMIT 1
  `, [workspaceId, providerIdOrUrl]);
  return rows[0] || null;
}

// ── Enrich unknown person via Unipile ─────────────────────────────────────────
async function enrichPerson(accountId, providerIdOrUrl) {
  const { enrichProfile } = require('../unipile');
  try {
    const url = providerIdOrUrl.startsWith('http') ? providerIdOrUrl
      : `https://www.linkedin.com/in/${providerIdOrUrl}`;
    const data = await enrichProfile(accountId, url);
    return {
      name: [data?.first_name, data?.last_name].filter(Boolean).join(' ') || data?.full_name || null,
      title: data?.occupation || data?.headline || null,
      company: data?.company?.name || null,
      li_url: url,
      provider_id: data?.provider_id || providerIdOrUrl,
    };
  } catch(e) { return { li_url: providerIdOrUrl, provider_id: providerIdOrUrl }; }
}

// ── Main handler ──────────────────────────────────────────────────────────────
async function handler() {
  const { rows: accounts } = await db.query(`
    SELECT ua.account_id, ua.display_name, ua.workspace_id, w.name AS workspace_name
    FROM unipile_accounts ua
    JOIN workspaces w ON w.id = ua.workspace_id
    WHERE ua.status = 'active' OR ua.status IS NULL
  `);

  if (!accounts.length) { console.log('[SyncSignals] No active accounts'); return; }
  console.log(`[SyncSignals] Scanning ${accounts.length} accounts`);

  // Fetch our own provider_id for each account
  const { getAccountInfo } = require('../unipile');
  for (const acc of accounts) {
    try {
      const info = await getAccountInfo(acc.account_id);
      acc.our_provider_id = info?.connection_params?.user_id
        || info?.user_id
        || info?.provider_id
        || null;
    } catch(e) { acc.our_provider_id = null; }
  }

  let totalNew = 0;

  for (const acc of accounts) {
    try {
      const chats = await fetchChats(acc.account_id, 100);
      console.log(`[SyncSignals] ${acc.display_name}: ${chats.length} chats`);

      for (const chat of chats) {
        // Skip group chats (type !== 0)
        if (chat.type !== 0) continue;

        // The other person's provider_id is directly on the chat
        const otherProviderId = chat.attendee_provider_id;
        if (!otherProviderId) continue;

        // Their LinkedIn URL
        const otherLiUrl = `https://www.linkedin.com/in/${otherProviderId}`;

        // Check if already a signal
        const { rows: existing } = await db.query(
          `SELECT id FROM signals WHERE workspace_id=$1 AND actor_provider_id=$2 AND type='inbound_message' AND created_at > NOW()-'30 days'::interval LIMIT 1`,
          [acc.workspace_id, otherProviderId]
        );
        if (existing.length) continue;

        // Check if this person is in our workspace (known contact in a campaign)
        const knownContact = await isKnownContact(otherProviderId, acc.workspace_id);

        // Skip if they're an enrolled contact actively in campaign (handled elsewhere)
        if (knownContact?.enrollment_status && ['messaged','replied','positive_reply'].includes(knownContact.enrollment_status)) continue;

        // Get recent messages in this chat
        const chatId = chat.id;
        const msgs = await fetchLastMessages(acc.account_id, chatId, 5);
        if (!msgs.length) continue;

        // Find the most recent message from THEM (is_sender=0 means they sent it)
        const theirLastMsg = msgs.find(m => m.is_sender === 0 || m.is_sender === false);
        if (!theirLastMsg) continue;

        // Only signal if their message is recent (within 7 days)
        const msgDate = new Date(theirLastMsg.timestamp || theirLastMsg.created_at || 0);
        if (Date.now() - msgDate.getTime() > 30 * 24 * 60 * 60 * 1000) continue;

        const messageText = theirLastMsg.text || theirLastMsg.body || '';

        // Enrich person if not known
        let personData = knownContact ? {
          name: [knownContact.first_name, knownContact.last_name].filter(Boolean).join(' '),
          title: knownContact.title, company: knownContact.company,
          provider_id: otherProviderId, li_url: otherLiUrl,
        } : await enrichPerson(acc.account_id, otherProviderId);

        await new Promise(r => setTimeout(r, 200));

        // AI score
        const score = await aiScoreSignal(personData, messageText, acc.workspace_name);
        await new Promise(r => setTimeout(r, 300));

        if (!messageText) continue;

        // Save signal
        const signalType = knownContact ? 'inbound_message' : 'unsolicited_message';
        const rawData = { chat_id: chatId, score, person: personData, last_message: messageText?.slice(0,500) };

        await db.query(`
          INSERT INTO signals (
            workspace_id, type, actor_contact_id,
            actor_provider_id, actor_name, actor_li_url, actor_headline,
            subject_li_account_id, content, raw_data, is_known,
            ai_priority, ai_action, ai_reason, ai_fit_score,
            occurred_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
          ON CONFLICT DO NOTHING
        `, [
          acc.workspace_id,
          signalType,
          knownContact?.id || null,
          otherProviderId,
          personData.name || other.name || null,
          personData.li_url || null,
          personData.title || null,
          acc.account_id,
          messageText?.slice(0, 500) || null,
          JSON.stringify(rawData),
          !!knownContact,
          score?.priority || null,
          score?.action || null,
          score?.reason || null,
          score?.fit_score || null,
        ]);

        console.log(`[SyncSignals] ✅ ${signalType}: ${personData.name || otherProviderId} → priority: ${score?.priority || 'unscored'}`);
        totalNew++;
      }
    } catch(e) {
      console.warn(`[SyncSignals] Error for account ${acc.display_name}: ${e.message}`);
    }
  }

  console.log(`[SyncSignals] Done — ${totalNew} new signals`);
}

module.exports = { handler };
