# El-Via ABM — Session TODO
_Updated: 2026-04-04T20:28:39.995Z_

## ✅ Completed this session

### Feed tab — full rebuild
- Removed all filters (Campaign, List, Fetch button)
- Shows all posts + comments for the workspace, no filtering
- Auto-refresh: polls every 60s, shows green "🔔 New posts available" banner
- **Comment button**: inline textarea + "COMMENT AS" account selector
  - Loads all connected workspace accounts (Tomer Tabibi, Elad Itzkovitch)
  - Sends via Unipile POST /api/v1/posts/{post_id}/comments
  - Account selector populates on-demand when box opens
- Comments displayed as: "COMMENTED ON A POST → View original post on LinkedIn" + contact comment below

### Feed data pipeline
- `POST /api/feed/sync-from-engagement`: reads contacts.engagement_data → inserts into linkedin_posts
  - Comments use urn:li:comment:{id} URN, posts use urn:li:activity:{id}
  - Sets parent_post_urn for comments
- `POST /api/feed/fetch-parent-posts`: fetches parent post content from Unipile (currently errors — endpoint may not exist)
- `POST /api/feed/comment`: accepts workspace_id, post_urn, text, account_id → calls Unipile
- `ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS parent_post_urn text`
- unipile.js: getPost() and commentPost() added

### engagementScraper fixes
- SCRAPE_LIMIT = 5 (was 50)
- Loops contact by contact (LIMIT 1 per query)
- Stops when 30 posts+comments found (TARGET=30), MAX_ATTEMPTS=150
- Manual trigger: POST /api/contacts/run-engagement-scraper

### Campaign modal fixes
- Fixed syntax errors (quote collisions in onclick attrs) in campaign-modal.js
- campaign row click now opens modal correctly (CLY + Datatailr)
- List attachment UI working in campaign modal

### Datatailr
- Dimi (id=12) + Damien (id=13): all 4 lists attached → 2,629 contacts each
- Engagement scraper triggered for campaign 11

---

## 🔲 Pending

1. **Feed parent post content** — fetch-parent-posts returns errors:24
   - Unipile may not have GET /api/v1/posts/{id} endpoint
   - Currently showing "View original post on LinkedIn →" link as fallback
   - Need to investigate correct Unipile endpoint

2. **Eshaan campaign (id=11)** — no message sequence configured yet

3. **Datatailr enrichment** — ~719 contacts still pending

4. **engagementScraper for Datatailr** — campaign 11 had 0 scraped contacts at last check

5. **CLY messages** — 15 contacts scheduled, should send tonight (20:19–23:47 Israel time)

---

## Key DB state
- CLY linkedin_posts: 52 total (27 comments with parent_post_urn, 16 posts, 9 old)
- CLY contacts: 113 scraped for engagement
- Datatailr contacts: 2,679 total
