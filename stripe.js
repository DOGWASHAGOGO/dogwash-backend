const fetch = require('node-fetch');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

async function createCheckout({ bookingId, size, price, addons, extraTime, total, customer, date, startTime, locationName }) {

  const addonNames = {
    cond: 'Conditioner',
    ear: 'Ear cleaner',
    perf: 'Perfume',
    shed: 'De-shedding treatment',
    lick: 'Licky mat'
  };

  const lineItems = [];

  // Main wash
  lineItems.push({
    price_data: {
      currency: 'eur',
      product_data: {
        name: `${size.charAt(0).toUpperCase() + size.slice(1)} dog wash`,
        description: `${locationName} · ${date} at ${startTime}`,
      },
      unit_amount: price * 100, // Stripe uses cents
    },
    quantity: 1,
  });

  // Add-ons
  if (addons && addons.length > 0) {
    addons.forEach(addon => {
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: {
            name: addonNames[addon.id] || addon.id,
          },
          unit_amount: addon.price * 100,
        },
        quantity: 1,
      });
    });
  }

  // Extra time
  if (extraTime) {
    lineItems.push({
      price_data: {
        currency: 'eur',
        product_data: {
          name: 'Extra 30 minutes',
        },
        unit_amount: 1000, // €10
      },
      quantity: 1,
    });
  }

  const BASE_URL = process.env.BASE_URL || 'https://dogwash-backend.onrender.com';

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('customer_email', customer.email);
  params.append('success_url', `${BASE_URL}/booking-confirmed?id=${bookingId}`);
  params.append('cancel_url', `${BASE_URL}/booking-cancelled?id=${bookingId}`);
  params.append('metadata[booking_id]', bookingId);
  params.append('metadata[date]', date);
  params.append('metadata[time]', startTime);
  params.append('metadata[location]', locationName);
  params.append('metadata[dog_name]', customer.dogName || '');

  lineItems.forEach((item, i) => {
    params.append(`line_items[${i}][price_data][currency]`, item.price_data.currency);
    params.append(`line_items[${i}][price_data][product_data][name]`, item.price_data.product_data.name);
    if (item.price_data.product_data.description) {
      params.append(`line_items[${i}][price_data][product_data][description]`, item.price_data.product_data.description);
    }
    params.append(`line_items[${i}][price_data][unit_amount]`, item.price_data.unit_amount);
    params.append(`line_items[${i}][quantity]`, item.quantity);
  });

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString()
  });

  const session = await response.json();

  if (session.error) {
    throw new Error(session.error.message);
  }

  return session.url;
}

module.exports = { createCheckout };
