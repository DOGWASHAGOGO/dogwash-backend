# Dog Wash A Go Go — Booking Backend

## Setup

### 1. Install dependencies
```
npm install
```

### 2. Configure environment variables
Copy `.env.example` to `.env` and fill in your values:
```
cp .env.example .env
```

### 3. Get your Shopify Storefront API token
1. Go to your Shopify admin → Settings → Apps and sales channels
2. Click "Develop apps" → "Create an app"
3. Name it "Booking System"
4. Click "Configure Storefront API scopes"
5. Enable: `unauthenticated_write_checkouts`, `unauthenticated_read_product_listings`
6. Click "Install app" → copy the Storefront API access token
7. Paste it into `.env` as `SHOPIFY_STOREFRONT_TOKEN`

### 4. Get your Shopify variant IDs
For each product (Small wash, Medium wash, Large wash, and each add-on):
1. Go to Shopify admin → Products → click the product
2. Click the variant
3. The URL will contain the variant ID: `.../variants/1234567890`
4. Copy that number into the matching line in `.env`

### 5. Set up email
Use an app password for Gmail:
1. Go to your Google account → Security → 2-Step Verification → App passwords
2. Create a password for "Mail"
3. Paste it into `.env` as `SMTP_PASS`

### 6. Run locally
```
npm start
```

## API Endpoints

- `GET /health` — health check
- `GET /availability/:locationId/:date` — get available slots for a date (date format: YYYY-MM-DD)
- `POST /reserve` — reserve a booking and get Shopify checkout URL
- `POST /webhook/shopify` — Shopify payment webhook (confirms booking)
- `GET /booking/:id` — get booking details

## Adding more stations or locations
Edit the `LOCATIONS` config at the top of `server.js`.
