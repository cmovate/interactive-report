/**
 * Inbox Route
 *
 * GET  /api/inbox?workspace_id=&campaign_id=&page=&limit=
 *   Returns paginated conversation threads for the workspace's campaign contacts.
 *
 * GET  /api/inbox/:threadId/messages?workspace_id=
 *   Returns all messages in a thread (chronological).
 *
 * POST /api/inbox/:threadId/reply
 *   body: { workspace_id, content }
 *   Sends a message via Unipile and records it in inbox_messages.
 *
 * POST /api/inbox/sync?workspace_id=
 *   Triggers a background sync of conversations from Unipile.
 *   Matches conversations to contacts by provider_id.
 *   Responds immediately with { status: 'started' }.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { getChatMessages, sendMessage, startDirectMessage, enrichProfile } = require('../unipile');

// Ã¢ÂÂÃ¢ÂÂ Helpers Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ

/**
 * Fetch and store messages for a single Unipile chat.
 * Upserts into inbox_messages (dedup by unipile_msg_id).
 * Returns { added, total } counts.
 */
async function syncThreadMessages(threadDbId, chatId, accountId, maxMessages = 20, accountProviderId = null) {
  let messages;
  try {
    messages = await getChatMessages(accountId, chatId, maxMessages);
  } catch (err) {
    console.warn(`[Inbox] getChatMessages failed for chat ${chatId}: ${err.message}`);
    return { added: 0, total: 0 };
  }

  let added = 0;
  for (const msg of messages) {
    const msgId = msg.id || msg.message_id || msg.uid;
    if (!msgId) continue;

    // direction: 'sent' if from_me / is_me flag, else 'received'
    // Detect direction: compare sender's provider_id with our account's provider_id
    const senderPid = msg.sender?.attendee_provider_id || msg.sender_id || null;
    const isOurMsg  = accountProviderId && senderPid && senderPid === accountProviderId;
    const direction = (msg.is_sender === 1 || msg.is_sender === true || isOurMsg || msg.from_me || msg.is_me) ? 'sent' : 'received';
    const content   = msg.text || msg.body || msg.content || '';
    const sentAt    = msg.created_at || msg.timestamp || msg.sent_at || null;

    try {
      await db.query(
        `INSERT INTO inbox_messages (thread_id, unipile_msg_id, direction, content, sent_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (unipile_msg_id) DO NOTHING`,
        [threadDbId, msgId, direction, content, sentAt]
      );
      added++;
    } catch (e) {
      // Silently ignore constraint errors
    }
  }

  // Update thread preview
  if (messages.length > 0) {
    const last = messages[messages.length - 1];
    const preview  = (last.text || last.body || last.content || '').slice(0, 120);
    const lastAt   = last.created_at || last.timestamp || null;
    await db.query(
      `UPDATE inbox_threads SET last_message_at=$1, last_message_preview=$2, updated_at=NOW()
       WHERE id=$3`,
      [lastAt, preview, threadDbId]
    );
  }

  return { added, total: messages.length };
}

/**
 * Background sync: iterates all accounts in workspace, fetches their chat list,
 * matches chats to campaign contacts by provider_id, upserts threads + messages.
 */
