import base64
import hmac
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import List, Literal, Optional

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

DB_PATH = os.path.join(os.path.dirname(__file__), "sos.db")
FRONTEND = os.path.join(os.path.dirname(__file__), "..", "frontend")
DATABASE_URL = os.getenv("DATABASE_URL")
APP_ENV = os.getenv("APP_ENV", "development").lower()
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")

if bool(ADMIN_USERNAME) != bool(ADMIN_PASSWORD):
    raise RuntimeError("Set both ADMIN_USERNAME and ADMIN_PASSWORD, or neither.")
if APP_ENV == "production" and not ADMIN_USERNAME:
    raise RuntimeError("Production requires ADMIN_USERNAME and ADMIN_PASSWORD.")
if APP_ENV == "production" and not DATABASE_URL:
    raise RuntimeError("Production requires DATABASE_URL for persistent shared storage.")

if DATABASE_URL:
    import psycopg
    from psycopg.rows import dict_row

    if DATABASE_URL.startswith("postgres://"):
        DATABASE_URL = "postgresql://" + DATABASE_URL[len("postgres://"):]

Hazard = Literal["Medical Emergency", "Structural Collapse / Trapped",
                 "Flood / Rising Water", "Food & Potable Water Shortage", "Fire"]
Status = Literal["PENDING", "RESCUE_DISPATCHED", "RESCUED"]

SQLITE_DDL = """
CREATE TABLE IF NOT EXISTS sos_reports (
  id TEXT PRIMARY KEY,
  timestamp DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  latitude REAL NOT NULL, longitude REAL NOT NULL, location_accuracy REAL,
  hazard_category TEXT NOT NULL, people_count INTEGER NOT NULL DEFAULT 1,
  details TEXT, contact_number TEXT,
  urgency_level TEXT NOT NULL CHECK (urgency_level IN ('CRITICAL','HIGH','MODERATE')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RESCUE_DISPATCHED','RESCUED')),
  created_offline BOOLEAN NOT NULL DEFAULT 0, client_timestamp DATETIME
);
CREATE INDEX IF NOT EXISTS idx_sos_status ON sos_reports(status, urgency_level);
"""

POSTGRES_DDL = """
CREATE TABLE IF NOT EXISTS sos_reports (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL, location_accuracy DOUBLE PRECISION,
  hazard_category TEXT NOT NULL, people_count INTEGER NOT NULL DEFAULT 1,
  details TEXT, contact_number TEXT,
  urgency_level TEXT NOT NULL CHECK (urgency_level IN ('CRITICAL','HIGH','MODERATE')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RESCUE_DISPATCHED','RESCUED')),
  created_offline BOOLEAN NOT NULL DEFAULT FALSE, client_timestamp TEXT
);
CREATE INDEX IF NOT EXISTS idx_sos_status ON sos_reports(status, urgency_level);
"""


def conn():
    if DATABASE_URL:
        return psycopg.connect(DATABASE_URL, row_factory=dict_row)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def execute(c, query: str, args=()):
    if DATABASE_URL:
        query = query.replace("?", "%s")
        if query.lstrip().upper().startswith("INSERT OR IGNORE"):
            query = query.replace("INSERT OR IGNORE", "INSERT", 1).rstrip().rstrip(";")
            query += " ON CONFLICT (id) DO NOTHING"
    return c.execute(query, args)


with conn() as c:
    ddl = POSTGRES_DDL if DATABASE_URL else SQLITE_DDL
    for statement in ddl.split(";"):
        if statement.strip():
            c.execute(statement)


def classify(h: str) -> str:
    if h in ("Medical Emergency", "Structural Collapse / Trapped", "Fire"):
        return "CRITICAL"
    if h == "Flood / Rising Water":
        return "HIGH"
    return "MODERATE"


