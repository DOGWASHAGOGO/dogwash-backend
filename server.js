require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const stripe = require('./stripe');
const mailer = require('./mailer');
const bookings = require('./bookings');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

const PORT = process.env.PORT || 3000;

const LOCATIONS = {
  neukolln: {
    name: 'Neukölln',
    address: 'Berlin Neukölln',
    stations: 1,
    hours: {
      1: { open: 11, close: 19 },
      3: { open: 11, close: 19 },
      4: { open: 11, close: 19 },
      5: { open: 10, close: 18 },
      6: { open: 10, close: 18 },
    }
  }
};

const SLOT_DURATION = 30;
const MIN_SLOTS = 2;

app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());

function getSlotsForDay(locationId, dateStr) {
  const location = LOCATIONS[locationId];
  if (!location) return [];
  const date = new Date(dateStr);
  const dow = date.getDay();
  const hours = location.hours[dow];
  if (!hours) return [];
  const slots = [];
  let current = hours.open * 60;
  const closeMin = hours.close * 60;
  while (current < closeMin) {
    const hh = String(Math.floor(current / 60)).padStart(2, '0');
    const mm = String(current % 60).padStart(2, '0');
    slots.push(`${hh}:${mm}`);
    current += SLOT_DURATION;
  }
  return slots;
}

function getBookedSlots(locationId, dateStr) {
  const dayBookings = bookings.getForDay(locationId, dateStr);
  const booked = {};
  dayBookings.forEach(b => {
    if (b.status === 'cancelled' || b.status === 'expired') return;
    b.slots.forEach(slot => {
      booked[slot] = (booked[slot] || 0) + 1;
    });
  });
  return booked;
}

function getSlotsFromTime(allSlots, startTime, count) {
  const idx = allSlots.indexOf(startTime);
  if (idx === -1 || idx + count > allSlots.length) return null;
  return allSlots.slice(idx, idx + count);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Dog Wash A Go Go Booking' });
});

app.get('/availability/:locationId/:date', (req, res) => {
  const { locationId, date } = req.params;
  if (!LOCATIONS[locationId]) return res.status(404).json({ error: 'Location not found' });
  const allSlots = getSlotsForDay(locationId, date);
  if (allSlots.length === 0) return res.json({ date, slots: [], closed: true });
  const booked = getBookedSlots(locationId, date);
  const stations = LOCATIONS[locationId].stations;
  const slots = allSlots.map((time, idx) => {
    const available = stations - (booked[time] || 0);
    let canBook = available > 0;
    if (canBook) {
      for (let i = 0; i < MIN_SLOTS; i++) {
        const checkSlot = allSlots[idx + i];
        if (!checkSlot || (stations - (booked[checkSlot] || 0)) <= 0) { canBook = false; break; }
      }
    }
    const extraSlot = allSlots[idx + MIN_SLOTS];
    const extraAvailable = extraSlot ? (stations - (booked[extraSlot] || 0)) > 0 : false;
    return { time, available, canBook, extraAvailable };
  });
  res.json({ date, locationId, slots, closed: false });
});

app.post('/reserve', async (req, res) => {
  const { locationId, date, startTime, extraTime, size, price, addons, customer } = req.body;
  if (!locationId || !date || !startTime || !size || !customer) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const allSlots = getSlotsForDay(locationId, date);
  const slotCount = MIN_SLOTS + (extraTime ? 1 : 0);
  const reservedSlots = getSlotsFromTime(allSlots, startTime, slotCount);
  if (!reservedSlots) return res.status(400).json({ error: 'Invalid time slot' });
  const booked = getBookedSlots(locationId, date);
  const stations = LOCATIONS[locationId].stations;
  for (const slot of reservedSlots) {
    if ((booked[slot] || 0) >= stations) {
      return res.status(409).json({ error: 'Slot no longer available' });
    }
  }
  const addonTotal = addons ? addons.reduce((sum, a) => sum + a.price, 0) : 0;
  const total = price + addonTotal + (extraTime ? 10 : 0);
  const bookingId = uuidv4();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const lang = req.body.lang || 'en';
  bookings.create({
    id: bookingId, locationId, date, slots: reservedSlots, startTime,
    extraTime: !!extraTime, size, price, addons: addons || [], total,
    customer, lang, status: 'reserved', expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString()
  });
  try {
    const checkoutUrl = await stripe.createCheckout({
      bookingId, size, price, addons: addons || [], extraTime, total,
      customer, date, startTime, locationName: LOCATIONS[locationId].name
    });
    res.json({ bookingId, checkoutUrl, expiresAt: expiresAt.toISOString(), total });
  } catch (err) {
    console.error('Stripe error:', err.message);
    bookings.cancel(bookingId);
    res.status(500).json({ error: 'Could not create checkout. Please try again.' });
  }
});

