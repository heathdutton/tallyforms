import { CACHE_VERSION } from '../cache_version.js';

const TALLY_API_BASE = 'https://api.tally.so';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers for API requests
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // API endpoints
      if (url.pathname === '/api/forms') {
        return await handleGetForms(request, env, corsHeaders);
      }

      if (url.pathname === '/api/form-fields') {
        return await handleGetFormFields(request, env, corsHeaders);
      }

      if (url.pathname === '/api/save-config') {
        return await handleSaveConfig(request, env, corsHeaders);
      }

      // Trigger cron manually (for testing) - DISABLED
      // if (url.pathname === '/api/trigger-cron' && request.method === 'POST') {
      //   try {
      //     await runCronTask(env);
      //     return jsonResponse({ message: 'Cron task completed successfully' }, 200, corsHeaders);
      //   } catch (error) {
      //     return jsonResponse({ error: error.message }, 500, corsHeaders);
      //   }
      // }

      // Serve static files
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return serveFile('index.html', 'text/html', env);
      }

      if (url.pathname === '/style.css') {
        return serveFile('style.css', 'text/css', env);
      }

      if (url.pathname === '/script.js') {
        return serveFile('script.js', 'application/javascript', env);
      }

      if (url.pathname === '/favicon.ico') {
        return new Response(null, {
          status: 301,
          headers: {
            'Location': 'https://tally.so/favicon.ico'
          }
        });
      }

      return new Response('Not found', { status: 404 });

    } catch (error) {
      console.error('Error handling request:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  },

  // Cron handler for hourly date updates
  async scheduled(event, env, _ctx) {
    await runCronTask(env);
  }
};

// Cron task logic (extracted for manual triggering)
async function runCronTask(env) {
  console.log('Cron task started:', new Date().toISOString());

  try {
    // Get all configuration keys
    const list = await env.TALLYFORMS.list({ prefix: 'config:' });

    for (const key of list.keys) {
      try {
        const configData = await env.TALLYFORMS.get(key.name, { type: 'json' });

        if (!configData || !configData.apiKey || !configData.formId) {
          continue;
        }

        // Check if this configuration needs an update based on timezone
        const shouldUpdate = await shouldUpdateNow(configData, env);

        if (shouldUpdate) {
          console.log(`Updating form ${configData.formId} in timezone ${configData.timezone}`);
          await updateFormDateLimits(configData, env);

          // Update last run timestamp
          configData.lastRun = Date.now();
          await env.TALLYFORMS.put(key.name, JSON.stringify(configData));
        }

      } catch (error) {
        console.error(`Error processing config ${key.name}:`, error);
      }
    }

    console.log('Cron task completed');

  } catch (error) {
    console.error('Error in cron task:', error);
    throw error;
  }
}

// Handle GET forms request
async function handleGetForms(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { apiKey } = body;

    if (!apiKey) {
      return jsonResponse({ error: 'API key is required' }, 400, corsHeaders);
    }

    // Check rate limiting
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const allowed = await checkRateLimit(clientIP, env);

    if (!allowed) {
      return jsonResponse({
        error: 'Rate limit exceeded. You can only configure 5 forms per day.'
      }, 429, corsHeaders);
    }

    // Fetch forms from Tally API
    const response = await fetch(`${TALLY_API_BASE}/forms`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch forms from Tally API');
    }

    const data = await response.json();
    const forms = data.items || data.data || [];

    // Check which forms are already configured
    for (const form of forms) {
      const configKey = `config:${await hashString(form.id)}`;
      const config = await env.TALLYFORMS.get(configKey, { type: 'json' });
      form.configured = !!config;
    }

    return jsonResponse({ forms }, 200, corsHeaders);

  } catch (error) {
    console.error('Error in handleGetForms:', error);
    return jsonResponse({ error: error.message }, 500, corsHeaders);
  }
}

