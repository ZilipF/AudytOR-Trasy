(function(global){
  'use strict';

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

function groupCenter(group){
  if(!group.length){ return null; }
  return {
    lat: group.reduce(function(sum, station){ return sum + station.lat; }, 0) / group.length,
    lng: group.reduce(function(sum, station){ return sum + station.lng; }, 0) / group.length
  };
}

function clusterStations(stations, k){
  if(stations.length <= k){ return stations.map(function(station){ return [station]; }); }

  var sorted = stations.slice().sort(function(a,b){
    return (b.risk || 0) - (a.risk || 0);
  });
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

    function stationByIdx(candidates, idx){
    for(var i=0; i<candidates.length; i++){
      if(candidates[i].idx === idx){ return candidates[i]; }
    }
    return null;
  }

  function routeRisk(order, candidates){
    var total = 0;
    for(var i=1; i<order.length; i++){
      var candidate = stationByIdx(candidates, order[i]);
      total += candidate ? (candidate.station.risk || 0) : 0;
    }
    return total;
  }

  function planQuality(order, schedule, candidates){
    if(!schedule){ return -Infinity; }
    var risk = routeRisk(order, candidates);
    var stationCount = order.length - 1;
    var lastDayAudits = schedule.breakdown.filter(function(day){
      return day === schedule.dayTotals.length;
    }).length;
    var imbalance = 0;
    for(var i=1; i<schedule.dayTotals.length; i++){
      if(schedule.dayTotals[i] > schedule.dayTotals[i-1]){
        imbalance += schedule.dayTotals[i] - schedule.dayTotals[i-1];
      }
    }
    return (risk * 10000) + (stationCount * 800) - schedule.totalMin -
      (lastDayAudits * 120) - (imbalance * 0.35);
  }

  function tryInsertEverywhere(order, candidateIdx, durMatrix, auditMin, days, candidates){
    var best = null;
    for(var pos=1; pos<=order.length; pos++){
      var draft = order.slice();
      draft.splice(pos, 0, candidateIdx);
      var schedule = evaluateSchedule(draft, durMatrix, auditMin, days);
      if(!schedule){ continue; }
      var quality = planQuality(draft, schedule, candidates);
      if(!best || quality > best.quality){
        best = { order:draft, schedule:schedule, quality:quality };
      }
    }
    return best;
  }

  function constructFeasibleRoute(candidates, durMatrix, distMatrix, auditMin, days){
    var eligible = candidates.filter(function(candidate){
      var baseKm = (distMatrix[0][candidate.idx] || 0) / 1000;
      return days === 1 || baseKm > 100;
    });
    if(!eligible.length){ return null; }

    var seedCandidates = eligible.slice().sort(function(a,b){
      var riskDiff = (b.station.risk || 0) - (a.station.risk || 0);
      if(riskDiff !== 0){ return riskDiff; }
      return durMatrix[0][a.idx] - durMatrix[0][b.idx];
    }).slice(0, Math.min(8, eligible.length));

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

        eligible.forEach(function(candidate){
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
              candidate:candidate,
              order:insertion.order,
              schedule:insertion.schedule,
              quality:insertion.quality,
              selectionScore:selectionScore
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
      order = improved.order;
      schedule = improved.schedule;
      var quality = planQuality(order, schedule, candidates);

      if(!bestPlan || quality > bestPlan.quality){
        bestPlan = { order:order, schedule:schedule, quality:quality };
      }
    });

    return bestPlan;
  }

  function improveFeasibleOrder(order, durMatrix, auditMin, days, candidates){
    var bestOrder = order.slice();
    var bestSchedule = evaluateSchedule(bestOrder, durMatrix, auditMin, days);
    var bestQuality = planQuality(bestOrder, bestSchedule, candidates);
    var improved = true;
    var rounds = 0;

    while(improved && rounds < 6){
      improved = false;
      rounds++;
      for(var i=1; i<bestOrder.length-1; i++){
        for(var j=i+1; j<bestOrder.length; j++){
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

    return { order:bestOrder, schedule:bestSchedule, quality:bestQuality };
  }

  var BASE_DAY_MIN = 8 * 60;
  var MAX_DAY_MIN = 11 * 60;
  var BREAK_MIN = 60;

  function calcBreakMin(activeMin){
    return activeMin > 0 ? BREAK_MIN : 0;
  }

  function evaluateSchedule(orderedIdx, durMatrix, auditMin, days){
    if(!orderedIdx || orderedIdx.length < 2){ return null; }

    var maxTotalMin = days * BASE_DAY_MIN;
    var stationCount = orderedIdx.length - 1;
    var services = [];

    for(var i=1; i<orderedIdx.length; i++){
      services.push({
        stationIdx: orderedIdx[i],
        legMin: durMatrix[orderedIdx[i-1]][orderedIdx[i]] / 60,
        workMin: (durMatrix[orderedIdx[i-1]][orderedIdx[i]] / 60) + auditMin
      });
    }

    var returnMin = durMatrix[orderedIdx[orderedIdx.length-1]][0] / 60;
    var best = null;

    function inspectSplit(cuts){
      var dayActive = [];
      var dayBreak = [];
      var start = 0;

      for(var day=0; day<days; day++){
        var end = day < cuts.length ? cuts[day] : stationCount;
        var active = 0;
        for(var j=start; j<end; j++) active += services[j].workMin;
        dayActive.push(active);
        for(var k=start; k<end; k++) dayBreak[k] = day + 1;
        start = end;
      }

      dayActive[days-1] += returnMin;
      var dayTotals = dayActive.map(function(active){
        return active + calcBreakMin(active);
      });
      var totalMin = dayTotals.reduce(function(sum, value){ return sum + value; }, 0);

      if(dayTotals.some(function(value){ return value > MAX_DAY_MIN; })) return;
      if(totalMin > maxTotalMin) return;

      var lastDayAuditCount = dayBreak.filter(function(value){ return value === days; }).length;
      var score = totalMin + (lastDayAuditCount * 45);
      for(var d=1; d<dayTotals.length; d++){
        if(dayTotals[d] > dayTotals[d-1]) score += (dayTotals[d] - dayTotals[d-1]) * 0.25;
      }

      if(!best || score < best.score){
        best = {
          score: score,
          breakdown: dayBreak,
          dayTotals: dayTotals,
          totalMin: totalMin,
          returnMin: returnMin
        };
      }
    }

    if(days === 1){
      inspectSplit([]);
    }else if(days === 2){
      for(var cut1=1; cut1<=stationCount; cut1++) inspectSplit([cut1]);
    }else{
      for(var first=1; first<=stationCount; first++){
        for(var second=first; second<=stationCount; second++) inspectSplit([first, second]);
      }
    }

    return best;
  }

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


  global.RouteEngine = Object.freeze({
    BASE_DAY_MIN: BASE_DAY_MIN,
    MAX_DAY_MIN: MAX_DAY_MIN,
    BREAK_MIN: BREAK_MIN,
    geoKm: geoKm,
    clusterStations: clusterStations,
    evaluateSchedule: evaluateSchedule,
    constructFeasibleRoute: constructFeasibleRoute,
    improveFeasibleOrder: improveFeasibleOrder,
    buildRouteForCluster: buildRouteForCluster
  });
})(window);
