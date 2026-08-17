(function(){ 

  'use strict'; 

  

function createStationsFromDb() {
  var db = window.STATIONS_DB || [];

  return db.map(function(s) {
    return {
      id: String(s.id || ('st' + s.stationNo)),
      group: String(s.group || ''),
      stationNo: String(s.stationNo || '').trim(),
      name: String(s.name || ('Stacja ' + s.stationNo)),
      address: String(s.address || ''),
      lat: Number(s.lat),
      lng: Number(s.lng),
      risk: 0,
      status: 'free',
      routeId: null,
      visited: false
    };
  }).filter(function(s) {
    return isValidLat(s.lat) && isValidLng(s.lng) && s.stationNo;
  });
}

function createInitialState() {
  return {
    stations: createStationsFromDb(),
    routes: [],
    auditors: [],
    activeRouteId: null,
    nextStationId: 1,
    nextRouteId: 1,
    pendingImport: null
  };
}

var state = createInitialState();

  

function saveState() { 

  try { 

    localStorage.setItem('audytor_trasy_state', JSON.stringify(state)); 

  } catch (err) { 

    console.error('Błąd zapisu:', err); 

  } 

} 

  

function loadState() { 

  try { 

    var saved = localStorage.getItem('audytor_trasy_state'); 

  

    if (!saved) return; 

  

    var loaded = JSON.parse(saved); 

  

if (loaded) { 

state = {
  stations: loaded.stations && loaded.stations.length
    ? loaded.stations
    : createStationsFromDb(),
  routes: loaded.routes || [],
  auditors: loaded.auditors || [],
  activeRouteId: loaded.activeRouteId || null,
  nextStationId: loaded.nextStationId || 1,
  nextRouteId: loaded.nextRouteId || 1,
  pendingImport: null
}; 

} 

  } catch (err) { 

    console.error('Błąd odczytu:', err); 

  } 

} 

  

  var map = L.map('map', { zoomControl: true }).setView([52.0693,19.4803], 6.3); 

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom:19 }).addTo(map); 

  var markersLayer = L.layerGroup().addTo(map); 

  var routeLayer = L.layerGroup().addTo(map); 

  

  function el(id){ return document.getElementById(id); } 

  function escapeHtml(str){ var d=document.createElement('div'); d.textContent=str||''; return d.innerHTML; } 

  function makeStationId(){ return 'st'+(state.nextStationId++); } 

  function makeRouteId(){ return 'r'+(state.nextRouteId++); } 

  function fmtDist(m){ if(typeof m!=='number'||isNaN(m)||m<0)return '—'; return (m/1000).toFixed(1).replace('.', ',')+' km'; } 

  function fmtMin(min){ if(typeof min!=='number'||isNaN(min)||min<0)return '—'; min=Math.round(min); if(min<60) return min+' min'; var h=Math.floor(min/60), r=min%60; return h+' godz '+(r?r+' min':''); } 

  function isValidLat(lat){ return typeof lat==='number'&&!isNaN(lat)&&lat>=-90&&lat<=90; } 

  function isValidLng(lng){ return typeof lng==='number'&&!isNaN(lng)&&lng>=-180&&lng<=180; } 

  

  // ================= GEOCODING ================= 

  function geocode(query){ 

    var url='https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=pl&q='+encodeURIComponent(query); 

    return fetch(url,{headers:{'Accept':'application/json'}}).then(function(r){ 

      if(!r.ok) throw new Error('Błąd serwera geokodowania'); 

      return r.json(); 

    }).then(function(res){ 

      if(!res||res.length===0) throw new Error('Nie znaleziono: '+query); 

      var lat=parseFloat(res[0].lat), lng=parseFloat(res[0].lon); 

      if(!isValidLat(lat)||!isValidLng(lng)) throw new Error('Niewłaściwe współrzędne dla: '+query); 

      return { lat:lat, lng:lng, display:res[0].display_name }; 

    }); 

  } 

  function reverseGeocode(lat,lng){ 

    if(!isValidLat(lat)||!isValidLng(lng)) return Promise.resolve('Punkt '+lat.toFixed(4)+', '+lng.toFixed(4)); 

    var url='https://nominatim.openstreetmap.org/reverse?format=json&lat='+lat+'&lon='+lng; 

    return fetch(url,{headers:{'Accept':'application/json'}}).then(function(r){return r.json();}) 

      .then(function(res){ return res&&res.display_name?res.display_name:('Punkt '+lat.toFixed(4)+', '+lng.toFixed(4)); }) 

      .catch(function(){ return 'Punkt '+lat.toFixed(4)+', '+lng.toFixed(4); }); 

  } 

  function setStatus(msg,isErr){ var s=el('geocodeStatus'); s.textContent=msg||''; s.className=isErr?'err':''; } 

  function normalizeVoivodeship(value){ 

    var v = String(value || '').trim(); 

    if(!v){ return ''; } 

    return v.replace(/^woj\.\s*/i, '').trim(); 

  } 

  function buildGeocodeQuery(city, voivodeship, address){ 

    var c = String(city || '').trim(); 

    var w = normalizeVoivodeship(voivodeship); 

    var a = String(address || '').trim(); 

    if(a && c && a.toLowerCase().indexOf(c.toLowerCase()) === -1){ 

      return a + ', ' + c + (w ? ', ' + w : '') + ', Polska'; 

    } 

    if(a){ 

      return a + (w ? ', ' + w : '') + ', Polska'; 

    } 

    if(c){ 

      return c + (w ? ', ' + w : '') + ', Polska'; 

    } 

    return ''; 

  } 

  function renderAuditorInputs(){ 

    var wrap = el('auditorsNamesWrap'); 

    if(!wrap){ return; } 

    var existing = Array.prototype.slice.call(document.querySelectorAll('.auditor-name-input')).map(function(input){ 

      return input.value; 

    }); 

    var count = parseInt(el('auditorsInput').value, 10) || 1; 

    count = Math.max(1, Math.min(20, count)); 

    el('auditorsInput').value = count; 

    wrap.innerHTML = ''; 

    var mainLabel = document.createElement('label'); 

    mainLabel.className = 'field-label'; 

    mainLabel.textContent = count === 1 ? 'Audytor' : 'Audytorzy'; 

    wrap.appendChild(mainLabel); 

    for(var i=0; i<count; i++){ 

      var input = document.createElement('input'); 

      input.type = 'text'; 

      input.className = 'auditor-name-input'; 

      input.dataset.auditorIndex = i; 

      input.placeholder = 'Audytor ' + (i+1); 

      input.value = existing[i] || ''; 

      input.style.marginBottom = '6px'; 

      wrap.appendChild(input); 

    } 

  } 

  function getAuditorNames(){ 

    return Array.prototype.slice.call(document.querySelectorAll('.auditor-name-input')).map(function(input, idx){ 

      return input.value.trim() || ('Audytor ' + (idx+1)); 

    }); 

  } 

  el('auditorsInput').addEventListener('input', renderAuditorInputs); 

  el('auditorsInput').addEventListener('change', renderAuditorInputs); 

  

  

  // ================= EXCEL IMPORT ================= 