// Handle GET form fields request
async function handleGetFormFields(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { apiKey, formId } = body;

    if (!apiKey || !formId) {
      return jsonResponse({ error: 'API key and form ID are required' }, 400, corsHeaders);
    }

    // Fetch form details from Tally API
    const response = await fetch(`${TALLY_API_BASE}/forms/${formId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch form from Tally API');
    }

    const formData = await response.json();
    const form = formData.data || formData;

    // Extract date fields from blocks
    const dateFields = [];
    if (form.blocks && Array.isArray(form.blocks)) {
      form.blocks.forEach((block, index) => {
        if (block.type === 'INPUT_DATE') {
          // Try multiple label sources within the block itself
          let label = block.payload?.label?.trim()
            || block.payload?.title?.trim()
            || block.payload?.text?.trim()
            || block.payload?.question?.trim()
            || block.label?.trim()
            || null;

          // If no label in the INPUT_DATE block, check the preceding TITLE block
          if (!label && index > 0) {
            const prevBlock = form.blocks[index - 1];
            if (prevBlock.type === 'TITLE' || prevBlock.type === 'QUESTION') {
              // Extract text from safeHTMLSchema which is typically [[["Question text"]]]
              const htmlSchema = prevBlock.payload?.safeHTMLSchema;
              if (htmlSchema && Array.isArray(htmlSchema) && htmlSchema.length > 0) {
                const firstRow = htmlSchema[0];
                if (Array.isArray(firstRow) && firstRow.length > 0) {
                  const firstCell = firstRow[0];
                  if (typeof firstCell === 'string') {
                    label = firstCell.trim();
                  } else if (Array.isArray(firstCell) && firstCell.length > 0) {
                    label = firstCell[0]?.trim();
                  }
                }
              }
            }
          }

          // Use label if found, otherwise show UUID
          const displayLabel = label || `Date Field (${block.uuid.substring(0, 8)}...)`;

          dateFields.push({
            uuid: block.uuid,
            label: displayLabel,
            type: block.type
          });
        }
      });
    }

    // Load existing configuration if available
    const configKey = `config:${await hashString(formId)}`;
    const configuration = await env.TALLYFORMS.get(configKey, { type: 'json' });

    return jsonResponse({
      dateFields,
      configuration
    }, 200, corsHeaders);

  } catch (error) {
    console.error('Error in handleGetFormFields:', error);
    return jsonResponse({ error: error.message }, 500, corsHeaders);
  }
}

// Handle save configuration request
async function handleSaveConfig(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { apiKey, formId, timezone, fields } = body;

    if (!apiKey || !formId || !timezone) {
      return jsonResponse({ error: 'Missing required fields' }, 400, corsHeaders);
    }

    const configKey = `config:${await hashString(formId)}`;

    // Check if this is a new form or an update to existing config
    const existingConfig = await env.TALLYFORMS.get(configKey, { type: 'json' });

    // Only apply rate limiting for NEW forms (not updates)
    if (!existingConfig) {
      const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
      await incrementRateLimit(clientIP, env);
    }

    // Determine if any fields are active
    const hasActiveFields = Object.values(fields).some(
      config => config.enabled && (config.minDays !== null || config.maxDays !== null)
    );

    const config = {
      apiKey,
      formId,
      timezone,
      fields,
      lastRun: null,
      disabled: !hasActiveFields,
      updatedAt: Date.now()
    };

    if (!hasActiveFields) {
      // Store with 3-day TTL if disabled
      await env.TALLYFORMS.put(configKey, JSON.stringify(config), {
        expirationTtl: 259200 // 3 days
      });
    } else {
      // Store perpetually if active
      await env.TALLYFORMS.put(configKey, JSON.stringify(config));

      // Immediately update the form (don't wait for cron)
      try {
        await updateFormDateLimits(config, env);
        console.log(`Immediately applied date limits for form ${formId}`);
      } catch (error) {
        console.error(`Failed to immediately update form ${formId}:`, error);
        // Don't fail the save if immediate update fails - cron will retry
      }
    }

    return jsonResponse({ success: true }, 200, corsHeaders);

  } catch (error) {
    console.error('Error in handleSaveConfig:', error);
    return jsonResponse({ error: error.message }, 500, corsHeaders);
  }
}

// Update form date limits via Tally API
// This function is surgical: it fetches the latest form state immediately before
// patching to minimize conflicts with concurrent edits, only modifies date fields
// we're managing, and only sends the PATCH if values actually changed.
async function updateFormDateLimits(config, _env) {
  try {
    // Fetch current form structure (gets latest state to minimize conflict window)
    const response = await fetch(`${TALLY_API_BASE}/forms/${config.formId}`, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch form from Tally API');
    }

    const formData = await response.json();
    const form = formData.data || formData;

    if (!form.blocks || !Array.isArray(form.blocks)) {
      return;
    }

    // Calculate date limits based on timezone
    const now = new Date();
    const tzNow = new Date(now.toLocaleString('en-US', { timeZone: config.timezone }));

    let blocksModified = false;

    // Update date field blocks - only touch fields we're actively managing with configured values
    form.blocks.forEach(block => {
      if (block.type === 'INPUT_DATE') {
        const fieldConfig = config.fields[block.uuid];

        // Skip if disabled or no limits configured (user will handle manually)
        if (!fieldConfig || !fieldConfig.enabled) {
          console.log(`Skipping field ${block.uuid} - disabled or not configured`);
          return;
        }

        const hasMinDays = fieldConfig.minDays !== null && fieldConfig.minDays !== undefined;
        const hasMaxDays = fieldConfig.maxDays !== null && fieldConfig.maxDays !== undefined;

        // Skip if no date limits configured (both blank)
        if (!hasMinDays && !hasMaxDays) {
          console.log(`Skipping field ${block.uuid} - no date limits configured`);
          return;
        }

        // Get a display label for logging
        const displayLabel = block.payload?.label?.trim()
          || block.payload?.title?.trim()
          || block.payload?.text?.trim()
          || block.payload?.question?.trim()
          || block.label?.trim()
          || block.uuid.substring(0, 8);

        console.log(`Processing date field "${displayLabel}" (${block.uuid}):`, {
          minDays: fieldConfig.minDays,
          maxDays: fieldConfig.maxDays,
          currentBeforeDate: block.payload?.beforeDate,
          currentAfterDate: block.payload?.afterDate
        });

        if (!block.payload) {
          block.payload = {};
        }

        let fieldModified = false;

        // Calculate minimum date (earliest selectable) - Tally uses "afterDate"
        if (hasMinDays) {
          const minDate = new Date(tzNow);
          minDate.setDate(minDate.getDate() + fieldConfig.minDays);
          const formattedMinDate = formatDate(minDate);

          // Only update if the value actually changed
          if (block.payload.afterDate !== formattedMinDate) {
            block.payload.afterDate = formattedMinDate;
            console.log(`Setting afterDate to ${formattedMinDate} (${fieldConfig.minDays} days from today)`);
            fieldModified = true;
          }
        }

        // Calculate maximum date (latest selectable) - Tally uses "beforeDate"
        if (hasMaxDays) {
          const maxDate = new Date(tzNow);
          maxDate.setDate(maxDate.getDate() + fieldConfig.maxDays);
          const formattedMaxDate = formatDate(maxDate);

          // Only update if the value actually changed
          if (block.payload.beforeDate !== formattedMaxDate) {
            block.payload.beforeDate = formattedMaxDate;
            console.log(`Setting beforeDate to ${formattedMaxDate} (${fieldConfig.maxDays} days from today)`);
            fieldModified = true;
          }
        }

        if (fieldModified) {
          console.log(`Updated payload:`, JSON.stringify(block.payload));
          blocksModified = true;
        } else {
          console.log(`No changes needed for field ${block.uuid}`);
        }
      }
    });

    if (blocksModified) {
      // Update form via PATCH
      const patchPayload = { blocks: form.blocks };
      console.log(`Sending PATCH request to Tally for form ${config.formId}`);
      console.log(`PATCH payload (first 2 blocks):`, JSON.stringify(patchPayload.blocks.slice(0, 2), null, 2));

      const updateResponse = await fetch(`${TALLY_API_BASE}/forms/${config.formId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(patchPayload)
      });

      console.log(`PATCH response status: ${updateResponse.status} ${updateResponse.statusText}`);

      if (!updateResponse.ok) {
        const errorText = await updateResponse.text();
        console.error('Failed to update form. Response:', errorText);
        throw new Error(`Failed to update form via Tally API: ${updateResponse.status} ${errorText}`);
      }

      const responseData = await updateResponse.json();
      console.log(`Successfully updated form ${config.formId}. Response:`, JSON.stringify(responseData, null, 2));
    } else {
      console.log(`No changes needed for form ${config.formId} - dates are already up to date`);
    }

  } catch (error) {
    console.error('Error updating form date limits:', error);
    throw error;
  }
}