async function syncWorkspaceInbox(workspaceId, specificAccountId = null) {
  console.log(`[Inbox] Syncing workspace ${workspaceId}` + (specificAccountId ? ` account ${specificAccountId}` : '') + '...');

  const { rows: accounts } = await db.query(
    specificAccountId
      ? 'SELECT account_id FROM unipile_accounts WHERE workspace_id = $1 AND account_id = $2'
      : 'SELECT account_id FROM unipile_accounts WHERE workspace_id = $1',
    specificAccountId ? [workspaceId, specificAccountId] : [workspaceId]
  );

  for (const { account_id } of accounts) {
    try {
      // Fetch recent chats from Unipile
      const { request } = require('../unipile');
      // We call the raw Unipile /chats endpoint with a higher limit
      const UNIPILE_DSN     = process.env.UNIPILE_DSN;
      const UNIPILE_API_KEY = process.env.UNIPILE_API_KEY;
      const chatRes = await fetch(
        `${UNIPILE_DSN}/api/v1/chats?account_id=${encodeURIComponent(account_id)}&limit=50`,
        { headers: { 'X-API-KEY': UNIPILE_API_KEY, 'accept': 'application/json' } }
      );
      if (!chatRes.ok) {
        console.warn(`[Inbox] Could not fetch chats for ${account_id}: ${chatRes.status}`);
        continue;
      }
      const chatData = await chatRes.json();
      let accountSelfId = null; // lazy-fetched own provider_id for direction detection
      const chats    = Array.isArray(chatData?.items) ? chatData.items : [];

      for (const chat of chats) {
        const chatId      = chat.id || chat.chat_id;
        const providerId  = chat.attendee_provider_id || chat.attendees?.[0]?.provider_id ||
                            chat.attendees?.[0]?.id;
        if (!chatId || !providerId) continue;

        // Find contact: by provider_id, then by li_profile_url, then create
        const { rows: contactRows } = await db.query(
          `SELECT id, campaign_id FROM contacts
           WHERE workspace_id = $1 AND provider_id = $2 LIMIT 1`,
          [workspaceId, providerId]
        );
        let contact = contactRows[0];
        if (!contact) {
          // Also try matching by li_profile_url (contacts from lists lack provider_id)
          const { rows: byUrl } = await db.query(
            `SELECT id, campaign_id FROM contacts
             WHERE workspace_id = $1 AND li_profile_url = $2 LIMIT 1`,
            [workspaceId, 'https://www.linkedin.com/in/' + providerId]
          );
          contact = byUrl[0];
        }
        if (!contact) {
          // Create new contact from chat — name fetched via enrichProfile later
          const { rows: newC } = await db.query(
            `INSERT INTO contacts (workspace_id, first_name, last_name, li_profile_url, campaign_id, provider_id)
             VALUES ($1, $2, $3, $4, NULL, $5)
             ON CONFLICT DO NOTHING RETURNING id, campaign_id`,
            [workspaceId, '', '', 'https://www.linkedin.com/in/' + providerId, providerId]
          );
          // Fire-and-forget enrichment to populate name, title, company
          if (newC[0]) {
            enrichProfile(account_id, 'https://www.linkedin.com/in/' + providerId).then(function(profile) {
              if (profile && (profile.first_name || profile.full_name)) {
                const nameParts = (profile.full_name || '').split(' ');
                const fn = profile.first_name || nameParts[0] || '';
                const ln = profile.last_name || nameParts.slice(1).join(' ') || '';
                db.query('UPDATE contacts SET first_name=$1, last_name=$2, title=$3 WHERE id=$4',
                  [fn, ln, profile.headline || profile.title || null, newC[0].id]).catch(function(){});
              }
            }).catch(function(){});
          }
          contact = newC[0];
        }
        if (!contact) continue; // Could not resolve or create contact

        // Upsert inbox thread
        const { rows: threadRows } = await db.query(
          `INSERT INTO inbox_threads
             (campaign_id, workspace_id, contact_id, account_id, thread_id, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (thread_id) DO UPDATE SET updated_at = NOW()
           RETURNING id`,
          [contact.campaign_id, workspaceId, contact.id, account_id, chatId]
        );
        const threadDbId = threadRows[0]?.id;
        if (!threadDbId) continue;

        // Sync messages for this thread
        // Get account's own provider_id for direction detection (lazy-fetched once per account)
        if (!accountSelfId) {
          try {
            const { getAccountInfo } = require('../unipile');
            const info = await getAccountInfo(account_id);
            accountSelfId = info?.user_id || info?.provider_id || null;
          } catch(e) { /* ignore */ }
        }
        await syncThreadMessages(threadDbId, chatId, account_id, 20, accountSelfId);

        await new Promise(r => setTimeout(r, 800));
      }
    } catch (err) {
      console.error(`[Inbox] Sync error for account ${account_id}:`, err.message);
    }
  }

  console.log(`[Inbox] Sync complete for workspace ${workspaceId}`);
}

// Ã¢ÂÂÃ¢ÂÂ Routes Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ

/**
 * GET /api/inbox?workspace_id=&campaign_id=&filter=all|unread|replied
 */
