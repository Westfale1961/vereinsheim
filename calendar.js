/* ICS-Parser und Terminliste. Alle Zeiten werden als "Wanduhrzeit Europe/Berlin"
 * verarbeitet (intern als Millisekunden, die wie UTC behandelt werden). Dadurch gibt es
 * keine Zeitzonen- oder Sommerzeit-Verschiebungen bei der Anzeige. */
(function (root) {
  "use strict";

  var TZ = "Europe/Berlin";
  var DAY = 86400000;
  var WD = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

  /* ---------- Hilfsfunktionen ---------- */

  function unfold(text) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
  }

  function unescapeText(s) {
    return s
      .replace(/\\[nN]/g, "\n")
      .replace(/\\,/g, ",")
      .replace(/\\;/g, ";")
      .replace(/\\\\/g, "\\");
  }

  // "NAME;PARAM=x:WERT" -> {name, params, value}; Doppelpunkte in Anfuehrungszeichen werden ignoriert
  function parseLine(line) {
    var inQuote = false, colon = -1, i;
    for (i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') inQuote = !inQuote;
      else if (c === ":" && !inQuote) { colon = i; break; }
    }
    if (colon < 0) return null;
    var head = line.slice(0, colon), value = line.slice(colon + 1);
    var parts = [], cur = "";
    inQuote = false;
    for (i = 0; i < head.length; i++) {
      var ch = head[i];
      if (ch === '"') inQuote = !inQuote;
      if (ch === ";" && !inQuote) { parts.push(cur); cur = ""; } else cur += ch;
    }
    parts.push(cur);
    var params = {};
    for (i = 1; i < parts.length; i++) {
      var eq = parts[i].indexOf("=");
      if (eq > 0) params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1).replace(/"/g, "");
    }
    return { name: parts[0].toUpperCase(), params: params, value: value };
  }

  var berlinFmt = null;
  // echte UTC-Zeit (ms) -> Berlin-Wanduhrzeit (ms, wie UTC behandelt)
  function utcToBerlinWall(ms) {
    if (!berlinFmt) {
      berlinFmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      });
    }
    var p = {};
    berlinFmt.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  }

  // Wert + Parameter -> {ms, allDay}
  function parseDate(value, params) {
    var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
    if (!m) return null;
    var allDay = !m[4] || (params && params.VALUE === "DATE");
    if (allDay) return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3]), allDay: true };
    var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    if (m[7]) ms = utcToBerlinWall(ms); // "Z" = UTC -> nach Berlin umrechnen
    return { ms: ms, allDay: false };
  }

  function startOfDay(ms) { return Math.floor(ms / DAY) * DAY; }

  /* ---------- ICS lesen ---------- */

  function parseICS(text) {
    var lines = unfold(text).split("\n");
    var raw = [], cur = null;
    lines.forEach(function (l) {
      if (l === "BEGIN:VEVENT") cur = { exdates: [] };
      else if (l === "END:VEVENT") { if (cur) raw.push(cur); cur = null; }
      else if (cur) {
        var p = parseLine(l);
        if (!p) return;
        switch (p.name) {
          case "UID": cur.uid = p.value; break;
          case "SUMMARY": cur.summary = unescapeText(p.value); break;
          case "LOCATION": cur.location = unescapeText(p.value); break;
          case "DESCRIPTION": cur.description = unescapeText(p.value); break;
          case "STATUS": cur.status = p.value.toUpperCase(); break;
          case "DTSTART": cur.start = parseDate(p.value, p.params); break;
          case "DTEND": cur.end = parseDate(p.value, p.params); break;
          case "RRULE": cur.rrule = p.value; break;
          case "RECURRENCE-ID": cur.recId = parseDate(p.value, p.params); break;
          case "EXDATE":
            p.value.split(",").forEach(function (v) {
              var d = parseDate(v, p.params);
              if (d) cur.exdates.push(d.ms);
            });
            break;
        }
      }
    });
    return raw.filter(function (e) { return e.start && e.status !== "CANCELLED"; });
  }

  /* ---------- Wiederholungen ---------- */

  function parseRule(str) {
    var r = {};
    str.split(";").forEach(function (kv) {
      var i = kv.indexOf("=");
      if (i > 0) r[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1);
    });
    return r;
  }

  function nthWeekdayOfMonth(dayMs, n, wd) {
    var d = new Date(dayMs);
    var y = d.getUTCFullYear(), mo = d.getUTCMonth();
    if (n > 0) {
      var first = new Date(Date.UTC(y, mo, 1)).getUTCDay();
      var day = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
      return Date.UTC(y, mo, day);
    }
    var last = new Date(Date.UTC(y, mo + 1, 0));
    var diff = (last.getUTCDay() - wd + 7) % 7;
    return Date.UTC(y, mo, last.getUTCDate() - diff + (n + 1) * 7);
  }

  function expand(ev, horizon, overrides) {
    var startMs = ev.start.ms;
    var dur = ev.end ? ev.end.ms - startMs : 0;
    var base = { uid: ev.uid, summary: ev.summary, location: ev.location,
      description: ev.description, allDay: ev.start.allDay };
    function make(ms) {
      var o = Object.assign({}, base);
      o.start = ms; o.end = dur > 0 ? ms + dur : null;
      return o;
    }
    if (!ev.rrule) return [make(startMs)];

    var r = parseRule(ev.rrule);
    var freq = r.FREQ, interval = Math.max(1, parseInt(r.INTERVAL || "1", 10));
    var count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
    var until = r.UNTIL ? parseDate(r.UNTIL, {}) : null;
    var untilMs = until ? (until.allDay ? until.ms + DAY - 1 : until.ms) : Infinity;
    var byday = r.BYDAY ? r.BYDAY.split(",") : null;
    var bymonthday = r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : null;
    var bymonth = r.BYMONTH ? r.BYMONTH.split(",").map(Number) : null;

    var s0 = startOfDay(startMs), tod = startMs - s0;
    var sd = new Date(s0);
    var weekStart = s0 - ((sd.getUTCDay() + 6) % 7) * DAY; // Montag der Startwoche
    var out = [], n = 0;

    for (var day = s0; day <= horizon && n < count; day += DAY) {
      var d = new Date(day), match = false;
      var wd = d.getUTCDay(), dom = d.getUTCDate(), mon = d.getUTCMonth() + 1;
      if (bymonth && bymonth.indexOf(mon) < 0) continue;
      if (freq === "DAILY") {
        match = Math.round((day - s0) / DAY) % interval === 0;
      } else if (freq === "WEEKLY") {
        var wk = Math.floor((day - weekStart) / (7 * DAY));
        var days = byday ? byday.map(function (b) { return WD.indexOf(b.slice(-2)); }) : [sd.getUTCDay()];
        match = wk % interval === 0 && days.indexOf(wd) >= 0;
      } else if (freq === "MONTHLY") {
        var mdiff = (d.getUTCFullYear() - sd.getUTCFullYear()) * 12 + d.getUTCMonth() - sd.getUTCMonth();
        if (mdiff % interval === 0) {
          if (byday) {
            match = byday.some(function (b) {
              var m = /^([+-]?\d+)?([A-Z]{2})$/.exec(b);
              if (!m) return false;
              var w = WD.indexOf(m[2]);
              if (m[1]) return nthWeekdayOfMonth(day, parseInt(m[1], 10), w) === day;
              return wd === w;
            });
          } else if (bymonthday) {
            match = bymonthday.indexOf(dom) >= 0;
          } else {
            match = dom === sd.getUTCDate();
          }
        }
      } else if (freq === "YEARLY") {
        var ydiff = d.getUTCFullYear() - sd.getUTCFullYear();
        match = ydiff % interval === 0 && dom === sd.getUTCDate() && d.getUTCMonth() === sd.getUTCMonth();
      } else {
        return [make(startMs)]; // unbekannte Regel: nur den ersten Termin zeigen
      }
      if (!match) continue;
      var occ = day + tod;
      if (occ < startMs) continue;
      if (occ > untilMs) break;
      n++;
      if (ev.exdates.indexOf(occ) >= 0) continue;
      if (overrides[(ev.uid || "") + "|" + occ]) continue; // durch geaenderten Einzeltermin ersetzt
      out.push(make(occ));
    }
    return out;
  }

  function buildEvents(text, nowWall) {
    var raw = parseICS(text);
    var horizon = nowWall + 400 * DAY;
    var overrides = {};
    raw.forEach(function (e) { if (e.recId) overrides[(e.uid || "") + "|" + e.recId.ms] = true; });
    var list = [];
    raw.forEach(function (e) {
      if (e.recId) list = list.concat(expand(Object.assign({}, e, { rrule: null }), horizon, overrides));
      else list = list.concat(expand(e, horizon, overrides));
    });
    // Ganztaegig: DTEND ist exklusiv -> letzten echten Tag berechnen
    list.forEach(function (e) {
      if (e.allDay) {
        e.endDay = e.end ? e.end - DAY : e.start;
        if (e.endDay < e.start) e.endDay = e.start;
      } else {
        e.endDay = e.end || e.start;
      }
    });
    list.sort(function (a, b) { return a.start - b.start; });
    return list;
  }

  /* ---------- Darstellung ---------- */

  var fmtDay = new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", day: "numeric" });
  var fmtWd = new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", weekday: "short" });
  var fmtMonth = new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", month: "long", year: "numeric" });
  var fmtLong = new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", day: "numeric", month: "numeric" });
  var fmtTime = new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });

  function timeText(e) {
    if (e.allDay) {
      if (startOfDay(e.endDay) > startOfDay(e.start))
        return fmtLong.format(e.start) + " – " + fmtLong.format(e.endDay);
      return "ganztägig";
    }
    var t = fmtTime.format(e.start) + (e.end && startOfDay(e.end) === startOfDay(e.start) ? " – " + fmtTime.format(e.end) : "") + " Uhr";
    if (e.end && startOfDay(e.end) !== startOfDay(e.start)) t = fmtTime.format(e.start) + " Uhr – " + fmtLong.format(e.end) + " " + fmtTime.format(e.end) + " Uhr";
    return t;
  }

  function el(tag, cls, text) {
    var x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text; // textContent: kein HTML aus dem Feed wird ausgefuehrt
    return x;
  }

  function render(container, events, cfg) {
    container.textContent = "";
    var now = utcToBerlinWall(Date.now());
    var today = startOfDay(now);
    var upcoming = events.filter(function (e) { return startOfDay(e.endDay) >= today; });
    if (cfg.maxEvents) upcoming = upcoming.slice(0, cfg.maxEvents);
    if (!upcoming.length) {
      container.appendChild(el("p", "cal-empty", cfg.emptyText || "Aktuell sind keine Termine eingetragen."));
      return;
    }
    var lastMonth = "";
    upcoming.forEach(function (e) {
      var month = fmtMonth.format(e.start);
      if (month !== lastMonth) {
        container.appendChild(el("h2", "cal-month", month));
        lastMonth = month;
      }
      var item = el("article", "cal-event");
      var date = el("div", "cal-date");
      date.appendChild(el("span", "cal-day", fmtDay.format(e.start)));
      date.appendChild(el("span", "cal-weekday", fmtWd.format(e.start)));
      var body = el("div", "cal-body");
      body.appendChild(el("h3", "cal-title", e.summary || "(ohne Titel)"));
      var meta = el("p", "cal-meta");
      meta.appendChild(el("span", "cal-time", timeText(e)));
      if (e.location) meta.appendChild(el("span", "cal-location", e.location));
      body.appendChild(meta);
      if (cfg.showDescription && e.description && e.description.trim()) {
        var det = el("details", "cal-details");
        det.appendChild(el("summary", null, "Mehr Infos"));
        det.appendChild(el("p", "cal-description", e.description.trim()));
        body.appendChild(det);
      }
      item.appendChild(date);
      item.appendChild(body);
      container.appendChild(item);
    });
  }

  function load(container, cfg) {
    container.appendChild(el("p", "cal-loading", "Termine werden geladen …"));
    fetch(cfg.feedUrl)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (text) {
        render(container, buildEvents(text, utcToBerlinWall(Date.now())), cfg);
      })
      .catch(function () {
        container.textContent = "";
        container.appendChild(el("p", "cal-error", "Die Termine konnten gerade nicht geladen werden. Bitte später erneut versuchen."));
      });
  }

  var api = { parseICS: parseICS, buildEvents: buildEvents, utcToBerlinWall: utcToBerlinWall, load: load, render: render };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VereinsKalender = api;
})(typeof window !== "undefined" ? window : globalThis);