// Check if form should be updated now based on timezone
async function shouldUpdateNow(config, env) {
  // If disabled, don't update
  if (config.disabled) {
    return false;
  }

  // Get current hour in the user's timezone
  const now = new Date();
  const tzTime = new Date(now.toLocaleString('en-US', { timeZone: config.timezone }));
  const currentHour = tzTime.getHours();

  // Check metadata for last update hour
  const metadataKey = `metadata:${await hashString(config.formId)}`;
  const metadata = await env.TALLYFORMS.get(metadataKey, { type: 'json' });

  if (metadata) {
    const lastUpdateHour = metadata.lastUpdateHour;
    const lastUpdateDate = metadata.lastUpdateDate;

    // Get today's date in timezone
    const todayDate = `${tzTime.getFullYear()}-${String(tzTime.getMonth() + 1).padStart(2, '0')}-${String(tzTime.getDate()).padStart(2, '0')}`;

    // If we already updated today at this hour, skip
    if (lastUpdateDate === todayDate && lastUpdateHour === currentHour) {
      return false;
    }
  }

  // Update metadata
  const todayDate = `${tzTime.getFullYear()}-${String(tzTime.getMonth() + 1).padStart(2, '0')}-${String(tzTime.getDate()).padStart(2, '0')}`;
  await env.TALLYFORMS.put(metadataKey, JSON.stringify({
    lastUpdateHour: currentHour,
    lastUpdateDate: todayDate,
    timezone: config.timezone
  }), {
    expirationTtl: 86400 // 1 day
  });

  return true;
}

