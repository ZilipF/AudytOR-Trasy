/**
 * OBCHÓD — planer tras audytowych stacji paliw
 * ---------------------------------------------------------------------------
 * Warstwa aplikacji: stan, interfejs, integracje sieciowe.
 * Logika optymalizacji tras mieszka w route-engine.js, baza stacji
 * w stations-db.js (plik generowany z Excela — nie edytować ręcznie).
 *
 * Układ pliku (szukaj banerów sekcji):
 *   1. KONFIGURACJA           — wszystkie stałe i adresy usług
 *   2. NARZĘDZIA              — DOM, formatowanie, walidacja
 *   3. STAN APLIKACJI         — budowa, zapis, odczyt, synchronizacja z bazą
 *   4. MAPA                   — inicjalizacja Leaflet
 *   5. USŁUGI SIECIOWE        — geokodowanie (Nominatim) i trasowanie (OSRM)
 *   6. PANEL: AUDYTORZY       — pola z nazwiskami
 *   7. PANEL: IMPORT EXCEL    — wczytanie pliku i mapowanie kolumn
 *   8. PANEL: LISTA STACJI    — lista wg priorytetu + statystyki nagłówka
 *   9. PANEL: WYBÓR TRASY     — lista rozwijana i usuwanie tras
 *  10. PROJEKT                — nowy, zapis do pliku, odczyt z pliku
 *  11. BUDOWA PLANU           — klastrowanie, macierze OSRM, warianty dni
 *  12. PANEL: PROPOZYCJE      — karty planów zespołowych
 *  13. ZATWIERDZENIE PLANU    — zapis tras i pobranie geometrii
 *  14. RENDER: MAPA           — znaczniki i linia trasy
 *  15. RENDER: MANIFEST       — lista przystanków z podziałem na dni
 *  16. EKSPORT CSV
 *  17. START                  — podpięcie zdarzeń i pierwszy render
 *  18. WEJŚCIE DLA TESTÓW     — czyste funkcje dla test.html
 */
