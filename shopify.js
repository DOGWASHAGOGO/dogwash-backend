const fetch = require('node-fetch');

const SHOP = process.env.SHOPIFY_SHOP; // e.g. dogwash-agogo
const TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

// Shopify product variant IDs for each size
// You'll fill these in from your Shopify admin
const VARIANT_IDS = {
  small:  process.env.SHOPIFY_VARIANT_SMALL,
  medium: process.env.SHOPIFY_VARIANT_MEDIUM,
  large:  process.env.SHOPIFY_VARIANT_LARGE,
};

const ADDON_VARIANT_IDS = {
  cond:  process.env.SHOPIFY_VARIANT_CONDITIONER,
  ear:   process.env.SHOPIFY_VARIANT_EAR_CLEANER,
  perf:  process.env.SHOPIFY_VARIANT_PERFUME,
  shed:  process.env.SHOPIFY_VARIANT_DESHEDDING,
  lick:  process.env.SHOPIFY_VARIANT_LICKY_MAT,
};

async function createCheckout({ bookingId, size, price, addons, extraTime, total, customer, date, startTime, locationName }) {

  const lineItems = [];

  // Main wash
  const washVariant = VARIANT_IDS[size];
  if (!washVariant) throw new Error(`No variant ID configured for size: ${size}`);

  lineItems.push({
    variantId: `gid://shopify/ProductVariant/${washVariant}`,
    quantity: 1,
    customAttributes: [
      { key: 'booking_id', value: bookingId },
      { key: 'date', value: date },
      { key: 'time', value: startTime },
      { key: 'location', value: locationName },
    ]
  });

  // Add-ons
  if (addons && addons.length > 0) {
    addons.forEach(addon => {
      const variantId = ADDON_VARIANT_IDS[addon.id];
      if (variantId) {
        lineItems.push({
          variantId: `gid://shopify/ProductVariant/${variantId}`,
          quantity: 1,
          customAttributes: [{ key: 'booking_id', value: bookingId }]
        });
      }
    });
  }

  // Extra time
  if (extraTime && process.env.SHOPIFY_VARIANT_EXTRA_TIME) {
    lineItems.push({
      variantId: `gid://shopify/ProductVariant/${process.env.SHOPIFY_VARIANT_EXTRA_TIME}`,
      quantity: 1,
      customAttributes: [{ key: 'booking_id', value: bookingId }]
    });
  }

  const mutation = `
    mutation checkoutCreate($input: CheckoutCreateInput!) {
      checkoutCreate(input: $input) {
        checkout {
          id
          webUrl
        }
        checkoutUserErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: {
      lineItems,
      email: customer.email,
      customAttributes: [
        { key: 'booking_id', value: bookingId },
        { key: 'booking_date', value: date },
        { key: 'booking_time', value: startTime },
        { key: 'location', value: locationName },
        { key: 'dog_name', value: customer.dogName || '' },
      ],
      note: `Booking ID: ${bookingId} | ${locationName} | ${date} at ${startTime}`
    }
  };

  const response = await fetch(
    `https://${SHOP}.myshopify.com/api/2024-01/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': TOKEN,
      },
      body: JSON.stringify({ query: mutation, variables })
    }
  );

  const json = await response.json();

  if (json.errors) {
    throw new Error(json.errors[0].message);
  }

  const errors = json.data?.checkoutCreate?.checkoutUserErrors;
  if (errors && errors.length > 0) {
    throw new Error(errors[0].message);
  }

  return json.data.checkoutCreate.checkout.webUrl;
}

module.exports = { createCheckout };
