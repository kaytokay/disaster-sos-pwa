# Offline-First Disaster SOS & Triage PWA

This project contains a browser-based citizen app, a responder dashboard, and a FastAPI service. The service serves the frontend and API from one origin. The current report API stores records; it does not notify or dispatch emergency responders.

## Run locally on Windows

Run `start.bat` and choose **Install everything**, then choose a page to open. The local database is `backend/sos.db` and is excluded from Git.

## Deploy on Render

1. Push this project to a GitHub repository. `.gitignore` excludes the local virtual environment, Python cache files, local database, and `.env` secrets.
2. In Render, create a PostgreSQL database and a Web Service connected to the repository. Render can also read the settings in `render.yaml` as a Blueprint.
3. Set the service's `DATABASE_URL` to the database's **internal** connection URL. Set `ADMIN_USERNAME` and a long, unique `ADMIN_PASSWORD` in Render's environment settings. Do not commit these values.
4. Deploy. The service uses the commands in `render.yaml`; check `/api/health` on its HTTPS URL. The citizen pages and API share that origin.
5. Open `/dashboard.html`; the browser will request the responder credentials. The reports API, statistics, status updates, and dashboard page are protected. Citizen report submissions remain public by design.

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
