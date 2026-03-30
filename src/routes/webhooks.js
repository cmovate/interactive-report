/**
 * POST /api/webhooks/unipile
 *
 * Handles Unipile webhook events:
 *
 * new_relation  — someone accepted our LinkedIn connection request
 *   → Sets invite_approved = true, invite_approved_at = NOW()
 *   → For ‘new’ sequence: sets msg_sequence_started_at
 *
 * new_message   — an incoming LinkedIn message was received
 *   → Marks msg_replied = true, increments reply_count, stops sequence
 *   → Enqueues contact for conversation analysis (debounced 2 min)
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { enqueueContact } = require('../conversationQueue');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'elvia-secret';

router.post('/unipile', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    console.warn('[Webhook] Invalid secret, rejecting request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body;
  console.log('[Webhook] Received event:', payload?.event, '| account:', payload?.account_id);

  // Respond 200 immediately so Unipile doesn\'t retry
  res.json({ received: true });

  try {
    if (payload?.event === 'new_relation')  await handleNewRelation(payload);
    if (payload?.event === 'new_message')   await handleNewMessage(payload);

  // Sync incoming message to inbox_threads + inbox_messages
  try {
    const chatId = payload.chat_id || payload.object_id;
    const msgId  = payload.message_id || payload.id || ('wh_' + Date.now());
    const text   = payload.text || payload.body || payload.content || '';
    if (chatId && text && rows.length) {
      const wsId = rows[0].workspace_id;
      const accId = rows[0].camp_account_id || null;
      const upsertThread = 'INSERT INTO inbox_threads'
        + ' (workspace_id, account_id, thread_id, last_message_at, last_message_preview, unread_count, updated_at)'
        + ' VALUES ($1,$2,$3,NOW(),$4,1,NOW())'
        + ' ON CONFLICT (thread_id) DO UPDATE SET'
        + ' unread_count = inbox_threads.unread_count + 1,'
        + ' last_message_at = NOW(), last_message_preview = $4, updated_at = NOW()'
        + ' RETURNING id';
      const thrRes = await db.query(upsertThread, [wsId, accId, chatId, text.slice(0,120)]);
      const threadDbId = thrRes.rows[0] && thrRes.rows[0].id;
      if (threadDbId) {
        const insertMsg = 'INSERT INTO inbox_messages (thread_id, unipile_msg_id, direction, content, sent_at)'
          + ' VALUES ($1,$2,''received'',$3,NOW()) ON CONFLICT (unipile_msg_id) DO NOTHING';
        await db.query(insertMsg, [threadDbId, msgId, text]);
      }
    }
  } catch (inboxErr) {
    console.warn('[Webhook] inbox sync failed:', inboxErr.message);
  }
  } catch (err) {
    console.error('[Webhook] Error processing event:', err.message);
  }
});

// ── new_relation ────────────────────────────────────────────────────────────────────

async function handleNewRelation(payload) {
  const { account_id, user_public_identifier, user_profile_url, user_full_name } = payload;
  if (!account_id) { console.warn('[Webhook] new_relation missing account_id'); return; }

  const identifier = user_public_identifier ||
    (user_profile_url ? user_profile_url.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1] : null);
  if (!identifier) { console.warn('[Webhook] new_relation: could not extract LinkedIn identifier'); return; }

  const { rows: contacts } = await db.query(
    `SELECT c.id, c.first_name, c.last_name, c.msg_sequence
     FROM contacts c
     INNER JOIN campaigns camp ON camp.id = c.campaign_id
     WHERE camp.account_id = $1
       AND c.invite_sent = true AND c.invite_approved = false
       AND c.li_profile_url ILIKE $2`,
    [account_id, `%/${identifier}%`]
  );

  if (!contacts.length) {
    console.log(`[Webhook] new_relation: no matching contact for "${identifier}"`);
    return;
  }

  for (const contact of contacts) {
    await db.query(
      `UPDATE contacts SET
         invite_approved         = true,
         invite_approved_at      = NOW(),
         msg_sequence_started_at = CASE
           WHEN msg_sequence = 'new' AND msg_sequence_started_at IS NULL THEN NOW()
           ELSE msg_sequence_started_at
         END
       WHERE id = $1`,
      [contact.id]
    );
    console.log(`[Webhook] new_relation: approved contact ${contact.id} (${contact.first_name} ${contact.last_name})`);
  }
}

// ── new_message ────────────────────────────────────────────────────────────────────

async function handleNewMessage(payload) {
  const { account_id, chat_id, sender_id, is_sender } = payload;

  // Only process incoming messages (not messages we sent)
  if (is_sender === true || is_sender === 'true') return;
  if (!account_id || !sender_id) {
    console.warn('[Webhook] new_message: missing account_id or sender_id');
    return;
  }

  const { rows: contacts } = await db.query(
    `SELECT c.id, c.first_name, c.last_name, c.campaign_id, c.chat_id, c.reply_count
     FROM contacts c
     INNER JOIN campaigns camp ON camp.id = c.campaign_id
     WHERE camp.account_id = $1
       AND c.msg_sent = true
       AND (c.provider_id = $2 OR c.chat_id = $3)`,
    [account_id, sender_id, chat_id || '']
  );

  if (!contacts.length) {
    console.log(`[Webhook] new_message: no matching contact for sender ${sender_id}`);
    return;
  }

  for (const contact of contacts) {
    const newCount        = (parseInt(contact.reply_count) || 0) + 1;
    const effectiveChatId = contact.chat_id || chat_id || null;

    if (!contact.chat_id && chat_id) {
      // Save chat_id and update reply fields in one query
      await db.query(
        `UPDATE contacts SET
           msg_replied    = true,
           msg_replied_at = COALESCE(msg_replied_at, NOW()),
           reply_count    = $2,
           msg_sequence   = NULL,
           chat_id        = $3
         WHERE id = $1`,
        [contact.id, newCount, chat_id]
      );
    } else {
      await db.query(
        `UPDATE contacts SET
           msg_replied    = true,
           msg_replied_at = COALESCE(msg_replied_at, NOW()),
           reply_count    = $2,
           msg_sequence   = NULL
         WHERE id = $1`,
        [contact.id, newCount]
      );
    }

    console.log(
      `[Webhook] Reply #${newCount} from contact ${contact.id}` +
      ` (${contact.first_name} ${contact.last_name}) — queuing analysis`
    );

    if (effectiveChatId) {
      enqueueContact(contact.id, account_id, effectiveChatId, contact.campaign_id);
    } else {
      console.warn(`[Webhook] No chat_id for contact ${contact.id} — skipping analysis queue`);
    }
  }
}

module.exports = router;