var ROLE_OPTIONS = [
  ['skip','— pomiń —'],
  ['stationNo','Nr stacji'],
  ['name','Nazwa stacji'],
  ['address','Pełny adres'],
  ['city','Miasto'],
  ['voivodeship','Województwo'],
  ['lat','Szerokość (lat)'],
  ['lng','Długość (lng)'],
  ['risk','Waga / ranking ryzyka']
];

  function guessRole(h){ 

    h=(h||'').toString().toLowerCase(); 

	if(/nr.*stacj|numer.*stacj|station.*no|stationno|id.*stacj/.test(h)) return 'stationNo';
	if(/miasto|city|miejscowo/.test(h)) return 'city';
	if(/wojew|woj\.|province|region/.test(h)) return 'voivodeship';
	if(/adres|address|lokaliz/.test(h)) return 'address';
	if(/^lat|szer/.test(h)) return 'lat';
	if(/^lon|^lng|d[łl]ug/.test(h)) return 'lng';
	if(/waga|ryzyk|risk|priorytet|score|rang|ranking|raking|poz/.test(h)) return 'risk';
	if(/nazwa|name|stacj|nr/.test(h)) return 'name'; 

    return 'skip'; 

  } 

  

  el('excelInput').addEventListener('change', function(e){ 

    var file=e.target.files[0]; if(!file) return; 

    var reader=new FileReader(); 

    reader.onload=function(evt){ 

      try { 

        var wb=XLSX.read(evt.target.result,{type:'array'}); 

        var sheet=wb.Sheets[wb.SheetNames[0]]; 

        var rows=XLSX.utils.sheet_to_json(sheet,{header:1,raw:false,defval:''}); 

        rows=rows.filter(function(r){ return r.some(function(c){ return String(c).trim()!==''; }); }); 

        if(rows.length===0){ setStatus('Plik jest pusty.',true); return; } 

        state.pendingImport={ rows: rows }; 

        renderImportMap(rows); 

      } catch(err) { 

        setStatus('Błąd czytania pliku.',true); 

        console.error(err); 

      } 

    }; 

    reader.onerror=function(){ setStatus('Nie udało się wczytać pliku.',true); }; 

    reader.readAsArrayBuffer(file); 

    e.target.value=''; 

  }); 

  

  function renderImportMap(rows){ 

    var hasHeader = el('hasHeaderChk').checked; 

    var headerRow = hasHeader ? rows[0] : rows[0].map(function(_,i){ return 'Kolumna '+(i+1); }); 

    var sampleRow = hasHeader ? (rows[1]||[]) : rows[0]; 

    var wrap = el('mapRows'); wrap.innerHTML=''; 

    headerRow.forEach(function(h,idx){ 

      var row=document.createElement('div'); row.className='map-row'; 

      var nameSpan=document.createElement('span'); nameSpan.className='colname'; 

      nameSpan.title=String(h); 

      nameSpan.textContent=String(h)+ (sampleRow[idx]!==undefined? '  ('+String(sampleRow[idx]).slice(0,14)+')':''); 

      var sel=document.createElement('select'); sel.dataset.colIdx=idx; 

      ROLE_OPTIONS.forEach(function(opt){ var o=document.createElement('option'); o.value=opt[0]; o.textContent=opt[1]; sel.appendChild(o); }); 

      sel.value = guessRole(hasHeader ? h : ''); 

      row.appendChild(nameSpan); row.appendChild(sel); 

      wrap.appendChild(row); 

    }); 

    el('importMap').classList.add('show'); 

  } 

  el('hasHeaderChk').addEventListener('change', function(){ if(state.pendingImport) renderImportMap(state.pendingImport.rows); }); 

  
