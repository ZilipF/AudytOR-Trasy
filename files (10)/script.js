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
      { id: 'gda', name: 'Gdańsk',   lat: 54.3520, lng: 18.6466 },
      { id: 'nww', name: 'Nowa Wieś Wielka', lat: 52.9703, lng: 18.0914 }
    ],

    // --- Usługi zewnętrzne ---
    // UWAGA: to publiczne serwery demonstracyjne. Nie mają SLA i nie nadają
    // się do pracy produkcyjnej — przed wdrożeniem podmienić na własne.
    OSRM_URL: 'https://router.project-osrm.org',
    NOMINATIM_URL: 'https://nominatim.openstreetmap.org',
    TILE_URL: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    TILE_ATTRIBUTION: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',

    // Czystsza, jaśniejsza mapa (same drogi, bez etykiet/POI) — CARTO Positron,
    // styl "light_nolabels". Od sierpnia 2026 wymaga darmowego klucza API
    // (bez karty, natychmiastowo): https://carto.com/basemaps/apikey
    // Po otrzymaniu klucza wklej go poniżej (i tylko wtedy — bez klucza
    // przełącznik "Czysta mapa" w UI zostaje wyłączony, żeby nie pokazywać
    // kafelków z wodnym znakiem "API KEY REQUIRED").
    // Formularz pyta o e-mail, domenę i krótki opis; limit darmowy to
    // 5 mln kafelków/mies. — z ogromnym zapasem dla jednego planisty.
    CLEAN_TILE_API_KEY: '', // np. 'pk.xxxxxxxxxxxxxxxxx'
    CLEAN_TILE_URL: 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png',
    CLEAN_TILE_ATTRIBUTION: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/about-carto/">CARTO</a>',

    // Polityka Nominatim dopuszcza maks. 1 zapytanie na sekundę.
    // Szybsze odpytywanie grozi zablokowaniem adresu IP przez OSM.
    GEOCODE_DELAY_MS: 1100,

    // Publiczny router.project-osrm.org dławi równoległe połączenia z tego
    // samego adresu IP — kilka jednoczesnych zapytań /table lub /route (np.
    // przy audytorach z różnych baz, budowanych naraz) kończy się błędem,
    // mimo że każde z osobna by przeszło. Zapytania do OSRM wysyłamy więc
    // po kolei, z tym odstępem między nimi (patrz runSequentially niżej).
    OSRM_REQUEST_DELAY_MS: 350,
    OSRM_RETRY_COUNT: 2,     // ile razy ponowić /table po błędzie (np. chwilowym 429)
    OSRM_RETRY_DELAY_MS: 900,

    // --- Parametry planowania ---
    AUDIT_MIN: 120,              // czas jednego audytu w minutach
    PLAN_DAY_OPTIONS: [1, 2, 3], // warianty długości delegacji do wygenerowania
    MAX_AUDITORS: 20,
    MAX_STATIONS_PER_AUDITOR: 80,
    MAX_STATIONS_TOTAL: 300,
    // Twardy, zmierzony limit publicznego router.project-osrm.org dla
    // zapytania /table: 100 punktów przechodzi, 101 już nie — potwierdzone
    // bezpośrednim testem (curl) 2026-09-01, komunikat serwera to dokładnie
    // "Too many table coordinates" (kod "TooBig"). Ten limit dotyczy JEDNEGO
    // zapytania, czyli jednej bazy naraz (origin + jej stacje) — nie sumy
    // wszystkich audytorów. MAX_STATIONS_PER_AUDITOR/MAX_STATIONS_TOTAL wyżej
    // ograniczają całą pulę PRZED podziałem na bazy, więc same w sobie NIE
    // chronią przed tym limitem, gdy jedna baza dostanie nieproporcjonalnie
    // dużo stacji (patrz assignStationsToAuditors). Margines 5 poniżej
    // realnego limitu 100 (czyli maks. 94 stacje + 1 baza = 95 punktów) na
    // wypadek, gdyby serwer kiedyś nieznacznie zmienił próg.
    MAX_STATIONS_PER_OSRM_REQUEST: 95,
    MAX_SEARCH_RESULTS: 200, // ochrona listy przed setkami wyników przy krótkim zapytaniu

    // --- Mapa ---
    MAP_CENTER: [52.0693, 19.4803],
    MAP_ZOOM: 6.3,
    MAP_MAX_ZOOM: 19,
    MAP_PADDING: [40, 40],
    ROUTE_COLOR: '#d81324'
  };

  /**
   * Domyślne parametry budowy tras — używane wprost w trybie prostym
   * i jako wartości startowe w trybie rozszerzonym (patrz sekcja 6b:
   * PANEL: PARAMETRY BUDOWY TRAS). AUDIT_MIN i PLAN_DAY_OPTIONS pochodzą
   * z CONFIG powyżej; reguły dnia pracy pochodzą z route-engine.js, żeby
   * nie trzymać tych samych liczb w dwóch miejscach.
   */
  var PLANNING_DEFAULTS = (function(){
    var engineDefaults = window.RouteEngine ? window.RouteEngine.getDefaultRules() : {
      baseDayMin: 8 * 60, maxDayMin: 11 * 60, breakMin: 60, multidayMinKm: 100
    };
    return {
      auditMin: CONFIG.AUDIT_MIN,
      dayOptions: CONFIG.PLAN_DAY_OPTIONS.slice(),
      baseDayMin: engineDefaults.baseDayMin,
      maxDayMin: engineDefaults.maxDayMin,
      breakMin: engineDefaults.breakMin,
      multidayMinKm: engineDefaults.multidayMinKm
    };
  })();

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
    if(!point || !isValidLat(point.lat) || !isValidLng(point.lng)){ return false; }
    // (0,0) leży na Atlantyku, nigdy nie jest prawdziwą stacją w Polsce —
    // to typowy efekt nieudanego geokodowania adresu (Nominatim albo błędny
    // wiersz w danych), nie realna lokalizacja. Odrzucamy, zanim taka
    // "stacja" trafi do zapytania OSRM.
    if(point.lat === 0 && point.lng === 0){ return false; }
    return true;
  }

  /**
   * Klasa CSS dla koloru wg grupy stacji (CODO/DOFO) — używana i w liście,
   * i na mapie (patrz .marker-pin.dofo / .group-dot.dofo w styles.css).
   * Pusty string = domyślny kolor (CODO i grupy nierozpoznane).
   */
  function stationGroupClass(station){
    var group = String((station && station.group) || '').toUpperCase();
    return group.indexOf('DOFO') !== -1 ? 'dofo' : 'codo';
  }

  /**
   * Wariant pinezki na mapie: zielony ("visited"), jeśli stacja jest
   * oznaczona jako skontrolowana — niezależnie od grupy CODO/DOFO i od
   * tego, czy to pierwszy przystanek trasy ("start"). Zielony ma pierwszeństwo
   * wszędzie, bo to najważniejsza informacja dla planera dobierającego
   * stacje ręcznie: "to już jest zrobione, nie dokładaj". @param fallback
   * wariant używany, gdy stacja NIE jest skontrolowana (np. 'start' albo
   * wynik stationGroupClass()).
   */
  function pinVariantFor(station, fallback){
    return station.visited ? 'visited' : fallback;
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

  /**
   * Poprawna polska odmiana liczebnika w opisach tras (1 trasa, 2 trasy, 5 tras...).
   * forms = [liczba pojedyncza, 2-4, pozostałe] np. ['stacja', 'stacje', 'stacji'].
   */
  function pluralPL(n, forms){
    var count = Math.abs(n);
    if(count === 1){ return forms[0]; }
    var mod10 = count % 10;
    var mod100 = count % 100;
    if(mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)){ return forms[1]; }
    return forms[2];
  }

  function fmtCount(n, forms){
    return n + ' ' + pluralPL(n, forms);
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
  var stationSearchQuery = ''; // treść pola wyszukiwania listy stacji (sesja, nie stan)
  var mapGroupFilter = 'all';  // filtr widoku mapy: 'all' | 'codo' | 'dofo' (sesja, nie stan)

  // Nawigacja propozycje ↔ manifest (sesja, nie zapisywane w state/projekcie):
  // lastPlans        — ostatnio wygenerowane warianty, do ponownego pokazania,
  // lastPlanRouteIds — id tras utworzonych z lastPlans, do cofnięcia wyboru.
  var lastPlans = [];
  var lastPlanRouteIds = [];
  // Który wariant długości (dni) jest aktualnie wybrany dla każdego audytora
  // w propozycjach — klucz to auditorName. Resetowane przy każdym nowym
  // budowaniu (patrz handleBuildPlan). Patrz sekcja 12b (PROPOZYCJE PER AUDYTOR).
  var auditorPlanSelections = {};
  // Trasa aktualnie oglądana w propozycjach (jeszcze nie zatwierdzona) —
  // gdy ustawiona, renderMap() rysuje ją zamiast normalnego widoku, żeby
  // dało się zobaczyć wariant na mapie przed kliknięciem "Zatwierdź".
  var previewedProposalRoute = null;
  // Wybrany audytor w panelu "Trasy audytora" (sesja, nie stan — jak filtr
  // grup na mapie). Puste = nic nie wybrano, panel pokazuje tylko selektor.
  var auditorRouteFilter = '';
  // Id stacji aktualnie przeciąganej w manifeście (patrz moveStationTo,
  // renderManifest) — sesja, nie stan.
  var draggedStationId = null;

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
  /**
   * Stacje, które warto rozważyć przy budowaniu trasy: mają wagę ryzyka,
   * są wolne (nieprzypisane do żadnej trasy) i NIE są już oznaczone jako
   * skontrolowane. To ostatnie daje checkboxowi „Oznacz jako skontrolowaną"
   * realne znaczenie — zaznaczona stacja nie wraca automatycznie do puli,
   * dopóki planer sam jej nie odznaczy albo ręcznie nie doda do trasy.
   */
  function plannableStations(){
    return state.stations.filter(function(station){
      return station.status === 'free' && station.risk > 0 && !station.visited;
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
  var osmTileLayer = null;
  var cleanTileLayer = null; // tylko gdy CONFIG.CLEAN_TILE_API_KEY jest ustawiony
  var mapCleanMode = false;  // "Czysta mapa" — sesja, nie stan

  function initMap(){
    map = L.map('map', { zoomControl: true }).setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);

    osmTileLayer = L.tileLayer(CONFIG.TILE_URL, {
      attribution: CONFIG.TILE_ATTRIBUTION,
      maxZoom: CONFIG.MAP_MAX_ZOOM
    }).addTo(map);

    // Kafelki CARTO Positron (same drogi, bez etykiet) tworzymy tylko, jeśli
    // w CONFIG.CLEAN_TILE_API_KEY jest wpisany klucz — bez niego CARTO
    // zwraca kafelki z wodnym znakiem "API KEY REQUIRED", więc lepiej ich
    // w ogóle nie ładować (patrz handleMapCleanToggle: bez klucza "Czysta
    // mapa" tylko odbarwia istniejące kafelki OSM przez CSS).
    if(CONFIG.CLEAN_TILE_API_KEY){
      cleanTileLayer = L.tileLayer(
        CONFIG.CLEAN_TILE_URL + '?api_key=' + encodeURIComponent(CONFIG.CLEAN_TILE_API_KEY),
        { attribution: CONFIG.CLEAN_TILE_ATTRIBUTION, maxZoom: CONFIG.MAP_MAX_ZOOM }
      );
    }

    markersLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);

    // Domyślnie w Leaflet znaczniki (markerPane, z-index 600) zawsze
    // rysują się NAD liniami (overlayPane, z-index 400) — bez względu na
    // kolejność dodania do mapy. Żeby trasa była zawsze widoczna nad
    // pinezkami, potrzebuje własnej warstwy z wyższym z-index niż markerPane.
    map.createPane('routeLinePane');
    map.getPane('routeLinePane').style.zIndex = 650;
  }

  /**
   * Przełącznik "Czysta mapa": z kluczem CARTO w CONFIG podmienia całą
   * warstwę kafelków na Positron bez etykiet (prawdziwe "same drogi");
   * bez klucza tylko odbarwia obecne kafelki OSM przez CSS filter — mniej
   * dokładne, ale działa od razu, bez żadnej rejestracji.
   */
  function applyMapCleanMode(){
    var btn = el('mapCleanToggle');
    btn.classList.toggle('active', mapCleanMode);
    btn.setAttribute('aria-pressed', mapCleanMode ? 'true' : 'false');

    if(cleanTileLayer){
      if(mapCleanMode){
        if(map.hasLayer(osmTileLayer)){ map.removeLayer(osmTileLayer); }
        if(!map.hasLayer(cleanTileLayer)){ cleanTileLayer.addTo(map); }
      } else {
        if(map.hasLayer(cleanTileLayer)){ map.removeLayer(cleanTileLayer); }
        if(!map.hasLayer(osmTileLayer)){ osmTileLayer.addTo(map); }
      }
    } else {
      el('map').classList.toggle('clean-filter', mapCleanMode);
    }
  }

  function handleMapCleanToggle(){
    mapCleanMode = !mapCleanMode;
    applyMapCleanMode();
  }

  /* =========================================================================
     5. USŁUGI SIECIOWE
     ========================================================================= */

  /** Zamienia listę punktów na format współrzędnych OSRM: "lng,lat;lng,lat". */
  function toOsrmCoords(points){
    return points.map(function(point){ return point.lng + ',' + point.lat; }).join(';');
  }

  /**
   * Wykonuje zadania asynchroniczne jedno po drugim (nie równolegle), z odstępem
   * między nimi — chroni publiczny serwer OSRM przed kilkoma jednoczesnymi
   * połączeniami (patrz komentarz przy OSRM_REQUEST_DELAY_MS w CONFIG).
   * Kolejność wyników odpowiada kolejności `items`, tak jak przy Promise.all.
   */
  function runSequentially(items, taskFn, delayMs){
    var results = new Array(items.length);

    return items.reduce(function(chain, item, idx){
      return chain
        .then(function(){ return taskFn(item, idx); })
        .then(function(result){
          results[idx] = result;
          if(idx < items.length - 1 && delayMs){
            return new Promise(function(resolve){ setTimeout(resolve, delayMs); });
          }
        });
    }, Promise.resolve()).then(function(){ return results; });
  }

  /** Ponawia zadanie po błędzie (np. chwilowe 429 z publicznego OSRM), z odstępem. */
  function withRetry(taskFn, retries, delayMs){
    return taskFn().catch(function(err){
      if(retries <= 0){ throw err; }
      return new Promise(function(resolve){ setTimeout(resolve, delayMs); })
        .then(function(){ return withRetry(taskFn, retries - 1, delayMs); });
    });
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

  /**
   * Macierz czasów i dystansów między punktami (OSRM /table).
   * Ponawia próbę po błędzie (OSRM_RETRY_COUNT razy) — na wypadek chwilowego
   * dławienia przez publiczny serwer demo, patrz komentarz przy CONFIG.OSRM_REQUEST_DELAY_MS.
   */
  function fetchDistanceMatrix(points){
    function attempt(){
      var url = CONFIG.OSRM_URL + '/table/v1/driving/' + toOsrmCoords(points) +
        '?annotations=duration,distance';

      return fetch(url)
        .then(function(response){
          if(!response.ok){
            // OSRM zwykle odsyła treścią błędu dokładny powód (np. "Number of
            // coordinates needs to be at least two" albo "URL string malformed").
            // Pokazujemy go od razu — bez tego zostaje tylko sam kod HTTP, co
            // przy diagnozowaniu problemu wymaga dodatkowej rundy w konsoli.
            return response.json().catch(function(){ return null; }).then(function(body){
              var detail = body && (body.message || body.code);
              throw new Error('Błąd OSRM (HTTP ' + response.status + ')' + (detail ? ': ' + detail : ''));
            });
          }
          return response.json();
        })
        .then(function(data){
          if(data.code !== 'Ok'){
            throw new Error('Serwer OSRM nie zwrócił macierzy odległości (' + data.code + ').');
          }
          if(!data.durations || !data.distances){
            throw new Error('Brak danych macierzy.');
          }
          return data;
        });
    }

    return withRetry(attempt, CONFIG.OSRM_RETRY_COUNT, CONFIG.OSRM_RETRY_DELAY_MS)
      .catch(function(err){
        console.error('Błąd pobierania macierzy OSRM:', err);
        throw err;
      });
  }

  /**
   * Cache macierzy odległości na czas sesji (nie zapisywany, nie w projekcie).
   * Klucz to dokładne współrzędne punktów — dla tego samego zestawu bazy
   * i stacji wynik z OSRM zawsze jest identyczny, więc bezpiecznie go
   * ponownie użyć. Realnie oszczędza zapytania, gdy planista klika
   * „Zbuduj trasy" kilka razy z rzędu (np. dostrajając tryb rozszerzony)
   * bez zmiany zestawu stacji — mniej zapytań to mniejsze ryzyko błędu
   * publicznego serwera OSRM. Ograniczony rozmiarem, żeby nie rosnąć
   * bez końca w bardzo długiej sesji.
   */
  var distanceMatrixCache = {};
  var distanceMatrixCacheOrder = [];
  var DISTANCE_MATRIX_CACHE_MAX = 30;

  function distanceMatrixCacheKey(points){
    return points.map(function(point){
      return point.lat.toFixed(5) + ',' + point.lng.toFixed(5);
    }).join('|');
  }

  function clearDistanceMatrixCache(){
    distanceMatrixCache = {};
    distanceMatrixCacheOrder = [];
  }

  function fetchDistanceMatrixCached(points){
    var key = distanceMatrixCacheKey(points);
    if(distanceMatrixCache[key]){ return distanceMatrixCache[key]; }

    var promise = fetchDistanceMatrix(points).catch(function(err){
      // Błędu nie trzymamy w cache'u — następna próba ma prawo spróbować od nowa.
      delete distanceMatrixCache[key];
      distanceMatrixCacheOrder = distanceMatrixCacheOrder.filter(function(k){ return k !== key; });
      throw err;
    });

    distanceMatrixCache[key] = promise;
    distanceMatrixCacheOrder.push(key);
    if(distanceMatrixCacheOrder.length > DISTANCE_MATRIX_CACHE_MAX){
      delete distanceMatrixCache[distanceMatrixCacheOrder.shift()];
    }
    return promise;
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

  /** Odtwarza wiersze audytorów (nazwisko + baza wyjazdu), zachowując to,
      co użytkownik już wpisał i wybrał. */
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

  /** Lista audytorów: nazwisko plus przypisana baza. Każdy planuje osobną trasę. */
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
     6b. PANEL: PARAMETRY BUDOWY TRAS (tryb prosty / rozszerzony)

     Tryb prosty: parametry zaszyte na stałe (PLANNING_DEFAULTS) — dotychczasowe
     zachowanie aplikacji, bez zmian.
     Tryb rozszerzony: planista dostosowuje czas audytu, warianty długości
     delegacji i reguły dnia pracy. Nieprzesyłane do `state` — podobnie jak
     liczba audytorów, to ustawienie robocze na czas sesji, nie część projektu.
     ========================================================================= */

  var DAY_OPTION_VALUES = [1, 2, 3];

  function planMode(){
    var checked = document.querySelector('input[name="planMode"]:checked');
    return (checked && checked.value === 'extended') ? 'extended' : 'simple';
  }

  function getDayOptionCheckboxes(){
    return Array.prototype.slice.call(document.querySelectorAll('.dayOptChk'));
  }

  /** Odczytuje i waliduje pola trybu rozszerzonego; przy błędzie wraca do wartości domyślnej danego pola. */
  function readExtendedPlanningParams(){
    var warnings = [];

    function readNumber(id, min, max, fallback, label){
      var input = el(id);
      var value = parseNumber(input.value);
      if(!(typeof value === 'number' && !isNaN(value)) || value < min || value > max){
        warnings.push(label + ': nieprawidłowa wartość, użyto domyślnej.');
        value = fallback;
      }
      return value;
    }

    var auditMin = readNumber('auditMinInput', 1, 600, PLANNING_DEFAULTS.auditMin, 'Czas audytu');
    var baseDayMin = readNumber('baseDayHInput', 1, 24, PLANNING_DEFAULTS.baseDayMin / 60, 'Budżet dnia') * 60;
    var maxDayMin = readNumber('maxDayHInput', 1, 24, PLANNING_DEFAULTS.maxDayMin / 60, 'Twardy limit dnia') * 60;
    var breakMin = readNumber('breakMinInput', 0, 240, PLANNING_DEFAULTS.breakMin, 'Przerwa');
    var multidayMinKm = readNumber('multidayKmInput', 0, 2000, PLANNING_DEFAULTS.multidayMinKm, 'Próg wielodniowy');

    if(maxDayMin < baseDayMin){
      warnings.push('Twardy limit dnia nie może być niższy niż budżet dnia — dopasowano do budżetu.');
      maxDayMin = baseDayMin;
    }

    var dayOptions = getDayOptionCheckboxes()
      .filter(function(chk){ return chk.checked; })
      .map(function(chk){ return parseInt(chk.value, 10); });
    if(dayOptions.length === 0){
      warnings.push('Zaznacz co najmniej jeden wariant długości delegacji — użyto wariantu 1-dniowego.');
      dayOptions = [1];
    }

    return {
      params: {
        auditMin: auditMin,
        dayOptions: dayOptions,
        baseDayMin: baseDayMin,
        maxDayMin: maxDayMin,
        breakMin: breakMin,
        multidayMinKm: multidayMinKm
      },
      warnings: warnings
    };
  }

  /** Parametry aktualnie obowiązujące: sztywne w trybie prostym, z formularza w trybie rozszerzonym. */
  function getActivePlanningParams(){
    if(planMode() !== 'extended'){
      return { params: PLANNING_DEFAULTS, warnings: [] };
    }
    return readExtendedPlanningParams();
  }

  function fillPlanningInputsWithDefaults(){
    el('auditMinInput').value = PLANNING_DEFAULTS.auditMin;
    el('baseDayHInput').value = PLANNING_DEFAULTS.baseDayMin / 60;
    el('maxDayHInput').value = PLANNING_DEFAULTS.maxDayMin / 60;
    el('breakMinInput').value = PLANNING_DEFAULTS.breakMin;
    el('multidayKmInput').value = PLANNING_DEFAULTS.multidayMinKm;
    getDayOptionCheckboxes().forEach(function(chk){
      chk.checked = PLANNING_DEFAULTS.dayOptions.indexOf(parseInt(chk.value, 10)) !== -1;
    });
    el('planParamsWarning').textContent = '';
  }

  function updatePlanModeUI(){
    var extended = planMode() === 'extended';
    el('planExtendedFields').hidden = !extended;
    el('planModeHint').textContent = extended
      ? 'Reguły delegacji poniżej nie zostały potwierdzone z działem kadr ani prawnym — dostosuj je przed produkcyjnym użyciem.'
      : 'Limity czasu są ustalone automatycznie zgodnie z zasadami delegacji.';
  }

  function handlePlanModeChange(){
    updatePlanModeUI();
  }

  function handleResetPlanParams(){
    fillPlanningInputsWithDefaults();
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
      if(!hasValidCoords({ lat: lat, lng: lng })){
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
    var emptyText = el('emptyStateText');
    list.innerHTML = '';

    var query = stationSearchQuery.trim().toLowerCase();
    var visible, truncated = 0;

    if(query){
      // Wyszukiwanie przeszukuje WSZYSTKIE stacje (nie tylko te z nadaną wagą) —
      // dzięki temu można znaleźć i ręcznie dodać do trasy stację, która nie
      // trafiła do importu ryzyka.
      var matches = state.stations.filter(function(station){
        return (station.stationNo || '').toLowerCase().indexOf(query) !== -1 ||
          (station.name || '').toLowerCase().indexOf(query) !== -1;
      }).sort(function(a, b){ return b.risk - a.risk; });

      truncated = Math.max(0, matches.length - CONFIG.MAX_SEARCH_RESULTS);
      visible = matches.slice(0, CONFIG.MAX_SEARCH_RESULTS);
    } else {
      // Stacje bez wagi i bez przypisania nie niosą informacji — nie zaśmiecamy
      // nimi listy, bo baza ma prawie 2000 pozycji.
      visible = state.stations
        .filter(function(station){ return station.risk > 0 || station.status !== 'free'; })
        .sort(function(a, b){ return b.risk - a.risk; });
    }

    empty.hidden = visible.length > 0;
    if(visible.length === 0){
      emptyText.textContent = query
        ? 'Brak stacji pasujących do „' + stationSearchQuery.trim() + '”.'
        : 'Zaimportuj plik z numerami stacji i rankingiem ryzyka.';
    }

    visible.forEach(function(station, idx){
      list.appendChild(buildStopListItem(station, idx));
    });

    if(truncated > 0){
      var note = document.createElement('li');
      note.className = 'stop-list-note';
      note.textContent = 'Pokazano pierwsze ' + CONFIG.MAX_SEARCH_RESULTS + ' wyników — doprecyzuj wyszukiwanie, żeby zobaczyć pozostałe ' + truncated + '.';
      list.appendChild(note);
    }

    renderHeaderStats();
  }

  function handleStationSearch(){
    stationSearchQuery = el('stationSearchInput').value || '';
    renderStopList();
  }

  function buildStopListItem(station, idx){
    var item = document.createElement('li');

    var rank = document.createElement('span');
    rank.className = 'rk';
    rank.textContent = String(idx + 1).padStart(2, '0');

    var dot = document.createElement('span');
    dot.className = 'group-dot ' + stationGroupClass(station);
    dot.title = station.group || '';

    var name = document.createElement('span');
    name.className = 'nm';
    name.textContent = station.name;
    name.title = station.address;

    var isFree = station.status === 'free';
    var badge = document.createElement('span');
    badge.className = 'badge ' + (isFree ? 'free' : 'assigned');
    badge.textContent = isFree ? 'wolna' : (routeLabel(station.routeId) || 'w trasie');

    item.appendChild(rank);
    item.appendChild(dot);
    item.appendChild(name);
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

  /**
   * Lista unikalnych imion audytorów, którzy mają choć jedną zatwierdzoną
   * trasę w bieżącym projekcie — do wypełnienia filtra audytora w nagłówku.
   * Alfabetycznie, żeby łatwo było znaleźć konkretną osobę.
   */
  function getAuditorNames(){
    var names = [];
    state.routes.forEach(function(route){
      if(route.auditor && names.indexOf(route.auditor) === -1){ names.push(route.auditor); }
    });
    return names.sort(function(a, b){ return a.localeCompare(b, 'pl'); });
  }

  /** Data zatwierdzenia trasy, czytelnie. Starsze zapisane projekty mogą jej nie mieć. */
  function fmtDateTime(iso){
    if(!iso){ return '—'; }
    var d = new Date(iso);
    if(isNaN(d.getTime())){ return '—'; }
    var pad = function(n){ return String(n).padStart(2, '0'); };
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /**
   * Filtr audytora w nagłówku — zawęża listę tras obok ("wybierz trasę") do
   * jednej osoby, żeby dało się przejrzeć wszystkie jej trasy (nowe i starsze,
   * to po prostu wszystko, co jest w state.routes dla tego imienia — nie
   * osobne archiwum, patrz README "Dane tylko w przeglądarce") bez
   * przewijania pełnej listy wszystkich audytorów naraz.
   */
  function renderAuditorFilterSelect(){
    var select = el('auditorFilterSelect');
    var names = getAuditorNames();

    // Audytor mógł zniknąć z listy (usunięto jego jedyną trasę) — nie
    // zostawiamy filtra wskazującego donikąd.
    if(auditorRouteFilter && names.indexOf(auditorRouteFilter) === -1){
      auditorRouteFilter = '';
    }

    select.innerHTML = '<option value="">— wszyscy audytorzy —</option>';
    names.forEach(function(name){
      var option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });
    select.value = auditorRouteFilter;
    select.hidden = names.length === 0;
  }

  function handleAuditorFilterChange(){
    auditorRouteFilter = el('auditorFilterSelect').value;
    renderRouteSelect();
  }

  function renderRouteSelect(){
    renderAuditorFilterSelect();

    var select = el('routeSelect');
    select.innerHTML = '<option value="">— wybierz trasę —</option>';

    var routes = auditorRouteFilter
      ? state.routes.filter(function(route){ return route.auditor === auditorRouteFilter; })
      : state.routes;

    routes.forEach(function(route){
      var option = document.createElement('option');
      option.value = route.id;

      // route.name zawiera już imię audytora („Trasa 1 · Filip") — dopisujemy
      // je osobno tylko wtedy, gdy z jakiegoś powodu go tam nie ma (np. starszy
      // zapisany projekt), żeby nie powielać tej samej informacji dwa razy.
      // Data pomaga odróżnić kilka tras tej samej osoby z różnych dni.
      var auditorSuffix = (route.auditor && route.name.indexOf(route.auditor) === -1)
        ? ' — ' + route.auditor
        : '';

      option.textContent = route.name + auditorSuffix +
        ' (' + fmtCount(route.order.length, ['stacja', 'stacje', 'stacji']) + ', ' +
        fmtDateTime(route.createdAt) + ')';
      select.appendChild(option);
    });

    // Aktywna trasa mogła zostać odfiltrowana (np. wybrano innego audytora,
    // a aktywna trasa jest kogoś innego) — wtedy selektor po prostu pokazuje
    // pusty wybór, trasa w manifeście zostaje bez zmian aż do ręcznego wyboru.
    select.value = routes.some(function(r){ return r.id === state.activeRouteId; })
      ? state.activeRouteId
      : '';
  }

  /** Panel prawy pokazuje albo propozycje, albo manifest — nigdy oba naraz. */
  function showPanel(name){
    el('proposalsPanel').hidden = name !== 'proposals';
    el('manifestPanel').hidden = name !== 'manifest';
    // Opuszczenie propozycji porzuca podgląd na mapie — wracamy do
    // normalnego stanu (rzeczywista aktywna trasa albo cały przegląd stacji).
    if(name !== 'proposals'){ previewedProposalRoute = null; }
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
        // "Skontrolowana" to teraz trwała wiedza planera o stacji, nie
        // stan wyłącznie na czas trwania jednej trasy — usunięcie trasy
        // jej nie kasuje (patrz plannableStations i buildTicket).
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
    clearDistanceMatrixCache();
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

    // Jedna baza = jedno zapytanie /table do OSRM, a to ma twardy limit
    // liczby punktów (patrz CONFIG.MAX_STATIONS_PER_OSRM_REQUEST) — globalny
    // limit z handleBuildPlan ogranicza tylko CAŁĄ pulę przed podziałem na
    // bazy, więc bez tego jedna baza mogłaby i tak dostać ich za dużo, gdy
    // większość stacji wypadnie geograficznie bliżej niej niż innych baz.
    // group.stations jest już posortowane wg priorytetu (kolejność wejściowa
    // z handleBuildPlan), więc ucinamy od końca — zostają te najważniejsze.
    var trimmedTotal = 0;
    var maxPerBase = CONFIG.MAX_STATIONS_PER_OSRM_REQUEST - 1; // -1 na samą bazę jako punkt origin
    byBase.forEach(function(group){
      if(group.stations.length > maxPerBase){
        trimmedTotal += group.stations.length - maxPerBase;
        group.stations = group.stations.slice(0, maxPerBase);
      }
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

    // Doczepione do tablicy (nie zmienia jej zachowania jako Array — .length,
    // .map itd. działają normalnie), żeby handleBuildPlan mógł ostrzec
    // planistę bez zmiany kształtu zwracanej wartości.
    assignments.trimmedByOsrmLimit = trimmedTotal;

    return assignments;
  }

  /** Pobiera macierz odległości dla jednego zadania i opisuje je dla silnika. */
  /** Pobiera macierz odległości dla jednego zadania i opisuje je dla silnika. */
  function prepareAssignment(assignment){
    var points = [{ lat: assignment.origin.lat, lng: assignment.origin.lng }].concat(
      assignment.stations.map(function(station){
        return { lat: station.lat, lng: station.lng };
      })
    );

    return fetchDistanceMatrixCached(points).then(function(data){
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

  /**
   * Dla każdego wariantu długości delegacji buduje plan dla wszystkich audytorów.
   * @param {Array}  clusterResults
   * @param {object} params  { auditMin, dayOptions, ... } — patrz getActivePlanningParams()
   */
  function buildPlansForAllVariants(clusterResults, params){
    var plans = [];

    params.dayOptions.slice().sort(function(a, b){ return a - b; }).forEach(function(days){
      var routes = [];

      clusterResults.forEach(function(result){
        var route = RouteEngine.buildRouteForCluster(result, days, params.auditMin);
        if(route && route.orderedStations.length > 0){
          route.auditMin = params.auditMin;
          routes.push(route);
        }
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

    var planning = getActivePlanningParams();
    el('planParamsWarning').textContent = planning.warnings.join(' ');
    // Silnik pracuje na regułach dnia z tego wywołania aż do następnego —
    // w trybie prostym to zawsze PLANNING_DEFAULTS, więc zachowanie jest
    // identyczne jak przed wprowadzeniem trybu rozszerzonego.
    RouteEngine.configureRules({
      baseDayMin: planning.params.baseDayMin,
      maxDayMin: planning.params.maxDayMin,
      breakMin: planning.params.breakMin,
      multidayMinKm: planning.params.multidayMinKm
    });

    var auditors = getAuditorConfigs();

    // Ochrona wydajności (globalna, przed podziałem na bazy) — właściwy
    // limit na zapytanie do OSRM egzekwuje dopiero assignStationsToAuditors,
    // per baza (patrz CONFIG.MAX_STATIONS_PER_OSRM_REQUEST).
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
    if(assignments.trimmedByOsrmLimit > 0){
      capNote += ' Dodatkowo pominięto ' + assignments.trimmedByOsrmLimit +
        ' stacji przy jednej z baz — zbyt wiele naraz dla jednego zapytania do OSRM (limit ' +
        CONFIG.MAX_STATIONS_PER_OSRM_REQUEST + ').';
    }

    var button = el('buildBtn');
    button.disabled = true;
    button.textContent = 'Liczę...';
    setStatus('Buduję plan zespołowy...' +
      (assignments.length > 1 ? ' (' + assignments.length + ' baz, po kolei — chwilę to zajmie)' : ''));

    // Sekwencyjnie, nie Promise.all: przy audytorach z różnych baz kilka
    // równoległych zapytań do publicznego OSRM kończyło się błędem (patrz
    // CONFIG.OSRM_REQUEST_DELAY_MS).
    runSequentially(assignments, prepareAssignment, CONFIG.OSRM_REQUEST_DELAY_MS)
      .then(function(prepared){
        var plans = buildPlansForAllVariants(prepared, planning.params);

        // Nowe budowanie unieważnia możliwość cofnięcia do poprzednich
        // propozycji — te dotyczyły innego zestawu wolnych stacji. Reset
        // wyboru per audytor też, żeby nie zostać z wyborem dla kogoś, kto
        // już nie istnieje w nowym zestawie.
        lastPlans = plans;
        lastPlanRouteIds = [];
        auditorPlanSelections = {};
        previewedProposalRoute = null; // wymusza domyślny podgląd nowego zestawu

        var builtDays = plans.map(function(p){ return p.days; });
        var missingDays = planning.params.dayOptions.filter(function(d){
          return builtDays.indexOf(d) === -1;
        }).sort(function(a, b){ return a - b; });
        var missingNote = missingDays.length
          ? ' Pominięto warianty bez wykonalnej trasy (limit ' + (RouteEngine.MAX_DAY_MIN / 60) +
            ' godz/dzień dla wybranych stacji): ' + missingDays.map(function(d){
              return d + (d === 1 ? ' dzień' : ' dni');
            }).join(', ') + '.'
          : '';

        renderTeamPlans(plans);
        setStatus(
          (plans.length ? 'Wygenerowano plan zespołowy.' : 'Nie udało się wygenerować planu.') +
            capNote + missingNote,
          plans.length === 0 || skipped > 0 || missingDays.length > 0
        );
      })
      .catch(function(err){
        console.error(err);
        setStatus('Błąd przy budowaniu tras: ' + (err.message || err) +
          ' To publiczny serwer demo bez gwarancji dostępności — spróbuj ponownie za chwilę.', true);
        alert((err.message || 'Nie udało się zbudować propozycji tras.') +
          '\n\nTo publiczny serwer demo (router.project-osrm.org) bez SLA — czasem chwilowo odmawia. Spróbuj ponownie za kilka sekund.');
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

  /**
   * Grupuje warianty planu (plans, po dniach — z buildPlansForAllVariants)
   * wg audytora. Każdy audytor może mieć różną liczbę wariantów — nie
   * wszystkie długości muszą dać wykonalną trasę dla każdej osoby.
   */
  function groupPlansByAuditor(plans){
    var byAuditor = {};
    var order = [];

    plans.forEach(function(plan){
      plan.routes.forEach(function(route){
        if(!byAuditor[route.auditorName]){
          byAuditor[route.auditorName] = [];
          order.push(route.auditorName);
        }
        byAuditor[route.auditorName].push({ days: plan.days, route: route });
      });
    });

    return order.map(function(name){
      var variants = byAuditor[name].slice().sort(function(a, b){ return a.days - b.days; });
      return { auditorName: name, variants: variants };
    });
  }

  /** Wariant domyślnie zaznaczony dla audytora: ten z największą liczbą stacji. */
  function bestVariantFor(variants){
    return variants.reduce(function(best, variant){
      return variant.route.orderedStations.length > best.route.orderedStations.length ? variant : best;
    }, variants[0]);
  }

  /** Pokazuje na mapie wariant trasy z propozycji — jeszcze niezatwierdzony. */
  function showProposalPreview(route){
    previewedProposalRoute = route;
    renderMap();
  }

  function renderTeamPlans(plans){
    showPanel('proposals');

    var wrap = el('proposalCards');
    wrap.innerHTML = '';

    if(!plans || plans.length === 0){
      wrap.innerHTML = '<p class="empty-state">Nie udało się wygenerować planu zespołowego.</p>';
      el('commitSelectedBtn').hidden = true;
      previewedProposalRoute = null;
      renderMap();
      return;
    }

    el('commitSelectedBtn').hidden = false;

    var groups = groupPlansByAuditor(plans);
    groups.forEach(function(group){
      if(!(group.auditorName in auditorPlanSelections)){
        auditorPlanSelections[group.auditorName] = bestVariantFor(group.variants).days;
      }
      wrap.appendChild(buildAuditorProposalCard(group));
    });

    // Domyślny podgląd — pierwszy audytor, jego aktualnie wybrany wariant —
    // żeby mapa od razu pokazywała coś sensownego, zanim planista cokolwiek
    // kliknie, zamiast zostawać przy poprzednim widoku (albo pustym).
    if(groups.length > 0 && !previewedProposalRoute){
      var first = groups[0];
      var selected = first.variants.filter(function(v){
        return v.days === auditorPlanSelections[first.auditorName];
      })[0] || bestVariantFor(first.variants);
      showProposalPreview(selected.route);
    }
  }

  /**
   * Karta jednego audytora z przyciskami-wariantami (1/2/3 dni — ile ich
   * faktycznie wyszło). Klik zaznacza wariant dla TEGO audytora, niezależnie
   * od wyborów innych — to jest właśnie zamiana grupowania "wg dni" na
   * "wg osoby", żeby każdy mógł dostać długość dopasowaną do siebie.
   */
  function buildAuditorProposalCard(group){
    var card = document.createElement('div');
    card.className = 'proposal-card auditor-proposal-card';

    var selectedDays = auditorPlanSelections[group.auditorName];
    var selectedVariant = group.variants.filter(function(v){ return v.days === selectedDays; })[0] ||
      group.variants[0];

    var head = document.createElement('div');
    head.className = 'proposal-head';
    head.innerHTML = '<h3>' + escapeHtml(group.auditorName) + '</h3>' +
      '<span>' + fmtCount(selectedVariant.route.orderedStations.length, ['stacja', 'stacje', 'stacji']) + '</span>';
    card.appendChild(head);

    var stats = document.createElement('div');
    stats.className = 'proposal-stats';
    stats.innerHTML =
      '<div class="pstat"><b>' + fmtDist(selectedVariant.route.totalDist) + '</b>dystans</div>' +
      '<div class="pstat"><b>' + fmtMin(selectedVariant.route.totalMin) + '</b>czas</div>';
    card.appendChild(stats);

    var row = document.createElement('div');
    row.className = 'auditor-variant-row';

    group.variants.forEach(function(variant){
      var btn = document.createElement('button');
      btn.type = 'button';
      var isSelected = variant.days === selectedVariant.days;
      btn.className = 'auditor-variant-btn' + (isSelected ? ' selected' : '');
      var dayWord = variant.days === 1 ? 'dzień' : 'dni';
      btn.innerHTML = '<b>' + variant.days + ' ' + dayWord + '</b>' +
        '<span>' + fmtCount(variant.route.orderedStations.length, ['stacja', 'stacje', 'stacji']) + '</span>' +
        '<span>' + fmtMin(variant.route.totalMin) + '</span>';
      btn.addEventListener('click', function(){
        auditorPlanSelections[group.auditorName] = variant.days;
        showProposalPreview(variant.route);
        renderTeamPlans(lastPlans);
      });
      row.appendChild(btn);
    });

    card.appendChild(row);
    return card;
  }

  /* =========================================================================
     13. ZATWIERDZENIE PLANU
     ========================================================================= */

  /** Zbiera aktualnie wybrany wariant KAŻDEGO audytora i zatwierdza je razem. */
  function handleCommitSelectedPlans(){
    var groups = groupPlansByAuditor(lastPlans);
    if(groups.length === 0){ return; }

    var routesToCommit = groups.map(function(group){
      var selectedDays = auditorPlanSelections[group.auditorName];
      var variant = group.variants.filter(function(v){ return v.days === selectedDays; })[0] ||
        bestVariantFor(group.variants);
      return variant.route;
    });

    commitPlannedRoutes(routesToCommit);
  }

  /**
   * Zapisuje wybrane trasy jako trasy w stanie aplikacji i dociąga geometrię
   * przejazdu do rysowania na mapie. Panel przełącza się dopiero po powrocie
   * wszystkich zapytań, żeby mapa nie mrugała częściowym wynikiem.
   * @param {Array} plannedRoutes lista tras do zapisania (jedna na audytora,
   *   mogą mieć różną liczbę dni — patrz handleCommitSelectedPlans).
   */
  function commitPlannedRoutes(plannedRoutes){
    var globalRoundtrip = el('roundtripCheck').checked;
    var createdRouteIds = [];

    // Krok 1: tworzymy i zapisujemy wszystkie trasy od razu, synchronicznie —
    // to czysta praca na stanie, bez sieci, więc nic nie czeka.
    var toFetch = plannedRoutes.map(function(planned){
      var routeId = makeRouteId();
      createdRouteIds.push(routeId);

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
        roundtrip: globalRoundtrip,
        // Zapamiętane, żeby ręczna edycja trasy (przeliczanie czasu po zmianie
        // kolejności) używała tego samego czasu audytu, z jakim trasa powstała —
        // istotne, gdy plan zbudowano w trybie rozszerzonym z innym auditMin.
        auditMin: planned.auditMin || CONFIG.AUDIT_MIN,
        // Data zatwierdzenia — do filtra audytora w nagłówku (patrz
        // renderAuditorFilterSelect). Starsze zapisane projekty jej nie mają;
        // fmtDateTime() radzi sobie z brakiem tego pola.
        createdAt: new Date().toISOString(),
        geometry: null
      };

      state.routes.push(route);
      state.activeRouteId = routeId;

      var points = [{ lat: planned.origin.lat, lng: planned.origin.lng }].concat(
        planned.orderedStations.map(function(station){
          return { lat: station.lat, lng: station.lng };
        })
      );
      if(globalRoundtrip){ points.push({ lat: planned.origin.lat, lng: planned.origin.lng }); }

      return { route: route, points: points };
    });

    // Trasy już istnieją w stanie — pokazujemy je od razu (bez geometrii,
    // dorysowanej po chwili), zamiast trzymać planistę przed pustym ekranem
    // aż domkną się wszystkie zapytania do OSRM.
    showManifestPanel();
    renderAll();

    // Krok 2: geometria do narysowania na mapie — sekwencyjnie, nie
    // równolegle, z tego samego powodu co przy budowaniu planu (patrz
    // CONFIG.OSRM_REQUEST_DELAY_MS): kilka baz naraz dławiło publiczny OSRM.
    runSequentially(toFetch, function(item){
      return fetchRouteGeometry(item.points).then(function(osrmRoute){
        if(!osrmRoute){ return; }
        item.route.geometry = osrmRoute.geometry;
        // Przy powrocie do bazy dystans z OSRM jest dokładniejszy niż suma
        // odcinków z macierzy, bo obejmuje też odcinek powrotny.
        if(item.route.roundtrip){ item.route.totalDist = osrmRoute.distance; }
      });
    }, CONFIG.OSRM_REQUEST_DELAY_MS).finally(function(){
      // Ten plan pochodził z lastPlans — zapamiętujemy jego trasy, żeby dało
      // się je cofnąć przyciskiem „Wróć do propozycji" w manifeście.
      lastPlanRouteIds = createdRouteIds;
      setStatus('Plan zatwierdzony. Możesz wrócić do propozycji i wybrać inny wariant.');
      showManifestPanel();
      renderAll();
    });
  }

  /**
   * Cofa ostatnio zatwierdzony plan (lastPlanRouteIds): kasuje jego trasy
   * i zwalnia ich stacje, tak żeby stan wrócił do momentu sprzed wyboru —
   * inaczej wybór innego wariantu próbowałby przypisać już zajęte stacje.
   */
  function rollbackLastPlanCommit(){
    if(!lastPlanRouteIds.length){ return; }

    lastPlanRouteIds.forEach(function(routeId){
      state.stations.forEach(function(station){
        if(station.routeId === routeId){
          station.status = 'free';
          station.routeId = null;
          // "Skontrolowana" przeżywa cofnięcie planu — to fakt o stacji,
          // niezależny od tego, który wariant akurat testujemy.
        }
      });
    });

    state.routes = state.routes.filter(function(route){
      return lastPlanRouteIds.indexOf(route.id) === -1;
    });
    if(lastPlanRouteIds.indexOf(state.activeRouteId) !== -1){
      state.activeRouteId = null;
    }
    lastPlanRouteIds = [];
  }

  /** Powrót z manifestu do ostatnich propozycji — cofa wybrany wcześniej wariant. */
  function handleBackToProposals(){
    if(!lastPlans.length){ return; }

    if(lastPlanRouteIds.length){
      var confirmed = confirm(
        'Wrócić do propozycji? Wybrana wcześniej trasa (i wszystkie zmiany w niej) ' +
        'zostanie usunięta, a jej stacje zwolnione.'
      );
      if(!confirmed){ return; }
      rollbackLastPlanCommit();
    }

    renderTeamPlans(lastPlans);
    renderAll();
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
   * Jedna funkcja obsługująca każdy sposób przenoszenia stacji: przeciąganie
   * (dowolny dzień, dowolna pozycja) i strzałki ▲▼ (ten sam dzień, sąsiednia
   * pozycja — patrz moveStopWithinDay). targetDay=null = zostań w obecnym dniu.
   * beforeStationId=null = wstaw na koniec dnia docelowego.
   */
  function moveStationTo(route, stationId, targetDay, beforeStationId){
    var fromIdx = route.order.indexOf(stationId);
    if(fromIdx === -1){ return; }
    if(targetDay == null){ targetDay = route.dayBreak[fromIdx]; }

    route.order.splice(fromIdx, 1);
    route.dayBreak.splice(fromIdx, 1);

    var insertIdx;
    if(beforeStationId){
      insertIdx = route.order.indexOf(beforeStationId);
      if(insertIdx === -1){ insertIdx = route.order.length; }
    } else {
      // Brak konkretnego celu — koniec dnia docelowego (tuż przed pierwszą
      // stacją kolejnego dnia, albo na sam koniec trasy).
      insertIdx = route.order.length;
      for(var i = 0; i < route.order.length; i++){
        if(route.dayBreak[i] > targetDay){ insertIdx = i; break; }
      }
    }

    route.order.splice(insertIdx, 0, stationId);
    route.dayBreak.splice(insertIdx, 0, targetDay);

    normalizeRouteDays(route);
    refreshRoute(route);
  }

  /**
   * Strzałki ▲▼ przy przystanku: zamieniają miejscami z sąsiadem w TYM SAMYM
   * dniu — nigdy nie przeskakują do innego dnia. To celowe uproszczenie:
   * wcześniej strzałka na granicy dnia po cichu przenosiła stację do
   * sąsiedniego dnia, co było mylące. Zmiana dnia to teraz wyłącznie
   * przeciąganie (patrz moveStationTo) — jeden, przewidywalny sposób na jedną
   * rzecz, zamiast dwóch nakładających się na siebie.
   */
  function moveStopWithinDay(route, idx, direction){
    var target = idx + direction;
    if(target < 0 || target >= route.order.length){ return; }
    if(route.dayBreak[target] !== route.dayBreak[idx]){ return; }

    var tmpId = route.order[idx];
    route.order[idx] = route.order[target];
    route.order[target] = tmpId;

    refreshRoute(route);
  }

  function removeStop(route, idx){
    var station = findStation(route.order[idx]);
    if(station){
      station.status = 'free';
      station.routeId = null;
      // "Skontrolowana" zostaje — usunięcie z trasy nie znaczy, że stacja
      // przestała być już sprawdzona.
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
      route.legsMin || [], route.auditMin || CONFIG.AUDIT_MIN, route.dayBreak, route.days, route.returnMin
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

  /** Czy stacja pasuje do aktualnego filtru widoku mapy (legenda-przełącznik). */
  function stationMatchesMapFilter(station){
    if(mapGroupFilter === 'all'){ return true; }
    if(mapGroupFilter === 'weighted'){ return station.risk > 0; }
    return stationGroupClass(station) === mapGroupFilter;
  }

  /** Odświeża liczniki i podświetlenie aktywnego przycisku w legendzie-filtrze mapy. */
  function updateMapLegend(){
    var codoCount = 0, dofoCount = 0, weightedCount = 0;
    state.stations.forEach(function(station){
      if(stationGroupClass(station) === 'dofo'){ dofoCount++; } else { codoCount++; }
      if(station.risk > 0){ weightedCount++; }
    });

    el('legendAllCount').textContent = String(state.stations.length);
    el('legendCodoCount').textContent = String(codoCount);
    el('legendDofoCount').textContent = String(dofoCount);
    el('legendWeightedCount').textContent = String(weightedCount);

    el('legendAll').classList.toggle('active', mapGroupFilter === 'all');
    el('legendCodo').classList.toggle('active', mapGroupFilter === 'codo');
    el('legendDofo').classList.toggle('active', mapGroupFilter === 'dofo');
    el('legendWeighted').classList.toggle('active', mapGroupFilter === 'weighted');
  }

  function handleMapGroupFilter(event){
    var btn = event.target.closest && event.target.closest('.legend-btn');
    if(!btn){ return; }
    mapGroupFilter = btn.getAttribute('data-group') || 'all';
    renderMap();
  }

  /**
   * Rysuje wariant z propozycji na mapie — bez zapytań do OSRM (byłoby zbyt
   * wolne przy każdym kliknięciu), więc odcinki to proste linie, nie
   * rzeczywista geometria drogowa. Wystarczające do oceny "czy ten wariant
   * ma sens geograficznie", zanim padnie decyzja o zatwierdzeniu.
   */
  function renderPreviewOnMap(previewRoute){
    var points = [];

    if(previewRoute.origin){
      markersLayer.addLayer(
        L.marker([previewRoute.origin.lat, previewRoute.origin.lng], { icon: pinIcon('B', 'base') })
          .bindPopup(baseNameFor(previewRoute.origin))
      );
      points.push([previewRoute.origin.lat, previewRoute.origin.lng]);
    }

    previewRoute.orderedStations.forEach(function(station, idx){
      markersLayer.addLayer(
        L.marker([station.lat, station.lng], {
          icon: pinIcon(String(idx + 1), pinVariantFor(station, idx === 0 ? 'start' : stationGroupClass(station)))
        }).bindPopup(stationPopup(station))
      );
      points.push([station.lat, station.lng]);
    });

    if(points.length > 1){
      L.polyline(points, {
        color: CONFIG.ROUTE_COLOR, weight: 3, opacity: 0.7, dashArray: '9 7',
        pane: 'routeLinePane'
      }).addTo(routeLayer);
    }

    if(points.length){
      map.fitBounds(L.latLngBounds(points), { padding: CONFIG.MAP_PADDING });
    }
  }

  function renderMap(){
    markersLayer.clearLayers();
    routeLayer.clearLayers();

    updateMapLegend();

    // Podgląd z propozycji (jeszcze niezatwierdzony wariant) ma pierwszeństwo
    // przed normalnym widokiem — patrz showProposalPreview().
    if(previewedProposalRoute){
      el('mapAddHint').hidden = true;
      renderPreviewOnMap(previewedProposalRoute);
      return;
    }

    var route = activeRoute();
    el('mapAddHint').hidden = !route;

    // Bez wybranej trasy pokazujemy wszystkie stacje jako nienumerowane
    // pinezki, kolorowane wg grupy (CODO/DOFO) — filtrowane wg legendy nad
    // mapą, żeby dało się ograniczyć bałagan przy prawie 2000 stacjach naraz.
    if(!route){
      state.stations.filter(stationMatchesMapFilter).forEach(function(station){
        markersLayer.addLayer(
          L.marker([station.lat, station.lng], { icon: pinIcon('', pinVariantFor(station, stationGroupClass(station))) })
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

    // Przystanki samej trasy pokazujemy zawsze, niezależnie od filtru — to
    // one są celem, nie "tłem" które filtr ma przycinać.
    var stations = routeStations(route);
    var inRoute = {};
    stations.forEach(function(station, idx){
      inRoute[station.id] = true;
      markersLayer.addLayer(
        L.marker([station.lat, station.lng], {
          icon: pinIcon(String(idx + 1), pinVariantFor(station, idx === 0 ? 'start' : stationGroupClass(station)))
        }).bindPopup(stationPopup(station))
      );
    });

    // Drugi sposób dodawania stacji do otwartej trasy (obok przycisku „+" na
    // liście): reszta wolnych stacji jest widoczna w tle jako wyszarzone
    // pinezki (też przycięte filtrem grup) — podwójne kliknięcie dopisuje
    // stację na koniec trasy.
    state.stations.forEach(function(station){
      if(station.status !== 'free' || inRoute[station.id]){ return; }
      if(!stationMatchesMapFilter(station)){ return; }

      var ghost = L.marker([station.lat, station.lng], {
        icon: pinIcon('', 'ghost ' + pinVariantFor(station, stationGroupClass(station))),
        bubblingMouseEvents: false // podwójny klik nie ma dodatkowo zoomować mapy
      });
      ghost.bindPopup(stationPopup(station) +
        '<br><button type="button" class="popup-add-btn" data-station-id="' +
        escapeHtml(station.id) + '">Dodaj do trasy</button>');
      ghost.on('dblclick', function(){ addStopToRoute(route, station); });
      markersLayer.addLayer(ghost);
    });

    if(route.geometry){
      var latlngs = route.geometry.coordinates.map(function(coord){ return [coord[1], coord[0]]; });
      var line = L.polyline(latlngs, {
        color: CONFIG.ROUTE_COLOR, weight: 3.5, opacity: 0.85,
        pane: 'routeLinePane'
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
    var dayControls = el('dayControls');

    el('backToProposalsBtn').hidden = lastPlans.length === 0;

    list.innerHTML = '';
    var route = activeRoute();

    if(!route){
      summary.classList.remove('show');
      empty.hidden = false;
      exportBtn.disabled = true;
      dayControls.hidden = true;
      return;
    }

    empty.hidden = true;
    summary.classList.add('show');
    exportBtn.disabled = false;

    dayControls.hidden = false;
    el('dayControlsCount').textContent = route.days;
    el('removeDayBtn').disabled = route.days <= 1;

    var stations = routeStations(route);
    var visited = stations.filter(function(station){ return station.visited; }).length;

    el('sumDist').textContent = fmtDist(route.totalDist);
    el('sumTime').textContent = fmtMin(route.totalMin);
    el('sumVisited').textContent = visited + '/' + stations.length;

    if(route.overBudget || (route.overLimitDays || []).length){
      var warning = document.createElement('p');
      warning.className = 'route-warning';
      warning.textContent = ((route.overLimitDays || []).length
        ? 'Po zmianach dzień ' + route.overLimitDays.join(', ') + ' przekracza limit ' +
          (RouteEngine.MAX_DAY_MIN / 60) + ' godz.'
        : 'Po zmianach trasa przekracza budżet ' + route.days + '-dniowej delegacji.') +
        ' Możesz dodać kolejny dzień przyciskiem „+ dzień" poniżej.';
      list.appendChild(warning);
    }

    if(route.needsRecalc){
      var stale = document.createElement('p');
      stale.className = 'route-warning';
      stale.textContent = 'Czasy przejazdu mogą być nieaktualne — nie udało się połączyć z serwerem tras.';
      list.appendChild(stale);
    }

    // Karta na każdy dzień — nie tylko nagłówek w płaskiej liście. Wyraźna
    // wizualna granica dnia i osobny obszar "upuszczania" przy przeciąganiu
    // (patrz buildDayCard) to główna zmiana wobec starej, płaskiej listy,
    // gdzie granica dnia była tylko cienkim nagłówkiem między przystankami.
    var byDay = [];
    for(var d = 1; d <= route.days; d++){ byDay.push([]); }
    stations.forEach(function(station, idx){
      byDay[dayOfStop(route, idx) - 1].push({ station: station, idx: idx });
    });

    byDay.forEach(function(items, dayIdx){
      list.appendChild(buildDayCard(route, dayIdx + 1, items));
    });
  }

  /**
   * Dodaje kolejny dzień do trasy — niezależnie od tego, jaki wariant
   * wybrano przy budowaniu planu. Sam fakt zwiększenia route.days od razu
   * daje więcej miejsca w budżecie (patrz RouteEngine.summarizeDays), więc
   * zwykle usuwa ostrzeżenie o przekroczonym limicie bez dalszej edycji —
   * a i tak nowy dzień jest pusty, dopóki planista nie przeciągnie na niego
   * przystanku (patrz moveStationTo, karta pustego dnia).
   */
  function handleAddDay(route){
    route.days += 1;
    applyDaySummary(route);
    setStatus('Dodano dzień ' + route.days + ' do trasy.');
    renderAll();
  }

  /**
   * Usuwa ostatni dzień trasy — tylko jeśli jest pusty (bez przypisanych
   * przystanków). Gdy nie jest, planista musi je najpierw przenieść ręcznie
   * (przeciągnięcie karty na wcześniejszy dzień) — celowo nie robimy tego
   * automatycznie, żeby nie przenosić stacji na dzień, który już jest pełny.
   */
  function handleRemoveDay(route){
    if(route.days <= 1){ return; }

    var lastDayHasStations = route.dayBreak.indexOf(route.days) !== -1;
    if(lastDayHasStations){
      setStatus('Dzień ' + route.days + ' ma jeszcze przypisane stacje — przenieś je najpierw na wcześniejszy dzień.', true);
      return;
    }

    route.days -= 1;
    applyDaySummary(route);
    setStatus('Usunięto pusty dzień ' + (route.days + 1) + ' z trasy.');
    renderAll();
  }

  /**
   * Karta jednego dnia: nagłówek z obciążeniem, lista przystanków, i — to
   * nowość — sama karta jest celem przeciągania. Upuszczenie stacji gdziekolwiek
   * na karcie (nie tylko dokładnie na innym przystanku) dopisuje ją na koniec
   * tego dnia; upuszczenie wprost na przystanek wstawia przed niego (patrz
   * buildTicket). Puste karty (nowo dodany dzień) mają wyraźną podpowiedź,
   * żeby nie wyglądały jak błąd.
   */
  function buildDayCard(route, day, items){
    var card = document.createElement('div');
    card.className = 'day-card';

    card.appendChild(buildDayHeader(route, day));

    var stopList = document.createElement('ul');
    stopList.className = 'day-stop-list';

    if(items.length === 0){
      var placeholder = document.createElement('li');
      placeholder.className = 'day-empty-hint';
      placeholder.textContent = 'Pusty dzień — przeciągnij tu przystanek z innego dnia.';
      stopList.appendChild(placeholder);
    } else {
      items.forEach(function(item){
        stopList.appendChild(buildTicket(route, item.station, item.idx));
      });
    }

    card.appendChild(stopList);

    // Cała karta (nie tylko lista) jest celem upuszczenia — łatwiej trafić
    // niż w wąski obszar samej listy, zwłaszcza gdy dzień jest prawie pusty.
    card.addEventListener('dragover', function(event){
      if(!draggedStationId){ return; }
      event.preventDefault();
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', function(event){
      if(event.target === card){ card.classList.remove('drag-over'); }
    });
    card.addEventListener('drop', function(event){
      event.preventDefault();
      card.classList.remove('drag-over');
      if(!draggedStationId){ return; }
      moveStationTo(route, draggedStationId, day, null);
    });

    return card;
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

  /** Przycisk edycji przystanku (przesuń w obrębie dnia / usuń). */
  function buildStopButton(label, ariaLabel, svgPath, onClick, disabled){
    var button = document.createElement('button');
    button.className = 'stop-edit-btn';
    button.title = label;
    button.disabled = !!disabled;
    button.setAttribute('aria-label', ariaLabel);
    button.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" ' +
      'stroke-width="2" aria-hidden="true">' + svgPath + '</svg>';
    button.addEventListener('click', onClick);
    return button;
  }

  /**
   * Strzałki są teraz wyłączone dokładnie tam, gdzie i tak nic by nie zrobiły
   * (pierwszy/ostatni przystanek dnia) — zamiast klikać i zastanawiać się,
   * czemu stacja nagle zmieniła dzień, od razu widać, że dalej się nie da,
   * i że zmiana dnia to przeciągnięcie karty, nie strzałka.
   */
  function buildStopControls(route, station, idx){
    var controls = document.createElement('div');
    controls.className = 'stop-controls';

    var day = route.dayBreak[idx];
    var isFirstOfDay = idx === 0 || route.dayBreak[idx - 1] !== day;
    var isLastOfDay = idx === route.order.length - 1 || route.dayBreak[idx + 1] !== day;

    controls.appendChild(buildStopButton(
      'Wyżej (w obrębie dnia)',
      'Przesuń stację ' + station.name + ' wyżej',
      '<path d="M18 15l-6-6-6 6"/>',
      function(){ moveStopWithinDay(route, idx, -1); },
      isFirstOfDay
    ));

    controls.appendChild(buildStopButton(
      'Niżej (w obrębie dnia)',
      'Przesuń stację ' + station.name + ' niżej',
      '<path d="M6 9l6 6 6-6"/>',
      function(){ moveStopWithinDay(route, idx, 1); },
      isLastOfDay
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
    ticket.draggable = true;

    var handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/>' +
      '<circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/>' +
      '<circle cx="15" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
    ticket.appendChild(handle);

    var body = document.createElement('div');
    body.className = 'ticket-body';

    var top = document.createElement('div');
    top.className = 'ticket-top';

    var text = document.createElement('div');

    var number = document.createElement('div');
    number.className = 'ticket-num';
    number.textContent = 'Nr ' + String(idx + 1).padStart(2, '0') +
      (idx === 0 ? ' — START' : '');

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
      // Zielona pinezka (patrz pinVariantFor) ma się pojawić na mapie od
      // razu, nie dopiero przy następnej niezwiązanej akcji.
      renderMap();
    });

    var actions = document.createElement('div');
    actions.className = 'ticket-actions';
    actions.appendChild(buildStopControls(route, station, idx));
    actions.appendChild(stamp);

    top.appendChild(text);
    top.appendChild(actions);
    body.appendChild(top);

    if(route.legsMin && route.legsMin[idx] !== undefined){
      var leg = document.createElement('div');
      leg.className = 'ticket-leg';
      leg.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" ' +
        'stroke-width="1.8" aria-hidden="true"><circle cx="6" cy="19" r="2"/>' +
        '<circle cx="18" cy="5" r="2"/>' +
        '<path d="M8 19h7a3 3 0 0 0 3-3v-1a3 3 0 0 0-3-3H9a3 3 0 0 1-3-3V8"/></svg>' +
        '<span>' + fmtMin(route.legsMin[idx]) + ' dojazdu</span>';
      body.appendChild(leg);
    }

    ticket.appendChild(body);

    // Przeciąganie: uchwyt na kartę i na konkretny przystanek naraz — patrz
    // buildDayCard (upuszczenie na kartę = koniec dnia) i niżej (upuszczenie
    // na przystanek = wstawienie przed nim, dowolny dzień, dowolna pozycja).
    ticket.addEventListener('dragstart', function(event){
      draggedStationId = station.id;
      ticket.classList.add('dragging');
      if(event.dataTransfer){
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', station.id);
      }
    });
    ticket.addEventListener('dragend', function(){
      ticket.classList.remove('dragging');
      draggedStationId = null;
      document.querySelectorAll('.day-card.drag-over, .ticket.drop-before')
        .forEach(function(el){ el.classList.remove('drag-over', 'drop-before'); });
    });
    ticket.addEventListener('dragover', function(event){
      if(!draggedStationId || draggedStationId === station.id){ return; }
      event.preventDefault();
      event.stopPropagation(); // nie odpalaj też upuszczenia "na koniec dnia" z karty
      ticket.classList.add('drop-before');
    });
    ticket.addEventListener('dragleave', function(){
      ticket.classList.remove('drop-before');
    });
    ticket.addEventListener('drop', function(event){
      event.preventDefault();
      event.stopPropagation();
      ticket.classList.remove('drop-before');
      if(!draggedStationId || draggedStationId === station.id){ return; }
      moveStationTo(route, draggedStationId, route.dayBreak[idx], station.id);
    });

    return ticket;
  }

  /* =========================================================================
     16. EKSPORT CSV
     ========================================================================= */

  function toCsv(rows){
    return rows.map(function(row){
      return row.map(function(cell){
        return '"' + String(cell).replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\n');
  }

  /**
   * Treść gotowej wiadomości dla audytora — plan dnia po dniu, w czystym
   * tekście do wklejenia w e-mail albo komunikator. Godziny są względne
   * (czas dojazdu/audytu), bo aplikacja nie przypisuje konkretnych dat do
   * dni delegacji — gdyby to się zmieniło, tu jest jedyne miejsce do edycji.
   */
  function buildRouteEmailText(route){
    var stations = routeStations(route);
    var auditMin = route.auditMin || CONFIG.AUDIT_MIN;
    var baseLabel = baseNameFor(route.origin).replace(/^Baza:\s*/, '');
    var dayWord = route.days === 1 ? 'dzień' : 'dni';

    var lines = [];
    lines.push('Temat: Trasa audytu — ' + route.auditor + ' (' + route.days + ' ' + dayWord + ')');
    lines.push('');
    lines.push('Cześć ' + route.auditor + ',');
    lines.push('');
    lines.push('poniżej zaplanowana trasa audytów stacji:');
    lines.push('');
    lines.push('Baza wyjazdu: ' + baseLabel);
    lines.push('Liczba dni: ' + route.days);
    lines.push('Liczba stacji: ' + stations.length);
    lines.push('Łączny dystans: ' + fmtDist(route.totalDist));
    lines.push('Łączny czas (jazda + audyty): ' + fmtMin(route.totalMin));

    var lastDay = 0;
    stations.forEach(function(station, idx){
      var day = dayOfStop(route, idx);
      if(day !== lastDay){
        var dayLoad = route.dayTotals && route.dayTotals[day - 1] !== undefined
          ? ' (obciążenie: ' + fmtMin(route.dayTotals[day - 1]) + ')'
          : '';
        lines.push('');
        lines.push('=== DZIEŃ ' + day + dayLoad + ' ===');
        lastDay = day;
      }

      var legMin = route.legsMin && route.legsMin[idx] !== undefined
        ? Math.round(route.legsMin[idx])
        : 0;

      lines.push(
        (idx + 1) + '. ' + station.name +
        (station.stationNo ? ' (nr ' + station.stationNo + ')' : '') +
        (station.address ? ' — ' + station.address : '')
      );
      lines.push('   dojazd: ' + fmtMin(legMin) + '  |  audyt: ' + fmtMin(auditMin));
    });

    lines.push('');
    lines.push('Powrót do bazy: ' + fmtMin(route.returnMin || 0));
    lines.push('');
    lines.push('Pozdrawiam');

    return lines.join('\n');
  }

  function handleGenerateEmail(){
    var route = activeRoute();
    if(!route){ return; }

    el('emailModalText').value = buildRouteEmailText(route);
    el('emailModalCopyStatus').textContent = '';
    el('emailModalOverlay').hidden = false;
    el('emailModalText').focus();
    el('emailModalText').select();
  }

  function handleCloseEmailModal(){
    el('emailModalOverlay').hidden = true;
  }

  function handleCopyEmailText(){
    var textarea = el('emailModalText');
    var status = el('emailModalCopyStatus');
    textarea.focus();
    textarea.select();

    function showCopied(){
      status.textContent = '✓ Skopiowano do schowka.';
      setTimeout(function(){ status.textContent = ''; }, 3000);
    }

    function showFailure(){
      status.textContent = 'Nie udało się skopiować automatycznie — zaznacz tekst i skopiuj ręcznie (Ctrl+C).';
    }

    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(textarea.value).then(showCopied).catch(function(){
        try{ document.execCommand('copy'); showCopied(); }
        catch(err){ showFailure(); }
      });
    } else {
      try{ document.execCommand('copy'); showCopied(); }
      catch(err){ showFailure(); }
    }
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
    el('commitSelectedBtn').addEventListener('click', handleCommitSelectedPlans);
    el('auditorFilterSelect').addEventListener('change', handleAuditorFilterChange);
    el('addDayBtn').addEventListener('click', function(){
      var route = activeRoute();
      if(route){ handleAddDay(route); }
    });
    el('removeDayBtn').addEventListener('click', function(){
      var route = activeRoute();
      if(route){ handleRemoveDay(route); }
    });
    el('backToProposalsBtn').addEventListener('click', handleBackToProposals);

    Array.prototype.slice.call(document.querySelectorAll('input[name="planMode"]'))
      .forEach(function(radio){ radio.addEventListener('change', handlePlanModeChange); });
    el('resetPlanParamsBtn').addEventListener('click', handleResetPlanParams);

    el('routeSelect').addEventListener('change', handleRouteSelected);
    el('deleteRouteBtn').addEventListener('click', handleDeleteRoute);

    el('stationSearchInput').addEventListener('input', handleStationSearch);
    el('mapLegend').addEventListener('click', handleMapGroupFilter);
    el('mapCleanToggle').addEventListener('click', handleMapCleanToggle);

    // Przycisk „Dodaj do trasy" w dymku wyszarzonej pinezki — dymki są
    // tworzone i niszczone dynamicznie przez Leaflet, więc nasłuch wieszamy
    // raz, na dokumencie, i deleguje się po kliknięciu.
    document.addEventListener('click', function(event){
      var btn = event.target.closest && event.target.closest('.popup-add-btn');
      if(!btn){ return; }
      var route = activeRoute();
      var station = findStation(btn.getAttribute('data-station-id'));
      if(route && station){ addStopToRoute(route, station); }
    });

    el('newProjectBtn').addEventListener('click', handleNewProject);
    el('saveProjectBtn').addEventListener('click', handleSaveProject);
    el('loadProjectBtn').addEventListener('click', function(){ el('loadProjectInput').click(); });
    el('loadProjectInput').addEventListener('change', handleLoadProjectFile);

    el('exportBtn').addEventListener('click', handleGenerateEmail);
    el('emailModalClose').addEventListener('click', handleCloseEmailModal);
    el('emailModalCopyBtn').addEventListener('click', handleCopyEmailText);
    el('emailModalOverlay').addEventListener('click', function(event){
      if(event.target.id === 'emailModalOverlay'){ handleCloseEmailModal(); }
    });
    document.addEventListener('keydown', function(event){
      if(event.key === 'Escape' && !el('emailModalOverlay').hidden){ handleCloseEmailModal(); }
    });
  }

  function init(){
    initMap();
    loadState();
    bindEvents();
    renderAuditorInputs();
    fillPlanningInputsWithDefaults();
    updatePlanModeUI();
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
    PLANNING_DEFAULTS: PLANNING_DEFAULTS,
    assignStationsToAuditors: assignStationsToAuditors,
    buildPlansForAllVariants: buildPlansForAllVariants,
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
    pluralPL: pluralPL,
    fmtCount: fmtCount,
    stationGroupClass: stationGroupClass,
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
