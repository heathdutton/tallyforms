# Tally Forms Tweaks

A Cloudflare Worker that provides tweaks for Tally forms.
Currently features automatic date field limitation management - set up date range constraints (X days before/after today) and let the worker automatically update your forms every hour based on your timezone.

## Features

- **Automatic Date Updates**: Configure date field limits that update hourly based on your timezone
- **Multiple Forms**: Manage date limits for multiple Tally forms from one interface
- **Flexible Configuration**: Set before-date and/or after-date limits in days
- **Timezone Support**: Date calculations respect your local timezone
- **Smart Cron**: Efficient hourly cron with timezone-aware updates (only updates when needed)
- **Rate Limiting**: 5 forms per day to prevent abuse
- **Clean UI**: Simple, modern interface matching the subsplash-ical aesthetic

## Use Cases

- **Event Registration**: Limit registration dates to 30 days before an event
- **Booking Systems**: Only allow bookings 7-90 days in advance
- **Survey Deadlines**: Automatically update "valid until" dates
- **Appointment Scheduling**: Keep date pickers within reasonable ranges

## Setup

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org/) v18 or later
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- A [Tally account](https://tally.so) with API access

### Installation

1. **Clone or download this repository**

2. **Install dependencies**

```bash
npm install
```

3. **Create KV namespace**

```bash
npm run kv:create
```

This will output a KV namespace ID. Copy it.

4. **Update wrangler.json**

Replace `PLACEHOLDER_KV_ID` with your actual KV namespace ID in both places:

```json
{
  "kv_namespaces": [
    {
      "binding": "TALLYFORMS",
      "id": "YOUR_KV_ID_HERE",
      "preview_id": "YOUR_KV_ID_HERE"
    }
  ]
}
```

5. **Deploy to Cloudflare Workers**

```bash
npm run deploy
```

6. **Note your Worker URL**

After deployment, Wrangler will display your Worker URL (e.g., `https://tallyforms.YOUR_SUBDOMAIN.workers.dev`).

## Usage

1. **Get your Tally API Key**
   - Visit [tally.so/settings/api-keys](https://tally.so/settings/api-keys)
   - Generate an API key

2. **Open your Worker URL**
   - Navigate to your deployed Worker URL in a browser

3. **Configure Date Limits**
   - Enter your Tally API key
   - Select your timezone (auto-detected by default)
   - Click "Load My Forms"
   - Select a form
   - Configure date field limits:
     - **Earliest Date**: Minimum selectable date as days from today (negative = past, positive = future)
     - **Latest Date**: Maximum selectable date as days from today (negative = past, positive = future)
   - Examples:
     - To allow only dates from 30 days ago to today: Earliest = `-30`, Latest = `0`
     - To allow only dates from 30-365 days in the future: Earliest = `30`, Latest = `365`
     - To allow only past dates up to 90 days ago: Earliest = `-90`, Latest = `0`
   - Save configuration

4. **Automatic Updates**
   - Date limits are applied **immediately** when you save
   - The worker will also update your form's date limits every hour to keep them current
   - Updates are timezone-aware
   - Disable a field by toggling it off

## How It Works

### Storage Structure

The worker uses Cloudflare KV with the following key structure:

- `config:{hash(formId)}` - Configuration for each form
- `metadata:{hash(formId)}` - Timezone metadata for efficient cron updates
- `ratelimit:{ip}` - Rate limiting counters (24-hour TTL)

### TTL Strategy

- **Active configurations**: Stored perpetually (at least one date field enabled)
- **Disabled configurations**: 3-day TTL (all date fields disabled)

### Cron Efficiency

The cron task runs hourly but only updates forms when needed:

1. Checks timezone metadata to see if an update is needed this hour
2. Skips forms that were already updated today at the current hour
3. Only processes active configurations (not disabled ones)

### Date Calculation

Date limits are calculated in the user's specified timezone:

- **Earliest Date (minDays)**: `minDate = today + X days` (negative X = past, positive X = future)
- **Latest Date (maxDays)**: `maxDate = today + X days` (negative X = past, positive X = future)

Examples:
- `minDays = -30`: Minimum date is 30 days ago
- `minDays = 0`: Minimum date is today
- `minDays = 30`: Minimum date is 30 days from now
- `maxDays = 365`: Maximum date is 365 days from now

These values are written to the Tally form's date field `payload` via the PATCH API.

## API Endpoints

### POST /api/forms

Fetch all forms for a Tally API key.

**Request:**
```json
{
  "apiKey": "your-tally-api-key"
}
```

**Response:**
```json
{
  "forms": [
    {
      "id": "form-id",
      "name": "Form Name",
      "configured": false
    }
  ]
}
```

### POST /api/form-fields

Fetch date fields for a specific form.

**Request:**
```json
{
  "apiKey": "your-tally-api-key",
  "formId": "form-id"
}
```

**Response:**
```json
{
  "dateFields": [
    {
      "uuid": "field-uuid",
      "label": "Event Date",
      "type": "INPUT_DATE"
    }
  ],
  "configuration": { /* existing config if any */ }
}
```

### POST /api/save-config

Save date limit configuration.

**Request:**
```json
{
  "apiKey": "your-tally-api-key",
  "formId": "form-id",
  "timezone": "America/New_York",
  "fields": {
    "field-uuid": {
      "enabled": true,
      "minDays": 30,
      "maxDays": 365
    }
  }
}
```

**Response:**
```json
{
  "success": true
}
```

## Rate Limiting

- **Limit**: 5 forms per day
- **Reset**: Counters reset after 24 hours
- **Notice**: Displayed in the footer of the web interface

## Development

### Run locally

```bash
npm run dev
```

This starts a local development server at `http://localhost:8787`.

### Lint code

```bash
npm run lint
```

### Deploy

```bash
npm run deploy
```

## Architecture

```
┌─────────────────┐
│   Web Browser   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌──────────────┐
│ Cloudflare      │◄────►│ Tally API    │
│ Worker          │      │ (tally.so)   │
└────────┬────────┘      └──────────────┘
         │
         ▼
┌─────────────────┐
│ KV Storage      │
│ - Configs       │
│ - Metadata      │
│ - Rate Limits   │
└─────────────────┘

Cron: Runs hourly
├─ Read all configs from KV
├─ Check timezone metadata
├─ Update date limits via Tally API
└─ Update metadata in KV
```

## Security Considerations

- API keys are stored in KV (encrypted at rest by Cloudflare)
- API keys are hashed for rate limiting keys
- CORS is enabled for browser access
- Rate limiting prevents abuse
- No API keys are logged

## License

MIT
