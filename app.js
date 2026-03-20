/**
 * PintPoint – Cambridge pub map with account-gated update proposals
 */

const CAMBRIDGE_CENTRE = [52.2053, 0.1218];
const MAP_ZOOM = 14;
const POUND_COIN_IMG = 'https://upload.wikimedia.org/wikipedia/en/c/c0/British_12_sided_pound_coin.png';
const MAPS_LINK_ICON = '<svg class="maps-link-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/></svg>';

let map = null;
let markers = [];
let pubs = [];
let currentUser = null;
let activeUpdatePubId = null;
let activeResetToken = null;
const DEFAULT_AUTH_TITLE = 'Your PintPoint account';
const AUTH_PANEL_META = {
  'login-panel': {
    title: 'Login to PintPoint',
    helper: 'Log in to submit updates and manage your account.'
  },
  'signup-panel': {
    title: 'Create your PintPoint account',
    helper: 'Sign up to submit updates. New accounts must verify within 12 hours or they are deleted.'
  },
  'verify-panel': {
    title: 'Verify your email',
    helper: 'Enter your verification code to unlock update submissions.'
  },
  'resend-panel': {
    title: 'Resend verification',
    helper: 'Request a fresh verification email/code for your account.'
  },
  'reset-panel': {
    title: 'Reset your password',
    helper: 'Request reset details, then set your new password.'
  },
  'username-panel': {
    title: 'Change username',
    helper: 'Update your display username (rate-limited for abuse protection).'
  },
  'status-panel': {
    title: 'Account message',
    helper: 'Important account and update messages are shown here.'
  }
};

const PINT_ICON = L.divIcon({
  html: `
    <svg class="map-pint-icon" viewBox="0 0 24 32" width="28" height="36" aria-hidden="true">
      <path fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" d="M6 2h12l-1.5 26H7.5L6 2z"/>
      <path fill="currentColor" d="M7 6h10v16c0 2-2 4-5 4s-5-2-5-4V6z" opacity="0.5"/>
      <path fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.9" d="M7 6h10"/>
    </svg>
  `,
  className: 'pint-marker',
  iconSize: [28, 36],
  iconAnchor: [14, 36],
  popupAnchor: [0, -36]
});

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text || '');
  return div.innerHTML;
}

function formatPrice(price) {
  return typeof price === 'number' ? `£${price.toFixed(2)}` : '—';
}

function formatUpdatedDate(value) {
  if (!value) return 'Unknown';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(String(value))) return String(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString('en-GB');
}

function googleMapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || '')}`;
}

function installClearButtons(scope = document) {
  const eligibleInputs = scope.querySelectorAll(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([data-clear-disabled="true"])'
  );

  eligibleInputs.forEach((input) => {
    if (input.dataset.clearEnhanced === '1') return;
    if (input.disabled || input.readOnly) return;

    const wrapper = document.createElement('span');
    wrapper.className = 'input-clear-wrap';
    input.parentNode?.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'input-clear-button';
    clearBtn.setAttribute('aria-label', 'Clear input');
    clearBtn.textContent = '×';
    wrapper.appendChild(clearBtn);

    const updateVisibility = () => {
      clearBtn.hidden = input.value.length === 0;
    };

    clearBtn.addEventListener('click', (event) => {
      event.preventDefault();
      input.value = '';
      updateVisibility();
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    input.addEventListener('input', updateVisibility);
    input.addEventListener('change', updateVisibility);
    updateVisibility();
    input.dataset.clearEnhanced = '1';
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'include',
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (_err) {
    payload = {};
  }
  if (!response.ok) {
    const fallbackText = raw && !raw.startsWith('<!DOCTYPE') ? raw : '';
    throw new Error(payload.error || payload.message || fallbackText || `Request failed (${response.status})`);
  }
  return payload;
}

function popupHtml(pub) {
  return `
    <div class="popup-name">${escapeHtml(pub.name)}</div>
    <div class="popup-price" title="Cheapest pint">
      ${escapeHtml(pub.cheapestPintName || 'TBC')} – ${formatPrice(pub.cheapestPint)}
      <img src="${POUND_COIN_IMG}" alt="" class="popup-coin-icon" />
    </div>
    <div class="popup-updated">Last updated: ${escapeHtml(formatUpdatedDate(pub.lastUpdated))}</div>
    <button type="button" class="popup-update-button" data-pub-id="${escapeHtml(pub.id)}" aria-label="Update pint details for ${escapeHtml(pub.name)}">
      <span class="popup-update-label">UPDATE</span>
      <img src="${POUND_COIN_IMG}" alt="" class="popup-update-coin" />
    </button>
    <div class="popup-address-row"><span class="popup-address">${escapeHtml(pub.address)}</span> <a href="${googleMapsUrl(pub.address)}" target="_blank" rel="noopener noreferrer" class="popup-maps-link" title="Open in Google Maps" aria-label="Open address in Google Maps">${MAPS_LINK_ICON}</a></div>
    <p class="popup-desc">${escapeHtml(pub.description)}</p>
  `;
}

function updatePopupHtml(pub) {
  return `
    <div class="popup-name">Update ${escapeHtml(pub.name)}</div>
    <p class="popup-desc">Submit a proposed cheapest pint update. A developer will review it before it goes live.</p>
    <div class="popup-current-values">
      <div><strong>Current pint:</strong> ${escapeHtml(pub.cheapestPintName || 'Unknown')}</div>
      <div><strong>Current price:</strong> ${formatPrice(pub.cheapestPint)}</div>
    </div>
    <form class="popup-update-form" data-pub-id="${escapeHtml(pub.id)}">
      <label>Pint name
        <input type="text" name="pintName" required maxlength="80" value="${escapeHtml(pub.cheapestPintName || '')}" />
      </label>
      <label>Pint price (£)
        <input type="number" name="pintPrice" min="0.5" max="30" step="0.01" required value="${Number(pub.cheapestPint).toFixed(2)}" />
      </label>
      <div class="popup-update-actions">
        <button type="button" class="popup-update-back" data-pub-id="${escapeHtml(pub.id)}">Back</button>
        <button type="submit" class="popup-update-submit" disabled>Submit update</button>
      </div>
    </form>
  `;
}

function renderPopups() {
  pubs.forEach((pub) => {
    const marker = markers.find((m) => m.pubId === pub.id);
    if (!marker || !marker.leaflet) return;
    marker.leaflet.bindPopup(popupHtml(pub), {
      maxWidth: 320,
      className: 'pintpoint-popup',
      autoPan: false
    });
    marker.leaflet.off('dblclick');
    marker.leaflet.on('dblclick', () => focusPub(pub.id));
  });
}

function buildMap() {
  map = L.map('map', {
    center: CAMBRIDGE_CENTRE,
    zoom: MAP_ZOOM,
    zoomControl: false
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);

  L.control.zoom({ position: 'topright' }).addTo(map);

  pubs.forEach((pub) => {
    const marker = L.marker([pub.lat, pub.lng], { alt: pub.name, icon: PINT_ICON });
    marker.pubId = pub.id;
    marker.addTo(map);
    markers.push({ pubId: pub.id, leaflet: marker });
  });

  renderPopups();
}

function getCheapestPub() {
  if (!pubs.length) return null;
  return pubs.reduce((min, pub) => (pub.cheapestPint < min.cheapestPint ? pub : min));
}

function updateCheapestCallout() {
  const cheapest = getCheapestPub();
  const nameEl = document.getElementById('cheapest-pub-name');
  const priceEl = document.getElementById('cheapest-pub-price');
  const pintNameEl = document.getElementById('cheapest-pub-pint-name');
  const addressEl = document.getElementById('cheapest-pub-address');
  const mapsLinkEl = document.getElementById('cheapest-pub-maps-link');
  if (!nameEl || !priceEl || !pintNameEl || !addressEl || !mapsLinkEl) return;

  if (!cheapest) {
    nameEl.textContent = '—';
    priceEl.textContent = '—';
    pintNameEl.textContent = '';
    addressEl.textContent = '';
    mapsLinkEl.style.display = 'none';
    return;
  }

  nameEl.textContent = cheapest.name;
  priceEl.textContent = formatPrice(cheapest.cheapestPint);
  pintNameEl.textContent = cheapest.cheapestPintName || 'TBC';
  addressEl.textContent = cheapest.address || '';
  mapsLinkEl.href = googleMapsUrl(cheapest.address || '');
  mapsLinkEl.style.display = cheapest.address ? '' : 'none';
}

function renderPubList(filteredPubs) {
  const listEl = document.getElementById('pub-list');
  if (!listEl) return;

  if (!filteredPubs.length) {
    listEl.innerHTML = '<p class="pub-list-empty">No pubs match your search.</p>';
    return;
  }

  listEl.innerHTML = filteredPubs.map((pub) => `
    <article class="pub-card" data-pub-id="${escapeHtml(pub.id)}" role="listitem" tabindex="0">
      <h3 class="pub-card-name">${escapeHtml(pub.name)}</h3>
      <p class="pub-card-price">${formatPrice(pub.cheapestPint)} <span class="pub-card-pint-name">${escapeHtml(pub.cheapestPintName || 'TBC')}</span></p>
      <p class="pub-card-address"><span>${escapeHtml(pub.address)}</span> <a href="${googleMapsUrl(pub.address)}" target="_blank" rel="noopener noreferrer" class="pub-card-maps-link" title="Open in Google Maps" aria-label="Open address in Google Maps" onclick="event.stopPropagation()">${MAPS_LINK_ICON}</a></p>
    </article>
  `).join('');

  listEl.querySelectorAll('.pub-card').forEach((card) => {
    card.addEventListener('click', () => focusPub(card.dataset.pubId));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        focusPub(card.dataset.pubId);
      }
    });
  });
}

function focusPub(pubId) {
  const pub = pubs.find((item) => item.id === pubId);
  if (!pub || !map) return;

  const app = document.getElementById('app');
  if (app?.classList.contains('app--list-view') && window.matchMedia('(max-width: 768px)').matches) {
    app.classList.remove('app--list-view');
  }

  map.setView([pub.lat, pub.lng], Math.max(map.getZoom(), 16), { animate: true });
  const marker = markers.find((entry) => entry.pubId === pubId);
  if (marker?.leaflet) marker.leaflet.openPopup();

  document.querySelectorAll('.pub-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.pubId === pubId);
  });
}

function applySortAndFilter() {
  const query = (document.getElementById('search')?.value || '').trim().toLowerCase();
  const sortBy = document.getElementById('sort')?.value || 'price-asc';
  let list = query
    ? pubs.filter((pub) =>
        pub.name.toLowerCase().includes(query) ||
        (pub.address && pub.address.toLowerCase().includes(query)) ||
        (pub.cheapestPintName && pub.cheapestPintName.toLowerCase().includes(query))
      )
    : [...pubs];

  if (sortBy === 'price-asc') list.sort((a, b) => a.cheapestPint - b.cheapestPint);
  else if (sortBy === 'price-desc') list.sort((a, b) => b.cheapestPint - a.cheapestPint);
  else if (sortBy === 'name') list.sort((a, b) => a.name.localeCompare(b.name));

  renderPubList(list);
}

function setAuthMessage(message, isError = false) {
  const el = document.getElementById('auth-message');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('auth-message--error', Boolean(isError));
}

function openOverlay(overlayId) {
  const overlay = document.getElementById(overlayId);
  if (!overlay) return;
  overlay.classList.add('is-visible');
  overlay.setAttribute('aria-hidden', 'false');
}

function closeOverlay(overlayId) {
  const overlay = document.getElementById(overlayId);
  if (!overlay) return;
  overlay.classList.remove('is-visible');
  overlay.setAttribute('aria-hidden', 'true');
}

function setActiveAuthPanel(panelId) {
  if (currentUser && ['login-panel', 'signup-panel', 'reset-panel'].includes(panelId)) {
    panelId = currentUser.verified ? 'username-panel' : 'verify-panel';
  }
  if (!currentUser && ['verify-panel', 'resend-panel', 'username-panel'].includes(panelId)) {
    panelId = 'login-panel';
  }
  if (panelId === 'username-panel' && !currentUser) {
    panelId = 'login-panel';
  }
  const panels = document.querySelectorAll('.auth-panel');
  const buttons = document.querySelectorAll('.auth-action-button');
  panels.forEach((panel) => panel.classList.toggle('is-active', panel.id === panelId));
  buttons.forEach((button) => button.classList.toggle('is-active', button.dataset.authPanelTarget === panelId));

  const titleEl = document.getElementById('auth-title');
  const helperEl = document.querySelector('#auth-overlay > .about-dialog > .auth-helper');
  const panelMeta = AUTH_PANEL_META[panelId];
  if (titleEl) {
    titleEl.textContent = currentUser?.username || panelMeta?.title || DEFAULT_AUTH_TITLE;
  }
  if (helperEl) {
    helperEl.textContent = panelMeta?.helper || 'Create an account or log in to submit pint updates.';
  }
}

function setStatusPanelMessage(message, isError = false) {
  const overlay = document.getElementById('auth-overlay');
  const statusTab = document.getElementById('auth-status-tab');
  const statusText = document.getElementById('auth-status-text');
  if (overlay) overlay.dataset.statusVisible = 'true';
  if (statusTab) statusTab.hidden = false;
  if (statusText) {
    statusText.textContent = message || '';
    statusText.classList.toggle('auth-status-text--error', Boolean(isError));
  }
  setAuthMessage('');
  syncAuthUi();
  setActiveAuthPanel('status-panel');
  openOverlay('auth-overlay');
}

function syncAuthUi() {
  const loginBtn = document.getElementById('auth-login-button');
  const accountBtn = document.getElementById('auth-account-button');
  const logoutBtn = document.getElementById('auth-logout-button');
  const devBtn = document.getElementById('developer-menu-button');
  const devBadge = document.getElementById('developer-badge');

  if (!loginBtn || !accountBtn || !logoutBtn || !devBtn || !devBadge) return;

  const isLoggedIn = Boolean(currentUser);
  loginBtn.hidden = isLoggedIn;
  accountBtn.hidden = !isLoggedIn;
  logoutBtn.hidden = !isLoggedIn;

  const isDeveloper = isLoggedIn && currentUser.role === 'developer';
  devBtn.hidden = !isDeveloper;
  devBadge.hidden = !isDeveloper;

  const usernameActionButton = document.querySelector('.auth-action-button[data-auth-panel-target="username-panel"]');
  const verifyActionButton = document.querySelector('.auth-action-button[data-auth-panel-target="verify-panel"]');
  const resendActionButton = document.querySelector('.auth-action-button[data-auth-panel-target="resend-panel"]');
  const loginActionButton = document.querySelector('.auth-action-button[data-auth-panel-target="login-panel"]');
  const signupActionButton = document.querySelector('.auth-action-button[data-auth-panel-target="signup-panel"]');
  const resetActionButton = document.querySelector('.auth-action-button[data-auth-panel-target="reset-panel"]');
  const statusActionButton = document.getElementById('auth-status-tab');
  const statusVisible = document.getElementById('auth-overlay')?.dataset.statusVisible === 'true';

  if (loginActionButton) {
    loginActionButton.hidden = isLoggedIn;
    loginActionButton.setAttribute('aria-hidden', isLoggedIn ? 'true' : 'false');
  }
  if (signupActionButton) {
    signupActionButton.hidden = isLoggedIn;
    signupActionButton.setAttribute('aria-hidden', isLoggedIn ? 'true' : 'false');
  }
  if (usernameActionButton) {
    usernameActionButton.hidden = !isLoggedIn;
    usernameActionButton.setAttribute('aria-hidden', !isLoggedIn ? 'true' : 'false');
  }
  if (verifyActionButton) {
    verifyActionButton.hidden = !isLoggedIn || Boolean(currentUser?.verified);
    verifyActionButton.setAttribute('aria-hidden', verifyActionButton.hidden ? 'true' : 'false');
  }
  if (resendActionButton) {
    resendActionButton.hidden = !isLoggedIn || Boolean(currentUser?.verified);
    resendActionButton.setAttribute('aria-hidden', resendActionButton.hidden ? 'true' : 'false');
  }
  if (resetActionButton) {
    resetActionButton.hidden = isLoggedIn;
    resetActionButton.setAttribute('aria-hidden', isLoggedIn ? 'true' : 'false');
  }
  if (statusActionButton) {
    statusActionButton.hidden = !statusVisible;
    statusActionButton.setAttribute('aria-hidden', statusActionButton.hidden ? 'true' : 'false');
  }

  const activePanel = document.querySelector('.auth-panel.is-active')?.id;
  if (isLoggedIn && (activePanel === 'login-panel' || activePanel === 'signup-panel' || activePanel === 'reset-panel')) {
    setActiveAuthPanel(currentUser?.verified ? 'username-panel' : 'verify-panel');
  } else if (!isLoggedIn && (activePanel === 'verify-panel' || activePanel === 'resend-panel' || activePanel === 'username-panel')) {
    setActiveAuthPanel('login-panel');
  }
}

async function refreshCurrentUser() {
  try {
    const payload = await api('/api/auth/me');
    currentUser = payload.user;
  } catch (_err) {
    currentUser = null;
  }
  syncAuthUi();
}

function requireVerifiedForUpdates() {
  if (!currentUser) {
    setAuthMessage('Please log in or create an account to submit updates.');
    setActiveAuthPanel('login-panel');
    openOverlay('auth-overlay');
    return false;
  }
  if (!currentUser.verified) {
    setAuthMessage('Please verify your email before submitting updates.');
    setActiveAuthPanel('verify-panel');
    openOverlay('auth-overlay');
    return false;
  }
  return true;
}

function syncUpdateSubmitButton(form) {
  const submitBtn = form.querySelector('.popup-update-submit');
  const nameInput = form.querySelector('input[name="pintName"]');
  const priceInput = form.querySelector('input[name="pintPrice"]');
  if (!submitBtn || !nameInput || !priceInput) return;

  const pubId = form.dataset.pubId;
  const pub = pubs.find((item) => item.id === pubId);
  if (!pub) {
    submitBtn.disabled = false;
    return;
  }

  const proposedName = String(nameInput.value || '').trim();
  const proposedPrice = Number(priceInput.value);
  const sameName = String(pub.cheapestPintName || '').trim().toLowerCase() === proposedName.toLowerCase();
  const samePrice = Number(Number(pub.cheapestPint).toFixed(2)) === Number(proposedPrice.toFixed(2));
  const unchanged = sameName && samePrice;
  const invalid = !proposedName || !Number.isFinite(proposedPrice) || proposedPrice < 0.5 || proposedPrice > 30;
  submitBtn.disabled = unchanged || invalid;
}

function bindUpdateFormState(scope) {
  const forms = scope.querySelectorAll('.popup-update-form');
  forms.forEach((form) => {
    if (form.dataset.stateBound === '1') return;
    form.dataset.stateBound = '1';
    const listener = () => syncUpdateSubmitButton(form);
    form.addEventListener('input', listener);
    form.addEventListener('change', listener);
    syncUpdateSubmitButton(form);
  });
}

function openUpdatePopup(pubId) {
  if (!requireVerifiedForUpdates()) return;
  const pub = pubs.find((item) => item.id === pubId);
  if (!pub || !map) return;
  activeUpdatePubId = pub.id;
  map.setView([pub.lat, pub.lng], Math.max(map.getZoom(), 16), { animate: true });
  L.popup({ maxWidth: 340, className: 'pintpoint-popup', autoPan: false })
    .setLatLng([pub.lat, pub.lng])
    .setContent(updatePopupHtml(pub))
    .openOn(map);
  const popupContent = map?._popup?.getElement()?.querySelector('.leaflet-popup-content') || document;
  installClearButtons(popupContent);
  bindUpdateFormState(popupContent);
}

function upsertPub(updatedPub) {
  const index = pubs.findIndex((pub) => pub.id === updatedPub.id);
  if (index === -1) return;
  pubs[index] = updatedPub;
  updateCheapestCallout();
  applySortAndFilter();
  renderPopups();
}

function proposalCardHtml(proposal) {
  return `
    <article class="developer-proposal" data-proposal-id="${escapeHtml(proposal.id)}">
      <h4>${escapeHtml(proposal.pubName)}</h4>
      <p><strong>Current:</strong> ${escapeHtml(proposal.currentPintName)} — ${formatPrice(Number(proposal.currentPintPrice))}</p>
      <p><strong>Proposed:</strong> ${escapeHtml(proposal.proposedPintName)} — ${formatPrice(Number(proposal.proposedPintPrice))}</p>
      <p><strong>By:</strong> ${escapeHtml(proposal.submittedByUsername)}</p>
      <div class="developer-proposal-actions">
        <button type="button" class="proposal-approve" data-proposal-id="${escapeHtml(proposal.id)}">✓ Approve</button>
        <button type="button" class="proposal-reject" data-proposal-id="${escapeHtml(proposal.id)}">✕ Reject</button>
      </div>
    </article>
  `;
}

async function loadDeveloperProposals() {
  const container = document.getElementById('developer-proposals');
  if (!container) return;
  container.innerHTML = '<p class="pub-list-empty">Loading proposals…</p>';
  try {
    const payload = await api('/api/developer/proposals');
    if (!payload.proposals.length) {
      container.innerHTML = '<p class="pub-list-empty">No pending proposals.</p>';
      return;
    }
    container.innerHTML = payload.proposals.map(proposalCardHtml).join('');
  } catch (error) {
    container.innerHTML = `<p class="pub-list-empty">${escapeHtml(error.message)}</p>`;
  }
}

function auditCardHtml(entry) {
  const action = entry.action === 'approve' ? 'Approved' : 'Rejected';
  const pubName = entry.proposal?.pubName || 'Unknown pub';
  const proposed = `${entry.proposal?.proposedPintName || 'N/A'} — ${formatPrice(Number(entry.proposal?.proposedPintPrice || 0))}`;
  const actedAt = entry.actedAt ? new Date(entry.actedAt).toLocaleString() : 'Unknown time';
  return `
    <article class="developer-proposal">
      <h4>${escapeHtml(action)}: ${escapeHtml(pubName)}</h4>
      <p><strong>Proposal:</strong> ${escapeHtml(proposed)}</p>
      <p><strong>By developer:</strong> ${escapeHtml(entry.actedByUsername || 'unknown')}</p>
      <p><strong>When:</strong> ${escapeHtml(actedAt)}</p>
    </article>
  `;
}

async function loadDeveloperAudit() {
  const container = document.getElementById('developer-audit');
  if (!container) return;
  container.innerHTML = '<p class="pub-list-empty">Loading audit log…</p>';
  try {
    const payload = await api('/api/developer/audit');
    if (!payload.entries.length) {
      container.innerHTML = '<p class="pub-list-empty">No audit entries yet.</p>';
      return;
    }
    container.innerHTML = payload.entries.map(auditCardHtml).join('');
  } catch (error) {
    container.innerHTML = `<p class="pub-list-empty">${escapeHtml(error.message)}</p>`;
  }
}

async function handleUrlTokens() {
  const params = new URLSearchParams(window.location.search);
  const verifyToken = params.get('verify');
  activeResetToken = params.get('reset');
  if (!verifyToken && !activeResetToken) return;

  if (activeResetToken) {
    setAuthMessage('Reset link detected. Enter a new password in the reset form.');
    setActiveAuthPanel('reset-panel');
    openOverlay('auth-overlay');
    const resetEmailInput = document.querySelector('#reset-password-form input[name="email"]');
    if (resetEmailInput) resetEmailInput.required = false;
  }

  if (!verifyToken) {
    params.delete('reset');
    const nextQueryOnlyReset = params.toString();
    const nextOnlyResetUrl = `${window.location.pathname}${nextQueryOnlyReset ? `?${nextQueryOnlyReset}` : ''}`;
    window.history.replaceState({}, '', nextOnlyResetUrl);
    return;
  }

  try {
    await api(`/api/auth/verify?token=${encodeURIComponent(verifyToken)}`);
    setAuthMessage('Your email is verified. You can now submit updates.');
  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('log in')) {
      setActiveAuthPanel('login-panel');
    }
    setAuthMessage(error.message, true);
  } finally {
    params.delete('verify');
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`;
    window.history.replaceState({}, '', nextUrl);
    await refreshCurrentUser();
    openOverlay('auth-overlay');
  }
}

