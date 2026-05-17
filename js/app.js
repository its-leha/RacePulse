'use strict';

const API = 'https://api.openf1.org/v1';

const TIRE = {
    SOFT:         { color: '#e8002d', abbr: 'S' },
    MEDIUM:       { color: '#ffd800', abbr: 'M' },
    HARD:         { color: '#f0f0f0', abbr: 'H' },
    INTERMEDIATE: { color: '#39b54a', abbr: 'I' },
    WET:          { color: '#0067ff', abbr: 'W' },
    UNKNOWN:      { color: '#555555', abbr: '?' }
};

// ── API ────────────────────────────────────────────────────────────────────

async function get(path, fallback = []) {
    try {
        const r = await fetch(API + path);
        if (r.status === 429) { console.warn('Rate limited:', path); return fallback; }
        if (!r.ok) throw new Error(`${r.status} ${path}`);
        return r.json();
    } catch (e) {
        console.warn('Fetch failed:', path, e.message);
        return fallback;
    }
}

// ── Lap cache (incremental fetch to avoid re-loading thousands of rows) ───

let cachedLaps = [];
let lapSessionKey = null;

async function fetchLaps(key) {
    if (key !== lapSessionKey) {
        cachedLaps = [];
        lapSessionKey = key;
    }

    if (cachedLaps.length === 0) {
        cachedLaps = await get(`/laps?session_key=${key}`);
        return cachedLaps;
    }

    // Only fetch laps newer than the latest we have
    const dates = cachedLaps.map(l => l.date_start).filter(Boolean).sort();
    const lastDate = dates[dates.length - 1];
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
    const posMap  = latestByDriver(positions);
    const intMap  = latestByDriver(intervals);

    // Group laps by driver
    const lapsByDrv = {};
    laps.forEach(l => {
        (lapsByDrv[l.driver_number] ??= []).push(l);
    });
    Object.values(lapsByDrv).forEach(arr => arr.sort((a, b) => a.lap_number - b.lap_number));

    // Current race lap
    let currentLap = 0;
    Object.values(lapsByDrv).forEach(arr => {
        const last = arr[arr.length - 1];
        if (last && last.lap_number > currentLap) currentLap = last.lap_number;
    });

    // Current & all stints per driver
    const currentStint = {};
    const allStints    = {};
    stints.forEach(s => {
        (allStints[s.driver_number] ??= []).push(s);
        if (!currentStint[s.driver_number] || s.stint_number > currentStint[s.driver_number].stint_number) {
            currentStint[s.driver_number] = s;
        }
    });

    // Latest pit per driver
    const latestPit = {};
    pits.forEach(p => {
        if (!latestPit[p.driver_number] || p.lap_number > latestPit[p.driver_number].lap_number) {
            latestPit[p.driver_number] = p;
        }
    });

    // Latest weather
    const wx = weather.length ? weather.slice().sort((a, b) => a.date > b.date ? 1 : -1).at(-1) : null;

    // Per-driver rows
    const rows = drivers.map(d => {
        const num      = d.driver_number;
        const drvLaps  = lapsByDrv[num] ?? [];
        const lastLap  = drvLaps.at(-1) ?? null;
        const validLaps = drvLaps.filter(l => l.lap_duration > 0 && !l.is_pit_out_lap);
        const bestLap  = validLaps.length
            ? validLaps.reduce((b, l) => l.lap_duration < b.lap_duration ? l : b)
            : null;

        const stint = currentStint[num];
        const pit   = latestPit[num];

        // Tyre laps on current stint
        const tyreLaps = stint && lastLap
            ? Math.max(0, lastLap.lap_number - stint.lap_start + 1)
            : null;

        // Status heuristic
        let status = 'ON TRACK';
        if (pit && pit.lap_number >= currentLap - 1 && !pit.pit_duration) {
            status = 'IN PIT';
        } else if (lastLap && currentLap - lastLap.lap_number > 3) {
            status = 'OUT';
        }

        return {
            num,
            abbr:      d.name_acronym ?? String(num),
            color:     d.team_colour ? '#' + d.team_colour : '#666666',
            team:      d.team_name ?? '',
            position:  posMap[num]?.position ?? 99,
            gap:       intMap[num]?.gap_to_leader,
            interval:  intMap[num]?.interval,
            lastTime:  lastLap?.lap_duration,
            bestTime:  bestLap?.lap_duration,
            status,
            compound:  stint?.compound ?? 'UNKNOWN',
            tyreLaps,
            tireAge:   stint?.tyre_age_at_start ?? 0,
            stints:    (allStints[num] ?? []).sort((a, b) => a.stint_number - b.stint_number),
            laps:      drvLaps
        };
    });

    rows.sort((a, b) => a.position - b.position);

    // Overall fastest lap (purple highlight)
    const times = rows.filter(r => r.bestTime).map(r => r.bestTime);
    const overallBest = times.length ? Math.min(...times) : null;

    return {
        rows,
        currentLap,
        totalLaps:   session?.total_laps ?? null,
        weather:     wx,
        rc:          rc.slice().sort((a, b) => a.date > b.date ? -1 : 1),
        overallBest
    };
}

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtTime(s) {
    if (!s || s <= 0) return '–';
    const m = Math.floor(s / 60);
    const r = (s % 60).toFixed(3).padStart(6, '0');
    return `${m}:${r}`;
}

