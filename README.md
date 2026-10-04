# Temp Mail — Phase 1

A clean disposable-email website foundation.

## What works now
- Generate a random temporary inbox
- 15-minute expiry countdown
- Copy email address
- Refresh inbox
- Delete inbox
- Clean responsive UI
- Express API
- SQLite persistence
- Automatic expired-inbox cleanup

## Important
Phase 1 does **not** receive real internet email yet. The inbox is fully functional as a local product prototype, but real mail delivery requires a domain + mail receiving server/DNS setup.

## Run

Requirements:
- Node.js 18+

From this folder:

```bash
npm install
npm run install-all
npm run dev
```

Open:

http://localhost:5173

The API runs on:

http://localhost:4000
