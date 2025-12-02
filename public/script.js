// State management
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
    const loadBtn = document.getElementById('loadFormsBtn');

    if (!apiKey) {
        showError('Please enter your Tally API key');
        return;
    }

    state.apiKey = apiKey;

    // Save API key to localStorage for convenience
    localStorage.setItem('tallyApiKey', apiKey);

    loadBtn.disabled = true;
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
        loadBtn.disabled = false;
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

        formCard.innerHTML = `
            <h3>${escapeHtml(form.name || 'Untitled Form')}</h3>
            <p>Form ID: ${escapeHtml(form.id)}</p>
            ${form.configured ? '<span class="form-badge configured">Configured</span>' : ''}
        `;

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

        fieldCard.innerHTML = `
            <div class="field-header">
                <h3>${escapeHtml(field.label || 'Date Field')}</h3>
                <label class="toggle-switch">
                    <input type="checkbox" data-field-id="${field.uuid}" class="field-toggle" ${enabled ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>
            <div class="date-inputs">
                <div class="date-input-group">
                    <label>Earliest Date (days from today):</label>
                    <input type="number"
                           placeholder="e.g. -30, 0, or 30"
                           value="${minDays}"
                           data-field-id="${field.uuid}"
                           data-type="min"
                           class="days-input"
                           ${!enabled ? 'disabled' : ''}>
                    <small>Minimum selectable date. Negative = past (e.g. -30 = 30 days ago), Positive = future (e.g. 30 = 30 days from now). Leave blank for no limit.</small>
                </div>
                <div class="date-input-group">
                    <label>Latest Date (days from today):</label>
                    <input type="number"
                           placeholder="e.g. 0, 365, or -30"
                           value="${maxDays}"
                           data-field-id="${field.uuid}"
                           data-type="max"
                           class="days-input"
                           ${!enabled ? 'disabled' : ''}>
                    <small>Maximum selectable date. Negative = past (e.g. -30 = 30 days ago), Positive = future (e.g. 365 = 1 year from now). Leave blank for no limit.</small>
                </div>
            </div>
        `;

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
    const saveBtn = document.getElementById('saveConfigBtn');
    const originalText = saveBtn.textContent;

    // Disable button and show saving state
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    hideError();

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
        saveBtn.disabled = false;
        saveBtn.textContent = originalText;
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
}
