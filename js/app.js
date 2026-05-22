'use strict';

const API = 'https://gentle-fire-7fad.hi-itsleha.workers.dev/v1';

const TIRE = {
    SOFT:         { color: '#e8002d', abbr: 'S' },
    MEDIUM:       { color: '#ffd800', abbr: 'M' },
    HARD:         { color: '#f0f0f0', abbr: 'H' },
    INTERMEDIATE: { color: '#39b54a', abbr: 'I' },
    WET:          { color: '#0067ff', abbr: 'W' },
    UNKNOWN:      { color: '#555555', abbr: '?' }
};

const FETCH_TIMEOUT = 8_000;

// ── API ────────────────────────────────────────────────────────────────────

async function get(path, fallback = []) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
        const r = await fetch(API + path, { signal: ctrl.signal });
        clearTimeout(timer);
        if (r.status === 429) { console.warn('Rate limited:', path); return fallback; }
        if (!r.ok) throw new Error(r.status);
        return r.json();
    } catch (e) {
        clearTimeout(timer);
        if (e.name !== 'AbortError') console.warn('Fetch failed:', path, e.message);
        return fallback;
    }
}

// ── Lap cache (incremental) ────────────────────────────────────────────────

let cachedLaps = [];
let lapSessionKey = null;

async function fetchLaps(key) {
    if (key !== lapSessionKey) { cachedLaps = []; lapSessionKey = key; }

    if (cachedLaps.length === 0) {
        cachedLaps = await get(`/laps?session_key=${key}`);
        return cachedLaps;
    }

    const lastDate = cachedLaps.map(l => l.date_start).filter(Boolean).sort().at(-1);
    if (lastDate) {
        const fresh = await get(`/laps?session_key=${key}&date_start>=${encodeURIComponent(lastDate)}`);
        const seen = new Set(cachedLaps.map(l => `${l.driver_number}_${l.lap_number}`));
        fresh.forEach(l => {
            const k = `${l.driver_number}_${l.lap_number}`;
            if (!seen.has(k)) { cachedLaps.push(l); seen.add(k); }
        });
    }
    return cachedLaps;
}

// ── Stints cache (TTL) ─────────────────────────────────────────────────────

let cachedStints = [];
let stintsKey = null;
let stintsTs  = 0;
const STINTS_TTL = 45_000;

async function fetchStints(key) {
    if (key !== stintsKey) { cachedStints = []; stintsKey = key; stintsTs = 0; }
    if (cachedStints.length && Date.now() - stintsTs < STINTS_TTL) return cachedStints;
    const fresh = await get(`/stints?session_key=${key}`);
    if (fresh.length) { cachedStints = fresh; stintsTs = Date.now(); }
    return cachedStints;
}

// ── Pits cache (TTL) ───────────────────────────────────────────────────────

let cachedPits = [];
let pitsKey = null;
let pitsTs  = 0;
const PITS_TTL = 45_000;

async function fetchPits(key) {
    if (key !== pitsKey) { cachedPits = []; pitsKey = key; pitsTs = 0; }
    if (cachedPits.length && Date.now() - pitsTs < PITS_TTL) return cachedPits;
    const fresh = await get(`/pit?session_key=${key}`);
    if (fresh.length) { cachedPits = fresh; pitsTs = Date.now(); }
    return cachedPits;
}

// ── Sector color logic ─────────────────────────────────────────────────────

function sectorColor(time, personalBest, sessionBest) {
    if (!time || time <= 0 || !isFinite(sessionBest)) return 'none';
    if (time <= sessionBest + 0.001)                   return 'purple';
    if (isFinite(personalBest) && time <= personalBest + 0.001) return 'green';
    return 'yellow';
}

// ── Data processing ────────────────────────────────────────────────────────

function latestByDriver(arr) {
    const map = {};
    arr.forEach(item => {
        const n = item.driver_number;
        if (!map[n] || item.date > map[n].date) map[n] = item;
    });
    return map;
}