// Rate limiting functions
async function checkRateLimit(ip, env) {
  const rateLimitKey = `ratelimit:${CACHE_VERSION}:${ip}`;
  const count = await env.TALLYFORMS.get(rateLimitKey);

  if (!count) {
    return true;
  }

  return parseInt(count) < 5;
}

async function incrementRateLimit(ip, env) {
  const rateLimitKey = `ratelimit:${CACHE_VERSION}:${ip}`;
  const count = await env.TALLYFORMS.get(rateLimitKey);

  const currentCount = count ? parseInt(count) : 0;

  if (currentCount >= 5) {
    throw new Error('Rate limit exceeded. You can only configure 5 forms per day.');
  }

  const newCount = currentCount + 1;

  // Set TTL to expire at end of day (86400 seconds = 24 hours)
  await env.TALLYFORMS.put(rateLimitKey, newCount.toString(), {
    expirationTtl: 86400
  });

  console.log(`Rate limit for ${ip} (cache: ${CACHE_VERSION}): ${newCount}/5`);
}

// Utility functions
async function hashString(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders
    }
  });
}

// Serve static files
function serveFile(filename, contentType, _env) {
  // Read from public directory
  const files = {
    'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tally Forms Automation</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <div class="container">
        <header>
            <h1>Tally Forms Automation</h1>
            <p>Automatically manage date field limitations for your Tally forms</p>
        </header>

        <main>
            <section class="input-section">
                <h2>Step 1: Connect Your Tally Account</h2>

                <div class="form-group">
                    <label for="apiKey">Tally API Key</label>
                    <input
                        type="password"
                        id="apiKey"
                        placeholder="Enter your Tally API key"
                        class="form-input"
                    >
                    <small>Get your API key from <a href="https://tally.so/settings/api-keys" target="_blank">tally.so/settings/api-keys</a></small>
                </div>

                <div class="form-group">
                    <label for="timezone">Your Timezone</label>
                    <select id="timezone" class="form-input">
                        <option value="">Detecting...</option>
                    </select>
                    <small>Date limits will update based on this timezone</small>
                </div>

                <button id="loadFormsBtn" class="btn btn-primary">Load My Forms</button>

                <div id="loadingIndicator" class="loading-indicator hidden">
                    <div class="spinner"></div>
                    <span>Loading forms...</span>
                </div>
            </section>

            <section id="formsSection" class="forms-section hidden">
                <h2>Step 2: Select a Form</h2>

                <div id="formsList" class="forms-list">
                    <!-- Forms will be populated here -->
                </div>
            </section>

            <section id="fieldsSection" class="fields-section hidden">
                <h2>Step 3: Configure Date Field Limits</h2>

                <div class="selected-form-info">
                    <strong>Selected Form:</strong> <span id="selectedFormName"></span>
                </div>

                <div id="dateFieldsList" class="date-fields-list">
                    <!-- Date fields will be populated here -->
                </div>

                <div class="action-buttons">
                    <button id="saveConfigBtn" class="btn btn-primary">Save Configuration</button>
                    <button id="backToFormsBtn" class="btn btn-secondary">Back to Forms</button>
                </div>
            </section>

            <section id="successSection" class="success-section hidden">
                <div class="success-message">
                    <svg viewBox="0 0 24 24" width="48" height="48">
                        <path fill="#27ae60" d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4M11,16.5L6.5,12L7.91,10.59L11,13.67L16.59,8.09L18,9.5L11,16.5Z"/>
                    </svg>
                    <h3>Configuration Saved!</h3>
                    <p>Your date field limits have been applied immediately and will be updated automatically every hour.</p>
                    <button id="configureAnotherBtn" class="btn btn-primary">Configure Another Form</button>
                </div>
            </section>
        </main>

        <footer>
            <p>Rate limit: 5 forms per day per IP address</p>
            <p>Date limits apply immediately and refresh hourly based on your timezone</p>
            <p>Not affiliated with Tally Forms</p>
        </footer>
    </div>

    <script src="script.js"></script>
</body>
</html>`,
    'style.css': `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    line-height: 1.6;
    color: #333;
    background-color: #f5f5f5;
}

.container {
    max-width: 900px;
    margin: 0 auto;
    padding: 20px;
}

header {
    text-align: center;
    margin-bottom: 40px;
    padding: 40px 20px;
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

header h1 {
    color: #2c3e50;
    font-size: 2.5em;
    margin-bottom: 10px;
}

header p {
    color: #7f8c8d;
    font-size: 1.1em;
}

.input-section, .forms-section, .fields-section, .success-section {
    background: white;
    padding: 30px;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    margin-bottom: 20px;
}

.input-section h2, .forms-section h2, .fields-section h2 {
    color: #2c3e50;
    margin-bottom: 20px;
}

.form-group {
    margin-bottom: 20px;
}

.form-group label {
    display: block;
    margin-bottom: 5px;
    font-weight: 600;
    color: #2c3e50;
}

.form-input {
    width: 100%;
    padding: 12px;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 16px;
    transition: border-color 0.3s;
}

.form-input:focus {
    outline: none;
    border-color: #3498db;
}

.form-group small {
    display: block;
    margin-top: 5px;
    color: #7f8c8d;
    font-size: 0.9em;
}

.form-group small a {
    color: #3498db;
    text-decoration: none;
}

.form-group small a:hover {
    text-decoration: underline;
}

.btn {
    padding: 12px 30px;
    border: none;
    border-radius: 4px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.3s;
}

.btn-primary {
    background-color: #3498db;
    color: white;
}

.btn-primary:hover {
    background-color: #2980b9;
}

.btn-primary:disabled {
    background-color: #95a5a6;
    cursor: not-allowed;
}

.btn-secondary {
    background-color: #95a5a6;
    color: white;
}

.btn-secondary:hover {
    background-color: #7f8c8d;
}

.hidden {
    display: none !important;
}

.loading-indicator {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 20px;
    color: #7f8c8d;
}

.spinner {
    border: 3px solid #f3f3f3;
    border-top: 3px solid #3498db;
    border-radius: 50%;
    width: 24px;
    height: 24px;
    animation: spin 1s linear infinite;
}

@keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}

.forms-list {
    display: grid;
    gap: 15px;
}

.form-card {
    padding: 20px;
    border: 2px solid #ecf0f1;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.3s;
    background: white;
}

.form-card:hover {
    border-color: #3498db;
    box-shadow: 0 2px 8px rgba(52, 152, 219, 0.2);
}

.form-card.configured {
    border-color: #27ae60;
    background-color: #f0fff4;
}

.form-card h3 {
    color: #2c3e50;
    margin-bottom: 10px;
    font-size: 1.2em;
}

.form-card p {
    color: #7f8c8d;
    font-size: 0.9em;
}

.form-badge {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 0.8em;
    font-weight: 600;
    margin-top: 10px;
}

.form-badge.configured {
    background-color: #27ae60;
    color: white;
}

.selected-form-info {
    padding: 15px;
    background-color: #f8f9fa;
    border-radius: 4px;
    margin-bottom: 25px;
    color: #2c3e50;
}

.date-fields-list {
    display: grid;
    gap: 20px;
    margin-bottom: 25px;
}

.date-field-card {
    padding: 20px;
    border: 2px solid #ecf0f1;
    border-radius: 8px;
    background: #fafafa;
}

.date-field-card.disabled {
    opacity: 0.6;
}

.field-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 15px;
}

