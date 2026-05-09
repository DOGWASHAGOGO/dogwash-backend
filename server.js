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
    refundYes: 'You're eligible for a <strong>full refund of €' + booking.total + '</strong> — your appointment is more than 24 hours away.',
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


app.use((req, res, next) => { bookings.expireOld(); next(); });

app.listen(PORT, () => console.log(`Dog Wash A Go Go booking server running on port ${PORT}`));