app.post('/webhook/stripe', async (req, res) => {
  let event;
  try {
    event = JSON.parse(req.body);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid webhook' });
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bookingId = session.metadata?.booking_id;
    if (bookingId) {
      const booking = bookings.getById(bookingId);
      if (booking) {
        bookings.confirm(bookingId, session.payment_intent);
        const confirmed = bookings.getById(bookingId);
        try {
          await mailer.sendCustomerConfirmation(confirmed);
          await mailer.sendOwnerNotification(confirmed);
        } catch (e) {
          console.error('Email error:', e.message);
        }
      }
    }
  }
  res.json({ received: true });
});

app.get('/booking-confirmed', (req, res) => {
  const booking = req.query.id ? bookings.getById(req.query.id) : null;
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Booking Confirmed</title><style>body{font-family:sans-serif;background:#FEFDF8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{background:white;border-radius:20px;padding:40px;max-width:440px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}h1{color:#09A6E3;font-size:26px;margin-bottom:8px}p{color:#888;line-height:1.6}.tag{display:inline-block;background:#F4D11A;border-radius:99px;padding:6px 18px;font-weight:700;color:#1A1A2E;margin-top:20px}</style></head><body><div class="box"><div style="font-size:52px;margin-bottom:16px">🛁</div><h1>You're all booked!</h1><p>A confirmation is on its way to your inbox.<br>We can't wait to meet your pup in Neukölln!</p>${booking?`<p style="margin-top:16px"><strong>${booking.date} at ${booking.startTime}</strong></p>`:''}<div class="tag">See you soon ✦</div></div></body></html>`);
});

app.get('/booking-cancelled', (req, res) => {
  if (req.query.id) bookings.cancel(req.query.id);
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Booking Cancelled</title><style>body{font-family:sans-serif;background:#FEFDF8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{background:white;border-radius:20px;padding:40px;max-width:440px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}h1{color:#1A1A2E;font-size:24px;margin-bottom:8px}p{color:#888;line-height:1.6}a{display:inline-block;background:#09A6E3;color:white;border-radius:12px;padding:12px 24px;text-decoration:none;font-weight:700;margin-top:20px}</style></head><body><div class="box"><div style="font-size:52px;margin-bottom:16px">😕</div><h1>Payment cancelled</h1><p>No worries — your slot has been released.<br>You can go back and try again.</p><a href="javascript:history.back()">← Go back</a></div></body></html>`);
});

app.get('/booking/:id', (req, res) => {
  const booking = bookings.getById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const { id, date, startTime, size, addons, total, customer, status, locationId } = booking;
  res.json({ id, date, startTime, size, addons, total, customer: { firstName: customer.firstName, dogName: customer.dogName }, status, locationId });
});


// ─── Cancellation ────────────────────────────────────────────────────────────

app.get('/cancel/:id', (req, res) => {
  const booking = bookings.getById(req.params.id);
  if (!booking) return res.send(cancelPage('Booking not found', 'We could not find your booking.', false, null));
  if (booking.status === 'cancelled') return res.send(cancelPage('Already cancelled', 'This booking has already been cancelled.', false, null));
  if (booking.status !== 'confirmed') return res.send(cancelPage('Cannot cancel', 'This booking cannot be cancelled as payment was not completed.', false, null));
  const bookingDate = new Date(booking.date + 'T' + booking.startTime + ':00');
  const hoursUntil = (bookingDate - new Date()) / (1000 * 60 * 60);
  const eligible = hoursUntil > 24;
  res.send(cancelPage(null, null, true, { booking, eligible, hoursUntil: Math.round(hoursUntil) }));
});

app.post('/cancel/:id', async (req, res) => {
  const booking = bookings.getById(req.params.id);
  if (!booking || booking.status !== 'confirmed') return res.status(400).json({ error: 'Booking not found or already cancelled' });
  const bookingDate = new Date(booking.date + 'T' + booking.startTime + ':00');
  const hoursUntil = (bookingDate - new Date()) / (1000 * 60 * 60);
  const eligible = hoursUntil > 24;
  bookings.cancel(booking.id);
  let refunded = false;
  if (eligible && booking.shopifyOrderId) {
    try {
      const fetch = require('node-fetch');
      const refundResp = await fetch('https://api.stripe.com/v1/refunds', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'payment_intent=' + booking.shopifyOrderId
      });
      const refundData = await refundResp.json();
      if (!refundData.error) refunded = true;
      else console.error('Refund error:', refundData.error.message);
    } catch (err) { console.error('Refund error:', err.message); }
  }
  try { await mailer.sendCancellationConfirmation(booking, refunded); } catch (err) { console.error('Cancel email error:', err.message); }
  res.json({ success: true, refunded });
});

function cancelPage(errorTitle, errorMsg, showForm, data) {
  const styles = `<style>body{font-family:sans-serif;background:#FEFDF8;min-height:100vh;margin:0;padding:20px;display:flex;align-items:center;justify-content:center;}.box{background:white;border-radius:20px;padding:36px;max-width:480px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08);}.logo{color:#09A6E3;font-size:18px;font-weight:900;margin-bottom:20px;letter-spacing:1px;}h1{color:#1A1A2E;font-size:22px;margin:0 0 10px;}p{color:#888;line-height:1.6;margin:0 0 12px;font-size:14px;}.details{background:#DDECF2;border-radius:12px;padding:14px 16px;margin:16px 0;}.row{display:flex;justify-content:space-between;font-size:13px;padding:3px 0;color:#1A1A2E;font-weight:600;}.row span:first-child{color:#888;font-weight:400;}.refund-yes{background:#E8F5E9;border-radius:10px;padding:12px 14px;font-size:13px;color:#2E7D32;margin:12px 0;}.refund-no{background:#FFF3E0;border-radius:10px;padding:12px 14px;font-size:13px;color:#E65100;margin:12px 0;}.btn{display:block;width:100%;padding:13px;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;border:none;text-align:center;margin-top:8px;}.btn-cancel{background:#FF5252;color:white;}.btn-back{background:none;border:2px solid #DDECF2;color:#888;}</style>`;
  if (!showForm) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}</head><body><div class="box"><div class="logo">DOG WASH A-GO-GO</div><h1>${errorTitle}</h1><p>${errorMsg}</p><a href="https://dogwashagogo.github.io/dogwash-widget/" style="display:inline-block;background:#09A6E3;color:white;border-radius:12px;padding:12px 24px;text-decoration:none;font-weight:700;margin-top:12px;">Book again</a></div></body></html>`;
  }
  const { booking, eligible } = data;
  const lang = booking.lang || 'en';
  const d = new Date(booking.date).toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB', {weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const sizeLabel = booking.size.charAt(0).toUpperCase() + booking.size.slice(1);
  const T = lang === 'de' ? {
    title: 'Buchung stornieren', sure: 'Bist du sicher, dass du diese Buchung stornieren möchtest?',
    refundYes: 'Du hast Anspruch auf eine <strong>vollständige Rückerstattung von €' + booking.total + '</strong> — dein Termin ist mehr als 24 Stunden entfernt.',
    refundNo: 'Dein Termin ist in weniger als 24 Stunden — gemäß unserer Stornierungsbedingungen erfolgt <strong>keine Rückerstattung</strong>.',
    cancelBtn: 'Ja, Buchung stornieren', backBtn: '← Buchung behalten',
    successMsg: (refunded) => refunded ? 'Eine Rückerstattung von €' + booking.total + ' wurde veranlasst und sollte innerhalb von 5-10 Werktagen erscheinen.' : 'Deine Buchung wurde storniert. Gemäß unserer Stornierungsbedingungen erfolgt keine Rückerstattung.',
    bookAgain: 'Erneut buchen'
  } : {
    title: 'Cancel your booking', sure: 'Are you sure you want to cancel this booking?',
    refundYes: 'You are eligible for a <strong>full refund of €' + booking.total + '</strong> — your appointment is more than 24 hours away.',
    refundNo: 'Your appointment is in less than 24 hours — <strong>no refund</strong> will be issued per our cancellation policy.',
    cancelBtn: 'Yes, cancel my booking', backBtn: '← Keep my booking',
    successMsg: (refunded) => refunded ? 'Your refund of €' + booking.total + ' has been processed and should appear within 5-10 business days.' : 'Your booking has been cancelled. No refund has been issued as per our cancellation policy.',
    bookAgain: 'Book again'
  };
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}</head><body>
    <div class="box">
      <div class="logo">DOG WASH A-GO-GO</div>
      <h1>${T.title}</h1>
      <div class="details">
        <div class="row"><span>${lang === 'de' ? 'Name' : 'Name'}</span><span>${booking.customer.firstName} ${booking.customer.lastName}</span></div>
        <div class="row"><span>${lang === 'de' ? 'Hund' : 'Dog'}</span><span>${booking.customer.dogName || '—'}</span></div>
        <div class="row"><span>${lang === 'de' ? 'Datum' : 'Date'}</span><span>${d}</span></div>
        <div class="row"><span>${lang === 'de' ? 'Uhrzeit' : 'Time'}</span><span>${booking.startTime}</span></div>
        <div class="row"><span>${lang === 'de' ? 'Wäsche' : 'Wash'}</span><span>${sizeLabel}</span></div>
        <div class="row"><span>${lang === 'de' ? 'Bezahlt' : 'Total paid'}</span><span>€${booking.total}</span></div>
      </div>
      ${eligible ? '<div class="refund-yes">✓ ' + T.refundYes + '</div>' : '<div class="refund-no">⚠ ' + T.refundNo + '</div>'}
      <p>${T.sure}</p>
      <button class="btn btn-cancel" onclick="doCancel()">${T.cancelBtn}</button>
      <button class="btn btn-back" onclick="history.back()">${T.backBtn}</button>
    </div>
    <script>
    async function doCancel() {
      var btn = document.querySelector('.btn-cancel');
      btn.disabled = true; btn.textContent = '...';
      try {
        var resp = await fetch('/cancel/${booking.id}', {method:'POST'});
        var d2 = await resp.json();
        document.querySelector('.box').innerHTML = '<div style="text-align:center"><div style="font-size:48px;margin-bottom:12px">✓</div><h1 style="color:#09A6E3">${lang === 'de' ? 'Buchung storniert' : 'Booking cancelled'}</h1><p style="color:#888;line-height:1.6">' + (d2.refunded ? '${T.successMsg(true)}' : '${T.successMsg(false)}') + '</p><a href="https://dogwashagogo.github.io/dogwash-widget/" style="display:inline-block;background:#09A6E3;color:white;border-radius:12px;padding:12px 24px;text-decoration:none;font-weight:700;margin-top:16px;">${T.bookAgain}</a></div>';
      } catch(err) {
        btn.disabled = false; btn.textContent = '${T.cancelBtn}';
        alert('${lang === 'de' ? 'Entschuldigung, etwas ist schiefgelaufen. Bitte schreibe uns an hello@dogwashagogo.com' : 'Sorry, something went wrong. Please email us at hello@dogwashagogo.com'}');
      }
    }
    </script>
    </body></html>`;
}