async function initAuthActions() {
  document.getElementById('auth-login-button')?.addEventListener('click', () => {
    setAuthMessage('');
    setActiveAuthPanel('login-panel');
    openOverlay('auth-overlay');
  });
  document.getElementById('auth-account-button')?.addEventListener('click', () => {
    setAuthMessage('');
    setActiveAuthPanel(currentUser?.verified ? 'username-panel' : 'verify-panel');
    openOverlay('auth-overlay');
  });
  document.getElementById('auth-close')?.addEventListener('click', () => closeOverlay('auth-overlay'));
  document.getElementById('developer-close')?.addEventListener('click', () => closeOverlay('developer-overlay'));
  document.getElementById('auth-actions')?.addEventListener('click', (event) => {
    const button = event.target.closest('.auth-action-button');
    if (!button?.dataset.authPanelTarget) return;
    if (button.dataset.authPanelTarget !== 'status-panel') {
      const overlay = document.getElementById('auth-overlay');
      const statusText = document.getElementById('auth-status-text');
      if (overlay) overlay.dataset.statusVisible = 'false';
      if (statusText) {
        statusText.textContent = '';
        statusText.classList.remove('auth-status-text--error');
      }
      syncAuthUi();
    }
    setActiveAuthPanel(button.dataset.authPanelTarget);
  });

  document.getElementById('auth-logout-button')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    currentUser = null;
    syncAuthUi();
    setActiveAuthPanel('login-panel');
    setAuthMessage('Logged out.');
  });

  document.getElementById('developer-menu-button')?.addEventListener('click', async () => {
    openOverlay('developer-overlay');
    await loadDeveloperProposals();
    await loadDeveloperAudit();
  });

  document.getElementById('login-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    try {
      const payload = await api('/api/auth/login', {
        method: 'POST',
        body: {
          email: formData.get('email'),
          password: formData.get('password')
        }
      });
      currentUser = payload.user;
      syncAuthUi();
      setAuthMessage('Logged in successfully.');
      closeOverlay('auth-overlay');
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  document.getElementById('signup-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    try {
      const payload = await api('/api/auth/signup', {
        method: 'POST',
        body: {
          email: formData.get('email'),
          username: formData.get('username'),
          password: formData.get('password'),
          code: formData.get('code')
        }
      });
      currentUser = payload.user || currentUser;
      form.reset();
      syncAuthUi();
      setActiveAuthPanel('verify-panel');
      setAuthMessage(payload.message || 'Account created and logged in. Verify your email to continue.');
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  document.getElementById('verify-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    try {
      const payload = await api('/api/auth/verify-code', {
        method: 'POST',
        body: {
          code: formData.get('code')
        }
      });
      currentUser = payload.user;
      syncAuthUi();
      setAuthMessage(payload.message || 'Email verified.');
      closeOverlay('auth-overlay');
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  document.getElementById('resend-verify-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = await api('/api/auth/resend-verification', {
        method: 'POST'
      });
      setAuthMessage(payload.message || 'Verification email sent.');
      setActiveAuthPanel('verify-panel');
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  document.getElementById('reset-request-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      const payload = await api('/api/auth/request-password-reset', {
        method: 'POST',
        body: { email: formData.get('email') }
      });
      const resetEmail = document.querySelector('#reset-password-form input[name="email"]');
      if (resetEmail) resetEmail.value = String(formData.get('email') || '');
      setActiveAuthPanel('reset-panel');
      setAuthMessage(payload.message || 'Password reset instructions sent.');
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  document.getElementById('reset-password-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      const payload = await api('/api/auth/reset-password', {
        method: 'POST',
        body: {
          email: formData.get('email'),
          code: formData.get('code'),
          token: activeResetToken,
          newPassword: formData.get('newPassword')
        }
      });
      setAuthMessage(payload.message || 'Password reset complete.');
      setActiveAuthPanel('login-panel');
      activeResetToken = null;
      const params = new URLSearchParams(window.location.search);
      if (params.has('reset')) {
        params.delete('reset');
        const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
        window.history.replaceState({}, '', nextUrl);
      }
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  document.getElementById('username-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentUser) {
      setAuthMessage('Please log in first.', true);
      return;
    }
    const formData = new FormData(event.currentTarget);
    try {
      const payload = await api('/api/auth/change-username', {
        method: 'POST',
        body: { username: formData.get('username') }
      });
      currentUser = payload.user;
      syncAuthUi();
      setAuthMessage(payload.message || 'Username updated.');
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  document.getElementById('developer-proposals')?.addEventListener('click', async (event) => {
    const approveBtn = event.target.closest('.proposal-approve');
    const rejectBtn = event.target.closest('.proposal-reject');
    const proposalId = approveBtn?.dataset.proposalId || rejectBtn?.dataset.proposalId;
    if (!proposalId) return;
    try {
      if (approveBtn) {
        const payload = await api(`/api/developer/proposals/${encodeURIComponent(proposalId)}/approve`, { method: 'POST' });
        if (payload.updatedPub) upsertPub(payload.updatedPub);
      } else {
        await api(`/api/developer/proposals/${encodeURIComponent(proposalId)}/reject`, { method: 'POST' });
      }
      await loadDeveloperProposals();
      await loadDeveloperAudit();
    } catch (error) {
      const container = document.getElementById('developer-proposals');
      if (container) container.insertAdjacentHTML('afterbegin', `<p class="pub-list-empty">${escapeHtml(error.message)}</p>`);
    }
  });
}

