-- Run this once to add webhook_id column to unipile_accounts
ALTER TABLE unipile_accounts ADD COLUMN IF NOT EXISTS webhook_id VARCHAR(255);
ALTER TABLE unipile_accounts ADD COLUMN IF NOT EXISTS invite_sent_at TIMESTAMP;

-- Index for fast lookup by li_profile_url on webhook arrival
CREATE INDEX IF NOT EXISTS idx_contacts_li_profile ON contacts(li_profile_url);
CREATE INDEX IF NOT EXISTS idx_contacts_invite_sent ON contacts(invite_sent);
