const fetch = require('node-fetch');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'hello@dogwashagogo.com';
const BASE_URL = process.env.BASE_URL || 'https://dogwash-backend.onrender.com';

async function sendEmail({ to, subject, html }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: `DOG WASH A-GO-GO <${FROM_EMAIL}>`, to, subject, html })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

function formatDate(dateStr, lang) {
  const d = new Date(dateStr);
  return d.toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

function formatAddons(addons, lang) {
  if (!addons || addons.length === 0) return lang === 'de' ? 'Keine' : 'None';
  const names = {
    en: { cond: 'Conditioner', ear: 'Ear cleaner', perf: 'Perfume', shed: 'De-shedding treatment', lick: 'Licky mat', treats: 'Bag of treats' },
    de: { cond: 'Conditioner', ear: 'Ohrenreiniger', perf: 'Parfüm', shed: 'Enthaarungsbehandlung', lick: 'Leckerliematte', treats: 'Tüte Leckerlies' }
  };
  return addons.map(a => `${names[lang][a.id] || a.id} (+€${a.price})`).join(', ');
}

function sizeLabel(size, lang) {
  const labels = {
    en: { small: 'Small', medium: 'Medium', large: 'Large' },
    de: { small: 'Klein', medium: 'Mittel', large: 'Groß' }
  };
  return labels[lang][size] || size;
}


function makeGoogleCalendarUrl(booking, lang) {
  const date = booking.date.replace(/-/g, '');
  const startHour = booking.startTime.replace(':', '');
  const duration = booking.extraTime ? 90 : 60;
  const endDate = new Date(booking.date + 'T' + booking.startTime + ':00');
  endDate.setMinutes(endDate.getMinutes() + duration);
  const endHour = String(endDate.getHours()).padStart(2,'0') + String(endDate.getMinutes()).padStart(2,'0');
  const title = lang === 'de' ? 'Hundewäsche bei DOG WASH A-GO-GO' : 'Dog wash at DOG WASH A-GO-GO';
  const details = lang === 'de' ? 'Deine Buchung in Neukölln, Berlin' : 'Your booking in Neukölln, Berlin';
  const location = 'Hermannstr. 30, 12049 Berlin';
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${date}T${startHour}00/${date}T${endHour}00&details=${encodeURIComponent(details)}&location=${encodeURIComponent(location)}`;
}

function makeICalUrl(booking, lang) {
  const date = booking.date.replace(/-/g, '');
  const startHour = booking.startTime.replace(':', '');
  const duration = booking.extraTime ? 90 : 60;
  const endDate = new Date(booking.date + 'T' + booking.startTime + ':00');
  endDate.setMinutes(endDate.getMinutes() + duration);
  const endHour = String(endDate.getHours()).padStart(2,'0') + String(endDate.getMinutes()).padStart(2,'0');
  const title = lang === 'de' ? 'Hundewäsche bei DOG WASH A-GO-GO' : 'Dog wash at DOG WASH A-GO-GO';
  const ical = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `DTSTART:${date}T${startHour}00`,
    `DTEND:${date}T${endHour}00`,
    `SUMMARY:${title}`,
    'LOCATION:Neukölln\, Berlin',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\n');
  return `data:text/calendar;charset=utf8,${encodeURIComponent(ical)}`;
}

async function sendCustomerConfirmation(booking) {
  const lang = booking.lang || 'en';
  const duration = booking.extraTime ? (lang === 'de' ? '1,5 Stunden' : '1.5 hours') : (lang === 'de' ? '1 Stunde' : '1 hour');
  const dogName = booking.customer.dogName ? ` ${lang === 'de' ? 'und' : 'and'} ${booking.customer.dogName}` : '';
  const date = formatDate(booking.date, lang);

  const T = {
    en: {
      subject: 'Your booking is confirmed! 🛁',
      greeting: `Hi ${booking.customer.firstName}${dogName}, we can't wait to see you!`,
      dateLabel: 'Date', timeLabel: 'Time', locationLabel: 'Location', location: 'Neukölln, Berlin',
      washLabel: 'Wash', addonsLabel: 'Add-ons', totalLabel: 'Total paid',
      note: 'Please arrive a couple of minutes early. Everything you need is provided — shampoo, towels, and dryer. Just bring your pup!',
      cancelText: 'Need to cancel? You can do so up to 24 hours before your appointment for a full refund.',
      cancelBtn: 'Cancel booking',
      signoff: 'See you soon! 🐾',
      team: '— The DOG WASH A-GO-GO team'
    },
    de: {
      subject: 'Deine Buchung ist bestätigt! 🛁',
      greeting: `Hallo ${booking.customer.firstName}${dogName}, wir freuen uns auf euch!`,
      dateLabel: 'Datum', timeLabel: 'Uhrzeit', locationLabel: 'Standort', location: 'Neukölln, Berlin',
      washLabel: 'Wäsche', addonsLabel: 'Extras', totalLabel: 'Bezahlter Betrag',
      note: 'Bitte komme ein paar Minuten früher. Alles was du brauchst ist vorhanden — Shampoo, Handtücher und Trockner. Bring einfach deinen Hund!',
      cancelText: 'Möchtest du stornieren? Du kannst bis 24 Stunden vor dem Termin kostenlos stornieren.',
      cancelBtn: 'Buchung stornieren',
      signoff: 'Bis bald! 🐾',
      team: '— Das DOG WASH A-GO-GO Team'
    }
  }[lang];

  await sendEmail({
    to: booking.customer.email,
    subject: T.subject,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1A1A2E;">
        <div style="background:#09A6E3;padding:28px 32px;border-radius:16px 16px 0 0;">
          <h1 style="color:white;margin:0;font-size:24px;">DOG WASH A-GO-GO</h1>
          <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:14px;">Berlin Neukölln</p>
        </div>
        <div style="background:#FEFDF8;padding:28px 32px;border-radius:0 0 16px 16px;border:1px solid #DDECF2;">
          <h2 style="color:#09A6E3;margin:0 0 20px;">${lang === 'de' ? 'Du bist gebucht! 🎉' : "You're all booked! 🎉"}</h2>
          <p style="margin:0 0 20px;font-size:15px;">${T.greeting}</p>
          <div style="background:#DDECF2;border-radius:12px;padding:18px 20px;margin-bottom:20px;">
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr><td style="padding:5px 0;color:#888;">${T.dateLabel}</td><td style="padding:5px 0;font-weight:600;text-align:right;">${date}</td></tr>
              <tr><td style="padding:5px 0;color:#888;">${T.timeLabel}</td><td style="padding:5px 0;font-weight:600;text-align:right;">${booking.startTime} (${duration})</td></tr>
              <tr><td style="padding:5px 0;color:#888;">${T.locationLabel}</td><td style="padding:5px 0;font-weight:600;text-align:right;">${T.location}</td></tr>
              <tr><td style="padding:5px 0;color:#888;">${T.washLabel}</td><td style="padding:5px 0;font-weight:600;text-align:right;">${sizeLabel(booking.size, lang)} (€${booking.price})</td></tr>
              <tr><td style="padding:5px 0;color:#888;">${T.addonsLabel}</td><td style="padding:5px 0;font-weight:600;text-align:right;">${formatAddons(booking.addons, lang)}</td></tr>
              <tr style="border-top:1px solid rgba(9,166,227,0.3);"><td style="padding:10px 0 5px;font-weight:700;font-size:15px;">${T.totalLabel}</td><td style="padding:10px 0 5px;font-weight:700;font-size:18px;color:#09A6E3;text-align:right;">€${booking.total}</td></tr>
            </table>
          </div>
          <div style="background:#FFF9E6;border-radius:12px;padding:14px 18px;margin-bottom:20px;font-size:13px;color:#555;">
            <strong>${lang === 'de' ? 'Gut zu wissen:' : 'Good to know:'}</strong> ${T.note}
          </div>
          <p style="font-size:13px;color:#888;margin:0;">${T.cancelText}</p>
          <p style="margin:12px 0 0;display:flex;gap:8px;flex-wrap:wrap;">
            <a href="${BASE_URL}/cancel/${booking.id}" style="background:#DDECF2;color:#09A6E3;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700;">${T.cancelBtn}</a>
            <a href="${makeGoogleCalendarUrl(booking, lang)}" target="_blank" style="background:#E8F5E9;color:#2E7D32;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700;">📅 Google Calendar</a>
            <a href="${makeICalUrl(booking, lang)}" style="background:#F3E5F5;color:#6A1B9A;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700;">📅 Apple / iCal</a>
          </p>
          <p style="font-size:13px;color:#888;margin:16px 0 4px;">${T.signoff}</p>
          <p style="font-size:13px;color:#888;margin:0;">${T.team}</p>
        </div>
      </div>
    `
  });
}

async function sendOwnerNotification(booking) {
  const lang = booking.lang || 'en';
  const duration = booking.extraTime ? '1.5 hrs' : '1 hr';
  const date = formatDate(booking.date, 'en');

  await sendEmail({
    to: FROM_EMAIL,
    subject: `New booking: ${booking.customer.firstName} — ${booking.date} at ${booking.startTime}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;color:#1A1A2E;">
        <h2 style="color:#09A6E3;">New booking confirmed</h2>
        <table style="border-collapse:collapse;font-size:14px;width:100%;">
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Customer</td><td style="font-weight:600;">${booking.customer.firstName} ${booking.customer.lastName}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Email</td><td>${booking.customer.email}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Dog</td><td>${booking.customer.dogName || '—'}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Date</td><td style="font-weight:600;">${date}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Time</td><td style="font-weight:600;">${booking.startTime} (${duration})</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Size</td><td>${sizeLabel(booking.size, 'en')}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Add-ons</td><td>${formatAddons(booking.addons, 'en')}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Newsletter</td><td>${booking.customer.newsletter ? 'Yes' : 'No'}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Language</td><td>${lang.toUpperCase()}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Total</td><td style="font-weight:600;color:#09A6E3;">€${booking.total}</td></tr>
          <tr><td style="padding:5px 10px 5px 0;color:#888;">Booking ID</td><td style="font-size:12px;color:#999;">${booking.id}</td></tr>
        </table>
      </div>
    `
  });
}

async function sendCancellationConfirmation(booking, refunded) {
  const lang = booking.lang || 'en';
  const date = formatDate(booking.date, lang);

  const T = {
    en: {
      subject: 'Your booking has been cancelled',
      title: 'Booking cancelled',
      body: `Hi ${booking.customer.firstName}, your booking on <strong>${date} at ${booking.startTime}</strong> has been cancelled.`,
      refundYes: `✓ A full refund of <strong>€${booking.total}</strong> has been processed and should appear within 5-10 business days.`,
      refundNo: 'No refund has been issued as the cancellation was made within 24 hours of the appointment.',
      closing: 'We hope to see you and your pup again soon!',
      team: '— The DOG WASH A-GO-GO team'
    },
    de: {
      subject: 'Deine Buchung wurde storniert',
      title: 'Buchung storniert',
      body: `Hallo ${booking.customer.firstName}, deine Buchung am <strong>${date} um ${booking.startTime} Uhr</strong> wurde storniert.`,
      refundYes: `✓ Eine vollständige Rückerstattung von <strong>€${booking.total}</strong> wurde veranlasst und sollte innerhalb von 5-10 Werktagen erscheinen.`,
      refundNo: 'Es erfolgt keine Rückerstattung, da die Stornierung weniger als 24 Stunden vor dem Termin erfolgte.',
      closing: 'Wir hoffen, dich und deinen Hund bald wiederzusehen!',
      team: '— Das DOG WASH A-GO-GO Team'
    }
  }[lang];

  await sendEmail({
    to: booking.customer.email,
    subject: T.subject,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1A1A2E;">
        <div style="background:#09A6E3;padding:28px 32px;border-radius:16px 16px 0 0;">
          <h1 style="color:white;margin:0;font-size:24px;">DOG WASH A-GO-GO</h1>
          <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:14px;">Berlin Neukölln</p>
        </div>
        <div style="background:#FEFDF8;padding:28px 32px;border-radius:0 0 16px 16px;border:1px solid #DDECF2;">
          <h2 style="color:#1A1A2E;margin:0 0 16px;">${T.title}</h2>
          <p style="font-size:14px;color:#555;margin:0 0 16px;">${T.body}</p>
          ${refunded
            ? `<div style="background:#E8F5E9;border-radius:10px;padding:14px 16px;font-size:13px;color:#2E7D32;margin-bottom:16px;">${T.refundYes}</div>`
            : `<div style="background:#FFF3E0;border-radius:10px;padding:14px 16px;font-size:13px;color:#E65100;margin-bottom:16px;">${T.refundNo}</div>`
          }
          <p style="font-size:13px;color:#888;">${T.closing}</p>
          <p style="font-size:13px;color:#888;margin-top:8px;">${T.team}</p>
        </div>
      </div>
    `
  });
}

module.exports = { sendCustomerConfirmation, sendOwnerNotification, sendCancellationConfirmation };
