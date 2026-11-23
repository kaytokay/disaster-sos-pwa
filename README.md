# Offline-First Disaster SOS & Triage PWA

This project contains a browser-based citizen app, a responder dashboard, and a FastAPI service. The service serves the frontend and API from one origin. The current report API stores records; it does not notify or dispatch emergency responders.

## Run locally on Windows

Run `start.bat` and choose **Install everything**, then choose a page to open. The local database is `backend/sos.db` and is excluded from Git.

## Free demo deployment (Render + Supabase)

1. Push this project to a GitHub repository. `.gitignore` excludes the local virtual environment, Python cache files, local database, and `.env` secrets.
2. Create a Supabase project on its Free plan. Choose a region near the Render service (Singapore is a good choice for India).
3. In Supabase, open **Connect** and copy the **Session pooler** connection string. Use this pooler rather than the direct connection because Render's network is IPv4-only. Add `sslmode=require` to the URL if it is not already present.
4. In Render, create a Web Service connected to the repository, choose the **Free** plan, and use the same region as Supabase. Or import `render.yaml` as a Blueprint; it explicitly sets the service plan to Free.
5. Set `DATABASE_URL` to the Supabase Session pooler string and set `ADMIN_USERNAME` plus a long, unique `ADMIN_PASSWORD` in Render's environment settings. Keep these secrets out of GitHub.
6. Deploy and check `/api/health` on the HTTPS service URL. The citizen pages and API share that origin. Open `/dashboard.html`; the browser will request the responder credentials.

Free tiers have limits: Render's Free web service sleeps after 15 minutes without traffic and may take about a minute to wake. Supabase Free projects can pause after a week of low activity and have no automatic backups. This setup is for a $0 demo, not a service people rely on during an emergency.

Production startup fails if the app is missing its PostgreSQL URL or responder credentials. The local launcher keeps using SQLite unless `DATABASE_URL` is set.

## Offline behavior

Load the app once while online to cache its shell. SOS submissions made offline stay in that device's IndexedDB queue and are sent when a connection returns. Report data and the authenticated dashboard API are not cached by the service worker.

## Local API

From the repository root:

```powershell
cd backend
..\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

Open `http://localhost:8000`, `http://localhost:8000/dashboard.html`, or `http://localhost:8000/docs`.
