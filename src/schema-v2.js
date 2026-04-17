/**
 * schema-v2.js
 *
 * Phase 1 schema migrations — new tables only.
 * Runs on server startup via initSchemaV2().
 * All migrations are idempotent (IF NOT EXISTS / IF NOT EXISTS).
 *
 * New tables:
 *   sequences           — reusable outreach scripts
 *   sequence_steps      — steps within a sequence
 *   enrollments         — state machine: contact × campaign
 *   enrollment_messages — what was actually sent per step
 *   target_accounts     — companies as first-class entities
 *   signals             — all inbound LinkedIn events
 *   scheduled_posts     — post scheduler DB persistence
 *   scheduled_comments  — comments to post on a schedule
 */

const db = require('./db');

async function s(label, fn) {
  try {
    await fn();
    // console.log(`[SchemaV2] ✓ ${label}`);
  } catch (err) {
    if (err.message && (err.message.includes('already exists') || err.message.includes('duplicate'))) {
      // idempotent — already ran
    } else {
      console.error(`[SchemaV2] ✗ ${label}: ${err.message}`);
    }
  }
}

async function initSchemaV2() {
  console.log('[SchemaV2] Running v2 migrations...');

  // ── Target Accounts (companies as ABM entities) ──────────────────────────
  await s('target_accounts', () => db.query(`
    CREATE TABLE IF NOT EXISTS target_accounts (
      id                  SERIAL PRIMARY KEY,
      workspace_id        INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name                TEXT NOT NULL,
      li_company_url      TEXT,
      li_company_id       TEXT,
      website             TEXT,
      industry            TEXT,
      company_size        TEXT,
      description         TEXT,
      engagement_score    INTEGER DEFAULT 0,
      engagement_score_7d INTEGER DEFAULT 0,
      last_signal_at      TIMESTAMP,
      enriched_at         TIMESTAMP,
      created_at          TIMESTAMP DEFAULT NOW()
    )
  `));

  await s('idx_ta_workspace', () => db.query(
    `CREATE INDEX IF NOT EXISTS idx_ta_workspace ON target_accounts(workspace_id)`
  ));
  await s('idx_ta_score', () => db.query(
    `CREATE INDEX IF NOT EXISTS idx_ta_score ON target_accounts(workspace_id, engagement_score_7d DESC)`
  ));
  await s('uniq_ta_company_id', () => db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_ta_company_id ON target_accounts(workspace_id, li_company_id) WHERE li_company_id IS NOT NULL`
  ));

  // ── Sequences ────────────────────────────────────────────────────────────
  await s('sequences', () => db.query(`
    CREATE TABLE IF NOT EXISTS sequences (
      id           SERIAL PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      description  TEXT,
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `));

  await s('sequence_steps', () => db.query(`
    CREATE TABLE IF NOT EXISTS sequence_steps (
      id          SERIAL PRIMARY KEY,
      sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
      step_index  INTEGER NOT NULL,
      type        TEXT NOT NULL DEFAULT 'message',
        -- 'invite' | 'message' | 'view_profile' | 'like_post' | 'follow_company'
      delay_days  INTEGER NOT NULL DEFAULT 0,
      variants    JSONB NOT NULL DEFAULT '[]',
        -- [{ label: 'A', text: 'Hi {{first_name}}...' }, ...]
      conditions  JSONB DEFAULT NULL,
      UNIQUE(sequence_id, step_index)
    )
  `));

  await s('idx_seq_steps', () => db.query(
    `CREATE INDEX IF NOT EXISTS idx_seq_steps ON sequence_steps(sequence_id, step_index)`
  ));

  // ── Enrollments (state machine: contact × campaign) ──────────────────────
  await s('enrollments', () => db.query(`
    CREATE TABLE IF NOT EXISTS enrollments (
      id                  SERIAL PRIMARY KEY,
      campaign_id         INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      contact_id          INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      status              TEXT NOT NULL DEFAULT 'pending',
        -- pending | invite_sent | approved | messaged | replied
        -- | positive_reply | withdrawn | done | skipped | error
      current_step        INTEGER DEFAULT 0,
      next_action_at      TIMESTAMP DEFAULT NOW(),
      invite_sent_at      TIMESTAMP,
      invite_approved_at  TIMESTAMP,
      chat_id             TEXT,
      a_b_assignments     JSONB DEFAULT '{}',
      error_count         INTEGER DEFAULT 0,
      last_error          TEXT,
      created_at          TIMESTAMP DEFAULT NOW(),
      updated_at          TIMESTAMP DEFAULT NOW(),
      UNIQUE(campaign_id, contact_id)
    )
  `));

  await s('idx_enroll_status', () => db.query(
    `CREATE INDEX IF NOT EXISTS idx_enroll_status
     ON enrollments(campaign_id, status)`
  ));
  await s('idx_enroll_next_action', () => db.query(
    `CREATE INDEX IF NOT EXISTS idx_enroll_next_action
     ON enrollments(next_action_at) WHERE status NOT IN ('done','withdrawn','skipped','error','positive_reply')`
  ));
  await s('idx_enroll_contact', () => db.query(
    `CREATE INDEX IF NOT EXISTS idx_enroll_contact ON enrollments(contact_id)`
  ));

  // ── Enrollment Messages (what was sent at each step) ──────────────────────
  await s('enrollment_messages', () => db.query(`
    CREATE TABLE IF NOT EXISTS enrollment_messages (
      id                  SERIAL PRIMARY KEY,
      enrollment_id       INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
      step_index          INTEGER NOT NULL,
      variant_label       TEXT DEFAULT 'A',
      text                TEXT,
      sent_at             TIMESTAMP DEFAULT NOW(),
      unipile_message_id  TEXT
    )
  `));

  await s('idx_em_enrollment', () => db.query(
    `CREATE INDEX IF NOT EXISTS idx_em_enrollment ON enrollment_messages(enrollment_id)`
  ));

  // ── Add sequence_id to campaigns ─────────────────────────────────────────
  await s('campaigns.sequence_id', () => db.query(
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sequence_id INTEGER REFERENCES sequences(id) ON DELETE SET NULL`
  ));
  await s('campaigns.invite_note', () => db.query(
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS invite_note TEXT`
  ));

  await s('opportunity_contacts', () => db.query(`
    CREATE TABLE IF NOT EXISTS opportunity_contacts (
      id                       SERIAL PRIMARY KEY,
      workspace_id             INTEGER NOT NULL,
      company_linkedin_id      TEXT    NOT NULL,
      company_name             TEXT    NOT NULL DEFAULT '',
      li_profile_url           TEXT    NOT NULL,
      provider_id              TEXT,
      first_name               TEXT    NOT NULL DEFAULT '',
      last_name                TEXT    NOT NULL DEFAULT '',
      title                    TEXT    NOT NULL DEFAULT '',
      connected_via_account_id TEXT    NOT NULL,
      connected_via_name       TEXT    NOT NULL DEFAULT '',
      last_seen_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (workspace_id, li_profile_url, connected_via_account_id)
    )
  `));
  await s('opportunity_contacts.idx_ws', () => db.query(
    `CREATE INDEX IF NOT EXISTS idx_opp_contacts_ws ON opportunity_contacts(workspace_id, company_linkedin_id)`
  ));
  await s('opportunity_contacts.chat_id', () => db.query(
    `ALTER TABLE opportunity_contacts ADD COLUMN IF NOT EXISTS chat_id TEXT`
  ));
  await s('opportunity_contacts.aco_id', () => db.query(
    `ALTER TABLE opportunity_contacts ADD COLUMN IF NOT EXISTS aco_id TEXT`
  ));
  await s('list_companies.opp_last_synced_at', () => db.query(
    `ALTER TABLE list_companies ADD COLUMN IF NOT EXISTS opp_last_synced_at TIMESTAMPTZ`
  ));

  // ── Signals (all inbound LinkedIn events) ────────────────────────────────
  await s('signals', () => db.query(`
    CREATE TABLE IF NOT EXISTS signals (
      id                      SERIAL PRIMARY KEY,
      workspace_id            INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      type                    TEXT NOT NULL,
        -- profile_view | post_like | post_comment | invite_received
        -- | invite_accepted | invite_declined | message_received | company_follow
      actor_contact_id        INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
      actor_target_account_id INTEGER REFERENCES target_accounts(id) ON DELETE SET NULL,
      actor_provider_id       TEXT,
      actor_name              TEXT,
      actor_li_url            TEXT,
      actor_headline          TEXT,
      subject_li_account_id   TEXT,
        -- the unipile account_id that received this signal
      content                 TEXT,
      post_url                TEXT,
      raw_data                JSONB DEFAULT '{}',
      is_known                BOOLEAN DEFAULT FALSE,
        -- TRUE if actor is in one of our lists
      is_notified             BOOLEAN DEFAULT FALSE,
      occurred_at             TIMESTAMP,
      created_at              TIMESTAMP DEFAULT NOW()
    )
  `));

  await s('idx_signals_ws', () => db.query(
    `CREATE INDEX IF NOT EXISTS idx_signals_ws ON signals(workspace_id, occurred_at DESC)`
  ));
  await s('idx_signals_contact', () => db.query(
    `CREATE INDEX IF NOT EXISTS idx_signals_contact ON signals(actor_contact_id)`
  ));
  await s('idx_signals_known', () => db.query(
    `CREATE INDEX IF NOT EXISTS idx_signals_known ON signals(workspace_id, is_known, occurred_at DESC)`
  ));

  // ── Scheduled Posts ───────────────────────────────────────────────────────
  await s('scheduled_posts', () => db.query(`
    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id              SERIAL PRIMARY KEY,
      workspace_id    INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      account_id      TEXT NOT NULL,
      content         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'scheduled',
        -- draft | scheduled | published | failed
      scheduled_at    TIMESTAMP,
      published_at    TIMESTAMP,
      unipile_post_id TEXT,
      error           TEXT,
      created_at      TIMESTAMP DEFAULT NOW()
    )
  `));

  await s('idx_sp_workspace', () => db.query(
    `CREATE INDEX IF NOT EXISTS idx_sp_workspace ON scheduled_posts(workspace_id, scheduled_at)`
  ));
  await s('idx_sp_status', () => db.query(
    `CREATE INDEX IF NOT EXISTS idx_sp_status ON scheduled_posts(status, scheduled_at)
     WHERE status = 'scheduled'`
  ));

  await s('scheduled_comments', () => db.query(`
    CREATE TABLE IF NOT EXISTS scheduled_comments (
      id                  SERIAL PRIMARY KEY,
      workspace_id        INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      account_id          TEXT NOT NULL,
      scheduled_post_id   INTEGER REFERENCES scheduled_posts(id) ON DELETE SET NULL,
      post_url            TEXT,
      content             TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'scheduled',
      scheduled_at        TIMESTAMP,
      published_at        TIMESTAMP,
      unipile_comment_id  TEXT,
      error               TEXT,
      created_at          TIMESTAMP DEFAULT NOW()
    )
  `));

  await s('idx_sc_workspace', () => db.query(
    `CREATE INDEX IF NOT EXISTS idx_sc_workspace ON scheduled_comments(workspace_id, scheduled_at)`
  ));

  // ── Link contacts → target_accounts ──────────────────────────────────────
  await s('contacts.target_account_id', () => db.query(
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS target_account_id INTEGER REFERENCES target_accounts(id) ON DELETE SET NULL`
  ));

  // ── Engagement scoring + signal tracking on contacts ──────────────────────
  await s('contacts.engagement_score',    () => db.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS engagement_score    INTEGER DEFAULT 0`));
  await s('contacts.engagement_score_7d', () => db.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS engagement_score_7d INTEGER DEFAULT 0`));
  await s('contacts.last_signal_at',      () => db.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_signal_at TIMESTAMPTZ`));

  // ── Seed: set provider_id = URL slug for contacts missing provider_id ────
  // Allows invitationSender to send invites before full Unipile enrichment.
  // Real enrichment (enrichProfile) will OVERWRITE the slug with ACoXXX later.
  await s('seed.provider_id_from_slug', async () => {
    const { rowCount } = await db.query(`
      UPDATE contacts
      SET provider_id = regexp_replace(
        li_profile_url,
        '.*linkedin\\.com/in/([^/?#/]+).*',
        '\\1'
      )
      WHERE (provider_id IS NULL OR provider_id = '')
        AND li_profile_url LIKE '%linkedin.com/in/%'
        AND li_profile_url ~ 'linkedin\\.com/in/[^/?#]+'
    `);
    if (rowCount > 0) console.log(`[SchemaV2] Seeded provider_id slug for ${rowCount} contacts`);
  });

  // ── Seed: CMOvate sequences ───────────────────────────────────────────────
  // Creates default sequences for workspace 1 if they don't exist yet.
  await s('seed.cmo_sequences', async () => {
    // Check if CMOvate workspace exists
    const { rows: ws } = await db.query('SELECT id FROM workspaces WHERE id = 1 LIMIT 1');
    if (!ws.length) return;

    // Check if sequences already exist
    const { rows: existing } = await db.query(
      `SELECT id FROM sequences WHERE workspace_id = 1 AND name LIKE 'CMOvate%' LIMIT 1`
    );
    if (existing.length) return; // already seeded

    // Create Israel sequence (invite only for now)
    const { rows: [israelSeq] } = await db.query(`
      INSERT INTO sequences (workspace_id, name, description)
      VALUES (1, 'CMOvate Israel — Invite Only',
              'שליחת invite בלבד. הודעות ייתווספו בשלב הבא.')
      RETURNING id
    `);
    await db.query(`
      INSERT INTO sequence_steps (sequence_id, step_index, type, delay_days, variants)
      VALUES ($1, 0, 'invite', 0, '[]')
    `, [israelSeq.id]);

    // Create Netherlands sequence (invite only)
    const { rows: [nlSeq] } = await db.query(`
      INSERT INTO sequences (workspace_id, name, description)
      VALUES (1, 'CMOvate Netherlands — Invite Only',
              'Invite only. Messages to be added once we have replies.')
      RETURNING id
    `);
    await db.query(`
      INSERT INTO sequence_steps (sequence_id, step_index, type, delay_days, variants)
      VALUES ($1, 0, 'invite', 0, '[]')
    `, [nlSeq.id]);

    // Attach sequences to campaigns
    await db.query(`UPDATE campaigns SET sequence_id = $1 WHERE id IN (14, 15) AND workspace_id = 1`, [israelSeq.id]);
    await db.query(`UPDATE campaigns SET sequence_id = $1 WHERE id IN (16, 17) AND workspace_id = 1`, [nlSeq.id]);

    console.log(`[SchemaV2] Created CMOvate sequences: Israel=${israelSeq.id} NL=${nlSeq.id}`);
  });

  // Remove sequences attached without user consent
  await s('fix.detach_datatailr_sequences', () => db.query(
    `UPDATE campaigns SET sequence_id = NULL WHERE id IN (11, 12, 13) AND workspace_id = 4 AND sequence_id = 4`
  ));

  console.log('[SchemaV2] ✓ All v2 migrations complete');
}

module.exports = { initSchemaV2 };
