"use strict";
const $ = id => document.getElementById(id);
const page = document.body.dataset.page;
const toast = (m, ms = 5000) => { const t = $("toast"); t.textContent = m; t.style.display = "block"; setTimeout(() => t.style.display = "none", ms); };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- IndexedDB wrapper ---------- */
const DB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open("disaster-db", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("pending_broadcasts", { keyPath: "id" });
      r.onsuccess = () => res(this._db = r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction("pending_broadcasts", mode), out = fn(t.objectStore("pending_broadcasts"));
      t.oncomplete = () => res(out.result); t.onerror = () => rej(t.error);
    });
  },
  put: rec => DB.tx("readwrite", s => s.put(rec)),
  all: () => DB.tx("readonly", s => s.getAll()),
};

/* ---------- Service worker ---------- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW failed", e));
  navigator.serviceWorker.addEventListener("message", e => { if (e.data === "SYNC_NOW") syncQueue(); });
}

/* ---------- Sync orchestrator ---------- */
let syncing = false;
async function syncQueue() {
  if (syncing) return;
  syncing = true;
  try {
    const queued = (await DB.all()).filter(r => r.sync_status === "QUEUED");
    if (!queued.length) return;
    const res = await fetch("/api/sos/batch", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(queued.map(r => ({ ...r.payload, id: r.id, created_offline: true }))) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    for (const r of queued) await DB.put({ ...r, sync_status: "SYNCED", synced_at: new Date().toISOString() });
    toast(`Back online. ${queued.length} saved SOS report(s) broadcast.`);
  } catch (e) { console.warn("Sync failed, will retry", e); }
  finally { syncing = false; if (page === "citizen") updateStatus(); }
}

/* ---------- Citizen page ---------- */
async function updateStatus() {
  const n = $("net");
  let on = false;
  try {
    const response = await fetch(`/api/health?check=${Date.now()}`, { cache: "no-store" });
    on = response.ok && (await response.json()).status === "ok";
  } catch {}
  n.className = "badge " + (on ? "on" : "off");
  n.textContent = on ? "Connected · SOS reports send directly to responders." : "SOS server unavailable. Reports will be saved on this device and sent when the server is reachable.";
  const q = (await DB.all()).filter(r => r.sync_status === "QUEUED").length;
  $("pending").textContent = q ? `${q} SOS report(s) waiting to be sent.` : "";
}

function getGPS() {
  const g = $("gps");
  if (!navigator.geolocation) { g.textContent = "GPS unavailable. Enter coordinates manually."; return; }
  g.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(p => {
    $("lat").value = p.coords.latitude.toFixed(6); $("lon").value = p.coords.longitude.toFixed(6);
    g.dataset.acc = p.coords.accuracy; g.textContent = `GPS fix: accuracy ±${Math.round(p.coords.accuracy)} m`;
    renderShelters();
  }, err => { g.dataset.acc = ""; g.textContent = `GPS unavailable (${err.message}). Enter coordinates manually.`; },
  { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
}

function buildPayload() {
  return {
    name: $("name").value.trim() || null, contact_number: $("contact").value.trim() || null,
    people_count: +$("people").value, hazard_category: $("hazard").value, details: $("note").value.trim(),
    latitude: +$("lat").value, longitude: +$("lon").value,
    location_accuracy: $("gps").dataset.acc ? +$("gps").dataset.acc : null, client_timestamp: new Date().toISOString(),
  };
}

async function queue(payload) {
  await DB.put({ id: crypto.randomUUID(), payload, sync_status: "QUEUED", created_at: new Date().toISOString() });
  const reg = await navigator.serviceWorker?.ready;
  if (reg && "sync" in reg) reg.sync.register("sync-sos").catch(() => {});
  toast("Operating in Offline Mode. SOS saved locally and will auto-broadcast upon network recovery.", 8000);
  updateStatus();
}

async function submitSOS(e) {
  e.preventDefault();
  const payload = buildPayload();
  if (isNaN(payload.latitude) || isNaN(payload.longitude)) return toast("Enter your coordinates first.");
  try {
    const res = await fetch("/api/sos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const d = await res.json(); toast(`SOS sent. Your ticket: ${d.ticket}`, 8000); updateStatus(); return;
  } catch (err) { console.warn("Send failed, queueing", err); }
  await queue(payload);
}

function sendSMS() {
  const p = buildPayload();
  const body = `SOS ${p.hazard_category}|${p.people_count}ppl|${p.latitude},${p.longitude}|${p.name || ""}|${p.contact_number || ""}|${p.details}`.slice(0, 300);
  location.href = "sms:?body=" + encodeURIComponent(body);
}

const km = (a, b, c, d) => { const r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
async function renderShelters() {
  const el = $("shelters"), lat = +$("lat").value, lon = +$("lon").value, has = $("lat").value && $("lon").value;
  try {
    let list = await (await fetch("shelters-v2.json")).json();
    if (has) list = list.map(s => ({ ...s, d: km(lat, lon, s.lat, s.lon) })).sort((a, b) => a.d - b.d);
    el.innerHTML = list.map((s, i) => {
      const contact = s.phone
        ? `<div class="facility-phone">${s.direct_phone ? "" : "No direct site number · "}<a href="tel:${encodeURIComponent(s.phone.replace(/[^+\d]/g, ""))}" aria-label="Call ${esc(s.phone_label || s.name)} at ${esc(s.phone)}">☎ ${esc(s.phone)}</a><small>${esc(s.phone_label || "Call")}</small></div>`
        : `<span class="facility-phone unavailable">Direct phone not listed · <a href="tel:112">Emergency: 112</a></span>`;
      return `<div class="shelter" data-place="${i}" data-lat="${s.lat}" data-lon="${s.lon}" data-name="${esc(s.name)}"><span class="shelter-info"><b>${esc(s.name)}</b><small>${esc(s.type)} · capacity ${s.capacity}</small>${contact}</span>
      <span class="shelter-distance">${s.d !== undefined ? s.d.toFixed(1) + " km" : "–"}<button type="button" class="map-link show-map">View map ↗</button></span></div>`;
    }).join("");
    el.querySelectorAll(".show-map").forEach(button => button.addEventListener("click", () => {
      const row = button.closest(".shelter");
      const { lat, lon, name } = row.dataset;
      $("nearby-map").src = `https://maps.google.com/maps?q=${lat},${lon}&z=15&output=embed`;
      $("map-title").textContent = name; $("map-caption").textContent = `${lat}, ${lon} · ${row.querySelector(".shelter-info small").textContent}`;
    }));
  } catch { el.textContent = "Shelter list unavailable."; }
}

/* ---------- Trusted contacts ---------- */
const CONTACTS_KEY = "disaster-trusted-contacts";
function renderContacts() {
  const root = $("contacts"); if (!root) return;
  let contacts = []; try { contacts = JSON.parse(localStorage.getItem(CONTACTS_KEY) || "[]"); } catch {}
  root.innerHTML = contacts.length ? contacts.map((c, i) => `<div class="contact-card"><span class="contact-avatar">${esc((c.name || "?").trim().charAt(0).toUpperCase())}</span><span class="contact-details"><b>${esc(c.name)}</b><small>${esc(c.phone)}</small></span><a class="call-contact" href="tel:${encodeURIComponent(c.phone.replace(/[^+\d]/g, ""))}">Call</a><button class="remove-contact" type="button" data-remove="${i}" aria-label="Remove ${esc(c.name)}">×</button></div>`).join("") : `<p class="hint">Add a relative or trusted contact for quick calling from this device.</p>`;
  root.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", () => { contacts.splice(+b.dataset.remove, 1); localStorage.setItem(CONTACTS_KEY, JSON.stringify(contacts)); renderContacts(); }));
}

/* ---------- Dashboard ---------- */
const LABEL = { PENDING: "OPEN", RESCUE_DISPATCHED: "DISPATCHED", RESCUED: "RESOLVED" };
async function loadDashboard() {
  try {
    const [rows, s] = await Promise.all([fetch("/api/sos").then(r => r.json()), fetch("/api/stats").then(r => r.json())]);
    $("stats").innerHTML = [["Reports", s.total], ["People awaiting rescue", s.people_trapped], ["Open", s.open], ["Resolved", s.resolved],
      ["Avg sync latency", s.avg_sync_latency_s + " s"]].map(([k, v]) => `<div class="stat"><b>${v}</b>${k}</div>`).join("");
    $("feed").innerHTML = rows.length ? rows.map(r => `<tr><td><span class="tag ${r.urgency_level}">${r.urgency_level}</span></td>
      <td>${esc(r.hazard_category)}${r.created_offline ? "<br><small>sent after reconnect</small>" : ""}</td><td>${r.people_count}</td>
      <td>${esc(r.details)}<br><small>${esc(r.contact_number || "")}</small></td><td>${new Date(r.timestamp).toLocaleString()}</td>
      <td><a href="https://maps.google.com/?q=${r.latitude},${r.longitude}" target="_blank" rel="noopener">Open map</a></td>
      <td><select data-id="${r.id}" aria-label="Status">${Object.entries(LABEL).map(([k, v]) => `<option value="${k}" ${k === r.status ? "selected" : ""}>${v}</option>`).join("")}</select></td></tr>`).join("")
      : `<tr><td colspan="7">No reports yet.</td></tr>`;
  } catch { toast("Cannot reach the server. Showing last data."); }
}

/* ---------- Boot ---------- */
window.addEventListener("online", () => { syncQueue(); if (page === "citizen") updateStatus(); });
window.addEventListener("offline", () => { if (page === "citizen") updateStatus(); });
if (page === "citizen") {
  $("sos-form").addEventListener("submit", submitSOS);
  $("refresh-gps").addEventListener("click", getGPS);
  $("sms").addEventListener("click", sendSMS);
  $("quick-sos").addEventListener("click", () => $("sos-form").requestSubmit());
  $("nearby-refresh").addEventListener("click", getGPS);
  $("add-contact").addEventListener("click", () => { $("contact-form").hidden = false; $("relative-name").focus(); });
  $("cancel-contact").addEventListener("click", () => { $("contact-form").reset(); $("contact-form").hidden = true; });
  $("contact-form").addEventListener("submit", e => { e.preventDefault(); const phone = $("relative-phone").value.trim(); if (phone.replace(/\D/g, "").length < 5) return toast("Enter a valid phone number."); let contacts = []; try { contacts = JSON.parse(localStorage.getItem(CONTACTS_KEY) || "[]"); } catch {} contacts.push({ name: $("relative-name").value.trim(), phone }); localStorage.setItem(CONTACTS_KEY, JSON.stringify(contacts)); e.currentTarget.reset(); e.currentTarget.hidden = true; renderContacts(); toast("Trusted contact saved on this device."); });
  ["lat", "lon"].forEach(i => $(i).addEventListener("change", renderShelters));
  renderContacts(); updateStatus(); renderShelters(); getGPS(); syncQueue();
} else {
  $("reload").addEventListener("click", loadDashboard);
  $("feed").addEventListener("change", async e => {
    if (!e.target.dataset.id) return;
    const r = await fetch(`/api/sos/${e.target.dataset.id}/status`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: e.target.value }) });
    toast(r.ok ? "Status updated." : "Update failed."); loadDashboard();
  });
  loadDashboard(); setInterval(loadDashboard, 10000);
}
