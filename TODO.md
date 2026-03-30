# El-Via ABM — Development TODO

Last session: 2026-03-30 23:19 UTC

## ✅ Completed this session
- Full Lists architecture: tables, routes, UI
- Campaign wizard: Account → List → Sequence → Name & Hours
- List picker in campaigns: data-id approach (no escaping issues)
- express.static before catch-all (workspace.html was broken)
- /dev/push-file works for files up to 10MB
- resetWizard TDZ fix
- apiFetch → fetch() in lists.html and campaigns.html

## 🔴 High Priority (do next)
- [ ] lists.html: "Upload contacts" panel — paste LinkedIn URLs → POST /api/lists/:id/contacts
- [ ] lists.html: list-card onclick fix (same escaping issue as campaigns — use data-id)
- [ ] Test full end-to-end: create list → add contacts → create campaign → verify contacts copied

## 🟡 Medium Priority
- [ ] opportunities.html: add list filter dropdown (select company list)
- [ ] feed.html: add list filter dropdown
- [ ] list_companies: UI to add companies to a companies-type list
- [ ] List stats: contact_count should update after contacts added

## 🟢 Low Priority  
- [ ] Admin Analytics encoding bug (garbled text in link)
- [ ] server.js: backfill account_profiles still uses old getAccountInfo

## Key Info
- Repo: cmovate/interactive-report
- Prod: https://interactive-report-production-0c5d.up.railway.app
- Push: POST /dev/push-file (10MB limit, GITHUB_TOKEN in Railway env)
- GitHub token: stored in Railway env as GITHUB_TOKEN (not here)
- DB: PostgreSQL on Railway (lists, list_contacts, list_companies tables added)
- Workspaces: CMOvate(1) CLY(2) TFT(3) Datatailr(4)