function processData({ drivers, positions, intervals, laps, stints, pits, rc, weather }, session) {
    const posMap = latestByDriver(positions);
    const intMap = latestByDriver(intervals);

    // Group & sort laps
    const lapsByDrv = {};
    laps.forEach(l => (lapsByDrv[l.driver_number] ??= []).push(l));
    Object.values(lapsByDrv).forEach(arr => arr.sort((a, b) => a.lap_number - b.lap_number));

    // Current lap
    let currentLap = 0;
    Object.values(lapsByDrv).forEach(arr => {
        const n = arr.at(-1)?.lap_number ?? 0;
        if (n > currentLap) currentLap = n;
    });

    // Session-best sectors (across all drivers/laps)
    const sessionBestS = { s1: Infinity, s2: Infinity, s3: Infinity };
    // Personal-best sectors per driver
    const personalBestS = {};

    laps.forEach(l => {
        const n = l.driver_number;
        personalBestS[n] ??= { s1: Infinity, s2: Infinity, s3: Infinity };
        (['s1', 's2', 's3']).forEach((k, i) => {
            const field = `duration_sector_${i + 1}`;
            const t = l[field];
            if (t > 0) {
                sessionBestS[k]      = Math.min(sessionBestS[k], t);
                personalBestS[n][k]  = Math.min(personalBestS[n][k], t);
            }
        });
    });

    // Current stints
    const currentStint = {};
    stints.forEach(s => {
        if (!currentStint[s.driver_number] || s.stint_number > currentStint[s.driver_number].stint_number)
            currentStint[s.driver_number] = s;
    });

    // Latest pits
    const latestPit = {};
    pits.forEach(p => {
        if (!latestPit[p.driver_number] || p.lap_number > latestPit[p.driver_number].lap_number)
            latestPit[p.driver_number] = p;
    });

    // Weather
    const wx = weather.length
        ? weather.slice().sort((a, b) => a.date > b.date ? 1 : -1).at(-1)
        : null;

    // Build rows
    const rows = drivers.map(d => {
        const num     = d.driver_number;
        const drvLaps = lapsByDrv[num] ?? [];
        const lastLap = drvLaps.at(-1) ?? null;
        const valid   = drvLaps.filter(l => l.lap_duration > 0 && !l.is_pit_out_lap);
        const bestLap = valid.length ? valid.reduce((b, l) => l.lap_duration < b.lap_duration ? l : b) : null;

        const stint    = currentStint[num];
        const pit      = latestPit[num];
        const tyreLaps = stint && lastLap ? Math.max(0, lastLap.lap_number - stint.lap_start + 1) : null;

        let status = 'ON TRACK';
        if (pit && pit.lap_number >= currentLap - 1 && !pit.pit_duration) status = 'IN PIT';
        else if (lastLap && currentLap - lastLap.lap_number > 3)          status = 'OUT';

        const pb = personalBestS[num] ?? { s1: Infinity, s2: Infinity, s3: Infinity };

        const sectors = lastLap ? {
            s1: { time: lastLap.duration_sector_1, color: sectorColor(lastLap.duration_sector_1, pb.s1, sessionBestS.s1) },
            s2: { time: lastLap.duration_sector_2, color: sectorColor(lastLap.duration_sector_2, pb.s2, sessionBestS.s2) },
            s3: { time: lastLap.duration_sector_3, color: sectorColor(lastLap.duration_sector_3, pb.s3, sessionBestS.s3) }
        } : null;

        return {
            num,
            abbr:     d.name_acronym ?? String(num),
            color:    d.team_colour ? '#' + d.team_colour : '#666',
            position: posMap[num]?.position ?? 99,
            gap:      intMap[num]?.gap_to_leader,
            interval: intMap[num]?.interval,
            lastTime: lastLap?.lap_duration,
            sectors,
            bestTime: bestLap?.lap_duration,
            status,
            compound: stint?.compound ?? 'UNKNOWN',
            tyreLaps
        };
    });

    rows.sort((a, b) => a.position - b.position);

    const times = rows.filter(r => r.bestTime).map(r => r.bestTime);
    const overallBest = times.length ? Math.min(...times) : null;

    return {
        rows, currentLap,
        totalLaps:  session?.total_laps ?? null,
        weather:    wx,
        rc:         rc.slice().sort((a, b) => a.date > b.date ? -1 : 1),
        overallBest
    };
}

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtTime(s) {
    if (!s || s <= 0) return '–';
    const m = Math.floor(s / 60);
    return `${m}:${(s % 60).toFixed(3).padStart(6, '0')}`;
}

function fmtGap(v, pos) {
    if (pos === 1 || v === null || v === undefined) return '–';
    if (typeof v === 'string') return v;
    return v === 0 ? '–' : '+' + v.toFixed(3);
}

function fmtInt(v, pos) {
    if (pos === 1 || v === null || v === undefined) return '–';
    if (typeof v === 'string') return v;
    return v === 0 ? '–' : '+' + v.toFixed(3);
}

function secHTML(sec) {
    const c = sec?.color || 'none';
    const t = (sec?.time > 0) ? sec.time.toFixed(3) : '–';
    return `<span class="sec ${c}"><span class="sec-bar"></span><span class="sec-val">${t}</span></span>`;
}

// ── Tower — incremental render ─────────────────────────────────────────────

function sClass(status) {
    return { 'ON TRACK': 's-track', 'IN PIT': 's-pit', 'OUT': 's-out' }[status] ?? 's-track';
}

