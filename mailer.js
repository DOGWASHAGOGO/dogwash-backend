const fetch = require('node-fetch');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'hello@dogwashagogo.com';

async function sendEmail({ to, subject, html }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `DOG WASH A-GO-GO <${FROM_EMAIL}>`,
      to,
      subject,
      html
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function formatAddons(addons) {
  if (!addons || addons.length === 0) return 'None';
  const names = { cond: 'Conditioner', ear: 'Ear cleaner', perf: 'Perfume', shed: 'De-shedding treatment', lick: 'Licky mat', treats: 'Bag of treats' };
  return addons.map(a => `${names[a.id] || a.id} (+€${a.price})`).join(', ');
}

async function sendCustomerConfirmation(booking) {
  const duration = booking.extraTime ? '1.5 hours' : '1 hour';
  const dogName = booking.customer.dogName ? ` and ${booking.customer.dogName}` : '';

  await sendEmail({
    to: booking.customer.email,
    subject: `Your booking is confirmed! 🛁`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1A1A2E;">
        <div style="background:#09A6E3;padding:28px 32px;border-radius:16px 16px 0 0;">
          <h1 style="color:white;margin:0;font-size:24px;">DOG WASH A GO GO</h1>
          <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:14px;">Berlin Neukölln</p>
        </div>
        <div style="background:#FEFDF8;padding:28px 32px;border-radius:0 0 16px 16px;border:1px solid #DDECF2;">
          <h2 style="color:#09A6E3;margin:0 0 20px;">You're all booked! 🎉</h2>
          <p style="margin:0 0 20px;font-size:15px;">Hi ${booking.customer.firstName}${dogName}, we can't wait to see you!</p>
          <div style="background:#DDECF2;border-radius:12px;padding:18px 20px;margin-bottom:20px;">
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr><td style="padding:5px 0;color:#888;">Date</td><td style="padding:5px 0;font-weight:600;text-align:right;">${formatDate(booking.date)}</td></tr>
              <tr><td style="padding:5px 0;color:#888;">Time</td><td style="padding:5px 0;font-weight:600;text-align:right;">${booking.startTime} (${duration})</td></tr>
              <tr><td style="padding:5px 0;color:#888;">Location</td><td style="padding:5px 0;font-weight:600;text-align:right;">Neukölln, Berlin</td></tr>
              <tr><td style="padding:5px 0;color:#888;">Wash</td><td style="padding:5px 0;font-weight:600;text-align:right;">${booking.size.charAt(0).toUpperCase()+booking.size.slice(1)} dog (€${booking.price})</td></tr>
              <tr><td style="padding:5px 0;color:#888;">Add-ons</td><td style="padding:5px 0;font-weight:600;text-align:right;">${formatAddons(booking.addons)}</td></tr>
              <tr style="border-top:1px solid rgba(9,166,227,0.3);"><td style="padding:10px 0 5px;font-weight:700;font-size:15px;">Total paid</td><td style="padding:10px 0 5px;font-weight:700;font-size:18px;color:#09A6E3;text-align:right;">€${booking.total}</td></tr>
            </table>
          </div>
          <div style="background:#FFF9E6;border-radius:12px;padding:14px 18px;margin-bottom:20px;font-size:13px;color:#555;">
            <strong>Good to know:</strong> Please arrive a couple of minutes early. Everything you need is provided — shampoo, towels, and dryer. Just bring your pup!
          </div>
          <p style="font-size:13px;color:#888;margin:0;">Need to cancel or reschedule? Just reply to this email.</p>
          <p style="font-size:13px;color:#888;margin:8px 0 0;">See you soon! 🐾</p>
          <p style="font-size:13px;color:#888;margin:4px 0 0;">— The Dog Wash A Go Go team</p>
        </div>
      </div>
    `
  });
}

async function sendOwnerNotification(booking) {
  const duration = booking.extraTime ? '1.5 hrs' : '1 hr';

  await sendEmail({
    to: FROM_EMAIL,
    subject: `New booking: ${booking.customer.firstName} — ${booking.date} at ${booking.startTime}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;color:#1A1A2E;">
        <h2 style="color:#09A6E3;">New booking confirmed</h2>
        <table style="border-collapse:collapse;font-size:14px;width:100%;">
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Customer</td><td style="padding:5px 0;font-weight:600;">${booking.customer.firstName} ${booking.customer.lastName}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Email</td><td style="padding:5px 0;">${booking.customer.email}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Dog</td><td style="padding:5px 0;">${booking.customer.dogName || '—'}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Date</td><td style="padding:5px 0;font-weight:600;">${formatDate(booking.date)}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Time</td><td style="padding:5px 0;font-weight:600;">${booking.startTime} (${duration})</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Size</td><td style="padding:5px 0;">${booking.size.charAt(0).toUpperCase()+booking.size.slice(1)}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Add-ons</td><td style="padding:5px 0;">${formatAddons(booking.addons)}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Newsletter</td><td style="padding:5px 0;">${booking.customer.newsletter ? 'Yes' : 'No'}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Total</td><td style="padding:5px 0;font-weight:600;color:#09A6E3;">€${booking.total}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Booking ID</td><td style="padding:5px 0;font-size:12px;color:#999;">${booking.id}</td></tr>
        </table>
      </div>
    `
  });
}

module.exports = { sendCustomerConfirmation, sendOwnerNotification };