async function initPopupActions() {
  document.addEventListener('click', (event) => {
    const updateBtn = event.target.closest('.popup-update-button');
    if (updateBtn?.dataset.pubId) {
      openUpdatePopup(updateBtn.dataset.pubId);
      return;
    }
    const backBtn = event.target.closest('.popup-update-back');
    if (backBtn?.dataset.pubId) {
      focusPub(backBtn.dataset.pubId);
    }
  });

  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('.popup-update-form');
    if (!form) return;
    event.preventDefault();

    if (!requireVerifiedForUpdates()) return;

    const pubId = form.dataset.pubId;
    const pintName = form.querySelector('input[name="pintName"]')?.value.trim() || '';
    const pintPriceValue = form.querySelector('input[name="pintPrice"]')?.value || '';
    const pintPrice = Number(pintPriceValue);
    const pub = pubs.find((item) => item.id === pubId);
    if (pub) {
      const sameName = String(pub.cheapestPintName || '').trim().toLowerCase() === pintName.toLowerCase();
      const samePrice = Number(Number(pub.cheapestPint).toFixed(2)) === Number(pintPrice.toFixed(2));
      if (sameName && samePrice) {
        setStatusPanelMessage('No changes detected. Update the pint name or price before submitting.', true);
        return;
      }
    }

    try {
      await api('/api/proposals', {
        method: 'POST',
        body: {
          pubId,
          proposedPintName: pintName,
          proposedPintPrice: pintPrice
        }
      });
      setStatusPanelMessage('Update submitted for review.');
      if (activeUpdatePubId) focusPub(activeUpdatePubId);
    } catch (error) {
      setStatusPanelMessage(error.message, true);
    }
  });
}