function buildRowHTML(r, overallBest) {
    const tire    = TIRE[r.compound] ?? TIRE.UNKNOWN;
    const fastest = r.bestTime && r.bestTime === overallBest;
    const sec     = r.sectors;

    return `
        <span class="col-pos">${r.position < 99 ? r.position : '–'}</span>
        <span class="col-driver">
            <span class="drv-abbr" style="color:${r.color}">${r.abbr}</span>
            <span class="drv-num">${r.num}</span>
        </span>
        <span class="col-status"><span class="s-badge ${sClass(r.status)}">${r.status}</span></span>
        <span class="col-gap">${fmtGap(r.gap, r.position)}</span>
        <span class="col-int">${fmtInt(r.interval, r.position)}</span>
        <span class="col-last">
            <span class="last-time">${fmtTime(r.lastTime)}</span>
            <span class="last-sectors">
                ${secHTML(sec?.s1)}${secHTML(sec?.s2)}${secHTML(sec?.s3)}
            </span>
        </span>
        <span class="col-best${fastest ? ' fastest' : ''}">${fmtTime(r.bestTime)}</span>
        <span class="col-tyre">
            <span class="tyre-dot" style="background:${tire.color}">${tire.abbr}</span>
            <span class="tyre-laps">${r.tyreLaps ?? '–'}</span>
        </span>`;
}

function sectorsChanged(a, b) {
    if (!a && !b) return false;
    if (!a || !b) return true;
    return ['s1', 's2', 's3'].some(k => a[k]?.time !== b[k]?.time || a[k]?.color !== b[k]?.color);
}

function patchRow(el, r, prev, overallBest, prevBest) {
    el.style.borderLeftColor = r.color;
    el.classList.toggle('row-out', r.status === 'OUT');

    if (r.position !== prev.position)
        el.querySelector('.col-pos').textContent = r.position < 99 ? r.position : '–';

    if (r.status !== prev.status) {
        const b = el.querySelector('.s-badge');
        b.textContent = r.status;
        b.className = 's-badge ' + sClass(r.status);
    }

    if (r.gap !== prev.gap)
        el.querySelector('.col-gap').textContent = fmtGap(r.gap, r.position);

    if (r.interval !== prev.interval)
        el.querySelector('.col-int').textContent = fmtInt(r.interval, r.position);

    if (r.lastTime !== prev.lastTime)
        el.querySelector('.last-time').textContent = fmtTime(r.lastTime);

    if (sectorsChanged(r.sectors, prev.sectors)) {
        const secEls = el.querySelectorAll('.sec');
        ['s1', 's2', 's3'].forEach((key, i) => {
            const secEl = secEls[i];
            if (!secEl) return;
            const sec = r.sectors?.[key];
            secEl.className = 'sec ' + (sec?.color || 'none');
            secEl.querySelector('.sec-val').textContent = (sec?.time > 0) ? sec.time.toFixed(3) : '–';
        });
    }

    const fastNow  = r.bestTime && r.bestTime === overallBest;
    const fastPrev = prev.bestTime && prev.bestTime === prevBest;
    if (r.bestTime !== prev.bestTime || fastNow !== fastPrev) {
        const bEl = el.querySelector('.col-best');
        bEl.textContent = fmtTime(r.bestTime);
        bEl.className = 'col-best' + (fastNow ? ' fastest' : '');
    }

    if (r.compound !== prev.compound || r.tyreLaps !== prev.tyreLaps) {
        const tire = TIRE[r.compound] ?? TIRE.UNKNOWN;
        const dot  = el.querySelector('.tyre-dot');
        dot.style.background = tire.color;
        dot.textContent = tire.abbr;
        el.querySelector('.tyre-laps').textContent = r.tyreLaps ?? '–';
    }
}

const rowCache = new Map();
let prevOverallBest = null;

function updateTower(rows, overallBest) {
    const tower = document.getElementById('timing-tower');
    if (!rows.length) { tower.innerHTML = '<div class="info-msg">Нет данных о пилотах</div>'; rowCache.clear(); return; }

    tower.querySelector('.info-msg')?.remove();

    for (const r of rows) {
        let cache = rowCache.get(r.num);
        if (!cache) {
            const el = document.createElement('div');
            el.className = 'tower-row driver-row';
            el.style.borderLeftColor = r.color;
            el.classList.toggle('row-out', r.status === 'OUT');
            el.innerHTML = buildRowHTML(r, overallBest);
            cache = { el, prev: { ...r } };
            rowCache.set(r.num, cache);
        } else {
            patchRow(cache.el, r, cache.prev, overallBest, prevOverallBest);
            cache.prev = { ...r };
        }
        tower.appendChild(cache.el); // moves existing node = reorders without recreation
    }

    prevOverallBest = overallBest;

    const active = new Set(rows.map(r => r.num));
    for (const [num, { el }] of rowCache) {
        if (!active.has(num)) { el.remove(); rowCache.delete(num); }
    }
}

// ── Race Control ───────────────────────────────────────────────────────────