router.get('/', async (req, res) => {
  try {
    const { workspace_id, campaign_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    const filter = req.query.filter || 'all'; // all | unread | replied

    const conditions = ['t.workspace_id = $1'];
    const params     = [workspace_id];
    const accountFilter = req.query.account_id;
    if (accountFilter) { conditions.push('t.account_id = $' + (params.length + 1)); params.push(accountFilter); }

    if (campaign_id) {
      conditions.push(`t.campaign_id = $${params.length + 1}`);
      params.push(campaign_id);
    }
    if (filter === 'unread') {
      conditions.push('t.unread_count > 0');
    } else if (filter === 'replied') {
      // Has at least one received message (they replied to us)
      conditions.push(`EXISTS (
        SELECT 1 FROM inbox_messages m
        WHERE m.thread_id = t.id AND m.direction = 'received'
      )`);
    }

    const where = conditions.join(' AND ');

    const { rows: totalRows } = await db.query(
      `SELECT COUNT(*) FROM inbox_threads t WHERE ${where}`, params
    );
    const total = parseInt(totalRows[0].count);

    const { rows: threads } = await db.query(
      `SELECT
         t.*,
         c.first_name, c.last_name, c.title AS contact_title,
         c.company   AS contact_company,
         c.li_profile_url, c.invite_approved, c.msg_replied,
         camp.name   AS campaign_name
       FROM inbox_threads t
       JOIN contacts  c    ON c.id   = t.contact_id
       LEFT JOIN campaigns camp ON camp.id = t.campaign_id
       WHERE ${where}
       ORDER BY t.last_message_at DESC NULLS LAST, t.updated_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({ items: threads, total, page, limit, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    console.error('[Inbox] GET / error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/inbox/:threadId/messages?workspace_id=
 */
router.get('/:threadId/messages', async (req, res) => {
  try {
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    // Verify thread belongs to workspace
    const { rows: tRows } = await db.query(
      'SELECT id, account_id, thread_id, contact_id FROM inbox_threads WHERE id=$1 AND workspace_id=$2',
      [req.params.threadId, workspace_id]
    );
    if (!tRows.length) return res.status(404).json({ error: 'Thread not found' });
    const thread = tRows[0];

    // Pull fresh messages from Unipile (updates DB as side effect)
    await syncThreadMessages(thread.id, thread.thread_id, thread.account_id);

    // Mark as read (reset unread_count)
    await db.query('UPDATE inbox_threads SET unread_count=0 WHERE id=$1', [thread.id]);

    const { rows: messages } = await db.query(
      'SELECT * FROM inbox_messages WHERE thread_id=$1 ORDER BY sent_at ASC, id ASC',
      [thread.id]
    );

    // Also return contact info
    const { rows: cRows } = await db.query(
      `SELECT id, first_name, last_name, title, company, li_profile_url, provider_id
       FROM contacts WHERE id=$1`,
      [thread.contact_id]
    );

    res.json({ messages, contact: cRows[0] || null, thread });
  } catch (err) {
    console.error('[Inbox] GET messages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/inbox/:threadId/reply
 * body: { workspace_id, content }
 */
router.post('/:threadId/reply', async (req, res) => {
  try {
    const { workspace_id, content } = req.body;
    if (!workspace_id || !content?.trim()) {
      return res.status(400).json({ error: 'workspace_id and content required' });
    }

    const { rows: tRows } = await db.query(
      'SELECT id, account_id, thread_id FROM inbox_threads WHERE id=$1 AND workspace_id=$2',
      [req.params.threadId, workspace_id]
    );
    if (!tRows.length) return res.status(404).json({ error: 'Thread not found' });
    const thread = tRows[0];

    // Send via Unipile
    await sendMessage(thread.account_id, thread.thread_id, content.trim());

    // Record in DB
    const now = new Date().toISOString();
    const { rows: msgRows } = await db.query(
      `INSERT INTO inbox_messages (thread_id, unipile_msg_id, direction, content, sent_at)
       VALUES ($1, $2, 'sent', $3, $4)
       RETURNING *`,
      [thread.id, `local_${Date.now()}`, content.trim(), now]
    );

    // Update thread preview
    await db.query(
      `UPDATE inbox_threads
       SET last_message_at=$1, last_message_preview=$2, updated_at=NOW()
       WHERE id=$3`,
      [now, content.trim().slice(0, 120), thread.id]
    );

    res.json({ success: true, message: msgRows[0] });
  } catch (err) {
    console.error('[Inbox] POST reply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/inbox/sync?workspace_id= (or body.workspace_id)
 */
router.post('/sync', async (req, res) => {
  try {
    const workspace_id = req.body?.workspace_id || req.query.workspace_id;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    syncWorkspaceInbox(workspace_id)
      .catch(err => console.error('[Inbox] background sync error:', err.message));

    res.json({ status: 'started', workspace_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inbox/by-provider?provider_id=X&workspace_id=Y
// Find inbox thread by contact's provider_id (LinkedIn member ID)
router.get('/by-provider', async (req, res) => {
  const { provider_id, workspace_id } = req.query;
  if (!provider_id || !workspace_id) return res.status(400).json({ error: 'provider_id and workspace_id required' });
  try {
    // First try direct match via contacts table
    const { rows } = await db.query(
      `SELECT 
          t.id, t.thread_id, t.account_id, t.workspace_id,
          c.first_name, c.last_name, c.title as contact_title, 
          c.company_name, c.li_profile_url, c.provider_id,
          t.last_message_at, t.last_message_preview,
          camp.name as campaign_name
        FROM inbox_threads t
        INNER JOIN contacts c ON t.contact_id = c.id
        LEFT JOIN campaigns camp ON t.campaign_id = camp.id
        WHERE t.workspace_id = $1
          AND (
            c.provider_id = $2
            OR c.li_profile_url LIKE $3
            OR c.li_profile_url = $4
          )
        LIMIT 1`,
      [workspace_id, provider_id, '%' + provider_id + '%', 
       'https://www.linkedin.com/in/' + provider_id]
    );
    if (rows.length > 0) return res.json({ thread: rows[0] });
    
    // Also search by li_profile_url containing provider_id in thread table itself
    const { rows: rows2 } = await db.query(
      `SELECT 
          t.id, t.thread_id, t.account_id, t.workspace_id,
          c.first_name, c.last_name, c.title as contact_title,
          c.company_name, c.li_profile_url, c.provider_id,
          t.last_message_at, t.last_message_preview
        FROM inbox_threads t
        LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.workspace_id = $1
          AND (
            t.thread_id LIKE $2
            OR (c.li_profile_url IS NOT NULL AND LOWER(c.li_profile_url) = LOWER($3))
          )
        LIMIT 1`,
      [workspace_id, '%' + provider_id + '%',
       'https://www.linkedin.com/in/' + provider_id]
    );
    if (rows2.length > 0) return res.json({ thread: rows2[0] });
    
    return res.json({ thread: null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


module.exports = router;
