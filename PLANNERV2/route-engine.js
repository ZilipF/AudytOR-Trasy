/**
 * OBCHÓD — silnik planowania tras audytowych
 * ---------------------------------------------------------------------------
 * Czysta logika obliczeniowa: bez DOM, bez sieci, bez zależności zewnętrznych.
 * Dzięki temu daje się testować w Node.js w izolacji od interfejsu.
 *
 * Problem: wariant VRP z oknem czasowym delegacji. Dla zbioru stacji o znanych
 * priorytetach (waga ryzyka) i macierzy czasów przejazdu szukamy trasy, która
 * mieści się w limicie dni i maksymalizuje sumę obsłużonych priorytetów.
 *
 * Przebieg:
 *   clusterStations()          → podział stacji między audytorów
 *   buildRouteForCluster()     → trasa dla jednego audytora, dla zadanej liczby dni
 *     └─ constructFeasibleRoute()   → zachłanne wstawianie stacji
 *          ├─ evaluateSchedule()    → podział trasy na dni i test wykonalności
 *          └─ improveFeasibleOrder()→ dopracowanie kolejności metodą 2-opt
 *
 * Publiczne API: window.RouteEngine (zamrożone).
 */
(function(global){
  'use strict';

  /* =========================================================================
     STAŁE — REGUŁY DELEGACJI
     Odwzorowują zasady rozliczania delegacji. Zmiana wpływa bezpośrednio
     na wykonalność planów, więc wymaga potwierdzenia po stronie biznesu.
     ========================================================================= */

  var BASE_DAY_MIN = 8 * 60;   // nominalny dzień pracy — budżet czasu na dzień
  var MAX_DAY_MIN = 11 * 60;   // twardy limit dobowy, żaden dzień go nie przekracza
  var BREAK_MIN = 60;          // przerwa doliczana do każdego dnia z aktywnością

  // Dla delegacji wielodniowych pomijamy stacje bliżej niż ten próg od bazy —
  // nocleg dla stacji „za rogiem" nie ma uzasadnienia kosztowego.
  // Dla planu jednodniowego próg nie obowiązuje.
  var MULTIDAY_MIN_KM_FROM_BASE = 100;

  // Migawka wartości powyżej z chwili wczytania pliku — punkt odniesienia
  // dla resetToDefaultRules() i dla UI trybu rozszerzonego (getDefaultRules()).
  var DEFAULT_RULES = {
    baseDayMin: BASE_DAY_MIN,
    maxDayMin: MAX_DAY_MIN,
    breakMin: BREAK_MIN,
    multidayMinKm: MULTIDAY_MIN_KM_FROM_BASE
  };

  function isPositiveFiniteNumber(value){
    return typeof value === 'number' && isFinite(value) && value > 0;
  }

  function isNonNegativeFiniteNumber(value){
    return typeof value === 'number' && isFinite(value) && value >= 0;
  }

  /**
   * Nadpisuje reguły delegacji (tryb rozszerzony w UI). Przyjmuje tylko
   * pola faktycznie podane i poprawne liczbowo — pozostałe reguły nie
   * są ruszane. Używane przez script.js tuż przed budową planu; przy
   * trybie prostym wywoływane z DEFAULT_RULES, więc silnik zawsze wie,
   * na jakich regułach pracuje.
   *
   * @param {object} overrides { baseDayMin, maxDayMin, breakMin, multidayMinKm }
   */
  function configureRules(overrides){
    overrides = overrides || {};

    if(isPositiveFiniteNumber(overrides.baseDayMin)){ BASE_DAY_MIN = overrides.baseDayMin; }
    if(isPositiveFiniteNumber(overrides.maxDayMin)){ MAX_DAY_MIN = overrides.maxDayMin; }
    if(isNonNegativeFiniteNumber(overrides.breakMin)){ BREAK_MIN = overrides.breakMin; }
    if(isNonNegativeFiniteNumber(overrides.multidayMinKm)){ MULTIDAY_MIN_KM_FROM_BASE = overrides.multidayMinKm; }

    // Zabezpieczenie przed sprzeczną konfiguracją z UI: twardy limit nie
    // może być niższy niż budżet dnia.
    if(MAX_DAY_MIN < BASE_DAY_MIN){ MAX_DAY_MIN = BASE_DAY_MIN; }

    return getRules();
  }

  function resetToDefaultRules(){
    return configureRules(DEFAULT_RULES);
  }

  function getRules(){
    return {
      baseDayMin: BASE_DAY_MIN,
      maxDayMin: MAX_DAY_MIN,
      breakMin: BREAK_MIN,
      multidayMinKm: MULTIDAY_MIN_KM_FROM_BASE
    };
  }

  function getDefaultRules(){
    return {
      baseDayMin: DEFAULT_RULES.baseDayMin,
      maxDayMin: DEFAULT_RULES.maxDayMin,
      breakMin: DEFAULT_RULES.breakMin,
      multidayMinKm: DEFAULT_RULES.multidayMinKm
    };
  }

  /* =========================================================================
     STAŁE — ZAWORY BEZPIECZEŃSTWA WYDAJNOŚCI
     Przy obecnych parametrach (audyt 120 min, dzień 8 h) trasa mieści maks.
     ok. 3 stacji dziennie, więc te limity NIE są w praktyce osiągane, a wyniki
     są identyczne z pełnym przeszukiwaniem — potwierdzone testem na 360
     przypadkach. Chronią przed zawieszeniem UI, gdyby skrócono czas audytu
     albo podniesiono limity dnia: trasy robią się wtedy długie, a pełne
     przeszukiwanie rośnie wielomianowo.
     Obniżanie tych wartości zacznie realnie obcinać jakość planów.
     ========================================================================= */

  var MAX_INSERT_POSITIONS = 24;      // pozycje wstawienia oceniane harmonogramem
  var MAX_CANDIDATES_PER_ROUND = 400; // kandydaci rozważani w jednej rundzie
  var MAX_2OPT_SPAN = 12;             // maks. długość odwracanego odcinka w 2-opt
  var MAX_2OPT_ROUNDS = 6;            // maks. przebiegów pętli poprawiającej
  var MAX_SEEDS = 8;                  // punkty startowe budowy trasy

  /* =========================================================================
     GEOMETRIA
     ========================================================================= */

  /** Odległość w linii prostej między dwoma punktami (haversine), w km. */
  function geoKm(a, b){
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLng = (b.lng - a.lng) * rad;
    var lat1 = a.lat * rad;
    var lat2 = b.lat * rad;
    var h = Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2) * Math.sin(dLng/2);
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
  }

  /** Środek ciężkości grupy stacji; null dla grupy pustej. */
  function groupCenter(group){
    if(!group.length){ return null; }
    return {
      lat: group.reduce(function(sum, station){ return sum + station.lat; }, 0) / group.length,
      lng: group.reduce(function(sum, station){ return sum + station.lng; }, 0) / group.length
    };
  }

  /* =========================================================================
     KLASTROWANIE — PODZIAŁ STACJI MIĘDZY AUDYTORÓW
     ========================================================================= */

  /**
   * Dzieli stacje na k grup: najpierw wybiera rozproszone ziarna (stacje
   * wysokiego ryzyka możliwie odległe od siebie), potem dokłada pozostałe
   * do grupy o najniższym koszcie = odległość + kara za obciążenie.
   * Kara wyrównuje wielkość grup, żeby jeden audytor nie dostał wszystkiego.
   */
  function clusterStations(stations, k){
    if(stations.length <= k){
      return stations.map(function(station){ return [station]; });
    }

    var sorted = stations.slice().sort(function(a, b){
      return (b.risk || 0) - (a.risk || 0);
    });

    // Ziarno 1: najwyższe ryzyko. Kolejne: najdalsze od już wybranych.
    var seeds = [sorted[0]];
    while(seeds.length < k){
      var nextSeed = null;
      var bestMinDistance = -1;

      sorted.forEach(function(station){
        if(seeds.indexOf(station) !== -1){ return; }

        var minDistance = Math.min.apply(null, seeds.map(function(seed){
          return geoKm(station, seed);
        }));

        if(minDistance > bestMinDistance){
          bestMinDistance = minDistance;
          nextSeed = station;
        }
      });

      if(!nextSeed){ break; }
      seeds.push(nextSeed);
    }

    var groups = seeds.map(function(seed){ return [seed]; });
    var assigned = {};
    seeds.forEach(function(seed){ assigned[seed.id] = true; });

    sorted.forEach(function(station){
      if(assigned[station.id]){ return; }

      var bestGroup = 0;
      var bestScore = Infinity;

      groups.forEach(function(group, idx){
        var center = groupCenter(group) || seeds[idx];
        var distance = geoKm(station, center);
        var activeMinutes = group.length * 120;
        var riskLoad = group.reduce(function(sum, item){ return sum + (item.risk || 0); }, 0);
        var loadPenalty = (activeMinutes / 60) * 8 + group.length * 12 + riskLoad * 0.15;
        var score = distance + loadPenalty;

        if(score < bestScore){
          bestScore = score;
          bestGroup = idx;
        }
      });

      groups[bestGroup].push(station);
    });

    return groups.filter(function(group){ return group.length > 0; });
  }

  /* =========================================================================
     HARMONOGRAM — PODZIAŁ TRASY NA DNI
     ========================================================================= */

  function calcBreakMin(activeMin){
    return activeMin > 0 ? BREAK_MIN : 0;
  }

  /**
   * Sprawdza, czy daną kolejność stacji da się zmieścić w `days` dniach,
   * i wybiera najlepszy podział na dni.
   *
   * Powrót do bazy doliczany jest wyłącznie do ostatniego dnia — kontrolerzy
   * nocują tam, gdzie dojadą, i wracają dopiero na koniec delegacji.
   *
   * @param {number[]}   orderedIdx indeksy w macierzy; [0] to zawsze baza
   * @param {number[][]} durMatrix  macierz czasów przejazdu w sekundach
   * @param {number}     auditMin   czas audytu jednej stacji w minutach
   * @param {number}     days       liczba dni delegacji (1–3)
   * @returns {object|null} null, gdy żaden podział nie jest wykonalny
   */
  function evaluateSchedule(orderedIdx, durMatrix, auditMin, days){
    if(!orderedIdx || orderedIdx.length < 2){ return null; }

    var maxTotalMin = days * BASE_DAY_MIN;
    var stationCount = orderedIdx.length - 1;

    // prefix[j] = łączny czas (dojazd + audyt) pierwszych j stacji.
    // Dzięki temu suma dowolnego przedziału dnia liczy się w O(1), zamiast
    // przechodzić pętlą po stacjach przy każdym z ~n² wariantów podziału.
    var prefix = new Array(stationCount + 1);
    prefix[0] = 0;
    for(var i = 1; i <= stationCount; i++){
      prefix[i] = prefix[i-1] + (durMatrix[orderedIdx[i-1]][orderedIdx[i]] / 60) + auditMin;
    }

    var returnMin = durMatrix[orderedIdx[stationCount]][0] / 60;
    var best = null;

    // cuts[d] = indeks pierwszej stacji dnia d+2; dzień 1 zaczyna się od zera.
    function inspectSplit(cuts){
      var dayTotals = [];
      var totalMin = 0;
      var start = 0;

      for(var day = 0; day < days; day++){
        var end = day < cuts.length ? cuts[day] : stationCount;
        var active = prefix[end] - prefix[start];
        if(day === days - 1){ active += returnMin; }

        var total = active + calcBreakMin(active);
        if(total > MAX_DAY_MIN){ return; }

        dayTotals.push(total);
        totalMin += total;
        start = end;
      }

      if(totalMin > maxTotalMin){ return; }

      // Kara za spychanie audytów na ostatni dzień oraz za rosnące obciążenie
      // kolejnych dni — plan ma być ułożony „od najcięższego dnia".
      var lastDayStart = days >= 2 ? (cuts[days-2] || 0) : 0;
      var lastDayAuditCount = stationCount - lastDayStart;

      var score = totalMin + (lastDayAuditCount * 45);
      for(var d = 1; d < dayTotals.length; d++){
        if(dayTotals[d] > dayTotals[d-1]){
          score += (dayTotals[d] - dayTotals[d-1]) * 0.25;
        }
      }

      if(!best || score < best.score){
        // Tablicę przypisania dni budujemy dopiero dla zwycięskiego wariantu.
        best = {
          score: score,
          cuts: cuts.slice(),
          dayTotals: dayTotals,
          totalMin: totalMin,
          returnMin: returnMin
        };
      }
    }

    if(days === 1){
      inspectSplit([]);
    } else if(days === 2){
      for(var cut1 = 1; cut1 <= stationCount; cut1++){
        inspectSplit([cut1]);
      }
    } else {
      for(var first = 1; first <= stationCount; first++){
        for(var second = first; second <= stationCount; second++){
          inspectSplit([first, second]);
        }
      }
    }

    if(!best){ return null; }

    // breakdown[i] = numer dnia (1-based), w którym obsługiwana jest i-ta stacja
    var breakdown = [];
    var segStart = 0;
    for(var day2 = 0; day2 < days; day2++){
      var segEnd = day2 < best.cuts.length ? best.cuts[day2] : stationCount;
      for(var k = segStart; k < segEnd; k++){ breakdown[k] = day2 + 1; }
      segStart = segEnd;
    }

    return {
      score: best.score,
      breakdown: breakdown,
      dayTotals: best.dayTotals,
      totalMin: best.totalMin,
      returnMin: best.returnMin
    };
  }

  /**
   * Przelicza obciążenie dni dla trasy o zadanej kolejności i przypisaniu dni.
   * Używane po ręcznej edycji planu przez planistę — w odróżnieniu od
   * evaluateSchedule nie szuka najlepszego podziału, tylko ocenia ten zadany
   * i mówi, czy mieści się w normach.
   *
   * @param {number[]} legsMin   czasy dojazdu do kolejnych stacji (minuty)
   * @param {number}   auditMin  czas audytu jednej stacji
   * @param {number[]} dayBreak  numer dnia (1-based) dla każdej stacji
   * @param {number}   days      liczba dni delegacji
   * @param {number}   returnMin czas powrotu do bazy, doliczany do ostatniego dnia
   */
  function summarizeDays(legsMin, auditMin, dayBreak, days, returnMin){
    var dayActive = [];
    for(var d = 0; d < days; d++){ dayActive.push(0); }

    for(var i = 0; i < legsMin.length; i++){
      var day = Math.min(Math.max(dayBreak[i] || 1, 1), days) - 1;
      dayActive[day] += legsMin[i] + auditMin;
    }
    dayActive[days-1] += returnMin || 0;

    var dayTotals = dayActive.map(function(active){
      return active + calcBreakMin(active);
    });
    var totalMin = dayTotals.reduce(function(sum, value){ return sum + value; }, 0);

    var overLimitDays = [];
    dayTotals.forEach(function(total, idx){
      if(total > MAX_DAY_MIN){ overLimitDays.push(idx + 1); }
    });

    return {
      dayTotals: dayTotals,
      totalMin: totalMin,
      overLimitDays: overLimitDays,
      overBudget: totalMin > days * BASE_DAY_MIN
    };
  }

  /* =========================================================================
     OCENA JAKOŚCI PLANU
     ========================================================================= */

  function stationByIdx(candidates, idx){
    for(var i = 0; i < candidates.length; i++){
      if(candidates[i].idx === idx){ return candidates[i]; }
    }
    return null;
  }

  /** Suma wag ryzyka stacji w trasie (bez bazy na pozycji 0). */
  function routeRisk(order, candidates){
    var total = 0;
    for(var i = 1; i < order.length; i++){
      var candidate = stationByIdx(candidates, order[i]);
      total += candidate ? (candidate.station.risk || 0) : 0;
    }
    return total;
  }

  /**
   * Jakość planu — im wyżej, tym lepiej. Kolejność wag jest celowa: suma ryzyka
   * dominuje nad liczbą stacji, ta nad czasem, a na końcu korygujemy o spychanie
   * pracy na ostatni dzień i o nierówne obciążenie kolejnych dni.
   */
  function planQuality(order, schedule, candidates){
    if(!schedule){ return -Infinity; }

    var risk = routeRisk(order, candidates);
    var stationCount = order.length - 1;
    var lastDayAudits = schedule.breakdown.filter(function(day){
      return day === schedule.dayTotals.length;
    }).length;

    var imbalance = 0;
    for(var i = 1; i < schedule.dayTotals.length; i++){
      if(schedule.dayTotals[i] > schedule.dayTotals[i-1]){
        imbalance += schedule.dayTotals[i] - schedule.dayTotals[i-1];
      }
    }

    return (risk * 10000) + (stationCount * 800) - schedule.totalMin -
      (lastDayAudits * 120) - (imbalance * 0.35);
  }

  /* =========================================================================
     BUDOWA TRASY — ZACHŁANNE WSTAWIANIE
     ========================================================================= */

  /**
   * Koszt objazdu (w minutach) przy wstawieniu stacji na pozycję `pos`.
   * pos === order.length oznacza wstawienie przed powrotem do bazy (indeks 0).
   */
  function detourMin(order, candidateIdx, pos, durMatrix){
    var prev = order[pos-1];
    var next = pos < order.length ? order[pos] : 0;
    return durMatrix[prev][candidateIdx] + durMatrix[candidateIdx][next] - durMatrix[prev][next];
  }

  /** Najtańsze pozycje wstawienia — tylko one trafiają do oceny harmonogramu. */
  function bestInsertPositions(order, candidateIdx, durMatrix, limit){
    var scored = [];
    for(var pos = 1; pos <= order.length; pos++){
      scored.push({ pos: pos, detour: detourMin(order, candidateIdx, pos, durMatrix) });
    }

    if(scored.length <= limit){
      return scored.map(function(x){ return x.pos; });
    }

    scored.sort(function(a, b){ return a.detour - b.detour; });
    return scored.slice(0, limit).map(function(x){ return x.pos; });
  }

  /** Wstępna selekcja kandydatów: tani ranking wg priorytetu i kosztu objazdu. */
  function shortlistCandidates(order, eligible, used, durMatrix, limit){
    var scored = [];

    eligible.forEach(function(candidate){
      if(used[candidate.idx]){ return; }

      var bestDetour = Infinity;
      for(var pos = 1; pos <= order.length; pos++){
        var d = detourMin(order, candidate.idx, pos, durMatrix);
        if(d < bestDetour){ bestDetour = d; }
      }

      scored.push({
        candidate: candidate,
        score: ((candidate.station.risk || 0) * 1000) - (bestDetour * 0.25)
      });
    });

    if(scored.length <= limit){
      return scored.map(function(x){ return x.candidate; });
    }

    scored.sort(function(a, b){ return b.score - a.score; });
    return scored.slice(0, limit).map(function(x){ return x.candidate; });
  }

  /** Znajduje najlepsze miejsce wstawienia stacji do istniejącej trasy. */
  function tryInsertEverywhere(order, candidateIdx, durMatrix, auditMin, days, candidates){
    var best = null;
    var positions = bestInsertPositions(order, candidateIdx, durMatrix, MAX_INSERT_POSITIONS);

    for(var p = 0; p < positions.length; p++){
      var draft = order.slice();
      draft.splice(positions[p], 0, candidateIdx);

      var schedule = evaluateSchedule(draft, durMatrix, auditMin, days);
      if(!schedule){ continue; }

      var quality = planQuality(draft, schedule, candidates);
      if(!best || quality > best.quality){
        best = { order: draft, schedule: schedule, quality: quality };
      }
    }

    return best;
  }

  /** Poprawa kolejności metodą 2-opt: odwracanie odcinków trasy. */
  function improveFeasibleOrder(order, durMatrix, auditMin, days, candidates){
    var bestOrder = order.slice();
    var bestSchedule = evaluateSchedule(bestOrder, durMatrix, auditMin, days);
    var bestQuality = planQuality(bestOrder, bestSchedule, candidates);
    var improved = true;
    var rounds = 0;

    while(improved && rounds < MAX_2OPT_ROUNDS){
      improved = false;
      rounds++;

      for(var i = 1; i < bestOrder.length - 1; i++){
        for(var j = i + 1; j < bestOrder.length && (j - i) <= MAX_2OPT_SPAN; j++){
          var draft = bestOrder.slice();
          var reversed = draft.slice(i, j+1).reverse();
          draft.splice.apply(draft, [i, j-i+1].concat(reversed));

          var schedule = evaluateSchedule(draft, durMatrix, auditMin, days);
          if(!schedule){ continue; }

          var quality = planQuality(draft, schedule, candidates);
          if(quality > bestQuality){
            bestOrder = draft;
            bestSchedule = schedule;
            bestQuality = quality;
            improved = true;
          }
        }
      }
    }

    return { order: bestOrder, schedule: bestSchedule, quality: bestQuality };
  }

  /**
   * Buduje trasę: dla kilku punktów startowych rozbudowuje ją zachłannie,
   * dokładając stację o najlepszym stosunku priorytetu do kosztu objazdu,
   * dopóki harmonogram pozostaje wykonalny. Zwraca najlepszy wariant.
   */
  function constructFeasibleRoute(candidates, durMatrix, distMatrix, auditMin, days){
    var eligible = candidates.filter(function(candidate){
      var baseKm = (distMatrix[0][candidate.idx] || 0) / 1000;
      return days === 1 || baseKm > MULTIDAY_MIN_KM_FROM_BASE;
    });
    if(!eligible.length){ return null; }

    var seedCandidates = eligible.slice().sort(function(a, b){
      var riskDiff = (b.station.risk || 0) - (a.station.risk || 0);
      if(riskDiff !== 0){ return riskDiff; }
      return durMatrix[0][a.idx] - durMatrix[0][b.idx];
    }).slice(0, Math.min(MAX_SEEDS, eligible.length));

    var bestPlan = null;

    seedCandidates.forEach(function(seed){
      var order = [0, seed.idx];
      var schedule = evaluateSchedule(order, durMatrix, auditMin, days);
      if(!schedule){ return; }

      var used = {};
      used[seed.idx] = true;
      var changed = true;

      while(changed){
        changed = false;
        var bestInsertion = null;
        var shortlist = shortlistCandidates(
          order, eligible, used, durMatrix, MAX_CANDIDATES_PER_ROUND
        );

        shortlist.forEach(function(candidate){
          if(used[candidate.idx]){ return; }

          var insertion = tryInsertEverywhere(
            order, candidate.idx, durMatrix, auditMin, days, candidates
          );
          if(!insertion){ return; }

          var currentQuality = planQuality(order, schedule, candidates);
          var gain = insertion.quality - currentQuality;
          var detourPenalty = Math.max(0, insertion.schedule.totalMin - schedule.totalMin);
          var priority = candidate.station.risk || 0;
          var selectionScore = (priority * 1000) + gain - (detourPenalty * 0.25);

          if(!bestInsertion || selectionScore > bestInsertion.selectionScore){
            bestInsertion = {
              candidate: candidate,
              order: insertion.order,
              schedule: insertion.schedule,
              selectionScore: selectionScore
            };
          }
        });

        if(bestInsertion){
          order = bestInsertion.order;
          schedule = bestInsertion.schedule;
          used[bestInsertion.candidate.idx] = true;
          changed = true;
        }
      }

      var improved = improveFeasibleOrder(order, durMatrix, auditMin, days, candidates);
      var quality = planQuality(improved.order, improved.schedule, candidates);

      if(!bestPlan || quality > bestPlan.quality){
        bestPlan = { order: improved.order, schedule: improved.schedule, quality: quality };
      }
    });

    return bestPlan;
  }

  /* =========================================================================
     API — TRASA DLA JEDNEGO AUDYTORA
     ========================================================================= */

  /**
   * Buduje kompletną trasę dla jednego klastra stacji.
   *
   * @param {object} result   { auditorName, origin, durMatrix, distMatrix, candidates }
   * @param {number} days     liczba dni delegacji (1–3)
   * @param {number} auditMin czas audytu jednej stacji w minutach
   * @returns {object|null}   null, gdy nie da się ułożyć wykonalnej trasy
   */
  function buildRouteForCluster(result, days, auditMin){
    var durMatrix = result.durMatrix;
    var distMatrix = result.distMatrix;
    var candidates = result.candidates;
    if(!candidates || !candidates.length){ return null; }

    var plan = constructFeasibleRoute(candidates, durMatrix, distMatrix, auditMin, days);
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
    for(var i = 1; i < orderedIdx.length; i++){
      legsMin.push(durMatrix[orderedIdx[i-1]][orderedIdx[i]] / 60);
      totalDist += distMatrix[orderedIdx[i-1]][orderedIdx[i]] || 0;
    }
    totalDist += distMatrix[orderedIdx[orderedIdx.length-1]][0] || 0;

    return {
      auditorName: result.auditorName,
      days: days,
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

  /* =========================================================================
     EKSPORT
     Poza funkcjami używanymi przez UI wystawiamy też wewnętrzne kroki —
     pozwala to testować silnik warstwami.
     ========================================================================= */

  var api = {
    geoKm: geoKm,
    clusterStations: clusterStations,
    evaluateSchedule: evaluateSchedule,
    summarizeDays: summarizeDays,
    constructFeasibleRoute: constructFeasibleRoute,
    improveFeasibleOrder: improveFeasibleOrder,
    buildRouteForCluster: buildRouteForCluster,
    // Tryb rozszerzony (UI): script.js woła configureRules() tuż przed
    // budową planu, resetToDefaultRules() w trybie prostym.
    configureRules: configureRules,
    resetToDefaultRules: resetToDefaultRules,
    getRules: getRules,
    getDefaultRules: getDefaultRules
  };

  // BASE_DAY_MIN i pokrewne wystawiamy jako gettery, nie migawki wartości —
  // dzięki temu po configureRules() od razu pokazują bieżącą konfigurację
  // (np. komunikaty UI o przekroczonym limicie dnia). Object.freeze niżej
  // nie przeszkadza getterom zwracać aktualnej wartości zamkniętej w domknięciu.
  Object.defineProperties(api, {
    BASE_DAY_MIN: { enumerable: true, get: function(){ return BASE_DAY_MIN; } },
    MAX_DAY_MIN: { enumerable: true, get: function(){ return MAX_DAY_MIN; } },
    BREAK_MIN: { enumerable: true, get: function(){ return BREAK_MIN; } },
    MULTIDAY_MIN_KM_FROM_BASE: { enumerable: true, get: function(){ return MULTIDAY_MIN_KM_FROM_BASE; } }
  });

  global.RouteEngine = Object.freeze(api);
})(window);