let prevRCCount = 0;

function rcIcon(flag, category) {
    if (category === 'SafetyCar') return '<span class="rc-icon rc-sc">SC</span>';
    if (category === 'Drs')       return '<span class="rc-icon rc-drs">DRS</span>';
    if (flag === 'RED')                              return '<span class="rc-icon rc-red">●</span>';
    if (flag === 'YELLOW' || flag === 'DOUBLE YELLOW') return '<span class="rc-icon rc-yellow">▲</span>';
    if (flag === 'GREEN')                            return '<span class="rc-icon rc-green">●</span>';
    return '<span class="rc-icon rc-info">i</span>';
}

function updateRC(messages) {
    const el = document.getElementById('rc-list');
    if (!messages.length) { el.innerHTML = '<div class="info-msg">Нет сообщений</div>'; prevRCCount = 0; return; }
    if (messages.length === prevRCCount) return;

    el.innerHTML = messages.slice(0, 40).map(m => `
        <div class="rc-msg">
            <span class="rc-lap">Lap ${m.lap_number ?? '–'}</span>
            ${rcIcon(m.flag, m.category)}
            <span class="rc-text">${m.message}</span>
        </div>`).join('');

    prevRCCount = messages.length;
}

// ── Weather ────────────────────────────────────────────────────────────────

function renderWeather(wx) {
    if (!wx) return;
    document.getElementById('w-air').textContent  = wx.air_temperature?.toFixed(0)   ?? '–';
    document.getElementById('w-trk').textContent  = wx.track_temperature?.toFixed(0) ?? '–';
    document.getElementById('w-hum').textContent  = wx.humidity?.toFixed(0)          ?? '–';
    document.getElementById('w-wind').textContent = wx.wind_speed?.toFixed(1)        ?? '–';
}

// ── Refresh (two-phase) ────────────────────────────────────────────────────

let sessionKey   = null;
let sessionData  = null;
let isRefreshing = false;

function dot(state) { document.getElementById('status-dot').className = 'dot-' + state; }

function applyRender(data) {
    document.getElementById('lap-num').textContent   = data.currentLap || '–';
    document.getElementById('lap-total').textContent = data.totalLaps  || '–';
    updateTower(data.rows, data.overallBest);
    updateRC(data.rc);
    renderWeather(data.weather);
    document.getElementById('last-update-label').textContent =
        'Обновлено: ' + new Date().toLocaleTimeString('ru-RU');
}

async function refresh() {
    if (isRefreshing) return;
    isRefreshing = true;
    dot('loading');

    let phase1Data = null;

    try {
        // Session init
        if (!sessionKey) {
            const sessions = await get('/sessions?session_key=latest');
            sessionData = sessions.at(-1);
            if (!sessionData) throw new Error('Нет данных сессии');
            sessionKey = sessionData.session_key;
            document.getElementById('session-name').textContent = sessionData.meeting_name ?? 'RacePulse';
            document.getElementById('session-type').textContent = sessionData.session_name ?? '';
            document.title = (sessionData.meeting_name ?? 'RacePulse') + ' | RacePulse';
        }

        // Phase 1 — fast endpoints: show positions/gaps immediately
        const [drivers, positions, intervals, rc, weather] = await Promise.all([
            get(`/drivers?session_key=${sessionKey}`),
            get(`/position?session_key=${sessionKey}`),
            get(`/intervals?session_key=${sessionKey}`),
            get(`/race_control?session_key=${sessionKey}`),
            get(`/weather?session_key=${sessionKey}`)
        ]);

        const phase1 = processData(
            { drivers, positions, intervals, laps: cachedLaps, stints: cachedStints, pits: cachedPits, rc, weather },
            sessionData
        );
        applyRender(phase1);
        dot('ok');
        phase1Data = { drivers, positions, intervals, rc, weather };

    } catch (err) {
        console.error(err);
        document.getElementById('last-update-label').textContent = 'Ошибка: ' + err.message;
        dot('error');
    } finally {
        // Release lock before Phase 2 so the next 12s tick isn't blocked
        isRefreshing = false;
    }

    // Phase 2 — heavy: laps (sector colors, best times), stints, pits
    // Runs independently — a slow laps response won't freeze future refresh cycles
    if (!phase1Data) return;
    try {
        const [laps, stints, pits] = await Promise.all([
            fetchLaps(sessionKey),
            fetchStints(sessionKey),
            fetchPits(sessionKey)
        ]);

        const phase2 = processData(
            { ...phase1Data, laps, stints, pits },
            sessionData
        );
        applyRender(phase2);
    } catch (err) {
        console.warn('Phase 2 failed:', err.message);
    }
}

// ── Boot ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('refresh-btn').addEventListener('click', refresh);
    refresh();
    setInterval(refresh, 12_000);
});