function normalizeStationNo(value) {
  var v = String(value || '').trim();

  if(!v) {
    return '';
  }

  v = v.replace(/\s+/g, '');

  if(/^\d+\.0$/.test(v)) {
    v = v.replace(/\.0$/, '');
  }

  return v;
}

function extractStationNo(value) {
  var v = normalizeStationNo(value);

  if(v) {
    return v;
  }

  var match = String(value || '').match(/\d+/);

  return match ? match[0] : '';
}

function applyRiskRows(dataRows, mapping, prioDir) {
  var colOf = function(role) {
    for(var k in mapping) {
      if(mapping[k] === role) {
        return parseInt(k, 10);
      }
    }

    return -1;
  };

  var stationNoCol = colOf('stationNo');
  var nameCol = colOf('name');
  var riskCol = colOf('risk');

  if(stationNoCol < 0 && nameCol < 0) {
    alert('Wskaż kolumnę z numerem stacji.');
    return;
  }

  if(riskCol < 0) {
    alert('Wskaż kolumnę z wagą / rankingiem ryzyka.');
    return;
  }

  var parsed = [];

  dataRows.forEach(function(r) {
    var stationNo = '';

    if(stationNoCol >= 0) {
      stationNo = extractStationNo(r[stationNoCol]);
    }

    if(!stationNo && nameCol >= 0) {
      stationNo = extractStationNo(r[nameCol]);
    }

    var rawRisk = parseFloat(String(r[riskCol] || '0').replace(',', '.'));

    if(!stationNo || isNaN(rawRisk)) {
      return;
    }

    parsed.push({
      stationNo: stationNo,
      rawRisk: rawRisk
    });
  });

  if(parsed.length === 0) {
    setStatus('Nie znaleziono prawidłowych rekordów ryzyka.', true);
    return;
  }

  var maxRisk = Math.max.apply(null, parsed.map(function(x) {
    return x.rawRisk;
  }));

  var stationByNo = {};

  state.stations.forEach(function(s) {
    stationByNo[normalizeStationNo(s.stationNo)] = s;
  });

  // Nowy import ryzyka czyści poprzednie trasy i poprzednie wagi.
  state.routes = [];
  state.activeRouteId = null;

  state.stations.forEach(function(s) {
    s.risk = 0;
    s.status = 'free';
    s.routeId = null;
    s.visited = false;
  });

  var matched = 0;
  var notFound = [];

  parsed.forEach(function(row) {
    var station = stationByNo[normalizeStationNo(row.stationNo)];

    if(!station) {
      notFound.push(row.stationNo);
      return;
    }

    var risk = row.rawRisk;

    if(prioDir === 'asc') {
      risk = maxRisk - row.rawRisk + 1;
    }

    station.risk = Math.max(0, risk);
    station.status = 'free';
    station.routeId = null;
    station.visited = false;

    matched++;
  });

  state.pendingImport = null;
  el('importMap').classList.remove('show');

  setStatus(
    'Zaimportowano ryzyka: dopasowano ' + matched + ' stacji, nie znaleziono ' + notFound.length + '.',
    notFound.length > 0
  );

  console.log('Nie znaleziono stacji z pliku ryzyka:', notFound);

  renderAll();
}
  el('confirmImportBtn').addEventListener('click', function(){ 

    if(!state.pendingImport) return; 

    var rows=state.pendingImport.rows; 

    var hasHeader=el('hasHeaderChk').checked; 

    var dataRows = hasHeader ? rows.slice(1) : rows; 

    var mapping={}; 

    document.querySelectorAll('#mapRows select').forEach(function(sel){ mapping[sel.dataset.colIdx]=sel.value; }); 

    var prioDir = document.querySelector('input[name=prioDir]:checked').value; 
var hasStationNoMapping = false;

for(var mk in mapping) {
  if(mapping[mk] === 'stationNo') {
    hasStationNoMapping = true;
  }
}

if(hasStationNoMapping) {
  applyRiskRows(dataRows, mapping, prioDir);
  return;
}
  

    var colOf = function(role){ for(var k in mapping){ if(mapping[k]===role) return parseInt(k,10); } return -1; }; 

    var nameCol=colOf('name'), addrCol=colOf('address'), cityCol=colOf('city'), voivCol=colOf('voivodeship'), latCol=colOf('lat'), lngCol=colOf('lng'), riskCol=colOf('risk'); 

    if(nameCol<0 && addrCol<0 && cityCol<0){ alert('Wskaż przynajmniej kolumnę z nazwą, pełnym adresem albo miastem.'); return; } 

  

    var toImport = dataRows.map(function(r){ 

      var city = cityCol>=0 ? String(r[cityCol]||'').trim() : ''; 

      var voivodeship = voivCol>=0 ? String(r[voivCol]||'').trim() : ''; 

      var rawAddress = addrCol>=0 ? String(r[addrCol]||'').trim() : ''; 

      var address = buildGeocodeQuery(city, voivodeship, rawAddress); 

      var rawName = nameCol>=0 ? String(r[nameCol]||'').trim() : ''; 

      var name = rawName || city || rawAddress || address; 

      var lat = latCol>=0 ? parseFloat(String(r[latCol]).replace(',','.')) : NaN; 

      var lng = lngCol>=0 ? parseFloat(String(r[lngCol]).replace(',','.')) : NaN; 

      var risk = riskCol>=0 ? parseFloat(String(r[riskCol]).replace(',','.')) : 0; 

      if(isNaN(risk)) risk=0; 

      if(prioDir==='asc') risk = -risk; 

      return { name:name, address:address, city:city, voivodeship:voivodeship, lat:lat, lng:lng, risk:Math.max(0,risk) }; 

    }).filter(function(s){ return s.name && (s.address || (isValidLat(s.lat) && isValidLng(s.lng))); }); 

  

    el('importMap').classList.remove('show'); 

    state.pendingImport=null; 

    importRowsSequential(toImport, 0); 

  }); 

  

  function importRowsSequential(rows, i){ 

    if(i>=rows.length){ setStatus('Import zakończony: '+rows.length+' stacji.'); renderAll(); return; } 

    var r=rows[i]; 

    var finish=function(lat,lng,addr){ 

      if(!isValidLat(lat)||!isValidLng(lng)){  

        setStatus('Pominięto (niewłaściwe współrzędne): '+r.address, true);  

        setTimeout(function(){ importRowsSequential(rows,i+1); },1100); 

        return; 

      } 

      state.stations.push({ id:makeStationId(), name:r.name, address:addr||r.address, lat:lat, lng:lng, risk:r.risk, status:'free', routeId:null, visited:false }); 

      setTimeout(function(){ importRowsSequential(rows,i+1); }, 500); 

    }; 

    if(isValidLat(r.lat) && isValidLng(r.lng)){ 

      finish(r.lat,r.lng,r.address); 

    } else { 

      setStatus('Geokoduję '+(i+1)+'/'+rows.length+': '+r.address); 

      geocode(r.address).then(function(res){ finish(res.lat,res.lng,res.display); }) 

        .catch(function(err){ setStatus('Pominięto: '+r.address, true); setTimeout(function(){ importRowsSequential(rows,i+1); },1100); }); 

    } 

  } 


  // ================= STATION LIST RENDER ================= 

  function renderStopList(){ 

    var ul=el('stopList'); var empty=el('emptyState'); ul.innerHTML=''; 

    var sorted = state.stations
  .filter(function(s) {
    return s.risk > 0 || s.status !== 'free';
  })
  .sort(function(a,b){ return b.risk - a.risk; }); 

    if(sorted.length===0){ empty.style.display='block'; } 

    else { 

      empty.style.display='none'; 

      sorted.forEach(function(s,idx){ 

        var li=document.createElement('li'); 

        var rk=document.createElement('span'); rk.className='rk'; rk.textContent=String(idx+1).padStart(2,'0'); 

        var nm=document.createElement('span'); nm.className='nm'; nm.textContent=s.name; nm.title=s.address; 

        var wt=document.createElement('span'); wt.className='wt'; wt.textContent=s.risk; 

        var badge=document.createElement('span'); 

        badge.className='badge '+(s.status==='free'?'free':'assigned'); 

        badge.textContent = s.status==='free' ? 'wolna' : (routeLabel(s.routeId)||'w trasie'); 

        li.appendChild(rk); li.appendChild(nm); li.appendChild(wt); li.appendChild(badge); 

        if(s.status==='free'){ 

          var rm=document.createElement('button'); rm.className='rm'; 

          rm.innerHTML='<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.8" width="14" height="14"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>'; 

          rm.title='Usuń'; 

          rm.addEventListener('click', function(){ state.stations=state.stations.filter(function(x){return x.id!==s.id;}); renderAll(); }); 

          li.appendChild(rm); 

        } 

        ul.appendChild(li); 

      }); 

    } 

    el('statTotal').textContent = state.stations.length; 

   el('statFree').textContent = state.stations.filter(function(s){return s.status === 'free' && s.risk > 0;
	}).length; 

    el('statRoutes').textContent = state.routes.length; 

    el('buildBtn').disabled = state.stations.filter(function(s){
  return s.status === 'free' && s.risk > 0;
}).length === 0;

  } 

  function routeLabel(routeId){ var r=state.routes.find(function(x){return x.id===routeId;}); return r?r.name:null; } 

  

  // ================= ROUTE SELECT ================= 

  function renderRouteSelect(){ 

    var sel=el('routeSelect'); 

    var cur=sel.value; 

    sel.innerHTML='<option value="">— wybierz trasę —</option>'; 

    state.routes.forEach(function(r){ 

      var o=document.createElement('option'); o.value=r.id; 

o.textContent = 

escapeHtml(r.name)+ 

' | '+ 

escapeHtml(r.auditor || 'Nieprzypisany')+ 

' ('+ 

r.order.length+ 

' stacji)'; 

      sel.appendChild(o); 

    }); 

    if(state.activeRouteId) sel.value=state.activeRouteId; 

  } 

  el('routeSelect').addEventListener('change', function(){ 

    state.activeRouteId = this.value || null; 

    el('proposalsPanel').style.display='none'; 

    el('manifestPanel').style.display='block'; 

    renderMap(); renderManifest(); 

  }); 

  el('deleteRouteBtn').addEventListener('click', function(){ 

    if(!state.activeRouteId) return; 

    if(!confirm('Usunąć trasę i zwolnić jej stacje?')) return; 

    state.stations.forEach(function(s){ if(s.routeId===state.activeRouteId){ s.status='free'; s.routeId=null; s.visited=false; } }); 

    state.routes = state.routes.filter(function(r){ return r.id!==state.activeRouteId; }); 

    state.activeRouteId=null; 

    renderAll(); 

  }); 

  