.field-header h3 {
    color: #2c3e50;
    font-size: 1.1em;
}

.toggle-switch {
    position: relative;
    display: inline-block;
    width: 50px;
    height: 26px;
}

.toggle-switch input {
    opacity: 0;
    width: 0;
    height: 0;
}

.toggle-slider {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: #ccc;
    transition: 0.4s;
    border-radius: 26px;
}

.toggle-slider:before {
    position: absolute;
    content: "";
    height: 18px;
    width: 18px;
    left: 4px;
    bottom: 4px;
    background-color: white;
    transition: 0.4s;
    border-radius: 50%;
}

input:checked + .toggle-slider {
    background-color: #27ae60;
}

input:checked + .toggle-slider:before {
    transform: translateX(24px);
}

.date-inputs {
    display: grid;
    gap: 15px;
}

.date-input-group {
    display: flex;
    align-items: center;
    gap: 10px;
}

.date-input-group label {
    min-width: 100px;
    font-weight: 600;
    color: #2c3e50;
}

.date-input-group input[type="number"] {
    flex: 1;
    padding: 10px;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 16px;
}

.date-input-group input[type="number"]:focus {
    outline: none;
    border-color: #3498db;
}

.date-input-group small {
    color: #7f8c8d;
    font-size: 0.85em;
}