(function(){
  'use strict';

  /* =========================================================================
     1. KONFIGURACJA
     Wszystkie wartości sterujące w jednym miejscu. Przejście na własne
     serwery OSRM/Nominatim (self-hosting) to zmiana wyłącznie w OSRM_URL
     i NOMINATIM_URL — reszta kodu ich nie zna.
     ========================================================================= */

  var CONFIG = {
    STORAGE_KEY: 'audytor_trasy_state',

    /**
     * Bazy, z których wyjeżdżają zespoły audytowe.
     * Żeby dodać kolejną, dopisz wiersz: potrzebne są nazwa i współrzędne
     * (można je odczytać z Map Google — prawy przycisk na punkcie, pierwsza
     * pozycja w menu to szerokość i długość geograficzna).
     * Kolejność na liście odpowiada kolejności w polu wyboru.
     */
    BASES: [
      { id: 'waw', name: 'Warszawa', lat: 52.2297, lng: 21.0122 },
      { id: 'gda', name: 'Gdańsk',   lat: 54.3520, lng: 18.6466 }
    ],

    // --- Usługi zewnętrzne ---
    // UWAGA: to publiczne serwery demonstracyjne. Nie mają SLA i nie nadają
    // się do pracy produkcyjnej — przed wdrożeniem podmienić na własne.
    OSRM_URL: 'https://router.project-osrm.org',
    NOMINATIM_URL: 'https://nominatim.openstreetmap.org',
    TILE_URL: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    TILE_ATTRIBUTION: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',

    // Polityka Nominatim dopuszcza maks. 1 zapytanie na sekundę.
    // Szybsze odpytywanie grozi zablokowaniem adresu IP przez OSM.
    GEOCODE_DELAY_MS: 1100,

    // --- Parametry planowania ---
    AUDIT_MIN: 120,              // czas jednego audytu w minutach
    PLAN_DAY_OPTIONS: [1, 2, 3], // warianty długości delegacji do wygenerowania
    MAX_AUDITORS: 20,
    MAX_STATIONS_PER_AUDITOR: 80,
    MAX_STATIONS_TOTAL: 300,

    // --- Mapa ---
    MAP_CENTER: [52.0693, 19.4803],
    MAP_ZOOM: 6.3,
    MAP_MAX_ZOOM: 19,
    MAP_PADDING: [40, 40],
    ROUTE_COLOR: '#d81324'
  };

  /* =========================================================================
     2. NARZĘDZIA
     ========================================================================= */

  function el(id){
    return document.getElementById(id);
  }

  function escapeHtml(str){
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function isValidLat(lat){
    return typeof lat === 'number' && !isNaN(lat) && lat >= -90 && lat <= 90;
  }

  function isValidLng(lng){
    return typeof lng === 'number' && !isNaN(lng) && lng >= -180 && lng <= 180;
  }

  function hasValidCoords(point){
    return !!point && isValidLat(point.lat) && isValidLng(point.lng);
  }

  /** Liczba z komórki Excela: obsługuje przecinek jako separator dziesiętny. */
  function parseNumber(value){
    return parseFloat(String(value == null ? '' : value).replace(',', '.'));
  }

  function fmtDist(meters){
    if(typeof meters !== 'number' || isNaN(meters) || meters < 0){ return '—'; }
    return (meters / 1000).toFixed(1).replace('.', ',') + ' km';
  }

  function fmtMin(minutes){
    if(typeof minutes !== 'number' || isNaN(minutes) || minutes < 0){ return '—'; }

    var total = Math.round(minutes);
    if(total < 60){ return total + ' min'; }

    var hours = Math.floor(total / 60);
    var rest = total % 60;
    return hours + ' godz ' + (rest ? rest + ' min' : '');
  }

  /** Komunikat w pasku statusu pod polem importu. */
  function setStatus(message, isError){
    var box = el('geocodeStatus');
    if(!box){ return; }
    box.textContent = message || '';
    box.className = isError ? 'err' : '';
  }

  /* =========================================================================
     3. STAN APLIKACJI
     ========================================================================= */

  var state = null;          // jedyne źródło prawdy dla całego UI
  var pendingImport = null;  // wiersze wczytanego pliku, przed mapowaniem kolumn
  var pendingMergeNote = ''; // komunikat o synchronizacji z bazą, pokazywany po starcie

  function makeStationId(){
    return 'st' + (state.nextStationId++);
  }

  function makeRouteId(){
    return 'r' + (state.nextRouteId++);
  }

  function findRoute(routeId){
    return state.routes.filter(function(route){ return route.id === routeId; })[0] || null;
  }

  function activeRoute(){
    return findRoute(state.activeRouteId);
  }

  function findStation(stationId){
    return state.stations.filter(function(station){ return station.id === stationId; })[0] || null;
  }

  /** Stacje trasy w kolejności przejazdu; pomija odwołania do usuniętych stacji. */
  function routeStations(route){
    if(!route){ return []; }
    return route.order.map(findStation).filter(Boolean);
  }

  /** Stacje gotowe do zaplanowania: nieprzypisane i z nadaną wagą ryzyka. */
  function plannableStations(){
    return state.stations.filter(function(station){
      return station.status === 'free' && station.risk > 0;
    });
  }

  /** Buduje listę stacji z pliku bazy, zerując dane robocze. */
  function createStationsFromDb(){
    var db = window.STATIONS_DB || [];

    return db.map(function(row){
      return {
        id: String(row.id || ('st' + row.stationNo)),
        group: String(row.group || ''),
        stationNo: String(row.stationNo || '').trim(),
        name: String(row.name || ('Stacja ' + row.stationNo)),
        address: String(row.address || ''),
        lat: Number(row.lat),
        lng: Number(row.lng),
        risk: 0,
        status: 'free',
        routeId: null,
        visited: false
      };
    }).filter(function(station){
      return hasValidCoords(station) && station.stationNo;
    });
  }

  function createInitialState(){
    return {
      stations: createStationsFromDb(),
      routes: [],
      activeRouteId: null,
      nextStationId: 1,
      nextRouteId: 1
    };
  }

  /**
   * Scala zapisany stan z aktualną bazą stations-db.js.
   *
   * Baza jest źródłem prawdy dla danych referencyjnych (nazwa, współrzędne,
   * grupa), a zapisany stan dla danych roboczych użytkownika (waga ryzyka,
   * przypisanie do trasy, status skontrolowania). Dzięki temu regeneracja
   * stations-db.js z Excela dociera do użytkowników bez kasowania ich pracy.
   */
  function mergeStationsWithDb(savedStations){
    var db = createStationsFromDb();
    var saved = Array.isArray(savedStations) ? savedStations : [];

    var savedById = {};
    saved.forEach(function(station){
      if(station && station.id){ savedById[station.id] = station; }
    });

    var stats = { added: 0, updated: 0, kept: 0, orphaned: 0, custom: 0, dropped: 0 };
    var merged = [];
    var seen = {};

    db.forEach(function(dbStation){
      seen[dbStation.id] = true;
      var prev = savedById[dbStation.id];

      if(!prev){
        merged.push(dbStation);
        stats.added++;
        return;
      }

      var moved = prev.lat !== dbStation.lat ||
        prev.lng !== dbStation.lng ||
        prev.name !== dbStation.name;
      if(moved){ stats.updated++; } else { stats.kept++; }

      merged.push({
        id: dbStation.id,
        group: dbStation.group,
        stationNo: dbStation.stationNo,
        name: dbStation.name,
        address: dbStation.address || prev.address || '',
        lat: dbStation.lat,
        lng: dbStation.lng,
        risk: typeof prev.risk === 'number' && !isNaN(prev.risk) ? prev.risk : 0,
        status: prev.status === 'assigned' ? 'assigned' : 'free',
        routeId: prev.routeId || null,
        visited: !!prev.visited
      });
    });

    saved.forEach(function(station){
      if(!station || !station.id || seen[station.id]){ return; }

      if(station.stationNo){
        // Stacja pochodziła z bazy, ale zniknęła z aktualnego stations-db.js.
        // Zachowujemy ją tylko wtedy, gdy niesie pracę użytkownika — inaczej
        // trasa straciłaby przystanek albo lista priorytetów wpis.
        if((station.risk || 0) > 0 || station.routeId){
          merged.push(station);
          stats.orphaned++;
        } else {
          stats.dropped++;
        }
        return;
      }

      // Stacja dodana ręcznie przez import adresowy — nie ma jej w bazie.
      merged.push(station);
      stats.custom++;
    });

    return { stations: merged, stats: stats };
  }

  /** Komunikat o zmianach w bazie; pusty ciąg, gdy nic się nie zmieniło. */
  function describeMergeStats(stats){
    if(!stats){ return ''; }

    var parts = [];
    if(stats.added > 0){ parts.push('nowych: ' + stats.added); }
    if(stats.updated > 0){ parts.push('zaktualizowanych: ' + stats.updated); }
    if(stats.orphaned > 0){ parts.push('spoza aktualnej bazy: ' + stats.orphaned); }
    if(stats.dropped > 0){ parts.push('usuniętych z bazy: ' + stats.dropped); }

    if(!parts.length){ return ''; }
    return 'Zsynchronizowano z bazą stacji (' + parts.join(', ') + ').';
  }

  /** Odtwarza stan z surowego obiektu (localStorage albo plik projektu). */
  function restoreState(loaded){
    var merge = mergeStationsWithDb(loaded.stations);

    state = {
      stations: merge.stations,
      routes: loaded.routes || [],
      activeRouteId: loaded.activeRouteId || null,
      nextStationId: Math.max(1, loaded.nextStationId || 1),
      nextRouteId: Math.max(1, loaded.nextRouteId || 1)
    };

    return describeMergeStats(merge.stats);
  }

  function saveState(){
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(state));
    } catch(err){
      console.error('Błąd zapisu stanu:', err);
    }
  }

  function loadState(){
    state = createInitialState();

    try {
      var saved = localStorage.getItem(CONFIG.STORAGE_KEY);
      if(!saved){ return; }

      var loaded = JSON.parse(saved);
      if(!loaded){ return; }

      pendingMergeNote = restoreState(loaded);
      if(pendingMergeNote){ console.log('Synchronizacja bazy stacji:', pendingMergeNote); }
    } catch(err){
      console.error('Błąd odczytu stanu:', err);
    }
  }

  /* =========================================================================
     4. MAPA
     ========================================================================= */

  var map = null;
  var markersLayer = null;
  var routeLayer = null;

  function initMap(){
    map = L.map('map', { zoomControl: true }).setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);

    L.tileLayer(CONFIG.TILE_URL, {
      attribution: CONFIG.TILE_ATTRIBUTION,
      maxZoom: CONFIG.MAP_MAX_ZOOM
    }).addTo(map);

    markersLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);
  }

  /* =========================================================================
     5. USŁUGI SIECIOWE
     ========================================================================= */

  /** Zamienia listę punktów na format współrzędnych OSRM: "lng,lat;lng,lat". */
  function toOsrmCoords(points){
    return points.map(function(point){ return point.lng + ',' + point.lat; }).join(';');
  }

  /** Adres → współrzędne (Nominatim). Odrzuca obietnicę, gdy brak trafienia. */
  function geocode(query){
    var url = CONFIG.NOMINATIM_URL + '/search?format=json&limit=1&countrycodes=pl&q=' +
      encodeURIComponent(query);

    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function(response){
        if(!response.ok){ throw new Error('Błąd serwera geokodowania'); }
        return response.json();
      })
      .then(function(results){
        if(!results || results.length === 0){ throw new Error('Nie znaleziono: ' + query); }

        var lat = parseFloat(results[0].lat);
        var lng = parseFloat(results[0].lon);
        if(!isValidLat(lat) || !isValidLng(lng)){
          throw new Error('Niewłaściwe współrzędne dla: ' + query);
        }

        return { lat: lat, lng: lng, display: results[0].display_name };
      });
  }

  /** Macierz czasów i dystansów między punktami (OSRM /table). */
  function fetchDistanceMatrix(points){
    var url = CONFIG.OSRM_URL + '/table/v1/driving/' + toOsrmCoords(points) +
      '?annotations=duration,distance';

    return fetch(url)
      .then(function(response){
        if(!response.ok){ throw new Error('Błąd OSRM'); }
        return response.json();
      })
      .then(function(data){
        if(data.code !== 'Ok'){
          throw new Error('Serwer OSRM nie zwrócił macierzy odległości.');
        }
        if(!data.durations || !data.distances){
          throw new Error('Brak danych macierzy.');
        }
        return data;
      })
      .catch(function(err){
        console.error('Błąd pobierania macierzy OSRM:', err);
        throw err;
      });
  }

  /** Geometria przejazdu do narysowania na mapie (OSRM /route). */
  function fetchRouteGeometry(points){
    var url = CONFIG.OSRM_URL + '/route/v1/driving/' + toOsrmCoords(points) +
      '?overview=full&geometries=geojson';

    return fetch(url)
      .then(function(response){ return response.json(); })
      .then(function(data){
        if(data.code === 'Ok' && data.routes && data.routes[0]){
          return data.routes[0];
        }
        return null;
      })
      .catch(function(err){
        console.error('Błąd pobierania geometrii trasy:', err);
        return null;
      });
  }

  /* =========================================================================
     6. PANEL: AUDYTORZY
     ========================================================================= */

  function readAuditorCount(){
    var raw = parseInt(el('auditorsInput').value, 10) || 1;
    return Math.max(1, Math.min(CONFIG.MAX_AUDITORS, raw));
  }

  function findBase(baseId){
    return CONFIG.BASES.filter(function(base){ return base.id === baseId; })[0] || CONFIG.BASES[0];
  }

  /**
   * Odtwarza wiersze audytorów (nazwisko + baza wyjazdu), zachowując to,
   * co użytkownik już wpisał i wybrał.
   */
  function renderAuditorInputs(){
    var wrap = el('auditorsNamesWrap');
    if(!wrap){ return; }

    var previous = getAuditorRows().map(function(row){
      return {
        name: row.querySelector('.auditor-name-input').value,
        baseId: row.querySelector('.auditor-base-select').value
      };
    });

    var count = readAuditorCount();
    el('auditorsInput').value = count;
    wrap.innerHTML = '';

    var label = document.createElement('label');
    label.className = 'field-label';
    label.textContent = count === 1 ? 'Audytor i baza wyjazdu' : 'Audytorzy i bazy wyjazdu';
    wrap.appendChild(label);

    for(var i = 0; i < count; i++){
      wrap.appendChild(buildAuditorRow(i, previous[i]));
    }
  }

  function buildAuditorRow(index, saved){
    var row = document.createElement('div');
    row.className = 'auditor-row';

    var name = document.createElement('input');
    name.type = 'text';
    name.className = 'auditor-name-input';
    name.placeholder = 'Audytor ' + (index + 1);
    name.value = saved ? saved.name : '';
    name.setAttribute('aria-label', 'Nazwisko audytora ' + (index + 1));

    var base = document.createElement('select');
    base.className = 'auditor-base-select';
    base.setAttribute('aria-label', 'Baza wyjazdu audytora ' + (index + 1));
    CONFIG.BASES.forEach(function(item){
      var option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      base.appendChild(option);
    });
    base.value = (saved && saved.baseId) || CONFIG.BASES[0].id;

    row.appendChild(name);
    row.appendChild(base);
    return row;
  }

  function getAuditorRows(){
    return Array.prototype.slice.call(document.querySelectorAll('.auditor-row'));
  }

  /** Lista audytorów: nazwisko plus przypisana baza. */
  function getAuditorConfigs(){
    return getAuditorRows().map(function(row, idx){
      var name = row.querySelector('.auditor-name-input').value.trim();
      return {
        name: name || ('Audytor ' + (idx + 1)),
        base: findBase(row.querySelector('.auditor-base-select').value)
      };
    });
  }

  /* =========================================================================
     7. PANEL: IMPORT EXCEL

     Plik obsługiwany jest w dwóch trybach, rozpoznawanych po tym, czy
     użytkownik wskazał kolumnę „Nr stacji":
       A) import wag ryzyka  — dopasowanie po numerze do istniejącej bazy
       B) import adresowy    — dodanie nowych stacji z geokodowaniem
     Tryb A to normalny miesięczny obieg pracy; tryb B służy przypadkom
     spoza bazy.
     ========================================================================= */

  var ROLE_OPTIONS = [
    ['skip', '— pomiń —'],
    ['stationNo', 'Nr stacji'],
    ['name', 'Nazwa stacji'],
    ['address', 'Pełny adres'],
    ['city', 'Miasto'],
    ['voivodeship', 'Województwo'],
    ['lat', 'Szerokość (lat)'],
    ['lng', 'Długość (lng)'],
    ['risk', 'Waga / ranking ryzyka']
  ];

  /** Podpowiada rolę kolumny na podstawie treści nagłówka. */
  function guessRole(header){
    var h = String(header || '').toLowerCase();

    if(/nr.*stacj|numer.*stacj|station.*no|stationno|id.*stacj/.test(h)){ return 'stationNo'; }
    if(/miasto|city|miejscowo/.test(h)){ return 'city'; }
    if(/wojew|woj\.|province|region/.test(h)){ return 'voivodeship'; }
    if(/adres|address|lokaliz/.test(h)){ return 'address'; }
    if(/^lat|szer/.test(h)){ return 'lat'; }
    if(/^lon|^lng|d[łl]ug/.test(h)){ return 'lng'; }
    if(/waga|ryzyk|risk|priorytet|score|rang|ranking|raking|poz/.test(h)){ return 'risk'; }
    if(/nazwa|name|stacj|nr/.test(h)){ return 'name'; }

    return 'skip';
  }

  function handleFileSelected(event){
    var file = event.target.files[0];
    if(!file){ return; }

    var reader = new FileReader();

    reader.onload = function(evt){
      try {
        var workbook = XLSX.read(evt.target.result, { type: 'array' });
        var sheet = workbook.Sheets[workbook.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

        rows = rows.filter(function(row){
          return row.some(function(cell){ return String(cell).trim() !== ''; });
        });

        if(rows.length === 0){
          setStatus('Plik jest pusty.', true);
          return;
        }

        pendingImport = { rows: rows };
        renderColumnMapping(rows);
      } catch(err){
        setStatus('Błąd czytania pliku.', true);
        console.error(err);
      }
    };

    reader.onerror = function(){ setStatus('Nie udało się wczytać pliku.', true); };
    reader.readAsArrayBuffer(file);

    event.target.value = ''; // pozwala wybrać ten sam plik ponownie
  }

  /** Rysuje formularz mapowania kolumn pliku na role. */
  function renderColumnMapping(rows){
    var hasHeader = el('hasHeaderChk').checked;
    var headerRow = hasHeader
      ? rows[0]
      : rows[0].map(function(_, i){ return 'Kolumna ' + (i + 1); });
    var sampleRow = hasHeader ? (rows[1] || []) : rows[0];

    var wrap = el('mapRows');
    wrap.innerHTML = '';

    headerRow.forEach(function(header, idx){
      var row = document.createElement('div');
      row.className = 'map-row';

      var name = document.createElement('span');
      name.className = 'colname';
      name.title = String(header);
      name.textContent = String(header) +
        (sampleRow[idx] !== undefined ? '  (' + String(sampleRow[idx]).slice(0, 14) + ')' : '');

      var select = document.createElement('select');
      select.dataset.colIdx = idx;
      ROLE_OPTIONS.forEach(function(option){
        var opt = document.createElement('option');
        opt.value = option[0];
        opt.textContent = option[1];
        select.appendChild(opt);
      });
      select.value = guessRole(hasHeader ? header : '');

      row.appendChild(name);
      row.appendChild(select);
      wrap.appendChild(row);
    });

    el('importMap').classList.add('show');
  }

  function closeColumnMapping(){
    pendingImport = null;
    el('importMap').classList.remove('show');
  }

  /** Odczytuje wybory użytkownika z formularza mapowania: { indeksKolumny: rola }. */
  function readColumnMapping(){
    var mapping = {};
    Array.prototype.slice.call(document.querySelectorAll('#mapRows select'))
      .forEach(function(select){ mapping[select.dataset.colIdx] = select.value; });
    return mapping;
  }

  /** Indeks kolumny przypisanej do danej roli; -1 gdy brak. */
  function columnOf(mapping, role){
    for(var key in mapping){
      if(mapping[key] === role){ return parseInt(key, 10); }
    }
    return -1;
  }

  /** Numer stacji bez spacji i bez końcówki „.0" dodawanej przez Excela. */
  function normalizeStationNo(value){
    var text = String(value == null ? '' : value).trim();
    if(!text){ return ''; }

    text = text.replace(/\s+/g, '');
    if(/^\d+\.0$/.test(text)){ text = text.replace(/\.0$/, ''); }

    return text;
  }

  /**
   * Numer stacji z komórki, która może zawierać opis: „Stacja nr 812" → „812".
   *
   * Wszystkie numery w bazie są czystymi liczbami, więc gdy po normalizacji
   * zostaje coś innego, wyłuskujemy pierwszą liczbę z tekstu. Bez tego kolumna
   * z nazwą typu „Stacja 812" nigdy nie dopasowałaby się do bazy.
   */
  function extractStationNo(value){
    var normalized = normalizeStationNo(value);
    if(/^\d+$/.test(normalized)){ return normalized; }

    var match = String(value == null ? '' : value).match(/\d+/);
    return match ? match[0] : '';
  }

  /**
   * TRYB A — import wag ryzyka.
   * Dopasowuje wiersze pliku do stacji w bazie po numerze stacji.
   * Nowy import zeruje poprzednie wagi i kasuje wcześniejsze trasy: comiesięczna
   * tabela ryzyk zastępuje poprzednią, a stare trasy odnosiłyby się do nieaktualnych
   * priorytetów.
   */
  function applyRiskRows(dataRows, mapping, prioDir){
    var stationNoCol = columnOf(mapping, 'stationNo');
    var nameCol = columnOf(mapping, 'name');
    var riskCol = columnOf(mapping, 'risk');

    if(stationNoCol < 0 && nameCol < 0){
      alert('Wskaż kolumnę z numerem stacji.');
      return;
    }
    if(riskCol < 0){
      alert('Wskaż kolumnę z wagą / rankingiem ryzyka.');
      return;
    }

    var parsed = [];
    dataRows.forEach(function(row){
      var stationNo = stationNoCol >= 0 ? extractStationNo(row[stationNoCol]) : '';
      if(!stationNo && nameCol >= 0){ stationNo = extractStationNo(row[nameCol]); }

      var rawRisk = parseNumber(row[riskCol] || '0');
      if(!stationNo || isNaN(rawRisk)){ return; }

      parsed.push({ stationNo: stationNo, rawRisk: rawRisk });
    });

    if(parsed.length === 0){
      setStatus('Nie znaleziono prawidłowych rekordów ryzyka.', true);
      return;
    }

    var maxRisk = Math.max.apply(null, parsed.map(function(row){ return row.rawRisk; }));

    var stationByNo = {};
    state.stations.forEach(function(station){
      stationByNo[normalizeStationNo(station.stationNo)] = station;
    });

    state.routes = [];
    state.activeRouteId = null;
    state.stations.forEach(resetStationWork);

    var matched = 0;
    var notFound = [];

    parsed.forEach(function(row){
      var station = stationByNo[normalizeStationNo(row.stationNo)];
      if(!station){
        notFound.push(row.stationNo);
        return;
      }

      // Przy rankingu rosnącym (1 = najpilniejsza) odwracamy skalę,
      // bo silnik zawsze traktuje wyższą wagę jako wyższy priorytet.
      var risk = prioDir === 'asc' ? (maxRisk - row.rawRisk + 1) : row.rawRisk;

      resetStationWork(station);
      station.risk = Math.max(0, risk);
      matched++;
    });

    closeColumnMapping();

    setStatus(
      'Zaimportowano ryzyka: dopasowano ' + matched + ' stacji, nie znaleziono ' + notFound.length + '.',
      notFound.length > 0
    );
    if(notFound.length){
      console.warn('Nie znaleziono w bazie stacji o numerach:', notFound);
    }

    renderAll();
  }

  /**
   * TRYB B — import adresowy.
   * Buduje listę nowych stacji; brakujące współrzędne uzupełnia geokodowaniem.
   */
  function collectAddressRows(dataRows, mapping, prioDir){
    var nameCol = columnOf(mapping, 'name');
    var addrCol = columnOf(mapping, 'address');
    var cityCol = columnOf(mapping, 'city');
    var voivCol = columnOf(mapping, 'voivodeship');
    var latCol = columnOf(mapping, 'lat');
    var lngCol = columnOf(mapping, 'lng');
    var riskCol = columnOf(mapping, 'risk');

    if(nameCol < 0 && addrCol < 0 && cityCol < 0){
      alert('Wskaż przynajmniej kolumnę z nazwą, pełnym adresem albo miastem.');
      return null;
    }

    var cell = function(row, col){
      return col >= 0 ? String(row[col] || '').trim() : '';
    };

    return dataRows.map(function(row){
      var city = cell(row, cityCol);
      var voivodeship = cell(row, voivCol);
      var rawAddress = cell(row, addrCol);
      var address = buildGeocodeQuery(city, voivodeship, rawAddress);
      var name = cell(row, nameCol) || city || rawAddress || address;

      var risk = riskCol >= 0 ? parseNumber(row[riskCol]) : 0;
      if(isNaN(risk)){ risk = 0; }
      if(prioDir === 'asc'){ risk = -risk; }

      return {
        name: name,
        address: address,
        lat: latCol >= 0 ? parseNumber(row[latCol]) : NaN,
        lng: lngCol >= 0 ? parseNumber(row[lngCol]) : NaN,
        risk: Math.max(0, risk)
      };
    }).filter(function(row){
      return row.name && (row.address || hasValidCoords(row));
    });
  }

  function normalizeVoivodeship(value){
    var text = String(value || '').trim();
    if(!text){ return ''; }
    return text.replace(/^woj\.\s*/i, '').trim();
  }

  /** Składa zapytanie adresowe dla Nominatim z rozbitych kolumn. */
  function buildGeocodeQuery(city, voivodeship, address){
    var c = String(city || '').trim();
    var w = normalizeVoivodeship(voivodeship);
    var a = String(address || '').trim();
    var suffix = (w ? ', ' + w : '') + ', Polska';

    if(a && c && a.toLowerCase().indexOf(c.toLowerCase()) === -1){
      return a + ', ' + c + suffix;
    }
    if(a){ return a + suffix; }
    if(c){ return c + suffix; }
    return '';
  }

  /**
   * Geokoduje i dodaje stacje po jednej, z odstępem wymaganym przez Nominatim.
   * Rekurencja zamiast pętli, bo każdy krok czeka na poprzedni.
   */
  function importRowsSequential(rows, index){
    if(index >= rows.length){
      setStatus('Import zakończony: ' + rows.length + ' stacji.');
      renderAll();
      return;
    }

    var row = rows[index];
    var next = function(){
      setTimeout(function(){ importRowsSequential(rows, index + 1); }, CONFIG.GEOCODE_DELAY_MS);
    };

    var addStation = function(lat, lng, address){
      if(!isValidLat(lat) || !isValidLng(lng)){
        setStatus('Pominięto (niewłaściwe współrzędne): ' + row.address, true);
        next();
        return;
      }

      state.stations.push({
        id: makeStationId(),
        group: '',
        stationNo: '',
        name: row.name,
        address: address || row.address,
        lat: lat,
        lng: lng,
        risk: row.risk,
        status: 'free',
        routeId: null,
        visited: false
      });
      next();
    };

    if(hasValidCoords(row)){
      addStation(row.lat, row.lng, row.address);
      return;
    }

    setStatus('Geokoduję ' + (index + 1) + '/' + rows.length + ': ' + row.address);
    geocode(row.address)
      .then(function(result){ addStation(result.lat, result.lng, result.display); })
      .catch(function(){
        setStatus('Pominięto: ' + row.address, true);
        next();
      });
  }

  /** Wybiera tryb importu na podstawie mapowania kolumn i uruchamia go. */
  function confirmImport(){
    if(!pendingImport){ return; }

    var rows = pendingImport.rows;
    var hasHeader = el('hasHeaderChk').checked;
    var dataRows = hasHeader ? rows.slice(1) : rows;
    var mapping = readColumnMapping();
    var prioDir = document.querySelector('input[name=prioDir]:checked').value;

    if(columnOf(mapping, 'stationNo') >= 0){
      applyRiskRows(dataRows, mapping, prioDir);
      return;
    }

    var toImport = collectAddressRows(dataRows, mapping, prioDir);
    if(!toImport){ return; }

    closeColumnMapping();
    importRowsSequential(toImport, 0);
  }

  /* =========================================================================
     8. PANEL: LISTA STACJI
     ========================================================================= */

  /** Kasuje dane robocze stacji, zostawiając dane referencyjne. */
  function resetStationWork(station){
    station.risk = 0;
    station.status = 'free';
    station.routeId = null;
    station.visited = false;
  }

  function routeLabel(routeId){
    var route = findRoute(routeId);
    return route ? route.name : null;
  }

  function renderStopList(){
    var list = el('stopList');
    var empty = el('emptyState');
    list.innerHTML = '';

    // Stacje bez wagi i bez przypisania nie niosą informacji — nie zaśmiecamy
    // nimi listy, bo baza ma prawie 2000 pozycji.
    var visible = state.stations
      .filter(function(station){ return station.risk > 0 || station.status !== 'free'; })
      .sort(function(a, b){ return b.risk - a.risk; });

    empty.hidden = visible.length > 0;

    visible.forEach(function(station, idx){
      list.appendChild(buildStopListItem(station, idx));
    });

    renderHeaderStats();
  }

  function buildStopListItem(station, idx){
    var item = document.createElement('li');

    var rank = document.createElement('span');
    rank.className = 'rk';
    rank.textContent = String(idx + 1).padStart(2, '0');

    var name = document.createElement('span');
    name.className = 'nm';
    name.textContent = station.name;
    name.title = station.address;

    var weight = document.createElement('span');
    weight.className = 'wt';
    weight.textContent = station.risk;

    var isFree = station.status === 'free';
    var badge = document.createElement('span');
    badge.className = 'badge ' + (isFree ? 'free' : 'assigned');
    badge.textContent = isFree ? 'wolna' : (routeLabel(station.routeId) || 'w trasie');

    item.appendChild(rank);
    item.appendChild(name);
    item.appendChild(weight);
    item.appendChild(badge);

    // Wolną stację można dopisać do otwartej trasy — planista zna kontekst,
    // którego algorytm nie ma (ustalenia z kontrolerem, remont, dojazd przy okazji).
    var route = activeRoute();
    if(isFree && route){
      var add = document.createElement('button');
      add.className = 'rm add';
      add.title = 'Dodaj do trasy: ' + route.name;
      add.setAttribute('aria-label', 'Dodaj stację ' + station.name + ' do trasy');
      add.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" ' +
        'stroke-width="2" width="14" height="14" aria-hidden="true">' +
        '<path d="M12 5v14M5 12h14"/></svg>';
      add.addEventListener('click', function(){ addStopToRoute(route, station); });
      item.appendChild(add);
    }

    // Usuwać można tylko stacje wolne — usunięcie przypisanej zepsułoby trasę.
    if(isFree){
      var remove = document.createElement('button');
      remove.className = 'rm';
      remove.title = 'Usuń stację z listy';
      remove.setAttribute('aria-label', 'Usuń stację ' + station.name);
      remove.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" ' +
        'stroke-width="1.8" width="14" height="14" aria-hidden="true">' +
        '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>';
      remove.addEventListener('click', function(){
        state.stations = state.stations.filter(function(other){ return other.id !== station.id; });
        renderAll();
      });
      item.appendChild(remove);
    }

    return item;
  }

  function renderHeaderStats(){
    var plannable = plannableStations().length;

    el('statTotal').textContent = state.stations.length;
    el('statFree').textContent = plannable;
    el('statRoutes').textContent = state.routes.length;
    el('buildBtn').disabled = plannable === 0;
  }

  /* =========================================================================
     9. PANEL: WYBÓR TRASY
     ========================================================================= */

  function renderRouteSelect(){
    var select = el('routeSelect');
    select.innerHTML = '<option value="">— wybierz trasę —</option>';

    state.routes.forEach(function(route){
      var option = document.createElement('option');
      option.value = route.id;
      option.textContent = route.name + ' | ' + (route.auditor || 'Nieprzypisany') +
        ' (' + route.order.length + ' stacji)';
      select.appendChild(option);
    });

    select.value = state.activeRouteId || '';
  }

  /** Panel prawy pokazuje albo propozycje, albo manifest — nigdy oba naraz. */
  function showPanel(name){
    el('proposalsPanel').hidden = name !== 'proposals';
    el('manifestPanel').hidden = name !== 'manifest';
  }

  function showManifestPanel(){
    showPanel('manifest');
  }

  function handleRouteSelected(){
    state.activeRouteId = el('routeSelect').value || null;
    showManifestPanel();
    renderMap();
    renderManifest();
  }

  function handleDeleteRoute(){
    if(!state.activeRouteId){ return; }
    if(!confirm('Usunąć trasę i zwolnić jej stacje?')){ return; }

    var routeId = state.activeRouteId;
    state.stations.forEach(function(station){
      if(station.routeId === routeId){
        station.status = 'free';
        station.routeId = null;
        station.visited = false;
      }
    });

    state.routes = state.routes.filter(function(route){ return route.id !== routeId; });
    state.activeRouteId = null;
    renderAll();
  }

  /* =========================================================================
     10. PROJEKT
     ========================================================================= */

  function downloadBlob(blob, filename){
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function handleNewProject(){
    if(!confirm('Rozpocząć nowy projekt i usunąć wszystkie zapisane dane?')){ return; }

    localStorage.removeItem(CONFIG.STORAGE_KEY);
    state = createInitialState();
    renderAll();
    setStatus('Rozpoczęto nowy projekt.');
  }

  function handleSaveProject(){
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'AudytOR_' + new Date().toISOString().slice(0, 10) + '.json');
  }

  function handleLoadProjectFile(event){
    var file = event.target.files[0];
    if(!file){ return; }

    var reader = new FileReader();

    reader.onload = function(evt){
      try {
        var mergeNote = restoreState(JSON.parse(evt.target.result));
        renderAll();
        setStatus(('Projekt został wczytany. ' + mergeNote).trim());
      } catch(err){
        alert('Nieprawidłowy plik projektu.');
        console.error(err);
      }
    };

    reader.onerror = function(){ alert('Nie udało się wczytać pliku.'); };
    reader.readAsText(file);

    event.target.value = '';
  }

  /* =========================================================================
     11. BUDOWA PLANU
     ========================================================================= */

  /**
   * Przydziela stacje audytorom z uwzględnieniem bazy każdego z nich.
   *
   * Krok 1: każda stacja trafia do najbliższej bazy spośród tych, z których
   *         faktycznie ktoś wyjeżdża — dzięki temu zespół z Gdańska nie
   *         dostaje stacji spod Krakowa.
   * Krok 2: stacje przypisane do danej bazy dzielone są między audytorów
   *         z tej bazy, tak jak dotąd (geografia + wyrównanie obciążenia).
   *
   * @returns {Array} lista zadań: { auditorName, origin, stations }
   */
  function assignStationsToAuditors(stations, auditors){
    // Grupujemy audytorów wg bazy, zachowując kolejność z formularza.
    var byBase = [];
    auditors.forEach(function(auditor){
      var group = byBase.filter(function(item){ return item.base.id === auditor.base.id; })[0];
      if(!group){
        group = { base: auditor.base, auditors: [], stations: [] };
        byBase.push(group);
      }
      group.auditors.push(auditor);
    });

    stations.forEach(function(station){
      var best = null;
      var bestKm = Infinity;

      byBase.forEach(function(group){
        var km = RouteEngine.geoKm(station, group.base);
        if(km < bestKm){
          bestKm = km;
          best = group;
        }
      });

      if(best){ best.stations.push(station); }
    });

    var assignments = [];
    byBase.forEach(function(group){
      if(group.stations.length === 0){ return; }

      var clusters = RouteEngine.clusterStations(group.stations, group.auditors.length);
      clusters.forEach(function(cluster, idx){
        var auditor = group.auditors[idx];
        if(!auditor || !cluster.length){ return; }

        assignments.push({
          auditorName: auditor.name,
          origin: { lat: auditor.base.lat, lng: auditor.base.lng, baseId: auditor.base.id },
          stations: cluster
        });
      });
    });

    return assignments;
  }

  /** Pobiera macierz odległości dla jednego zadania i opisuje je dla silnika. */
  function prepareAssignment(assignment){
    var points = [{ lat: assignment.origin.lat, lng: assignment.origin.lng }].concat(
      assignment.stations.map(function(station){
        return { lat: station.lat, lng: station.lng };
      })
    );

    return fetchDistanceMatrix(points).then(function(data){
      return {
        auditorName: assignment.auditorName,
        origin: assignment.origin,
        durMatrix: data.durations,
        distMatrix: data.distances,
        // idx 0 zarezerwowany dla bazy, więc stacje numerujemy od 1
        candidates: assignment.stations.map(function(station, i){
          return { station: station, idx: i + 1 };
        })
      };
    });
  }

  /** Dla każdego wariantu długości delegacji buduje plan dla wszystkich audytorów. */
  function buildPlansForAllVariants(clusterResults){
    var plans = [];

    CONFIG.PLAN_DAY_OPTIONS.forEach(function(days){
      var routes = [];

      clusterResults.forEach(function(result){
        var route = RouteEngine.buildRouteForCluster(result, days, CONFIG.AUDIT_MIN);
        if(route && route.orderedStations.length > 0){ routes.push(route); }
      });

      if(routes.length === 0){ return; }

      var sum = function(pick){
        return routes.reduce(function(total, route){ return total + pick(route); }, 0);
      };

      plans.push({
        days: days,
        routes: routes,
        totalStations: sum(function(r){ return r.orderedStations.length; }),
        totalDist: sum(function(r){ return r.totalDist; }),
        totalMin: sum(function(r){ return r.totalMin; }),
        totalRisk: sum(function(r){ return r.totalRisk; })
      });
    });

    return plans;
  }

  function handleBuildPlan(){
    renderAuditorInputs();

    var free = plannableStations().sort(function(a, b){ return b.risk - a.risk; });
    if(free.length === 0){
      setStatus('Brak wolnych stacji do zaplanowania.', true);
      return;
    }

    var auditors = getAuditorConfigs();

    // Limit chroni wydajność i mieści się w limicie długości zapytania OSRM.
    var cap = Math.min(free.length, auditors.length * CONFIG.MAX_STATIONS_PER_AUDITOR, CONFIG.MAX_STATIONS_TOTAL);
    var capped = free.slice(0, cap);
    var skipped = free.length - capped.length;
    var capNote = skipped > 0
      ? ' Uwaga: pominięto ' + skipped + ' stacji o najniższym priorytecie (limit ' + cap + ').'
      : '';
    if(skipped > 0){
      console.warn('Pominięto', skipped, 'stacji ponad limit planowania (' + cap + ').');
    }

    var assignments = assignStationsToAuditors(capped, auditors);
    if(assignments.length === 0){
      setStatus('Nie udało się przydzielić stacji do audytorów.', true);
      return;
    }

    var button = el('buildBtn');
    button.disabled = true;
    button.textContent = 'Liczę...';
    setStatus('Buduję plan zespołowy...');

    Promise.all(assignments.map(prepareAssignment))
      .then(function(prepared){
        var plans = buildPlansForAllVariants(prepared);
        renderTeamPlans(plans);
        setStatus(
          (plans.length ? 'Wygenerowano plan zespołowy.' : 'Nie udało się wygenerować planu.') + capNote,
          plans.length === 0 || skipped > 0
        );
      })
      .catch(function(err){
        console.error(err);
        setStatus('Błąd przy budowaniu tras: ' + (err.message || err), true);
        alert(err.message || 'Nie udało się zbudować propozycji tras.');
      })
      .finally(function(){
        button.disabled = false;
        button.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' +
          '<path d="M12 5v14M5 12h14"/></svg>Zbuduj trasy';
      });
  }

  /* =========================================================================
     12. PANEL: PROPOZYCJE
     ========================================================================= */

  function renderTeamPlans(plans){
    showPanel('proposals');

    var wrap = el('proposalCards');
    wrap.innerHTML = '';

    if(!plans || plans.length === 0){
      wrap.innerHTML = '<p class="empty-state">Nie udało się wygenerować planu zespołowego.</p>';
      return;
    }

    // Wariant o najwyższej sumie wag jest wyróżniany jako domyślnie najlepszy.
    var bestRisk = Math.max.apply(null, plans.map(function(plan){ return plan.totalRisk; }));
    plans.forEach(function(plan){
      wrap.appendChild(buildProposalCard(plan, plan.totalRisk === bestRisk));
    });
  }

  function buildProposalCard(plan, isBest){
    var card = document.createElement('div');
    card.className = 'proposal-card' + (isBest ? ' best' : '');

    var dayLabel = plan.days === 1 ? 'dzień' : 'dni';
    var chips = plan.routes.map(function(route){
      return '<span class="day-chip">' + escapeHtml(route.auditorName) + ': ' +
        route.orderedStations.length + ' stacji, ' + fmtMin(route.totalMin) + '</span>';
    }).join('');

    card.innerHTML =
      '<div class="proposal-head">' +
        '<h3>Plan zespołowy · ' + plan.days + ' ' + dayLabel + '</h3>' +
        '<span>' + plan.routes.length + ' tras</span>' +
      '</div>' +
      '<div class="proposal-stats">' +
        '<div class="pstat"><b>' + plan.totalStations + '</b>stacji łącznie</div>' +
        '<div class="pstat"><b>' + fmtDist(plan.totalDist) + '</b>dystans łącznie</div>' +
        '<div class="pstat"><b>' + fmtMin(plan.totalMin) + '</b>czas łącznie</div>' +
        '<div class="pstat"><b>' + plan.totalRisk.toFixed(0) + '</b>suma wag</div>' +
      '</div>' +
      '<div>' + chips + '</div>';

    var useBtn = document.createElement('button');
    useBtn.className = 'use-proposal';
    useBtn.textContent = 'Wybierz cały plan';
    useBtn.addEventListener('click', function(){ commitTeamPlan(plan); });
    card.appendChild(useBtn);

    return card;
  }

  /* =========================================================================
     13. ZATWIERDZENIE PLANU
     ========================================================================= */

  /**
   * Zapisuje wybrany plan jako trasy w stanie aplikacji i dociąga geometrię
   * przejazdu do rysowania na mapie. Panel przełącza się dopiero po powrocie
   * wszystkich zapytań, żeby mapa nie mrugała częściowym wynikiem.
   */
  function commitTeamPlan(plan){
    var roundtrip = el('roundtripCheck').checked;

    var pending = plan.routes.map(function(planned){
      var routeId = makeRouteId();

      planned.orderedStations.forEach(function(station){
        station.status = 'assigned';
        station.routeId = routeId;
        station.visited = false;
      });

      var route = {
        id: routeId,
        name: 'Trasa ' + (state.routes.length + 1) + ' · ' + planned.auditorName,
        auditor: planned.auditorName,
        days: planned.days,
        order: planned.orderedStations.map(function(station){ return station.id; }),
        dayBreak: planned.dayBreak,
        dayTotals: planned.dayTotals,
        returnMin: planned.returnMin,
        legsMin: planned.legsMin,
        totalDist: planned.totalDist,
        totalMin: planned.totalMin,
        origin: planned.origin,
        roundtrip: roundtrip,
        geometry: null
      };

      state.routes.push(route);
      state.activeRouteId = routeId;

      var points = [{ lat: planned.origin.lat, lng: planned.origin.lng }].concat(
        planned.orderedStations.map(function(station){
          return { lat: station.lat, lng: station.lng };
        })
      );
      if(roundtrip){ points.push({ lat: planned.origin.lat, lng: planned.origin.lng }); }

      return fetchRouteGeometry(points).then(function(osrmRoute){
        if(!osrmRoute){ return; }
        route.geometry = osrmRoute.geometry;
        // Przy powrocie do bazy dystans z OSRM jest dokładniejszy niż suma
        // odcinków z macierzy, bo obejmuje też odcinek powrotny.
        if(roundtrip){ route.totalDist = osrmRoute.distance; }
      });
    });

    Promise.all(pending).finally(function(){
      showManifestPanel();
      renderAll();
    });
  }

  /* =========================================================================
     13b. RĘCZNA EDYCJA TRASY

     Algorytm nie zna kontekstu, który zna planista: remontu na stacji, urlopu,
     wcześniejszych ustaleń z kontrolerami. Dlatego wygenerowany plan jest
     propozycją, którą wolno poprawić. Po każdej zmianie trasa jest przeliczana
     przez OSRM, a przekroczenie norm czasu pracy zostaje pokazane wprost.
     ========================================================================= */

  /**
   * Porządkuje trasę tak, żeby dni były niemalejące i spójne.
   * Sortowanie jest stabilne — kolejność stacji w obrębie dnia zostaje.
   */
  function normalizeRouteDays(route){
    var items = route.order.map(function(stationId, idx){
      var day = Math.min(Math.max((route.dayBreak && route.dayBreak[idx]) || 1, 1), route.days);
      return { id: stationId, day: day, idx: idx };
    });

    items.sort(function(a, b){
      return a.day - b.day || a.idx - b.idx;
    });

    route.order = items.map(function(item){ return item.id; });
    route.dayBreak = items.map(function(item){ return item.day; });
  }

  /**
   * Przesuwa przystanek o jedną pozycję.
   * Na granicy dnia zamiast zamiany miejsc następuje przeniesienie do
   * sąsiedniego dnia — to naturalniejsze niż przeskakiwanie całych bloków.
   */
  function moveStop(route, idx, direction){
    var target = idx + direction;

    if(target < 0 || target >= route.order.length){
      // Poza trasą: pozostaje zmiana dnia, o ile jest dokąd.
      var edgeDay = route.dayBreak[idx] + direction;
      if(edgeDay >= 1 && edgeDay <= route.days){ route.dayBreak[idx] = edgeDay; }
    } else if(route.dayBreak[target] !== route.dayBreak[idx]){
      route.dayBreak[idx] = route.dayBreak[target];
    } else {
      var tmpId = route.order[idx];
      route.order[idx] = route.order[target];
      route.order[target] = tmpId;
    }

    normalizeRouteDays(route);
    refreshRoute(route);
  }

  function removeStop(route, idx){
    var station = findStation(route.order[idx]);
    if(station){
      station.status = 'free';
      station.routeId = null;
      station.visited = false;
    }

    route.order.splice(idx, 1);
    route.dayBreak.splice(idx, 1);

    if(route.order.length === 0){
      state.routes = state.routes.filter(function(item){ return item.id !== route.id; });
      state.activeRouteId = null;
      setStatus('Trasa została pusta i usunięta.');
      renderAll();
      return;
    }

    normalizeRouteDays(route);
    refreshRoute(route);
  }

  /** Dopisuje stację na koniec trasy, do ostatniego dnia. */
  function addStopToRoute(route, station){
    station.status = 'assigned';
    station.routeId = route.id;
    station.visited = false;

    route.order.push(station.id);
    route.dayBreak.push(route.days);

    normalizeRouteDays(route);
    refreshRoute(route);
  }

  /**
   * Przelicza trasę po edycji: pobiera z OSRM czasy odcinków i geometrię,
   * a potem odświeża podsumowanie dni.
   *
   * Powrót do bazy jest zawsze doliczany do czasu (kontroler musi wrócić),
   * ale rysowany na mapie tylko wtedy, gdy zaznaczono „Wlicz powrót do bazy".
   */
  function refreshRoute(route){
    var stations = routeStations(route);
    if(!stations.length){ return; }

    var basePoint = { lat: route.origin.lat, lng: route.origin.lng };
    var stationPoints = stations.map(function(station){
      return { lat: station.lat, lng: station.lng };
    });
    var withReturn = [basePoint].concat(stationPoints, [basePoint]);

    setStatus('Przeliczam trasę...');
    renderAll();

    fetchRouteGeometry(withReturn)
      .then(function(osrmRoute){
        if(!osrmRoute || !osrmRoute.legs){
          route.needsRecalc = true;
          setStatus('Nie udało się przeliczyć trasy — czasy mogą być nieaktualne.', true);
          renderAll();
          return;
        }

        var legs = osrmRoute.legs.map(function(leg){ return leg.duration / 60; });
        route.legsMin = legs.slice(0, stations.length);
        route.returnMin = legs[legs.length - 1];
        route.needsRecalc = false;

        if(route.roundtrip){
          route.geometry = osrmRoute.geometry;
          route.totalDist = osrmRoute.distance;
          applyDaySummary(route);
          setStatus('Trasa przeliczona.');
          renderAll();
          return;
        }

        // Bez powrotu rysujemy tylko drogę do ostatniej stacji.
        return fetchRouteGeometry([basePoint].concat(stationPoints)).then(function(oneWay){
          if(oneWay){
            route.geometry = oneWay.geometry;
            route.totalDist = oneWay.distance;
          }
          applyDaySummary(route);
          setStatus('Trasa przeliczona.');
          renderAll();
        });
      })
      .catch(function(err){
        console.error('Błąd przeliczania trasy:', err);
        route.needsRecalc = true;
        setStatus('Nie udało się przeliczyć trasy — czasy mogą być nieaktualne.', true);
        renderAll();
      });
  }

  /** Aktualizuje obciążenie dni i zapamiętuje przekroczenia norm. */
  function applyDaySummary(route){
    var summary = RouteEngine.summarizeDays(
      route.legsMin || [], CONFIG.AUDIT_MIN, route.dayBreak, route.days, route.returnMin
    );

    route.dayTotals = summary.dayTotals;
    route.totalMin = summary.totalMin;
    route.overLimitDays = summary.overLimitDays;
    route.overBudget = summary.overBudget;
  }

  /* =========================================================================
     14. RENDER: MAPA
     ========================================================================= */

  function pinIcon(label, variant){
    return L.divIcon({
      className: '',
      html: '<div class="marker-pin' + (variant ? ' ' + variant : '') + '">' +
        '<span>' + escapeHtml(label) + '</span></div>',
      iconSize: [24, 24],
      iconAnchor: [12, 24]
    });
  }

  /** Nazwa bazy do dymka na mapie; obsługuje też trasy zapisane starszą wersją. */
  function baseNameFor(origin){
    var base = CONFIG.BASES.filter(function(item){ return item.id === origin.baseId; })[0];
    return base ? ('Baza: ' + base.name) : 'Punkt bazowy';
  }

  function stationPopup(station){
    return '<strong>' + escapeHtml(station.name) + '</strong><br>' +
      '<span style="color:#5b5f66;font-size:12px">' + escapeHtml(station.address || '') + '</span>';
  }

  function renderMap(){
    markersLayer.clearLayers();
    routeLayer.clearLayers();

    var route = activeRoute();

    // Bez wybranej trasy pokazujemy wszystkie stacje jako nienumerowane pinezki.
    if(!route){
      state.stations.forEach(function(station){
        markersLayer.addLayer(
          L.marker([station.lat, station.lng], { icon: pinIcon('', '') })
            .bindPopup(stationPopup(station))
        );
      });
      return;
    }

    if(route.origin){
      markersLayer.addLayer(
        L.marker([route.origin.lat, route.origin.lng], { icon: pinIcon('B', 'base') })
          .bindPopup(baseNameFor(route.origin))
      );
    }

    var stations = routeStations(route);
    stations.forEach(function(station, idx){
      markersLayer.addLayer(
        L.marker([station.lat, station.lng], {
          icon: pinIcon(String(idx + 1), idx === 0 ? 'start' : '')
        }).bindPopup(stationPopup(station))
      );
    });

    if(route.geometry){
      var latlngs = route.geometry.coordinates.map(function(coord){ return [coord[1], coord[0]]; });
      var line = L.polyline(latlngs, {
        color: CONFIG.ROUTE_COLOR, weight: 3.5, opacity: 0.85
      }).addTo(routeLayer);
      map.fitBounds(line.getBounds(), { padding: CONFIG.MAP_PADDING });
    } else if(stations.length){
      var bounds = L.latLngBounds(stations.map(function(station){
        return [station.lat, station.lng];
      }));
      map.fitBounds(bounds, { padding: CONFIG.MAP_PADDING });
    }
  }

  /* =========================================================================
     15. RENDER: MANIFEST
     ========================================================================= */

  function dayOfStop(route, idx){
    return Math.min((route.dayBreak && route.dayBreak[idx]) || 1, route.days || 1);
  }

  function renderManifest(){
    var list = el('manifestList');
    var summary = el('manifestSummary');
    var empty = el('manifestEmpty');
    var exportBtn = el('exportBtn');

    list.innerHTML = '';
    var route = activeRoute();

    if(!route){
      summary.classList.remove('show');
      empty.hidden = false;
      exportBtn.disabled = true;
      return;
    }

    empty.hidden = true;
    summary.classList.add('show');
    exportBtn.disabled = false;

    var stations = routeStations(route);
    var visited = stations.filter(function(station){ return station.visited; }).length;

    el('sumDist').textContent = fmtDist(route.totalDist);
    el('sumTime').textContent = fmtMin(route.totalMin);
    el('sumVisited').textContent = visited + '/' + stations.length;

    if(route.overBudget || (route.overLimitDays || []).length){
      var warning = document.createElement('p');
      warning.className = 'route-warning';
      warning.textContent = (route.overLimitDays || []).length
        ? 'Po zmianach dzień ' + route.overLimitDays.join(', ') + ' przekracza limit ' +
          (RouteEngine.MAX_DAY_MIN / 60) + ' godz.'
        : 'Po zmianach trasa przekracza budżet ' + route.days + '-dniowej delegacji.';
      list.appendChild(warning);
    }

    if(route.needsRecalc){
      var stale = document.createElement('p');
      stale.className = 'route-warning';
      stale.textContent = 'Czasy przejazdu mogą być nieaktualne — nie udało się połączyć z serwerem tras.';
      list.appendChild(stale);
    }

    var lastDay = 0;
    stations.forEach(function(station, idx){
      var day = dayOfStop(route, idx);
      if(day !== lastDay){
        list.appendChild(buildDayHeader(route, day));
        lastDay = day;
      }
      list.appendChild(buildTicket(route, station, idx));
    });
  }

  /**
   * Nagłówek dnia z jego obciążeniem. Dzień ponad normę jest oznaczany —
   * ręczna edycja może wypchnąć plan poza limit czasu pracy i planista
   * musi to zobaczyć od razu.
   */
  function buildDayHeader(route, day){
    var header = document.createElement('div');
    header.className = 'day-header';

    var label = document.createElement('span');
    label.textContent = 'Dzień ' + day;
    header.appendChild(label);

    var totals = route.dayTotals;
    if(totals && totals[day - 1] !== undefined){
      var overLimit = (route.overLimitDays || []).indexOf(day) !== -1;

      var load = document.createElement('span');
      load.className = 'day-load' + (overLimit ? ' over' : '');
      load.textContent = fmtMin(totals[day - 1]);
      if(overLimit){
        load.title = 'Przekroczony limit ' + (RouteEngine.MAX_DAY_MIN / 60) + ' godz dla jednego dnia';
        load.textContent += ' — ponad normę';
      }
      header.appendChild(load);
    }

    return header;
  }

  /** Przycisk edycji przystanku (przesuń / usuń). */
  function buildStopButton(label, ariaLabel, svgPath, onClick){
    var button = document.createElement('button');
    button.className = 'stop-edit-btn';
    button.title = label;
    button.setAttribute('aria-label', ariaLabel);
    button.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" ' +
      'stroke-width="2" aria-hidden="true">' + svgPath + '</svg>';
    button.addEventListener('click', onClick);
    return button;
  }

  function buildStopControls(route, station, idx){
    var controls = document.createElement('div');
    controls.className = 'stop-controls';

    controls.appendChild(buildStopButton(
      'Wcześniej / poprzedni dzień',
      'Przesuń stację ' + station.name + ' wcześniej',
      '<path d="M18 15l-6-6-6 6"/>',
      function(){ moveStop(route, idx, -1); }
    ));

    controls.appendChild(buildStopButton(
      'Później / następny dzień',
      'Przesuń stację ' + station.name + ' później',
      '<path d="M6 9l6 6 6-6"/>',
      function(){ moveStop(route, idx, 1); }
    ));

    controls.appendChild(buildStopButton(
      'Usuń z trasy',
      'Usuń stację ' + station.name + ' z trasy',
      '<path d="M18 6L6 18M6 6l12 12"/>',
      function(){ removeStop(route, idx); }
    ));

    return controls;
  }

  function buildTicket(route, station, idx){
    var ticket = document.createElement('li');
    ticket.className = 'ticket' + (station.visited ? ' visited' : '');

    var top = document.createElement('div');
    top.className = 'ticket-top';

    var text = document.createElement('div');

    var number = document.createElement('div');
    number.className = 'ticket-num';
    number.textContent = 'Nr ' + String(idx + 1).padStart(2, '0') +
      (idx === 0 ? ' — START' : '') + '  •  waga ' + station.risk;

    var name = document.createElement('div');
    name.className = 'ticket-name';
    name.textContent = station.name;

    text.appendChild(number);
    text.appendChild(name);

    var stamp = document.createElement('button');
    stamp.className = 'stamp-btn' + (station.visited ? ' on' : '');
    stamp.title = 'Oznacz jako skontrolowaną';
    stamp.setAttribute('aria-label', 'Oznacz stację ' + station.name + ' jako skontrolowaną');
    stamp.setAttribute('aria-pressed', station.visited ? 'true' : 'false');
    stamp.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" ' +
      'stroke-width="2" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';
    stamp.addEventListener('click', function(){
      station.visited = !station.visited;
      saveState();
      renderManifest();
    });

    var actions = document.createElement('div');
    actions.className = 'ticket-actions';
    actions.appendChild(buildStopControls(route, station, idx));
    actions.appendChild(stamp);

    top.appendChild(text);
    top.appendChild(actions);
    ticket.appendChild(top);

    if(route.legsMin && route.legsMin[idx] !== undefined){
      var leg = document.createElement('div');
      leg.className = 'ticket-leg';
      leg.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" ' +
        'stroke-width="1.8" aria-hidden="true"><circle cx="6" cy="19" r="2"/>' +
        '<circle cx="18" cy="5" r="2"/>' +
        '<path d="M8 19h7a3 3 0 0 0 3-3v-1a3 3 0 0 0-3-3H9a3 3 0 0 1-3-3V8"/></svg>' +
        '<span>' + fmtMin(route.legsMin[idx]) + ' dojazdu</span>';
      ticket.appendChild(leg);
    }

    return ticket;
  }

  /* =========================================================================
     16. EKSPORT CSV
     ========================================================================= */

  var CSV_HEADER = [
    'dzien', 'nr', 'nazwa', 'adres', 'szerokosc', 'dlugosc',
    'waga_ryzyka', 'dojazd_min', 'skontrolowano'
  ];

  function toCsv(rows){
    return rows.map(function(row){
      return row.map(function(cell){
        return '"' + String(cell).replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\n');
  }

  function handleExportCsv(){
    var route = activeRoute();
    if(!route){ return; }

    var rows = [CSV_HEADER];
    routeStations(route).forEach(function(station, idx){
      var legMin = route.legsMin && route.legsMin[idx] !== undefined
        ? Math.round(route.legsMin[idx])
        : 0;

      rows.push([
        dayOfStop(route, idx),
        idx + 1,
        station.name,
        station.address || '',
        station.lat,
        station.lng,
        station.risk,
        legMin,
        station.visited ? 'tak' : 'nie'
      ]);
    });

    var blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, route.name.replace(/\s+/g, '_') + '.csv');
  }

  /* =========================================================================
     17. START
     ========================================================================= */

  /** Jedyne miejsce, w którym stan trafia na ekran i na dysk. */
  function renderAll(){
    saveState();
    renderStopList();
    renderRouteSelect();
    renderMap();
    renderManifest();
  }

  function bindEvents(){
    el('auditorsInput').addEventListener('input', renderAuditorInputs);
    el('auditorsInput').addEventListener('change', renderAuditorInputs);

    el('excelInput').addEventListener('change', handleFileSelected);
    el('hasHeaderChk').addEventListener('change', function(){
      if(pendingImport){ renderColumnMapping(pendingImport.rows); }
    });
    el('confirmImportBtn').addEventListener('click', confirmImport);

    el('buildBtn').addEventListener('click', handleBuildPlan);
    el('cancelBuildBtn').addEventListener('click', showManifestPanel);

    el('routeSelect').addEventListener('change', handleRouteSelected);
    el('deleteRouteBtn').addEventListener('click', handleDeleteRoute);

    el('newProjectBtn').addEventListener('click', handleNewProject);
    el('saveProjectBtn').addEventListener('click', handleSaveProject);
    el('loadProjectBtn').addEventListener('click', function(){ el('loadProjectInput').click(); });
    el('loadProjectInput').addEventListener('change', handleLoadProjectFile);

    el('exportBtn').addEventListener('click', handleExportCsv);
  }

  function init(){
    initMap();
    loadState();
    bindEvents();
    renderAuditorInputs();
    renderAll();

    if(pendingMergeNote){ setStatus(pendingMergeNote); }
  }

  /* =========================================================================
     18. WEJŚCIE DLA TESTÓW

     Czyste funkcje udostępniane stronie test.html. Nie są używane przez samą
     aplikację — służą wyłącznie do sprawdzenia, czy logika działa poprawnie
     po zmianach w kodzie.
     ========================================================================= */

  window.ObchodInternals = {
    CONFIG: CONFIG,
    assignStationsToAuditors: assignStationsToAuditors,
    normalizeRouteDays: normalizeRouteDays,
    createStationsFromDb: createStationsFromDb,
    mergeStationsWithDb: mergeStationsWithDb,
    describeMergeStats: describeMergeStats,
    normalizeStationNo: normalizeStationNo,
    extractStationNo: extractStationNo,
    buildGeocodeQuery: buildGeocodeQuery,
    guessRole: guessRole,
    columnOf: columnOf,
    parseNumber: parseNumber,
    fmtDist: fmtDist,
    fmtMin: fmtMin,
    toCsv: toCsv,
    toOsrmCoords: toOsrmCoords
  };

  // Aplikacja startuje tylko wtedy, gdy na stronie jest jej interfejs.
  // Dzięki temu ten sam plik można wczytać w test.html — testy dostają
  // funkcje przez ObchodInternals, a UI się nie uruchamia.
  if(document.getElementById('app')){
    init();
  }
})();