async function init() {
  const aboutOverlay = document.getElementById('about-overlay');
  const aboutButton = document.getElementById('about-button');
  const aboutClose = document.getElementById('about-close');
  const app = document.getElementById('app');
  const sidebar = document.querySelector('.sidebar');
  const sidebarToggle = document.getElementById('sidebar-toggle');

  aboutButton?.addEventListener('click', () => openOverlay('about-overlay'));
  aboutClose?.addEventListener('click', () => closeOverlay('about-overlay'));
  aboutOverlay?.addEventListener('click', (event) => {
    if (event.target === aboutOverlay) closeOverlay('about-overlay');
  });
  document.getElementById('auth-overlay')?.addEventListener('click', (event) => {
    if (event.target.id === 'auth-overlay') closeOverlay('auth-overlay');
  });
  document.getElementById('developer-overlay')?.addEventListener('click', (event) => {
    if (event.target.id === 'developer-overlay') closeOverlay('developer-overlay');
  });

  if (sidebar && sidebarToggle && app) {
    sidebarToggle.addEventListener('click', () => {
      const isCollapsed = app.classList.toggle('app--sidebar-collapsed');
      sidebarToggle.setAttribute('aria-expanded', (!isCollapsed).toString());
      sidebar.setAttribute('aria-hidden', isCollapsed ? 'true' : 'false');
      sidebarToggle.classList.toggle('sidebar-toggle--show', isCollapsed);
      sidebarToggle.innerHTML = isCollapsed
        ? `<svg class="mobile-toggle-icon" viewBox="0 0 24 32" width="20" height="26" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" d="M6 2h12l-1.5 26H7.5L6 2z"/>
            <path fill="currentColor" d="M7 6h10v16c0 2-2 4-5 4s-5-2-5-4V6z" opacity="0.5"/>
            <path fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.9" d="M7 6h10"/>
          </svg><span>Switch to Pub-list</span>`
        : '<span aria-hidden="true">❮</span>';
      sidebarToggle.setAttribute('aria-label', isCollapsed ? 'Switch to Pub-list' : 'Collapse list');
      sidebarToggle.setAttribute('title', isCollapsed ? 'Switch to Pub-list' : 'Collapse list');
      if (map) setTimeout(() => map.invalidateSize(), 0);
    });
  }

  try {
    const response = await fetch('/api/pubs');
    if (!response.ok) throw new Error('Failed to load pubs');
    pubs = await response.json();
  } catch (error) {
    console.error(error);
    pubs = [];
  }

  updateCheapestCallout();
  applySortAndFilter();
  buildMap();

  document.getElementById('search')?.addEventListener('input', applySortAndFilter);
  document.getElementById('search')?.addEventListener('search', applySortAndFilter);
  document.getElementById('sort')?.addEventListener('change', applySortAndFilter);
  document.getElementById('cheapest-callout')?.addEventListener('click', () => {
    const cheapest = getCheapestPub();
    if (cheapest) focusPub(cheapest.id);
  });

  document.getElementById('mobile-toggle-list')?.addEventListener('click', () => {
    app?.classList.add('app--list-view');
    if (map) setTimeout(() => map.invalidateSize(), 0);
  });
  document.getElementById('mobile-toggle-map')?.addEventListener('click', () => {
    app?.classList.remove('app--list-view');
    if (map) setTimeout(() => map.invalidateSize(), 0);
  });

  await refreshCurrentUser();
  setActiveAuthPanel('login-panel');
  await initAuthActions();
  await initPopupActions();
  await handleUrlTokens();
  installClearButtons(document);
}

init();
