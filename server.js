require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const shopify = require('./shopify');
const mailer = require('./mailer');
const bookings = require('./bookings');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Config ───────────────────────────────────────────────────────────────────

const LOCATIONS = {
  neukolln: {
    name: 'Neukölln',
    address: 'Berlin Neukölln',
    stations: 1,
    hours: {
      // day of week (0=Sun): { open, close } in 24h
      1: { open: 11, close: 19 }, // Mon
      3: { open: 11, close: 19 }, // Wed
      4: { open: 11, close: 19 }, // Thu
      5: { open: 10, close: 18 }, // Fri
      6: { open: 10, close: 18 }, // Sat
    }
  }
};

const SLOT_DURATION = 30; // minutes
const MIN_SLOTS = 2;      // minimum booking = 2 slots (1 hour)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSlotsForDay(locationId, dateStr) {
  const location = LOCATIONS[locationId];
  if (!location) return [];

  const date = new Date(dateStr);
  const dow = date.getDay();
  const hours = location.hours[dow];
  if (!hours) return []; // closed

  const slots = [];
  let current = hours.open * 60; // minutes from midnight
  const closeMinutes = hours.close * 60;

  // Last valid start = close minus (MIN_SLOTS * SLOT_DURATION)
  const lastStart = closeMinutes - (MIN_SLOTS * SLOT_DURATION);

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
    if (b.status === 'cancelled') return;
    // Each booking blocks its slots
    b.slots.forEach(slot => {
      booked[slot] = (booked[slot] || 0) + 1;
    });
  });
  return booked;
}

function getSlotsFromTime(allSlots, startTime, count) {
  const idx = allSlots.indexOf(startTime);
  if (idx === -1) return null;
  if (idx + count > allSlots.length) return null;
  return allSlots.slice(idx, idx + count);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Dog Wash A Go Go Booking' });
});

// Get availability for a date
app.get('/availability/:locationId/:date', (req, res) => {
  const { locationId, date } = req.params;

  if (!LOCATIONS[locationId]) {
    return res.status(404).json({ error: 'Location not found' });
  }

  const allSlots = getSlotsForDay(locationId, date);
  if (allSlots.length === 0) {
    return res.json({ date, slots: [], closed: true });
  }

  const booked = getBookedSlots(locationId, date);
  const stations = LOCATIONS[locationId].stations;

  const slots = allSlots.map((time, idx) => {
    const bookedCount = booked[time] || 0;
    const available = stations - bookedCount;

    // Check if this slot can be a valid start (needs MIN_SLOTS consecutive free slots)
    let canBook = available > 0;
    if (canBook) {
      for (let i = 0; i < MIN_SLOTS; i++) {
        const checkSlot = allSlots[idx + i];
        if (!checkSlot) { canBook = false; break; }
        const checkBooked = booked[checkSlot] || 0;
        if (stations - checkBooked <= 0) { canBook = false; break; }
      }
    }

    // Check if extra slot (3rd) is available
    const extraSlot = allSlots[idx + MIN_SLOTS];
    const extraAvailable = extraSlot
      ? (stations - (booked[extraSlot] || 0)) > 0
      : false;

    return {
      time,
      available,
      canBook,
      extraAvailable
    };
  });

  res.json({ date, locationId, slots, closed: false });
});

// Reserve a booking (hold for 10 min before payment)
app.post('/reserve', async (req, res) => {
  const { locationId, date, startTime, extraTime, size, price, addons, customer } = req.body;

  // Validate
  if (!locationId || !date || !startTime || !size || !customer) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const allSlots = getSlotsForDay(locationId, date);
  const slotCount = MIN_SLOTS + (extraTime ? 1 : 0);
  const reservedSlots = getSlotsFromTime(allSlots, startTime, slotCount);

  if (!reservedSlots) {
    return res.status(400).json({ error: 'Invalid time slot' });
  }

  // Check availability
  const booked = getBookedSlots(locationId, date);
  const stations = LOCATIONS[locationId].stations;
  for (const slot of reservedSlots) {
    if ((booked[slot] || 0) >= stations) {
      return res.status(409).json({ error: 'Slot no longer available' });
    }
  }

  // Calculate total
  const addonTotal = addons ? addons.reduce((sum, a) => sum + a.price, 0) : 0;
  const extraTotal = extraTime ? 10 : 0;
  const total = price + addonTotal + extraTotal;

  // Create reservation
  const bookingId = uuidv4();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  bookings.create({
    id: bookingId,
    locationId,
    date,
    slots: reservedSlots,
    startTime,
    extraTime: !!extraTime,
    size,
    price,
    addons: addons || [],
    total,
    customer,
    status: 'reserved',
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString()
  });

  // Create Shopify checkout
  try {
    const checkoutUrl = await shopify.createCheckout({
      bookingId,
      size,
      price,
      addons: addons || [],
      extraTime,
      total,
      customer,
      date,
      startTime,
      locationName: LOCATIONS[locationId].name
    });

    res.json({
      bookingId,
      checkoutUrl,
      expiresAt: expiresAt.toISOString(),
      total
    });
  } catch (err) {
    console.error('Shopify error:', err);
    bookings.cancel(bookingId);
    res.status(500).json({ error: 'Could not create checkout. Please try again.' });
  }
});

// Shopify webhook — payment confirmed
app.post('/webhook/shopify', express.raw({ type: 'application/json' }), (req, res) => {
  // In production you'd verify the HMAC signature here
  const data = JSON.parse(req.body);

  // Extract booking ID from order note or line item properties
  const bookingId = data.note_attributes?.find(a => a.name === 'booking_id')?.value
    || data.line_items?.[0]?.properties?.find(p => p.name === 'booking_id')?.value;

  if (!bookingId) {
    return res.status(200).json({ received: true });
  }

  const booking = bookings.getById(bookingId);
  if (!booking) {
    return res.status(200).json({ received: true });
  }

  // Confirm booking
  bookings.confirm(bookingId, data.id);

  // Send confirmation emails
  mailer.sendCustomerConfirmation(booking);
  mailer.sendOwnerNotification(booking);

  res.status(200).json({ received: true });
});

// Get booking by ID (for confirmation page)
app.get('/booking/:id', (req, res) => {
  const booking = bookings.getById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  // Don't expose internal fields
  const { id, date, startTime, size, addons, total, customer, status, locationId } = booking;
  res.json({ id, date, startTime, size, addons, total, customer: { firstName: customer.firstName, dogName: customer.dogName }, status, locationId });
});

// Cancel expired reservations (runs on each request, lightweight)
app.use((req, res, next) => {
  bookings.expireOld();
  next();
});

app.listen(PORT, () => {
  console.log(`Dog Wash A Go Go booking server running on port ${PORT}`);
});