.action-buttons {
    display: flex;
    gap: 10px;
}

.success-message {
    text-align: center;
    padding: 40px 20px;
}

.success-message svg {
    margin-bottom: 20px;
}

.success-message h3 {
    color: #27ae60;
    font-size: 1.8em;
    margin-bottom: 10px;
}

.success-message p {
    color: #7f8c8d;
    font-size: 1.1em;
    margin-bottom: 25px;
}

.error-message {
    padding: 15px;
    background-color: #fee;
    border: 1px solid #fcc;
    border-radius: 4px;
    color: #c33;
    margin-top: 15px;
}

footer {
    text-align: center;
    padding: 20px;
    color: #7f8c8d;
    font-size: 0.9em;
}

footer p {
    margin: 5px 0;
}

footer a {
    color: #3498db;
    text-decoration: none;
}

footer a:hover {
    text-decoration: underline;
}

@media (max-width: 600px) {
    .container {
        padding: 10px;
    }

    header h1 {
        font-size: 2em;
    }

    .input-section, .forms-section, .fields-section, .success-section {
        padding: 20px;
    }

    .action-buttons {
        flex-direction: column;
    }

    .date-input-group {
        flex-direction: column;
        align-items: flex-start;
    }

    .date-input-group label {
        min-width: auto;
    }
}`,
    'script.js': `// State management
let state = {
    apiKey: '',
    timezone: '',
    forms: [],
    selectedForm: null,
    dateFields: [],
    configurations: {}
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initializeTimezones();
    attachEventListeners();
    loadSavedConfiguration();
});

// Initialize timezone selector
function initializeTimezones() {
    const timezoneSelect = document.getElementById('timezone');
    const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Common timezones
    const timezones = [
        'America/New_York',
        'America/Chicago',
        'America/Denver',
        'America/Los_Angeles',
        'America/Phoenix',
        'America/Anchorage',
        'Pacific/Honolulu',
        'Europe/London',
        'Europe/Paris',
        'Europe/Berlin',
        'Asia/Tokyo',
        'Asia/Shanghai',
        'Asia/Dubai',
        'Australia/Sydney',
        'Pacific/Auckland'
    ];

    timezoneSelect.innerHTML = '';

    timezones.forEach(tz => {
        const option = document.createElement('option');
        option.value = tz;
        option.textContent = tz.replace(/_/g, ' ');
        if (tz === detectedTimezone) {
            option.selected = true;
        }
        timezoneSelect.appendChild(option);
    });

    // If detected timezone is not in the list, add it at the top
    if (!timezones.includes(detectedTimezone)) {
        const option = document.createElement('option');
        option.value = detectedTimezone;
        option.textContent = detectedTimezone.replace(/_/g, ' ') + ' (Detected)';
        option.selected = true;
        timezoneSelect.insertBefore(option, timezoneSelect.firstChild);
    }

    state.timezone = detectedTimezone;
}

// Attach event listeners
function attachEventListeners() {
    document.getElementById('loadFormsBtn').addEventListener('click', loadForms);
    document.getElementById('saveConfigBtn').addEventListener('click', saveConfiguration);
    document.getElementById('backToFormsBtn').addEventListener('click', showFormsSection);
    document.getElementById('configureAnotherBtn').addEventListener('click', resetToStart);
    document.getElementById('timezone').addEventListener('change', (e) => {
        state.timezone = e.target.value;
    });
}

