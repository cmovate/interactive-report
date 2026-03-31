# El-Via ABM — Development TODO

Last session: 2026-03-31 07:54 UTC

## CORE FEATURES — COMPLETE ✅
- Lists tab: create, upload contacts (LinkedIn URLs), view count + card
- Campaign wizard: Account → List → Sequence → Name & Hours  
- Campaign card: shows list name badge (👥 Israeli CTOs Q3 2025)
- Opportunities: list filter dropdown (for companies lists)
- Feed: list filter dropdown (for contacts lists)
- Full e2e: list(3 contacts) → campaign → 3 contacts auto-copied ✅

## 🔴 Still Needed (next session)
- [ ] New list modal: test via UI (the + New list button)
- [ ] Companies list: UI to add companies (similar to upload contacts)
- [ ] Opportunities filter: only shows options when companies-type lists exist — need to create one to test

## 🟡 Medium Priority
- [ ] Campaign card: show contact count from list_id (currently shows contacts in campaign)
- [ ] lists.html: "+ New list" modal test — verify it works from UI (not just API)
- [ ] Admin Analytics encoding bug (garbled unicode in link)
- [ ] server.js: backfill.account_profiles uses old getAccountInfo

## Key Info
- Repo: cmovate/interactive-report
- Prod: https://interactive-report-production-0c5d.up.railway.app
- Push: POST /dev/push-file (10MB, GITHUB_TOKEN in Railway env)
- TFT test: list id=1 "Israeli CTOs Q3 2025" has 3 contacts
- Workspaces: CMOvate(1) CLY(2) TFT(3) Datatailr(4)
