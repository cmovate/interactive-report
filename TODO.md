# El-Via ABM — Development TODO

Last session: 2026-03-31 07:39 UTC

## CORE ARCHITECTURE — COMPLETE ✅
The Lists-first architecture is fully working:
- Lists tab: create lists, upload contacts (LinkedIn URLs), view count
- Campaign wizard: Account → List → Sequence → Name & Hours
- Campaign creation: contacts automatically copied from selected list
- End-to-end tested: list with 3 contacts → campaign created with 3 contacts

## 🔴 High Priority (next)
- [ ] Upload contacts UI: test from the actual modal (lca-u button click → modal → paste URLs → upload)
- [ ] Campaign wizard UI test: click through all 4 steps visually, create real campaign
- [ ] Lists: "+ New list" modal test (create via UI, not API)

## 🟡 Medium Priority  
- [ ] opportunities.html: add list filter dropdown (select company list to scope scan)
- [ ] feed.html: add list filter dropdown
- [ ] list_companies: UI to add companies to companies-type list
- [ ] campaigns.html: show list name on campaign card (currently only account shown)

## 🟢 Low Priority
- [ ] Admin Analytics encoding bug (garbled unicode in link text)
- [ ] server.js: backfill.account_profiles uses old getAccountInfo (no avatar)
- [ ] Notification system: test that index.html banner fires on next visit

## Key Info
- Repo: cmovate/interactive-report  
- Prod: https://interactive-report-production-0c5d.up.railway.app
- Push: POST /dev/push-file (10MB limit, GITHUB_TOKEN env in Railway)
- Workspaces: CMOvate(1) CLY(2) TFT(3) Datatailr(4)
- TFT test list id=1 "Israeli CTOs Q3 2025" has 3 contacts