class SOSIn(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = Field(None, max_length=80)
    contact_number: Optional[str] = Field(None, max_length=30)
    people_count: int = Field(1, ge=1, le=1000)
    hazard_category: Hazard
    details: str = Field("", max_length=500)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    location_accuracy: Optional[float] = Field(None, ge=0)
    client_timestamp: Optional[str] = None
    created_offline: bool = False


class StatusIn(BaseModel):
    status: Status


def insert(s: SOSIn) -> dict:
    rid = s.id or str(uuid.uuid4())
    details = (f"[{s.name}] " if s.name else "") + s.details
    with conn() as c:  # INSERT OR IGNORE makes retried syncs idempotent
        execute(c, """INSERT OR IGNORE INTO sos_reports (id,timestamp,latitude,longitude,location_accuracy,
            hazard_category,people_count,details,contact_number,urgency_level,created_offline,client_timestamp)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (rid, datetime.now(timezone.utc).isoformat(), s.latitude, s.longitude, s.location_accuracy,
             s.hazard_category, s.people_count, details, s.contact_number, classify(s.hazard_category),
             s.created_offline, s.client_timestamp))
        return dict(execute(c, "SELECT * FROM sos_reports WHERE id=?", (rid,)).fetchone())


app = FastAPI(title="Disaster SOS Broadcast")


@app.middleware("http")
async def protect_responder_data(request: Request, call_next):
    path = request.url.path
    protected = path == "/dashboard.html" or (
        path in ("/api/sos", "/api/stats") and request.method == "GET"
    ) or (path.startswith("/api/sos/") and path.endswith("/status"))
    if protected and ADMIN_USERNAME:
        try:
            scheme, token = request.headers.get("authorization", "").split(" ", 1)
            raw = base64.b64decode(token, validate=True).decode("utf-8")
            username, password = raw.split(":", 1)
        except (ValueError, UnicodeDecodeError):
            username = password = ""
            scheme = ""
        if (scheme.lower() != "basic" or
                not hmac.compare_digest(username, ADMIN_USERNAME) or
                not hmac.compare_digest(password, ADMIN_PASSWORD)):
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="Responder dashboard"'})
    response = await call_next(request)
    if protected:
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.post("/api/sos", status_code=201)
async def create_sos(s: SOSIn):
    r = insert(s)
    return {"ticket": r["id"][:8].upper(), **r}


@app.post("/api/sos/batch", status_code=201)
async def create_batch(items: List[SOSIn]):
    out = []
    for s in items:
        s.created_offline = True
        out.append(insert(s)["id"])
    return {"synced_ids": out, "count": len(out)}


@app.get("/api/sos")
async def list_sos(status: Optional[Status] = None):
    q = "SELECT * FROM sos_reports"
    args = []
    if status:
        q += " WHERE status=?"
        args.append(status)
    q += """ ORDER BY CASE urgency_level WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 ELSE 2 END,
             people_count DESC, timestamp ASC"""
    with conn() as c:
        return [dict(r) for r in execute(c, q, args)]


@app.patch("/api/sos/{sos_id}/status")
async def update_status(sos_id: str, body: StatusIn):
    with conn() as c:
        cur = execute(c, "UPDATE sos_reports SET status=? WHERE id=?", (body.status, sos_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "Report not found")
        return dict(execute(c, "SELECT * FROM sos_reports WHERE id=?", (sos_id,)).fetchone())


@app.get("/api/stats")
async def stats():
    with conn() as c:
        rows = [dict(r) for r in execute(c, "SELECT * FROM sos_reports")]
    lat = []
    for r in rows:
        if r["created_offline"] and r["client_timestamp"]:
            try:
                a = datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
                b = datetime.fromisoformat(r["client_timestamp"].replace("Z", "+00:00"))
                lat.append((a - b).total_seconds())
            except ValueError:
                pass
    return {"total": len(rows), "people_trapped": sum(r["people_count"] for r in rows if r["status"] != "RESCUED"),
            "open": sum(r["status"] != "RESCUED" for r in rows), "resolved": sum(r["status"] == "RESCUED" for r in rows),
            "avg_sync_latency_s": round(sum(lat) / len(lat), 1) if lat else 0}


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
