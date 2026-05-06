require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const stripe = require('./stripe');
const mailer = require('./mailer');
const bookings = require('./bookings');

const app = express();
app.use(cors());

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
  const lastStart = hours.close * 60 - (MIN_SLOTS * SLOT_DURATION);
  while (current <= lastStart) {
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
  bookings.create({
    id: bookingId, locationId, date, slots: reservedSlots, startTime,
    extraTime: !!extraTime, size, price, addons: addons || [], total,
    customer, status: 'reserved', expiresAt: expiresAt.toISOString(),
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

app.use((req, res, next) => { bookings.expireOld(); next(); });

app.listen(PORT, () => console.log(`Dog Wash A Go Go booking server running on port ${PORT}`));
