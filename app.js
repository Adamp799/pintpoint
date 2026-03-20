/**
 * PintPoint – Cambridge pub map with cheapest pint finder
 */

const CAMBRIDGE_CENTRE = [52.2053, 0.1218];

// Realistic pound coin image from Wikimedia, used in popups
const POUND_COIN_IMG = 'https://upload.wikimedia.org/wikipedia/en/c/c0/British_12_sided_pound_coin.png';
const MAP_ZOOM = 14;

let map = null;
let markers = [];
let pubs = [];

function formatPrice(price) {
  return typeof price === 'number' ? `£${price.toFixed(2)}` : price;
}

function renderPopups() {
  pubs.forEach((pub) => {
    const marker = markers.find((m) => m.pubId === pub.id);
    if (!marker || !marker.leaflet) return;

    marker.leaflet.bindPopup(`
      <div class="popup-name">${escapeHtml(pub.name)}</div>
      <div class="popup-price" title="Cheapest pint">${escapeHtml(pub.cheapestPintName || 'TBC')} – ${formatPrice(pub.cheapestPint)}<img src="${POUND_COIN_IMG}" alt="" class="popup-coin-icon" /></div>
      <div class="popup-address-row"><span class="popup-address">${escapeHtml(pub.address)}</span> <a href="${googleMapsUrl(pub.address)}" target="_blank" rel="noopener noreferrer" class="popup-maps-link" title="Open in Google Maps" aria-label="Open address in Google Maps">${MAPS_LINK_ICON}</a></div>
      <p class="popup-desc">${escapeHtml(pub.description)}</p>
    `, {
      maxWidth: 320,
      className: 'pintpoint-popup',
      autoPan: false
    });
    marker.leaflet.on('dblclick', () => focusPub(pub.id));
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function googleMapsUrl(address) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address);
}

// Small map pin icon for "open in Google Maps" links
const MAPS_LINK_ICON = '<svg class="maps-link-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/></svg>';

// Pint glass icon used for all pub markers on the map
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
    const marker = L.marker([pub.lat, pub.lng], {
      alt: pub.name,
      icon: PINT_ICON
    });
    marker.pubId = pub.id;
    marker.addTo(map);
    markers.push({ pubId: pub.id, leaflet: marker });
  });

  renderPopups();
}

function getCheapestPub() {
  if (!pubs.length) return null;
  return pubs.reduce((min, p) => (p.cheapestPint < min.cheapestPint ? p : min));
}

function updateCheapestCallout() {
  const cheapest = getCheapestPub();
  const nameEl = document.getElementById('cheapest-pub-name');
  const priceEl = document.getElementById('cheapest-pub-price');
  const pintNameEl = document.getElementById('cheapest-pub-pint-name');
  const addressEl = document.getElementById('cheapest-pub-address');
  const mapsLinkEl = document.getElementById('cheapest-pub-maps-link');
  if (!nameEl || !priceEl) return;
  if (cheapest) {
    nameEl.textContent = cheapest.name;
    priceEl.textContent = formatPrice(cheapest.cheapestPint);
    if (pintNameEl) pintNameEl.textContent = cheapest.cheapestPintName || 'TBC';
    if (addressEl) addressEl.textContent = cheapest.address || '';
    if (mapsLinkEl) {
      mapsLinkEl.href = googleMapsUrl(cheapest.address || '');
      mapsLinkEl.style.display = cheapest.address ? '' : 'none';
    }
  } else {
    nameEl.textContent = '—';
    priceEl.textContent = '—';
    if (pintNameEl) pintNameEl.textContent = '';
    if (addressEl) addressEl.textContent = '';
    if (mapsLinkEl) mapsLinkEl.style.display = 'none';
  }
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
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        focusPub(card.dataset.pubId);
      }
    });
  });
}

function focusPub(pubId) {
  const pub = pubs.find((p) => p.id === pubId);
  if (!pub || !map) return;

  // On mobile list view, switch to map first
  const app = document.getElementById('app');
  if (app?.classList.contains('app--list-view') && window.matchMedia('(max-width: 768px)').matches) {
    app.classList.remove('app--list-view');
  }

  map.setView([pub.lat, pub.lng], Math.max(map.getZoom(), 16), { animate: true });

  const marker = markers.find((m) => m.pubId === pubId);
  if (marker && marker.leaflet) {
    marker.leaflet.openPopup();
  }

  document.querySelectorAll('.pub-card').forEach((c) => c.classList.toggle('active', c.dataset.pubId === pubId));
}

function applySortAndFilter() {
  const query = (document.getElementById('search')?.value || '').trim().toLowerCase();
  const sortBy = document.getElementById('sort')?.value || 'price-asc';

  let list = query
    ? pubs.filter((p) =>
        p.name.toLowerCase().includes(query) ||
        (p.address && p.address.toLowerCase().includes(query)) ||
        (p.cheapestPintName && p.cheapestPintName.toLowerCase().includes(query))
      )
    : [...pubs];

  if (sortBy === 'price-asc') list.sort((a, b) => a.cheapestPint - b.cheapestPint);
  else if (sortBy === 'price-desc') list.sort((a, b) => b.cheapestPint - a.cheapestPint);
  else if (sortBy === 'name') list.sort((a, b) => a.name.localeCompare(b.name));

  renderPubList(list);
}

async function init() {
  const aboutOverlay = document.getElementById('about-overlay');
  const aboutButton = document.getElementById('about-button');
  const aboutClose = document.getElementById('about-close');
  const app = document.getElementById('app');
  const sidebar = document.querySelector('.sidebar');
  const sidebarToggle = document.getElementById('sidebar-toggle');

  aboutButton?.addEventListener('click', () => {
    if (aboutOverlay) {
      aboutOverlay.classList.add('is-visible');
      aboutOverlay.setAttribute('aria-hidden', 'false');
    }
  });

  aboutClose?.addEventListener('click', () => {
    if (aboutOverlay) {
      aboutOverlay.classList.remove('is-visible');
      aboutOverlay.setAttribute('aria-hidden', 'true');
    }
  });

  if (sidebar && sidebarToggle && app) {
    sidebarToggle.addEventListener('click', () => {
      const isCollapsed = app.classList.toggle('app--sidebar-collapsed');
      sidebarToggle.setAttribute('aria-expanded', (!isCollapsed).toString());
      sidebar.setAttribute('aria-hidden', isCollapsed ? 'true' : 'false');
      sidebarToggle.textContent = isCollapsed ? '» Show list' : '« Hide list';

      // Let Leaflet know the map container size changed
      if (map) {
        setTimeout(() => {
          map.invalidateSize();
        }, 0);
      }
    });
  }

  try {
    const res = await fetch('data/pubs.json');
    if (!res.ok) throw new Error('Failed to load pubs');
    pubs = await res.json();
  } catch (e) {
    console.error(e);
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

  // Mobile view toggle
  document.getElementById('mobile-toggle-list')?.addEventListener('click', () => {
    app?.classList.add('app--list-view');
    if (map) {
      setTimeout(() => {
        map.invalidateSize();
      }, 0);
    }
  });
  document.getElementById('mobile-toggle-map')?.addEventListener('click', () => {
    app?.classList.remove('app--list-view');
    if (map) {
      setTimeout(() => {
        map.invalidateSize();
      }, 0);
    }
  });
}

init();
