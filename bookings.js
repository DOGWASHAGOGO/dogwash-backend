// Simple in-memory store with JSON file persistence
// In production this could be swapped for a database (Postgres, etc.)

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'bookings.json');

// Ensure data directory exists
function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(data) {
  ensureDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getAll() {
  return load();
}

function getById(id) {
  return load().find(b => b.id === id) || null;
}

function getForDay(locationId, dateStr) {
  return load().filter(b => b.locationId === locationId && b.date === dateStr);
}

function create(booking) {
  const all = load();
  all.push(booking);
  save(all);
  return booking;
}

function confirm(id, shopifyOrderId) {
  const all = load();
  const idx = all.findIndex(b => b.id === id);
  if (idx === -1) return null;
  all[idx].status = 'confirmed';
  all[idx].shopifyOrderId = shopifyOrderId;
  all[idx].confirmedAt = new Date().toISOString();
  save(all);
  return all[idx];
}

function cancel(id) {
  const all = load();
  const idx = all.findIndex(b => b.id === id);
  if (idx === -1) return null;
  all[idx].status = 'cancelled';
  all[idx].cancelledAt = new Date().toISOString();
  save(all);
  return all[idx];
}

function expireOld() {
  const all = load();
  const now = new Date();
  let changed = false;
  all.forEach(b => {
    if (b.status === 'reserved' && new Date(b.expiresAt) < now) {
      b.status = 'expired';
      changed = true;
    }
  });
  if (changed) save(all);
}

module.exports = { getAll, getById, getForDay, create, confirm, cancel, expireOld };