// Load forms from Tally API
async function loadForms() {
    const apiKey = document.getElementById('apiKey').value.trim();

    if (!apiKey) {
        showError('Please enter your Tally API key');
        return;
    }

    state.apiKey = apiKey;

    // Save API key to localStorage for convenience
    localStorage.setItem('tallyApiKey', apiKey);

    showLoading(true);
    hideError();

    try {
        const response = await fetch('/api/forms', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                apiKey: state.apiKey
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to load forms');
        }

        const data = await response.json();
        state.forms = data.forms;

        displayForms();
        showFormsSection();

    } catch (error) {
        showError(error.message);
    } finally {
        showLoading(false);
    }
}

// Display forms list
function displayForms() {
    const formsList = document.getElementById('formsList');
    formsList.innerHTML = '';

    if (state.forms.length === 0) {
        formsList.innerHTML = '<p style="color: #7f8c8d; text-align: center;">No forms found in your Tally account.</p>';
        return;
    }

    state.forms.forEach(form => {
        const formCard = document.createElement('div');
        formCard.className = 'form-card';

        if (form.configured) {
            formCard.classList.add('configured');
        }

        formCard.innerHTML = \`
            <h3>\${escapeHtml(form.name || 'Untitled Form')}</h3>
            <p>Form ID: \${escapeHtml(form.id)}</p>
            \${form.configured ? '<span class="form-badge configured">Configured</span>' : ''}
        \`;

        formCard.addEventListener('click', () => selectForm(form));

        formsList.appendChild(formCard);
    });
}

// Select a form and load its fields
async function selectForm(form) {
    state.selectedForm = form;

    showLoading(true);
    hideError();

    try {
        const response = await fetch('/api/form-fields', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                apiKey: state.apiKey,
                formId: form.id
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to load form fields');
        }

        const data = await response.json();
        state.dateFields = data.dateFields;

        // Load existing configuration for this form if available
        if (form.configured && data.configuration) {
            state.configurations = data.configuration.fields || {};
        } else {
            state.configurations = {};
        }

        displayDateFields();
        showFieldsSection();

    } catch (error) {
        showError(error.message);
    } finally {
        showLoading(false);
    }
}

// Display date fields with configuration options
function displayDateFields() {
    const dateFieldsList = document.getElementById('dateFieldsList');
    const selectedFormName = document.getElementById('selectedFormName');

    selectedFormName.textContent = state.selectedForm.name || 'Untitled Form';
    dateFieldsList.innerHTML = '';

    if (state.dateFields.length === 0) {
        dateFieldsList.innerHTML = '<p style="color: #7f8c8d; text-align: center;">No date fields found in this form.</p>';
        document.getElementById('saveConfigBtn').disabled = true;
        return;
    }

    document.getElementById('saveConfigBtn').disabled = false;

    state.dateFields.forEach(field => {
        const existingConfig = state.configurations[field.uuid] || {};
        const enabled = existingConfig.enabled !== false;
        const minDays = existingConfig.minDays !== undefined ? existingConfig.minDays : '';
        const maxDays = existingConfig.maxDays !== undefined ? existingConfig.maxDays : '';

        const fieldCard = document.createElement('div');
        fieldCard.className = 'date-field-card';
        if (!enabled) {
            fieldCard.classList.add('disabled');
        }

        fieldCard.innerHTML = \`
            <div class="field-header">
                <h3>\${escapeHtml(field.label || 'Date Field')}</h3>
                <label class="toggle-switch">
                    <input type="checkbox" data-field-id="\${field.uuid}" class="field-toggle" \${enabled ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>
            <div class="date-inputs">
                <div class="date-input-group">
                    <label>Earliest Date (days from today):</label>
                    <input type="number"
                           placeholder="e.g. -30, 0, or 30"
                           value="\${minDays}"
                           data-field-id="\${field.uuid}"
                           data-type="min"
                           class="days-input"
                           \${!enabled ? 'disabled' : ''}>
                    <small>Minimum selectable date. Negative = past (e.g. -30 = 30 days ago), Positive = future (e.g. 30 = 30 days from now). Leave blank for no limit.</small>
                </div>
                <div class="date-input-group">
                    <label>Latest Date (days from today):</label>
                    <input type="number"
                           placeholder="e.g. 0, 365, or -30"
                           value="\${maxDays}"
                           data-field-id="\${field.uuid}"
                           data-type="max"
                           class="days-input"
                           \${!enabled ? 'disabled' : ''}>
                    <small>Maximum selectable date. Negative = past (e.g. -30 = 30 days ago), Positive = future (e.g. 365 = 1 year from now). Leave blank for no limit.</small>
                </div>
            </div>
        \`;

        dateFieldsList.appendChild(fieldCard);
    });

    // Attach toggle listeners
    document.querySelectorAll('.field-toggle').forEach(toggle => {
        toggle.addEventListener('change', handleFieldToggle);
    });
}

// Handle field enable/disable toggle
function handleFieldToggle(e) {
    const fieldId = e.target.dataset.fieldId;
    const enabled = e.target.checked;

    if (!state.configurations[fieldId]) {
        state.configurations[fieldId] = {};
    }
    state.configurations[fieldId].enabled = enabled;

    // Enable/disable inputs
    const fieldCard = e.target.closest('.date-field-card');
    const inputs = fieldCard.querySelectorAll('.days-input');

    inputs.forEach(input => {
        input.disabled = !enabled;
    });

    if (enabled) {
        fieldCard.classList.remove('disabled');
    } else {
        fieldCard.classList.add('disabled');
    }
}

// Save configuration
async function saveConfiguration() {
    // Gather all configurations
    document.querySelectorAll('.days-input').forEach(input => {
        const fieldId = input.dataset.fieldId;
        const type = input.dataset.type;
        const value = input.value === '' ? null : parseInt(input.value);

        if (!state.configurations[fieldId]) {
            state.configurations[fieldId] = { enabled: true };
        }

        if (type === 'min') {
            state.configurations[fieldId].minDays = value;
        } else {
            state.configurations[fieldId].maxDays = value;
        }
    });

    // Check if at least one field is enabled with limits
    const hasActiveConfig = Object.values(state.configurations).some(config =>
        config.enabled && (config.minDays !== null || config.maxDays !== null)
    );

    showLoading(true);
    hideError();

    try {
        const response = await fetch('/api/save-config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                apiKey: state.apiKey,
                formId: state.selectedForm.id,
                timezone: state.timezone,
                fields: state.configurations
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to save configuration');
        }

        showSuccessSection();

    } catch (error) {
        showError(error.message);
    } finally {
        showLoading(false);
    }
}

// Load saved configuration on page load
async function loadSavedConfiguration() {
    const savedApiKey = localStorage.getItem('tallyApiKey');
    if (savedApiKey) {
        document.getElementById('apiKey').value = savedApiKey;
    }
}

// UI Helper functions
function showFormsSection() {
    document.getElementById('formsSection').classList.remove('hidden');
    document.getElementById('fieldsSection').classList.add('hidden');
    document.getElementById('successSection').classList.add('hidden');
}

function showFieldsSection() {
    document.getElementById('formsSection').classList.add('hidden');
    document.getElementById('fieldsSection').classList.remove('hidden');
    document.getElementById('successSection').classList.add('hidden');
}

function showSuccessSection() {
    document.getElementById('formsSection').classList.add('hidden');
    document.getElementById('fieldsSection').classList.add('hidden');
    document.getElementById('successSection').classList.remove('hidden');

    // Save API key for convenience
    localStorage.setItem('tallyApiKey', state.apiKey);
}

function resetToStart() {
    state.selectedForm = null;
    state.dateFields = [];
    state.configurations = {};

    // Go back to the forms list (no need to reload)
    showFormsSection();
}

function showLoading(show) {
    const indicator = document.getElementById('loadingIndicator');
    if (show) {
        indicator.classList.remove('hidden');
    } else {
        indicator.classList.add('hidden');
    }
}

function showError(message) {
    hideError();

    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    errorDiv.id = 'errorMessage';

    const activeSection = document.querySelector('.input-section:not(.hidden), .forms-section:not(.hidden), .fields-section:not(.hidden)');
    if (activeSection) {
        activeSection.appendChild(errorDiv);
    }
}

function hideError() {
    const errorMessage = document.getElementById('errorMessage');
    if (errorMessage) {
        errorMessage.remove();
    }
}

function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}`
  };

  const content = files[filename];

  if (!content) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(content, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600'
    }
  });
}