// ─── Admin ────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const fs_admin = require('fs');
const path_admin = require('path');
const ADMIN_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin — Dog Wash A Go Go</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@700;900&family=Nunito+Sans:wght@400;600&display=swap');
:root{--blue:#09A6E3;--sky:#DDECF2;--cream:#FEFDF8;--yellow:#F4D11A;--pink:#FF9DB4;--dark:#1A1A2E;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:"Nunito Sans",sans-serif;background:#f0f2f5;min-height:100vh;}
.topbar{background:var(--blue);padding:14px 28px;display:flex;align-items:center;justify-content:space-between;}
.topbar-logo{font-family:"Nunito",sans-serif;font-weight:900;font-size:18px;color:white;letter-spacing:.5px;}
.topbar-sub{font-size:12px;color:rgba(255,255,255,.7);}
.logout{background:rgba(255,255,255,.2);color:white;border:none;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;}
.logout:hover{background:rgba(255,255,255,.3);}

/* LOGIN */
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;background:var(--cream);}
.login-box{background:white;border-radius:20px;padding:36px;max-width:360px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;}
.login-logo{font-family:"Nunito",sans-serif;font-weight:900;font-size:22px;color:var(--blue);margin-bottom:4px;}
.login-sub{font-size:13px;color:#888;margin-bottom:24px;}
.login-box input{width:100%;border:2px solid var(--sky);border-radius:11px;padding:11px 14px;font-family:inherit;font-size:14px;outline:none;margin-bottom:12px;}
.login-box input:focus{border-color:var(--blue);}
.login-box button{width:100%;padding:13px;border-radius:11px;background:var(--blue);color:white;border:none;font-family:"Nunito",sans-serif;font-weight:900;font-size:16px;cursor:pointer;}
.login-box button:hover{background:#0790C0;}
.login-err{color:#e53935;font-size:13px;margin-bottom:10px;}

/* MAIN */
.main{max-width:900px;margin:0 auto;padding:28px 20px;}
.section{background:white;border-radius:16px;padding:20px 24px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,.06);}
.section-title{font-family:"Nunito",sans-serif;font-weight:900;font-size:17px;color:var(--dark);margin-bottom:16px;display:flex;align-items:center;gap:8px;}
.badge{background:var(--blue);color:white;border-radius:99px;padding:2px 10px;font-size:12px;font-weight:700;}
.badge-yellow{background:var(--yellow);color:var(--dark);}

/* DATE NAV */
.date-nav{display:flex;align-items:center;gap:10px;margin-bottom:16px;}
.date-nav button{background:white;border:2px solid var(--sky);border-radius:9px;width:32px;height:32px;cursor:pointer;font-size:14px;color:var(--blue);display:flex;align-items:center;justify-content:center;}
.date-nav button:hover{border-color:var(--blue);}
.date-label{font-family:"Nunito",sans-serif;font-weight:900;font-size:16px;color:var(--dark);}
.today-btn{background:var(--sky);border:none;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:700;color:var(--blue);cursor:pointer;font-family:inherit;}

/* BOOKING TABLE */
.booking-table{width:100%;border-collapse:collapse;}
.booking-table th{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#888;padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--sky);}
.booking-table td{padding:10px;font-size:13px;color:var(--dark);border-bottom:1px solid #f5f5f5;vertical-align:top;}
.booking-table tr:last-child td{border-bottom:none;}
.booking-table tr:hover td{background:#fafafa;}
.status-confirmed{background:#E8F5E9;color:#2E7D32;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;}
.status-reserved{background:#FFF9E6;color:#F57F17;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;}
.status-cancelled{background:#FFEBEE;color:#C62828;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;}
.empty{text-align:center;padding:32px;color:#888;font-size:14px;}

/* BLOCK SECTION */
.block-form{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;}
.block-form .fr{display:flex;flex-direction:column;gap:4px;}
.block-form label{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#888;}
.block-form input,.block-form select{border:2px solid var(--sky);border-radius:10px;padding:9px 12px;font-family:inherit;font-size:13px;outline:none;background:white;}
.block-form input:focus,.block-form select:focus{border-color:var(--blue);}
.btn-block{background:#e53935;color:white;border:none;border-radius:10px;padding:10px 18px;font-family:"Nunito",sans-serif;font-weight:900;font-size:14px;cursor:pointer;}
.btn-block:hover{background:#c62828;}
.btn-unblock{background:var(--sky);color:var(--blue);border:none;border-radius:8px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;margin-left:6px;}
.btn-unblock:hover{background:#c5e3ef;}
.blocked-list{margin-top:14px;}
.blocked-item{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#FFF5F5;border-radius:8px;margin-bottom:6px;font-size:13px;color:#C62828;font-weight:600;}

/* UPCOMING */
.upcoming-day{margin-bottom:14px;}
.upcoming-day-title{font-family:"Nunito",sans-serif;font-weight:900;font-size:13px;color:var(--blue);margin-bottom:6px;letter-spacing:.3px;}

/* STATS */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px;}
.stat{background:white;border-radius:14px;padding:16px 18px;box-shadow:0 2px 8px rgba(0,0,0,.06);}
.stat-num{font-family:"Nunito",sans-serif;font-weight:900;font-size:28px;color:var(--blue);}
.stat-label{font-size:12px;color:#888;font-weight:600;margin-top:2px;}
</style>
</head>
<body>
<script>
function doLogin() {
  const pw = document.getElementById('pw-input').value;
  const API = 'https://dogwash-backend.onrender.com';
  fetch(API + '/admin/login', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({password: pw})
  }).then(r => r.json()).then(d => {
    if (d.token) {
      sessionStorage.setItem('admin_token', d.token);
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('admin-screen').style.display = 'block';
      window._adminReady && window._adminReady();
    } else {
      document.getElementById('login-err').style.display = 'block';
    }
  }).catch(() => {
    document.getElementById('login-err').style.display = 'block';
  });
}
function doLogout() {
  sessionStorage.removeItem('admin_token');
  document.getElementById('admin-screen').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('pw-input').value = '';
}
</script>

<!-- LOGIN SCREEN -->
<div id="login-screen" class="login-wrap">
  <div class="login-box">
    <div class="login-logo">DOG WASH A-GO-GO</div>
    <div class="login-sub">Admin access</div>
    <div class="login-err" id="login-err" style="display:none">Wrong password</div>
    <input type="password" id="pw-input" placeholder="Password" onkeydown="if(event.key==='Enter')doLogin()">
    <button onclick="doLogin()">Log in</button>
  </div>
</div>

<!-- ADMIN SCREEN -->
<div id="admin-screen" style="display:none">
  <div class="topbar">
    <div>
      <div class="topbar-logo">DOG WASH A-GO-GO — Admin</div>
      <div class="topbar-sub">Neukölln · Station 1</div>
    </div>
    <button class="logout" onclick="doLogout()">Log out</button>
  </div>
  <div class="main">

    <!-- STATS -->
    <div class="stats">
      <div class="stat"><div class="stat-num" id="stat-today">—</div><div class="stat-label">Bookings today</div></div>
      <div class="stat"><div class="stat-num" id="stat-week">—</div><div class="stat-label">This week</div></div>
      <div class="stat"><div class="stat-num" id="stat-revenue">—</div><div class="stat-label">Revenue this week</div></div>
    </div>

    <!-- TODAY'S BOOKINGS -->
    <div class="section">
      <div class="date-nav">
        <button onclick="shiftDay(-1)">‹</button>
        <div class="date-label" id="view-date-label"></div>
        <button onclick="shiftDay(1)">›</button>
        <button class="today-btn" onclick="goToday()">Today</button>
      </div>
      <div id="day-bookings"></div>
    </div>

    <!-- BLOCK SLOTS -->
    <div class="section">
      <div class="section-title">🚫 Block dates or slots</div>
      <div class="block-form">
        <div class="fr">
          <label>Date</label>
          <input type="date" id="block-date">
        </div>
        <div class="fr">
          <label>Time (optional — leave blank to block whole day)</label>
          <select id="block-time">
            <option value="">— Whole day —</option>
          </select>
        </div>
        <div class="fr">
          <label>Reason (optional)</label>
          <input type="text" id="block-reason" placeholder="e.g. Maintenance">
        </div>
        <button class="btn-block" onclick="blockSlot()">Block</button>
      </div>
      <div class="blocked-list" id="blocked-list"></div>
    </div>

    <!-- UPCOMING -->
    <div class="section">
      <div class="section-title">📅 Upcoming bookings <span class="badge badge-yellow" id="upcoming-badge">7 days</span></div>
      <div id="upcoming-bookings"></div>
    </div>

  </div>
</div>

<script>
const API = 'https://dogwash-backend.onrender.com';
let viewDate = new Date();
let allBookings = [];
let blockedSlots = [];

// ─── Auth ─────────────────────────────────────────────────────────────────────
function getToken() { return sessionStorage.getItem('admin_token'); }

function showAdmin() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('admin-screen').style.display = 'block';
  loadAll();
}

window._adminReady = function() { loadAll(); };

// Auto-login if token exists
if (getToken()) showAdmin();

// ─── Load data ────────────────────────────────────────────────────────────────
function loadAll() {
  const token = getToken();
  fetch(API + '/admin/bookings', {headers:{'Authorization':'Bearer '+token}})
    .then(r => r.json()).then(d => {
      allBookings = d.bookings || [];
      blockedSlots = d.blocked || [];
      renderDay();
      renderStats();
      renderUpcoming();
      renderBlocked();
      populateTimeSlots();
    });
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function renderStats() {
  const today = fmtDate(new Date());
  const todayB = allBookings.filter(b => b.date === today && b.status === 'confirmed');
  document.getElementById('stat-today').textContent = todayB.length;

  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    weekDates.push(fmtDate(d));
  }
  const weekB = allBookings.filter(b => weekDates.includes(b.date) && b.status === 'confirmed');
  document.getElementById('stat-week').textContent = weekB.length;
  const revenue = weekB.reduce((s, b) => s + (b.total || 0), 0);
  document.getElementById('stat-revenue').textContent = '€' + revenue;
}

// ─── Day view ─────────────────────────────────────────────────────────────────
function shiftDay(n) { viewDate.setDate(viewDate.getDate() + n); renderDay(); }
function goToday() { viewDate = new Date(); renderDay(); }

function renderDay() {
  const dateStr = fmtDate(viewDate);
  const label = viewDate.toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'});
  document.getElementById('view-date-label').textContent = label;

  const dayB = allBookings.filter(b => b.date === dateStr && b.status !== 'expired')
    .sort((a,b) => a.startTime.localeCompare(b.startTime));

  const el = document.getElementById('day-bookings');
  if (dayB.length === 0) {
    el.innerHTML = '<div class="empty">No bookings for this day</div>';
    return;
  }

  el.innerHTML = '<table class="booking-table"><thead><tr><th>Time</th><th>Customer</th><th>Dog</th><th>Size</th><th>Add-ons</th><th>Total</th><th>Status</th></tr></thead><tbody>' +
    dayB.map(b => {
      const addonNames = {cond:'Conditioner',ear:'Ear cleaner',perf:'Perfume',shed:'De-shedding',lick:'Licky mat',treats:'Treats'};
      const addons = b.addons && b.addons.length ? b.addons.map(a => addonNames[a.id]||a.id).join(', ') : '—';
      const statusClass = 'status-' + b.status;
      return '<tr><td><strong>' + b.startTime + '</strong>' + (b.extraTime ? '<br><small>+30 min</small>' : '') + '</td>' +
        '<td>' + b.customer.firstName + ' ' + b.customer.lastName + '<br><small style="color:#888">' + b.customer.email + '</small></td>' +
        '<td>' + (b.customer.dogName || '—') + '</td>' +
        '<td>' + b.size.charAt(0).toUpperCase() + b.size.slice(1) + '</td>' +
        '<td style="font-size:12px">' + addons + '</td>' +
        '<td>€' + b.total + '</td>' +
        '<td><span class="' + statusClass + '">' + b.status + '</span></td></tr>';
    }).join('') + '</tbody></table>';
}

// ─── Upcoming ─────────────────────────────────────────────────────────────────
function renderUpcoming() {
  const today = fmtDate(new Date());
  const upcoming = allBookings.filter(b => b.date > today && b.status === 'confirmed')
    .sort((a,b) => (a.date+a.startTime).localeCompare(b.date+b.startTime));

  const el = document.getElementById('upcoming-bookings');
  if (upcoming.length === 0) {
    el.innerHTML = '<div class="empty">No upcoming bookings</div>';
    return;
  }

  // Group by date
  const byDate = {};
  upcoming.forEach(b => { if (!byDate[b.date]) byDate[b.date] = []; byDate[b.date].push(b); });

  el.innerHTML = Object.keys(byDate).slice(0, 14).map(date => {
    const label = new Date(date).toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long'});
    return '<div class="upcoming-day"><div class="upcoming-day-title">' + label + '</div>' +
      '<table class="booking-table"><thead><tr><th>Time</th><th>Customer</th><th>Dog</th><th>Size</th><th>Total</th></tr></thead><tbody>' +
      byDate[date].map(b => '<tr><td>' + b.startTime + '</td><td>' + b.customer.firstName + ' ' + b.customer.lastName + '</td><td>' + (b.customer.dogName||'—') + '</td><td>' + b.size.charAt(0).toUpperCase()+b.size.slice(1) + '</td><td>€' + b.total + '</td></tr>').join('') +
      '</tbody></table></div>';
  }).join('');
}

// ─── Block slots ──────────────────────────────────────────────────────────────
function populateTimeSlots() {
  const sel = document.getElementById('block-time');
  sel.innerHTML = '<option value="">— Whole day —</option>';
  for (let hr = 10; hr <= 19; hr++) {
    sel.innerHTML += '<option value="' + hr + ':00">' + hr + ':00</option>';
    sel.innerHTML += '<option value="' + hr + ':30">' + hr + ':30</option>';
  }
}

function blockSlot() {
  const date = document.getElementById('block-date').value;
  const time = document.getElementById('block-time').value;
  const reason = document.getElementById('block-reason').value;
  if (!date) { alert('Please select a date'); return; }

  fetch(API + '/admin/block', {
    method: 'POST',
    headers: {'Content-Type':'application/json','Authorization':'Bearer '+getToken()},
    body: JSON.stringify({date, time, reason})
  }).then(r => r.json()).then(() => {
    document.getElementById('block-date').value = '';
    document.getElementById('block-time').value = '';
    document.getElementById('block-reason').value = '';
    loadAll();
  });
}

function unblockById(btn) { unblock(btn.getAttribute('data-id')); }
function unblock(id) {
  fetch(API + '/admin/unblock/' + id, {
    method: 'DELETE',
    headers: {'Authorization':'Bearer '+getToken()}
  }).then(() => loadAll());
}

function renderBlocked() {
  const el = document.getElementById('blocked-list');
  if (!blockedSlots || blockedSlots.length === 0) {
    el.innerHTML = '<p style="font-size:13px;color:#888;margin-top:10px;">No blocked slots</p>';
    return;
  }
  el.innerHTML = blockedSlots.map(b =>
    '<div class="blocked-item"><span>' + b.date + (b.time ? ' at ' + b.time : ' — whole day') + (b.reason ? ' (' + b.reason + ')' : '') + '</span>' +
    '<button class="btn-unblock" onclick="unblock('' + b.id + '')">Remove</button></div>'
  ).join('');
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
</script>
</body>
</html>
`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Hermannstr.30';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'dwagogo-admin-secret-2026';
const fs = require('fs');
const path = require('path');
const BLOCKED_FILE = process.env.DATA_FILE ? process.env.DATA_FILE.replace('bookings.json','blocked.json') : './data/blocked.json';

function ensureDir(f) { const d = path_admin.dirname(f); if (!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); }
function loadBlocked() { ensureDir(BLOCKED_FILE); if (!fs.existsSync(BLOCKED_FILE)) return []; try { return JSON.parse(fs.readFileSync(BLOCKED_FILE,'utf8')); } catch { return []; } }
function saveBlocked(b) { ensureDir(BLOCKED_FILE); fs.writeFileSync(BLOCKED_FILE, JSON.stringify(b,null,2)); }

function makeToken() { return crypto.createHmac('sha256', ADMIN_SECRET).update(ADMIN_PASSWORD + Date.now()).digest('hex'); }
function checkToken(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  // Simple: token must be stored in memory (set on login)
  return global._adminToken && global._adminToken === token;
}

// Serve admin page
app.get('/admin', (req, res) => {
  res.send(ADMIN_HTML);
});

// Admin login
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = makeToken();
    global._adminToken = token;
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// Get all bookings + blocked slots
app.get('/admin/bookings', (req, res) => {
  if (!checkToken(req)) return res.status(401).json({ error: 'Unauthorized' });
  const allBookings = bookings.getAll();
  const blocked = loadBlocked();
  res.json({ bookings: allBookings, blocked });
});

// Block a date/slot
app.post('/admin/block', (req, res) => {
  if (!checkToken(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { date, time, reason } = req.body;
  const blocked = loadBlocked();
  const id = crypto.randomUUID();
  blocked.push({ id, date, time: time || null, reason: reason || null, createdAt: new Date().toISOString() });
  saveBlocked(blocked);
  res.json({ success: true, id });
});

// Unblock
app.delete('/admin/unblock/:id', (req, res) => {
  if (!checkToken(req)) return res.status(401).json({ error: 'Unauthorized' });
  const blocked = loadBlocked().filter(b => b.id !== req.params.id);
  saveBlocked(blocked);
  res.json({ success: true });
});


app.use((req, res, next) => { bookings.expireOld(); next(); });

app.listen(PORT, () => console.log(`Dog Wash A Go Go booking server running on port ${PORT}`));