function fmtGap(v, pos) {
    if (pos === 1) return '–';
    if (v === null || v === undefined) return '–';
    if (typeof v === 'string') return v;
    return v === 0 ? '–' : '+' + v.toFixed(3);
}

function fmtInt(v, pos) {
    if (pos === 1) return '–';
    if (v === null || v === undefined) return '–';
    if (typeof v === 'string') return v;
    return v === 0 ? '–' : '+' + v.toFixed(3);
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderTower(rows, overallBest) {
    const el = document.getElementById('timing-tower');
    if (!rows.length) { el.innerHTML = '<div class="info-msg">Нет данных о пилотах</div>'; return; }

    el.innerHTML = rows.map(r => {
        const tire = TIRE[r.compound] ?? TIRE.UNKNOWN;
        const isOut = r.status === 'OUT';
        const sClass = { 'ON TRACK': 's-track', 'IN PIT': 's-pit', 'OUT': 's-out' }[r.status] ?? 's-track';
        const fastest = r.bestTime && r.bestTime === overallBest;

        return `<div class="tower-row driver-row ${isOut ? 'row-out' : ''}" style="border-left-color:${r.color}">
            <span class="col-pos">${r.position < 99 ? r.position : '–'}</span>
            <span class="col-driver">
                <span class="drv-abbr" style="color:${r.color}">${r.abbr}</span>
                <span class="drv-num">${r.num}</span>
            </span>
            <span class="col-status"><span class="s-badge ${sClass}">${r.status}</span></span>
            <span class="col-gap">${fmtGap(r.gap, r.position)}</span>
            <span class="col-int">${fmtInt(r.interval, r.position)}</span>
            <span class="col-last">${fmtTime(r.lastTime)}</span>
            <span class="col-best${fastest ? ' fastest' : ''}">${fmtTime(r.bestTime)}</span>
            <span class="col-tyre">
                <span class="tyre-dot" style="background:${tire.color}">${tire.abbr}</span>
                <span class="tyre-laps">${r.tyreLaps ?? '–'}</span>
            </span>
        </div>`;
    }).join('');
}

function rcIcon(flag, category) {
    if (category === 'SafetyCar') return '<span class="rc-icon rc-sc">SC</span>';
    if (category === 'Drs')       return '<span class="rc-icon rc-drs">DRS</span>';
    if (flag === 'RED')                       return '<span class="rc-icon rc-red">●</span>';
    if (flag === 'YELLOW' || flag === 'DOUBLE YELLOW') return '<span class="rc-icon rc-yellow">▲</span>';
    if (flag === 'GREEN')                     return '<span class="rc-icon rc-green">●</span>';
    return '<span class="rc-icon rc-info">i</span>';
}

function renderRC(messages) {
    const el = document.getElementById('rc-list');
    if (!messages.length) { el.innerHTML = '<div class="info-msg">Нет сообщений</div>'; return; }

    el.innerHTML = messages.slice(0, 40).map(m => `
        <div class="rc-msg">
            <span class="rc-lap">Lap ${m.lap_number ?? '–'}</span>
            ${rcIcon(m.flag, m.category)}
            <span class="rc-text">${m.message}</span>
        </div>`).join('');
}

function renderStints(rows) {
    const el = document.getElementById('stints-list');
    const withStints = rows.filter(r => r.stints.length > 0);
    if (!withStints.length) { el.innerHTML = '<div class="info-msg">Нет данных о шинах</div>'; return; }

    el.innerHTML = withStints.map(r => {
        const stintRows = r.stints.map(s => {
            const stintLaps = r.laps.filter(l =>
                l.lap_number >= s.lap_start &&
                (s.lap_end == null || l.lap_number <= s.lap_end)
            );
            const valid = stintLaps.filter(l => l.lap_duration > 0 && !l.is_pit_out_lap);
            const best  = valid.length ? valid.reduce((b, l) => l.lap_duration < b.lap_duration ? l : b) : null;

            const lapsOnTire = s.lap_end != null
                ? s.lap_end - s.lap_start + 1
                : Math.max(0, (r.laps.at(-1)?.lap_number ?? s.lap_start) - s.lap_start + 1);

            const tire = TIRE[s.compound] ?? TIRE.UNKNOWN;

            return `<div class="stint-row">
                <span class="tyre-dot" style="background:${tire.color};width:16px;height:16px;font-size:8px">${tire.abbr}</span>
                <span>${lapsOnTire} кр.</span>
                <span style="color:var(--text-dim)">+${s.tyre_age_at_start}</span>
                <span class="stint-best">${fmtTime(best?.lap_duration)}</span>
            </div>`;
        }).join('');

        return `<div class="driver-stints">
            <div class="stints-drv-header" style="border-left-color:${r.color}">
                <span style="color:${r.color}">${r.abbr}</span>
                <span class="stints-total">Стинтов: ${r.stints.length}</span>
            </div>
            <div class="stint-head">
                <span></span><span>Круги</span><span>Возраст</span><span>Лучший</span>
            </div>
            ${stintRows}
        </div>`;
    }).join('');
}

function renderWeather(wx) {
    if (!wx) return;
    document.getElementById('w-air').textContent  = wx.air_temperature?.toFixed(0)   ?? '–';
    document.getElementById('w-trk').textContent  = wx.track_temperature?.toFixed(0) ?? '–';
    document.getElementById('w-hum').textContent  = wx.humidity?.toFixed(0)          ?? '–';
    document.getElementById('w-wind').textContent = wx.wind_speed?.toFixed(1)        ?? '–';
}

// ── Session / refresh ──────────────────────────────────────────────────────

let sessionKey   = null;
let sessionData  = null;
let isRefreshing = false;

function dot(state) {
    document.getElementById('status-dot').className = 'dot-' + state;
}

async function refresh() {
    if (isRefreshing) return;
    isRefreshing = true;
    dot('loading');

    try {
        // 1. Resolve session
        if (!sessionKey) {
            const sessions = await get('/sessions?session_key=latest');
            sessionData = sessions.at(-1);
            if (!sessionData) throw new Error('Нет данных сессии');
            sessionKey = sessionData.session_key;
            document.getElementById('session-name').textContent =
                sessionData.meeting_name ?? 'RacePulse';
            document.getElementById('session-type').textContent =
                sessionData.session_name ?? '';
            document.title = (sessionData.meeting_name ?? 'RacePulse') + ' | RacePulse';
        }

        // 2. Parallel fetch (laps are incremental)
        const [drivers, positions, intervals, laps, stints, pits, rc, weather] = await Promise.all([
            get(`/drivers?session_key=${sessionKey}`),
            get(`/position?session_key=${sessionKey}`),
            get(`/intervals?session_key=${sessionKey}`),
            fetchLaps(sessionKey),
            get(`/stints?session_key=${sessionKey}`),
            get(`/pit?session_key=${sessionKey}`),
            get(`/race_control?session_key=${sessionKey}`),
            get(`/weather?session_key=${sessionKey}`)
        ]);

        const data = processData({ drivers, positions, intervals, laps, stints, pits, rc, weather }, sessionData);

        // 3. Render
        document.getElementById('lap-num').textContent   = data.currentLap || '–';
        document.getElementById('lap-total').textContent = data.totalLaps  || '–';

        renderTower(data.rows, data.overallBest);
        renderRC(data.rc);
        renderStints(data.rows);
        renderWeather(data.weather);

        document.getElementById('last-update-label').textContent =
            'Обновлено: ' + new Date().toLocaleTimeString('ru-RU');

        dot('ok');
    } catch (err) {
        console.error(err);
        document.getElementById('last-update-label').textContent = 'Ошибка: ' + err.message;
        dot('error');
    } finally {
        isRefreshing = false;
    }
}

// ── Boot ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('refresh-btn').addEventListener('click', refresh);
    refresh();
    setInterval(refresh, 30_000);
});