el('newProjectBtn').addEventListener('click', function(){ 

  if(!confirm('Rozpocząć nowy projekt i usunąć wszystkie zapisane dane?')){ 

    return; 

  } 

  localStorage.removeItem('audytor_trasy_state'); 

state = createInitialState();
  
saveState(); 
renderAll(); 
}); 

  

el('saveProjectBtn').addEventListener('click', function(){ 

  

  var project = JSON.stringify(state, null, 2); 

  

  var blob = new Blob( 

    [project], 

    {type:'application/json'} 

  ); 

  

  var url = URL.createObjectURL(blob); 

  

  var a = document.createElement('a'); 

  

  a.href = url; 

  

  a.download = 

    'AudytOR_' + 

    new Date().toISOString().slice(0,10) + 

    '.json'; 

  

  a.click(); 

  

  URL.revokeObjectURL(url); 

  

}); 

el('loadProjectBtn').addEventListener('click', function(){ 

el('loadProjectInput').click(); 

}); 

  

el('loadProjectInput').addEventListener('change', function(e){ 

  

  var file = e.target.files[0]; 

  

  if(!file) return; 

  

  var reader = new FileReader(); 

  

  reader.onload = function(evt){ 

  

    try{ 

  

      var loadedState = 

        JSON.parse(evt.target.result); 

  

state = { 

  stations: loadedState.stations || [], 

  routes: loadedState.routes || [], 

  auditors: loadedState.auditors || [], 

  activeRouteId: loadedState.activeRouteId || null, 

  nextStationId: Math.max(1, loadedState.nextStationId || 1), 

  nextRouteId: Math.max(1, loadedState.nextRouteId || 1), 

  pendingImport: null 

}; 

  

      saveState(); 

  

      renderAll(); 

  

      setStatus( 

        'Projekt został wczytany.' 

      ); 

  

    } 

    catch(err){ 

  

      alert( 

        'Nieprawidłowy plik projektu.' 

      ); 

      console.error(err); 

  

    } 

  

  }; 

  reader.onerror=function(){ alert('Nie udało się wczytać pliku.'); }; 

  

  reader.readAsText(file); 

  

}); 

  

  // ================= MATRIX + FEASIBLE ROUTE ENGINE ================= 

  function fetchTable(coordsArr){ 

    var coordStr = coordsArr.map(function(c){ return c.lng+','+c.lat; }).join(';'); 

    var url='https://router.project-osrm.org/table/v1/driving/'+coordStr+'?annotations=duration,distance'; 

    return fetch(url).then(function(r){ 

      if(!r.ok) throw new Error('Błąd OSRM'); 

      return r.json(); 

    }).then(function(data){ 

      if(data.code!=='Ok') throw new Error('Serwer OSRM nie zwrócił macierzy odległości.'); 

      if(!data.durations||!data.distances) throw new Error('Brak danych macierzy.'); 

      return data; 

    }).catch(function(err){ 

      console.error('fetchTable error:', err); 

      throw err; 

    }); 

  } 

  el('buildBtn').addEventListener('click', function(){ 

    renderAuditorInputs(); 

var free = state.stations
  .filter(function(s){ return s.status === 'free' && s.risk > 0; })
  .sort(function(a,b){ return b.risk - a.risk; });

  

    var auditors = parseInt(el('auditorsInput').value, 10) || 1; 

    auditors = Math.max(1, Math.min(20, auditors)); 

    var auditorNames = getAuditorNames(); 

  

    if(free.length === 0){ 

      setStatus('Brak wolnych stacji do zaplanowania.', true); 

      return; 

    } 

  

    var cap = Math.min(free.length, auditors * 80, 300); 

    var capped = free.slice(0, cap); 

var clusters = RouteEngine.clusterStations(capped, auditors);

  

    console.log('CLUSTERS'); 

    console.log(clusters); 

    clusters.forEach(function(c, i){ console.log('Klaster', i + 1, 'liczba stacji:', c.length); }); 

  

    var auditMin = 120; // Stały czas audytu: 2 godziny. 

    var dailyCapMin = 8 * 60; // Stały standardowy limit dnia. Reguły delegacji określa silnik. 

    var baseAddr = el('baseInput').value.trim(); 

    var btn = this; 

  

    btn.disabled = true; 

    btn.textContent = 'Liczę...'; 

    setStatus('Buduję plan zespołowy...'); 

  

    var baseOriginPromise = baseAddr ? geocode(baseAddr).then(function(r){ 

      return { lat:r.lat, lng:r.lng, isStation:false }; 

    }) : Promise.resolve(null); 

  

    baseOriginPromise.then(function(baseOrigin){ 

      var clusterPromises = clusters.map(function(cluster, clusterIndex){ 

        if(!cluster || cluster.length === 0){ return Promise.resolve(null); } 

  

        var origin = baseOrigin || { 

          lat: cluster[0].lat, 

          lng: cluster[0].lng, 

          isStation: true, 

          stationRef: cluster[0] 

        }; 

  

        var coordsList = [{ lat:origin.lat, lng:origin.lng }].concat(cluster.map(function(s){ 

          return { lat:s.lat, lng:s.lng }; 

        })); 

  

        return fetchTable(coordsList).then(function(data){ 

          return { 

            clusterIndex: clusterIndex, 

            auditorId: clusterIndex + 1, 

            auditorName: auditorNames[clusterIndex] || ('Audytor ' + (clusterIndex + 1)), 

            origin: origin, 

            durMatrix: data.durations, 

            distMatrix: data.distances, 

            candidates: cluster.map(function(s,i){ return { station:s, idx:i+1, risk:s.risk }; }), 

            cluster: cluster 

          }; 

        }); 

      }); 

  

      return Promise.all(clusterPromises).then(function(clusterResults){ 

        clusterResults = clusterResults.filter(Boolean); 

        var plans = []; 

  

        for(var days=1; days<=3; days++){ 

          var planRoutes = []; 

          var budgetMin = days * RouteEngine.BASE_DAY_MIN; 

  

          clusterResults.forEach(function(result){ 

            var routeData = RouteEngine.buildRouteForCluster(result, days, budgetMin, auditMin, dailyCapMin);

            if(routeData && routeData.orderedStations.length > 0){ 

              planRoutes.push(routeData); 

            } 

          }); 

  

          if(planRoutes.length > 0){ 

            plans.push({ 

              days: days, 

              budgetMin: budgetMin, 

              routes: planRoutes, 

              totalStations: planRoutes.reduce(function(a,r){ return a + r.orderedStations.length; }, 0), 

              totalDist: planRoutes.reduce(function(a,r){ return a + r.totalDist; }, 0), 

              totalMin: planRoutes.reduce(function(a,r){ return a + r.totalMin; }, 0), 

              totalRisk: planRoutes.reduce(function(a,r){ return a + r.totalRisk; }, 0) 

            }); 

          } 

        } 

  

        console.log('Plany zespołowe:'); 

        console.log(plans); 

        renderTeamPlans(plans); 

        setStatus(plans.length ? 'Wygenerowano plan zespołowy.' : 'Nie udało się wygenerować planu.', plans.length === 0); 

      }); 

    }).catch(function(err){ 

      console.error(err); 

      setStatus('Błąd przy budowaniu tras: ' + (err.message || err), true); 

      alert(err.message || 'Nie udało się zbudować propozycji tras.'); 

    }).finally(function(){ 

      btn.disabled = false; 

      btn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Zbuduj trasy'; 

    }); 

  }); 

  

  function buildRouteForCluster(result, days, budgetMin, auditMin, dailyCapMin){
    var durMatrix = result.durMatrix;
    var distMatrix = result.distMatrix;
    var candidates = result.candidates;
    if(!candidates || !candidates.length){ return null; }

    var plan = constructFeasibleRoute(
      candidates, durMatrix, distMatrix, auditMin, days
    );
    if(!plan || !plan.schedule || plan.order.length < 2){ return null; }

    var orderedIdx = plan.order;
    var schedule = plan.schedule;
    var orderedStations = orderedIdx.slice(1).map(function(idx){
      var candidate = stationByIdx(candidates, idx);
      return candidate ? candidate.station : null;
    }).filter(Boolean);
    if(!orderedStations.length){ return null; }

    var legsMin = [];
    var totalDist = 0;
    for(var i=1; i<orderedIdx.length; i++){
      legsMin.push(durMatrix[orderedIdx[i-1]][orderedIdx[i]] / 60);
      totalDist += distMatrix[orderedIdx[i-1]][orderedIdx[i]] || 0;
    }
    totalDist += distMatrix[orderedIdx[orderedIdx.length-1]][0] || 0;

    return {
      auditorId: result.auditorId,
      auditorName: result.auditorName,
      days: days,
      budgetMin: days * BASE_DAY_MIN,
      orderedIdx: orderedIdx,
      orderedStations: orderedStations,
      legsMin: legsMin,
      totalDist: totalDist,
      totalMin: schedule.totalMin,
      dayTotals: schedule.dayTotals,
      returnMin: schedule.returnMin,
      dayBreak: schedule.breakdown,
      totalRisk: orderedStations.reduce(function(sum, station){
        return sum + (station.risk || 0);
      }, 0),
      origin: result.origin
    };
  }

  function renderTeamPlans(plans){ 

    el('manifestPanel').style.display='none'; 

    el('proposalsPanel').style.display='block'; 

    var wrap = el('proposalCards'); 

    wrap.innerHTML = ''; 

  

    if(!plans || plans.length === 0){ 

      wrap.innerHTML = '<p class="empty-state">Nie udało się wygenerować planu zespołowego.</p>'; 

      return; 

    } 

  

    var bestRisk = Math.max.apply(null, plans.map(function(p){ return p.totalRisk; })); 

    plans.forEach(function(plan){ 

      var card = document.createElement('div'); 

      card.className = 'proposal-card' + (plan.totalRisk === bestRisk ? ' best' : ''); 

      var dayLabel = plan.days === 1 ? 'dzień' : 'dni'; 

  

      var routeRows = plan.routes.map(function(r){ 

        return '<span class="day-chip">' + escapeHtml(r.auditorName) + ': ' + r.orderedStations.length + ' stacji, ' + fmtMin(r.totalMin) + '</span>'; 

      }).join(''); 

  

      card.innerHTML = 

        '<div class="proposal-head"><h3>Plan zespołowy · ' + plan.days + ' ' + dayLabel + '</h3><span>' + plan.routes.length + ' tras</span></div>' + 

        '<div class="proposal-stats">' + 

          '<div class="pstat"><b>' + plan.totalStations + '</b>stacji łącznie</div>' + 

          '<div class="pstat"><b>' + fmtDist(plan.totalDist) + '</b>dystans łącznie</div>' + 

          '<div class="pstat"><b>' + fmtMin(plan.totalMin) + '</b>czas łącznie</div>' + 

          '<div class="pstat"><b>' + plan.totalRisk.toFixed(0) + '</b>suma wag</div>' + 

        '</div>' + 

        '<div>' + routeRows + '</div>'; 

  

      var useBtn = document.createElement('button'); 

      useBtn.className = 'use-proposal'; 

      useBtn.textContent = 'Wybierz cały plan'; 

      useBtn.addEventListener('click', function(){ commitTeamPlan(plan); }); 

      card.appendChild(useBtn); 

      wrap.appendChild(card); 

    }); 

  } 

  

  el('cancelBuildBtn').addEventListener('click', function(){ 

    el('proposalsPanel').style.display='none'; 

    el('manifestPanel').style.display='block'; 

  }); 

  

  function commitTeamPlan(plan){ 

    var roundtrip = el('roundtripCheck').checked; 

    var geometryPromises = []; 

  

    plan.routes.forEach(function(pr){ 

      var routeId = makeRouteId(); 

      pr.orderedStations.forEach(function(s){ 

        s.status = 'assigned'; 

        s.routeId = routeId; 

        s.visited = false; 

      }); 

  

      var route = { 

        id: routeId, 

        name: 'Trasa ' + (state.routes.length + 1) + ' · ' + pr.auditorName, 

        auditor: pr.auditorName,

        days: pr.days, 

        order: pr.orderedStations.map(function(s){ return s.id; }), 

        dayBreak: pr.dayBreak,
        dayTotals: pr.dayTotals,
        returnMin: pr.returnMin, 

        legsMin: pr.legsMin, 

        totalDist: pr.totalDist, 

        totalMin: pr.totalMin, 

        origin: pr.origin, 

        roundtrip: roundtrip, 

        geometry: null 

      }; 

      state.routes.push(route); 

      state.activeRouteId = routeId; 

  

      var coords = [{ lat:pr.origin.lat, lng:pr.origin.lng }].concat(pr.orderedStations.map(function(s){ 

        return { lat:s.lat, lng:s.lng }; 

      })); 

      if(roundtrip){ coords.push({ lat:pr.origin.lat, lng:pr.origin.lng }); } 

      var coordStr = coords.map(function(c){ return c.lng + ',' + c.lat; }).join(';'); 

  

      geometryPromises.push( 

        fetch('https://router.project-osrm.org/route/v1/driving/' + coordStr + '?overview=full&geometries=geojson') 

          .then(function(r){ return r.json(); }) 

          .then(function(data){ 

            if(data.code === 'Ok' && data.routes && data.routes[0]){ 

              route.geometry = data.routes[0].geometry; 

              if(roundtrip){ 

                route.totalDist = data.routes[0].distance;
                route.totalMin = pr.totalMin; 

              } 

            } 

          }) 

          .catch(function(err){ console.error('Route fetch error:', err); }) 

      ); 

    }); 

  

    Promise.all(geometryPromises).finally(function(){ 

      el('proposalsPanel').style.display='none'; 

      el('manifestPanel').style.display='block'; 

      renderAll(); 

    }); 

  } 

  

  // ================= MAP RENDER ================= 

  function pinIcon(label, cls){ 

    return L.divIcon({ className:'', html:'<div class="marker-pin'+(cls?' '+cls:'')+'"><span>'+escapeHtml(label)+'</span></div>', iconSize:[24,24], iconAnchor:[12,24] }); 

  } 

  function renderMap(){ 

    markersLayer.clearLayers(); routeLayer.clearLayers(); 

    var route = state.routes.find(function(r){return r.id===state.activeRouteId;}); 

    if(!route){ 

      state.stations.forEach(function(s){ 

        var m=L.marker([s.lat,s.lng], { icon: pinIcon('','') }); 

        m.bindPopup('<strong>'+escapeHtml(s.name)+'</strong><br><span style="color:#5b5f66;font-size:12px">'+escapeHtml(s.address||'')+'</span>'); 

        markersLayer.addLayer(m); 

      }); 

      return; 

    } 

    var stations = route.order.map(function(id){ return state.stations.find(function(s){return s.id===id;}); }).filter(Boolean); 

    if(route.origin && !route.origin.isStation){ 

      markersLayer.addLayer(L.marker([route.origin.lat,route.origin.lng], { icon: pinIcon('B','base') }).bindPopup('Punkt bazowy')); 

    } 

    stations.forEach(function(s,idx){ 

      var m=L.marker([s.lat,s.lng], { icon: pinIcon(String(idx+1), idx===0?'start':'') }); 

      m.bindPopup('<strong>'+escapeHtml(s.name)+'</strong><br><span style="color:#5b5f66;font-size:12px">'+escapeHtml(s.address||'')+'</span>'); 

      markersLayer.addLayer(m); 

    }); 

    if(route.geometry){ 

      var latlngs = route.geometry.coordinates.map(function(c){return [c[1],c[0]];}); 

      var line=L.polyline(latlngs, { color:'#d81324', weight:3.5, opacity:.85 }).addTo(routeLayer); 

      map.fitBounds(line.getBounds(), { padding:[40,40] }); 

    } else if(stations.length){ 

      map.fitBounds(L.latLngBounds(stations.map(function(s){return [s.lat,s.lng];})), { padding:[40,40] }); 

    } 

  } 

  

  // ================= MANIFEST RENDER ================= 

  function renderManifest(){ 

    var ol=el('manifestList'); var summary=el('manifestSummary'); var empty=el('manifestEmpty'); var exportBtn=el('exportBtn'); 

    ol.innerHTML=''; 

    var route = state.routes.find(function(r){return r.id===state.activeRouteId;}); 

    if(!route){ summary.classList.remove('show'); empty.style.display='block'; exportBtn.disabled=true; return; } 

    empty.style.display='none'; summary.classList.add('show'); 

    var stations = route.order.map(function(id){ return state.stations.find(function(s){return s.id===id;}); }).filter(Boolean); 

    var visitedCount = stations.filter(function(s){return s.visited;}).length; 

    el('sumDist').textContent = fmtDist(route.totalDist); 

    el('sumTime').textContent = fmtMin(route.totalMin); 

    el('sumVisited').textContent = visitedCount+'/'+stations.length; 

  

    var lastDay=0; 

    stations.forEach(function(s,idx){ 

      var dayNo = Math.min((route.dayBreak && route.dayBreak[idx]) || 1, route.days || 3); 

      if(dayNo!==lastDay){ 

        var dh=document.createElement('div'); dh.className='day-header'; dh.textContent='Dzień '+dayNo; 

        ol.appendChild(dh); lastDay=dayNo; 

      } 

      var li=document.createElement('li'); li.className='ticket'+(s.visited?' visited':''); 

      var top=document.createElement('div'); top.className='ticket-top'; 

      var tb=document.createElement('div'); 

      var num=document.createElement('div'); num.className='ticket-num'; 

      num.textContent='Nr '+String(idx+1).padStart(2,'0')+(idx===0?' — START':'')+'  •  waga '+s.risk; 

      var name=document.createElement('div'); name.className='ticket-name'; name.textContent=s.name; 

      tb.appendChild(num); tb.appendChild(name); 

      var stampBtn=document.createElement('button'); stampBtn.className='stamp-btn'+(s.visited?' on':''); 

      stampBtn.innerHTML='<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2"><path d="M5 13l4 4L19 7"/></svg>'; 

      stampBtn.addEventListener('click', function(){ s.visited=!s.visited; renderManifest(); }); 

      top.appendChild(tb); top.appendChild(stampBtn); li.appendChild(top); 

      if(route.legsMin && route.legsMin[idx]!==undefined){ 

        var legEl=document.createElement('div'); legEl.className='ticket-leg'; 

        legEl.innerHTML='<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.8"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7a3 3 0 0 0 3-3v-1a3 3 0 0 0-3-3H9a3 3 0 0 1-3-3V8"/></svg><span>'+fmtMin(route.legsMin[idx])+' dojazdu</span>'; 

        li.appendChild(legEl); 

      } 

      ol.appendChild(li); 

    }); 

    exportBtn.disabled=false; 

  } 

  

  el('exportBtn').addEventListener('click', function(){ 

    var route = state.routes.find(function(r){return r.id===state.activeRouteId;}); 

    if(!route) return; 

    var stations = route.order.map(function(id){ return state.stations.find(function(s){return s.id===id;}); }).filter(Boolean); 

    var rows=[['dzień','nr','nazwa','adres','szerokosc','dlugosc','waga_ryzyka','dojazd_min','skontrolowano']]; 

    stations.forEach(function(s,idx){ 

      rows.push([ (route.dayBreak&&route.dayBreak[idx])||1, idx+1, s.name, s.address||'', s.lat, s.lng, s.risk, route.legsMin&&route.legsMin[idx]!==undefined?Math.round(route.legsMin[idx]):0, s.visited?'tak':'nie' ]); 

    }); 

    var csv = rows.map(function(r){ return r.map(function(c){ return '"'+String(c).replace(/"/g,'""')+'"'; }).join(','); }).join('\n'); 

    var blob=new Blob([csv],{type:'text/csv;charset=utf-8;'}); 

    var url=URL.createObjectURL(blob); 

    var a=document.createElement('a'); a.href=url; a.download=route.name.replace(/\s+/g,'_')+'.csv'; a.click(); 

    URL.revokeObjectURL(url); 

  }); 

  

  function renderAll(){ saveState(); renderStopList(); renderRouteSelect(); renderMap(); renderManifest(); } 

  loadState(); 

  renderAll(); 

})(); 