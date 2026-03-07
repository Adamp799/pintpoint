/**
 * PintPoint – Cambridge pub map with cheapest pint finder
 */

const CAMBRIDGE_CENTRE = [52.2053, 0.1218];
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
      <div class="popup-price">Cheapest pint: ${escapeHtml(pub.cheapestPintName || 'TBC')} – ${formatPrice(pub.cheapestPint)}</div>
      <div class="popup-address">${escapeHtml(pub.address)}</div>
      <p class="popup-desc">${escapeHtml(pub.description)}</p>
    `, {
      maxWidth: 320,
      className: 'pintpoint-popup'
    });
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
    const marker = L.marker([pub.lat, pub.lng], {
      alt: pub.name
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
  if (!nameEl || !priceEl) return;
  if (cheapest) {
    nameEl.textContent = cheapest.name;
    priceEl.textContent = formatPrice(cheapest.cheapestPint);
    if (pintNameEl) pintNameEl.textContent = cheapest.cheapestPintName || 'TBC';
  } else {
    nameEl.textContent = '—';
    priceEl.textContent = '—';
    if (pintNameEl) pintNameEl.textContent = '';
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
      <p class="pub-card-address">${escapeHtml(pub.address)}</p>
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

  map.setView([pub.lat, pub.lng], Math.max(map.getZoom(), 16));

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
        (p.description && p.description.toLowerCase().includes(query))
      )
    : [...pubs];

  if (sortBy === 'price-asc') list.sort((a, b) => a.cheapestPint - b.cheapestPint);
  else if (sortBy === 'price-desc') list.sort((a, b) => b.cheapestPint - a.cheapestPint);
  else if (sortBy === 'name') list.sort((a, b) => a.name.localeCompare(b.name));

  renderPubList(list);
}

async function init() {
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
}

init();
