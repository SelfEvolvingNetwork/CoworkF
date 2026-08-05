import { calculateTermSessions, calculateTermSessionsWithHistory, getTodayJalali } from "../../src/utils/jalali";

interface Env {
  DB?: any;
  COWORKING_D1?: any;
  d1?: any;
}

interface DbState {
  version: number;
  config: { 
    totalRegularDesks: number; 
    totalPremiumDesks: number;
    academyName?: string;
    academyPhone?: string;
    academyAddress?: string;
    academyLogo?: string;
  };
  shifts: any[];
  members: any[];
  terms: any[];
  sessionNotes: Record<string, string>;
  sessionAttendance: Record<string, string>;
  calendarOverrides: Record<string, "holiday" | "working">;
}

const DEFAULT_DB: DbState = {
  version: 1,
  config: { 
    totalRegularDesks: 20, 
    totalPremiumDesks: 5,
    academyName: "آموزشگاه پرستو",
    academyPhone: "",
    academyAddress: "",
    academyLogo: ""
  },
  shifts: [],
  members: [],
  terms: [],
  sessionNotes: {},
  sessionAttendance: {},
  calendarOverrides: {}
};

let inMemoryDb: DbState | null = null;
let d1Initialized = false;
let lastD1Error: string | null = null;

function recalculateAllTerms(db: DbState) {
  if (!db.terms || !Array.isArray(db.terms)) return;
  const todayDate = getTodayJalali();
  db.terms = db.terms.map((t) => {
    const shift = db.shifts.find((s) => s.id === t.shiftId);
    if (!shift) return t;
    const calc = calculateTermSessionsWithHistory(
      t,
      shift.weekDays,
      db.calendarOverrides,
      todayDate,
      db.sessionAttendance
    );
    return {
      ...t,
      sessions: calc.sessions,
      endDate: calc.endDate,
    };
  });
}

function migrateAndNormalizeState(input: any): DbState {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_DB };
  }

  const config = input.config || {};
  const rawShifts = Array.isArray(input.shifts) ? input.shifts : [];
  const rawMembers = Array.isArray(input.members) ? input.members : [];
  const rawTerms = Array.isArray(input.terms) ? input.terms : [];
  
  let rawNotes = input.sessionNotes || input.notes || {};
  let rawAttendance = input.sessionAttendance || input.attendance || {};
  let rawOverrides = input.calendarOverrides || input.overrides || {};

  if (typeof rawNotes !== "object" || rawNotes === null) rawNotes = {};
  if (typeof rawAttendance !== "object" || rawAttendance === null) rawAttendance = {};
  if (typeof rawOverrides !== "object" || rawOverrides === null) rawOverrides = {};

  const normalizedConfig = {
    totalRegularDesks: typeof config.totalRegularDesks === "number" 
      ? config.totalRegularDesks 
      : (typeof config.totalDesks === "number" ? config.totalDesks : 20),
    totalPremiumDesks: typeof config.totalPremiumDesks === "number" 
      ? config.totalPremiumDesks 
      : 5,
    academyName: typeof config.academyName === "string" ? config.academyName : "آموزشگاه پرستو",
    academyPhone: typeof config.academyPhone === "string" ? config.academyPhone : "",
    academyAddress: typeof config.academyAddress === "string" ? config.academyAddress : "",
    academyLogo: typeof config.academyLogo === "string" ? config.academyLogo : "",
  };

  const normalizedShifts = rawShifts.map((s: any) => {
    if (!s || typeof s !== "object") return null;
    return {
      id: String(s.id || `shift-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`),
      name: String(s.name || s.title || "").trim(),
      weekDays: Array.isArray(s.weekDays) ? s.weekDays : (Array.isArray(s.days) ? s.days : []),
      totalRegular: typeof s.totalRegular === "number" ? s.totalRegular : (typeof s.regularSeats === "number" ? s.regularSeats : 20),
      totalPremium: typeof s.totalPremium === "number" ? s.totalPremium : (typeof s.premiumSeats === "number" ? s.premiumSeats : 5)
    };
  }).filter(Boolean);

  const normalizedMembers = rawMembers.map((m: any) => {
    if (!m || typeof m !== "object") return null;
    return {
      id: String(m.id || `member-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`),
      fullName: String(m.fullName || m.name || "").trim(),
      phone: String(m.phone || m.mobile || m.phoneNumber || "").trim()
    };
  }).filter(Boolean);

  const normalizedOverrides: Record<string, "holiday" | "working"> = {};
  for (const [key, val] of Object.entries(rawOverrides)) {
    if (val === "holiday" || val === "working") {
      normalizedOverrides[key] = val;
    }
  }

  const normalizedTerms = rawTerms.map((t: any) => {
    if (!t || typeof t !== "object") return null;
    return {
      id: String(t.id || `term-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`),
      memberId: String(t.memberId || ""),
      shiftId: String(t.shiftId || ""),
      startDate: String(t.startDate || ""),
      endDate: String(t.endDate || ""),
      sessionsCount: typeof t.sessionsCount === "number" ? t.sessionsCount : 12,
      sessions: Array.isArray(t.sessions) ? t.sessions : [],
      deskType: String(t.deskType || "regular")
    };
  }).filter(Boolean);

  const cleanNotes: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawNotes)) {
    if (typeof value === "string") {
      cleanNotes[key] = value;
    }
  }

  const cleanAttendance: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawAttendance)) {
    if (typeof value === "string") {
      cleanAttendance[key] = value;
    }
  }

  const cleanState: DbState = {
    version: typeof input.version === "number" ? input.version : 1,
    config: normalizedConfig,
    shifts: normalizedShifts,
    members: normalizedMembers,
    terms: normalizedTerms,
    sessionNotes: cleanNotes,
    sessionAttendance: cleanAttendance,
    calendarOverrides: normalizedOverrides
  };

  recalculateAllTerms(cleanState);
  return cleanState;
}

function getD1Store(env: Env) {
  return env.DB || env.COWORKING_D1 || env.d1 || null;
}

const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    week_days TEXT NOT NULL,
    total_regular INTEGER NOT NULL DEFAULT 20,
    total_premium INTEGER NOT NULL DEFAULT 5,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS terms (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    shift_id TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    sessions_count INTEGER NOT NULL DEFAULT 12,
    desk_type TEXT NOT NULL DEFAULT 'regular',
    sessions TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_terms_member ON terms(member_id)`,
  `CREATE INDEX IF NOT EXISTS idx_terms_shift ON terms(shift_id)`,
  `CREATE TABLE IF NOT EXISTS session_notes (
    term_id TEXT NOT NULL,
    date_str TEXT NOT NULL,
    note TEXT NOT NULL,
    PRIMARY KEY (term_id, date_str)
  )`,
  `CREATE TABLE IF NOT EXISTS session_attendance (
    term_id TEXT NOT NULL,
    date_str TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (term_id, date_str)
  )`,
  `CREATE TABLE IF NOT EXISTS calendar_overrides (
    date_str TEXT PRIMARY KEY,
    status TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS db_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`
];

async function ensureD1Tables(d1: any) {
  if (d1Initialized) return;
  for (const stmt of TABLE_STATEMENTS) {
    await d1.prepare(stmt).run();
  }
  d1Initialized = true;
}

async function readD1State(d1: any): Promise<DbState> {
  await ensureD1Tables(d1);

  const [configRows, shiftRows, memberRows, termRows, noteRows, attendanceRows, overrideRows, metaRow] = await Promise.all([
    d1.prepare("SELECT key, value FROM config").all(),
    d1.prepare("SELECT id, name, week_days, total_regular, total_premium FROM shifts").all(),
    d1.prepare("SELECT id, full_name, phone FROM members").all(),
    d1.prepare("SELECT id, member_id, shift_id, start_date, end_date, sessions_count, desk_type, sessions FROM terms").all(),
    d1.prepare("SELECT term_id, date_str, note FROM session_notes").all(),
    d1.prepare("SELECT term_id, date_str, status FROM session_attendance").all(),
    d1.prepare("SELECT date_str, status FROM calendar_overrides").all(),
    d1.prepare("SELECT value FROM db_meta WHERE key = 'version'").first(),
  ]);

  const isD1Empty = (!configRows?.results || configRows.results.length === 0) &&
                    (!shiftRows?.results || shiftRows.results.length === 0) &&
                    (!memberRows?.results || memberRows.results.length === 0) &&
                    (!termRows?.results || termRows.results.length === 0);

  if (isD1Empty) {
    return await writeFullStateToD1(d1, DEFAULT_DB);
  }

  const configObj: any = { ...DEFAULT_DB.config };
  if (configRows && configRows.results) {
    for (const r of configRows.results) {
      if (r.key === "totalRegularDesks" || r.key === "totalPremiumDesks") {
        configObj[r.key] = Number(r.value);
      } else {
        configObj[r.key] = r.value;
      }
    }
  }

  const shifts = (shiftRows?.results || []).map((s: any) => ({
    id: String(s.id),
    name: String(s.name),
    weekDays: typeof s.week_days === "string" ? JSON.parse(s.week_days) : (s.week_days || []),
    totalRegular: typeof s.total_regular === "number" ? s.total_regular : 20,
    totalPremium: typeof s.total_premium === "number" ? s.total_premium : 5,
  }));

  const members = (memberRows?.results || []).map((m: any) => ({
    id: String(m.id),
    fullName: String(m.full_name),
    phone: String(m.phone),
  }));

  const terms = (termRows?.results || []).map((t: any) => ({
    id: String(t.id),
    memberId: String(t.member_id),
    shiftId: String(t.shift_id),
    startDate: String(t.start_date),
    endDate: String(t.end_date),
    sessionsCount: typeof t.sessions_count === "number" ? t.sessions_count : 12,
    deskType: String(t.desk_type || "regular"),
    sessions: typeof t.sessions === "string" ? JSON.parse(t.sessions) : (t.sessions || []),
  }));

  const sessionNotes: Record<string, string> = {};
  if (noteRows && noteRows.results) {
    for (const n of noteRows.results) {
      sessionNotes[`${n.term_id}_${n.date_str}`] = n.note;
    }
  }

  const sessionAttendance: Record<string, string> = {};
  if (attendanceRows && attendanceRows.results) {
    for (const a of attendanceRows.results) {
      sessionAttendance[`${a.term_id}_${a.date_str}`] = a.status;
    }
  }

  const calendarOverrides: Record<string, "holiday" | "working"> = {};
  if (overrideRows && overrideRows.results) {
    for (const o of overrideRows.results) {
      if (o.status === "holiday" || o.status === "working") {
        calendarOverrides[o.date_str] = o.status;
      }
    }
  }

  const version = metaRow ? Number(metaRow.value) : 1;

  const state: DbState = {
    version,
    config: configObj,
    shifts,
    members,
    terms,
    sessionNotes,
    sessionAttendance,
    calendarOverrides,
  };

  recalculateAllTerms(state);
  return state;
}

async function writeFullStateToD1(d1: any, state: DbState): Promise<DbState> {
  await ensureD1Tables(d1);
  state.version = (state.version || 0) + 1;
  const cleanState = migrateAndNormalizeState(state);
  cleanState.version = state.version;

  const batchStmts: any[] = [
    d1.prepare("DELETE FROM config"),
    d1.prepare("DELETE FROM shifts"),
    d1.prepare("DELETE FROM members"),
    d1.prepare("DELETE FROM terms"),
    d1.prepare("DELETE FROM session_notes"),
    d1.prepare("DELETE FROM session_attendance"),
    d1.prepare("DELETE FROM calendar_overrides"),
    d1.prepare("INSERT OR REPLACE INTO db_meta (key, value) VALUES ('version', ?)").bind(String(cleanState.version))
  ];

  for (const [k, v] of Object.entries(cleanState.config)) {
    if (v !== undefined && v !== null) {
      batchStmts.push(d1.prepare("INSERT INTO config (key, value) VALUES (?, ?)").bind(String(k), String(v)));
    }
  }

  for (const s of cleanState.shifts) {
    batchStmts.push(
      d1.prepare("INSERT INTO shifts (id, name, week_days, total_regular, total_premium) VALUES (?, ?, ?, ?, ?)").bind(
        String(s.id || `shift-${Date.now()}`),
        String(s.name || ""),
        JSON.stringify(s.weekDays || []),
        Number(s.totalRegular ?? 20),
        Number(s.totalPremium ?? 5)
      )
    );
  }

  for (const m of cleanState.members) {
    batchStmts.push(
      d1.prepare("INSERT INTO members (id, full_name, phone) VALUES (?, ?, ?)").bind(
        String(m.id || `member-${Date.now()}`),
        String(m.fullName || ""),
        String(m.phone || "")
      )
    );
  }

  for (const t of cleanState.terms) {
    batchStmts.push(
      d1.prepare("INSERT INTO terms (id, member_id, shift_id, start_date, end_date, sessions_count, desk_type, sessions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
        String(t.id || `term-${Date.now()}`),
        String(t.memberId || ""),
        String(t.shiftId || ""),
        String(t.startDate || ""),
        String(t.endDate || ""),
        Number(t.sessionsCount ?? 12),
        String(t.deskType || "regular"),
        JSON.stringify(t.sessions || [])
      )
    );
  }

  for (const [key, note] of Object.entries(cleanState.sessionNotes)) {
    if (typeof note === "string") {
      const parts = key.split("_");
      if (parts.length >= 2) {
        const termId = parts[0];
        const dateStr = parts.slice(1).join("_");
        batchStmts.push(
          d1.prepare("INSERT INTO session_notes (term_id, date_str, note) VALUES (?, ?, ?)").bind(
            String(termId),
            String(dateStr),
            String(note)
          )
        );
      }
    }
  }

  for (const [key, status] of Object.entries(cleanState.sessionAttendance)) {
    if (typeof status === "string") {
      const parts = key.split("_");
      if (parts.length >= 2) {
        const termId = parts[0];
        const dateStr = parts.slice(1).join("_");
        batchStmts.push(
          d1.prepare("INSERT INTO session_attendance (term_id, date_str, status) VALUES (?, ?, ?)").bind(
            String(termId),
            String(dateStr),
            String(status)
          )
        );
      }
    }
  }

  for (const [dateStr, status] of Object.entries(cleanState.calendarOverrides)) {
    if (typeof status === "string") {
      batchStmts.push(
        d1.prepare("INSERT INTO calendar_overrides (date_str, status) VALUES (?, ?)").bind(
          String(dateStr),
          String(status)
        )
      );
    }
  }

  const BATCH_SIZE = 50;
  for (let i = 0; i < batchStmts.length; i += BATCH_SIZE) {
    const chunk = batchStmts.slice(i, i + BATCH_SIZE);
    await d1.batch(chunk);
  }

  return cleanState;
}

async function readDb(env: Env): Promise<DbState> {
  const d1 = getD1Store(env);
  if (d1) {
    try {
      const data = await readD1State(d1);
      lastD1Error = null;
      return data;
    } catch (err: any) {
      console.error("Cloudflare D1 read error:", err);
      lastD1Error = err?.message || String(err);
      throw new Error(`خطا در خواندن از دیتابیس D1 کلودفلر: ${err?.message || String(err)}`);
    }
  }

  if (!inMemoryDb) {
    inMemoryDb = migrateAndNormalizeState(DEFAULT_DB);
  }
  return inMemoryDb;
}

async function writeDb(env: Env, state: DbState): Promise<DbState> {
  state.version = (state.version || 0) + 1;
  const cleanState = migrateAndNormalizeState(state);
  cleanState.version = state.version;

  const d1 = getD1Store(env);
  if (d1) {
    try {
      const saved = await writeFullStateToD1(d1, cleanState);
      lastD1Error = null;
      return saved;
    } catch (err: any) {
      console.error("Cloudflare D1 write error:", err);
      lastD1Error = err?.message || String(err);
      throw new Error(`خطا در ذخیره‌سازی در دیتابیس D1 کلودفلر: ${err?.message || String(err)}`);
    }
  }

  inMemoryDb = cleanState;
  lastD1Error = null;
  return cleanState;
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store, no-cache, must-revalidate, private"
    }
  });
}

export async function onRequest(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") {
    return jsonResponse({ ok: true });
  }

  try {
    // Health Check
    if (path === "/api/health") {
      return jsonResponse({
        status: "ok",
        service: "coworking-manager",
        platform: "cloudflare-pages"
      });
    }

    // Version Check
    if (path === "/api/version") {
      return jsonResponse({ version: "cf-pages-d1-1.0.0" });
    }

    // Secure Folder Status
    if (path === "/api/secure-folder-status") {
      const d1 = getD1Store(env);
      if (d1) {
        try {
          await ensureD1Tables(d1);
          const [mCount, sCount, tCount, cCount, nCount, aCount, oCount] = await Promise.all([
            d1.prepare("SELECT count(*) as count FROM members").first(),
            d1.prepare("SELECT count(*) as count FROM shifts").first(),
            d1.prepare("SELECT count(*) as count FROM terms").first(),
            d1.prepare("SELECT count(*) as count FROM config").first(),
            d1.prepare("SELECT count(*) as count FROM session_notes").first(),
            d1.prepare("SELECT count(*) as count FROM session_attendance").first(),
            d1.prepare("SELECT count(*) as count FROM calendar_overrides").first(),
          ]);

          return jsonResponse({
            status: "ok",
            d1Bound: true,
            diskPath: "پایگاه داده ابری کلودفلر (Cloudflare D1 SQL Database)",
            source: "cloudflare_d1",
            lastError: lastD1Error || null,
            tableCounts: {
              members: Number(mCount?.count ?? 0),
              shifts: Number(sCount?.count ?? 0),
              terms: Number(tCount?.count ?? 0),
              config: Number(cCount?.count ?? 0),
              sessionNotes: Number(nCount?.count ?? 0),
              sessionAttendance: Number(aCount?.count ?? 0),
              calendarOverrides: Number(oCount?.count ?? 0)
            },
            timestamp: new Date().toISOString()
          });
        } catch (d1Err: any) {
          console.error("Cloudflare D1 status check error:", d1Err);
          lastD1Error = d1Err?.message || String(d1Err);
          return jsonResponse({
            status: "error",
            d1Bound: true,
            diskPath: `خطا در اسکیما یا تیبل‌های D1: ${d1Err?.message || "ناشناخته"}`,
            source: "cloudflare_d1_error",
            error: d1Err?.message || "امکان بررسی تیبل‌های D1 وجود ندارد",
            lastError: lastD1Error,
            timestamp: new Date().toISOString()
          });
        }
      }

      return jsonResponse({
        status: "unbound",
        d1Bound: false,
        diskPath: "حافظه موقت ایج (پایگاه داده D1 کلودفلر متصل نشده است)",
        source: "edge_memory",
        error: "پایگاه داده D1 کلودفلر هنوز متصل نشده است. لطفا Binding با متغیر DB را در پنل کلودفلر انجام دهید.",
        timestamp: new Date().toISOString()
      });
    }

    // Data Read
    if (path === "/api/data" && method === "GET") {
      const db = await readDb(env);
      return jsonResponse(db);
    }

    // Config Update
    if (path === "/api/config" && method === "POST") {
      const body = await request.json() as any;
      const db = await readDb(env);
      db.config = { ...db.config, ...body.config };
      const updated = await writeDb(env, db);
      return jsonResponse(updated);
    }

    // SHIFTS
    if (path === "/api/shifts" && method === "POST") {
      const body = await request.json() as any;
      const db = await readDb(env);
      const newShift = {
        id: body.id || `shift-${Date.now()}`,
        name: (body.name || "").trim(),
        weekDays: body.weekDays || [],
        totalRegular: typeof body.totalRegular === "number" ? body.totalRegular : 20,
        totalPremium: typeof body.totalPremium === "number" ? body.totalPremium : 5,
      };
      db.shifts.push(newShift);
      const updated = await writeDb(env, db);
      return jsonResponse(updated);
    }

    if (path.startsWith("/api/shifts/") && method === "PUT") {
      const id = path.replace("/api/shifts/", "");
      const body = await request.json() as any;
      const db = await readDb(env);
      db.shifts = db.shifts.map((s) => (s.id === id ? { ...s, ...body } : s));
      recalculateAllTerms(db);
      const updated = await writeDb(env, db);
      return jsonResponse(updated);
    }

    if (path.startsWith("/api/shifts/") && method === "DELETE") {
      const id = path.replace("/api/shifts/", "");
      const db = await readDb(env);
      db.shifts = db.shifts.filter((s) => s.id !== id);
      const updated = await writeDb(env, db);
      return jsonResponse(updated);
    }

    // MEMBERS
    if (path === "/api/members" && method === "POST") {
      const body = await request.json() as any;
      const db = await readDb(env);
      const newId = body.id || `member-${Date.now()}`;
      const newMember = {
        id: newId,
        fullName: (body.fullName || "").trim(),
        phone: (body.phone || "").trim(),
      };
      db.members.push(newMember);
      const updated = await writeDb(env, db);
      return jsonResponse({ db: updated, newId });
    }

    if (path.startsWith("/api/members/") && method === "PUT") {
      const id = path.replace("/api/members/", "");
      const body = await request.json() as any;
      const db = await readDb(env);
      db.members = db.members.map((m) => (m.id === id ? { ...m, ...body } : m));
      const updated = await writeDb(env, db);
      return jsonResponse(updated);
    }

    if (path.startsWith("/api/members/") && method === "DELETE") {
      const id = path.replace("/api/members/", "");
      const db = await readDb(env);
      db.members = db.members.filter((m) => m.id !== id);
      const updated = await writeDb(env, db);
      return jsonResponse(updated);
    }

    // TERMS
    if (path === "/api/terms" && method === "POST") {
      const body = await request.json() as any;
      const db = await readDb(env);
      const newId = body.id || `term-${Date.now()}`;

      const shiftObj = db.shifts.find((s: any) => s.id === body.shiftId);
      if (!shiftObj) {
        return jsonResponse({ error: "Shift not found" }, 400);
      }

      const sessionsCountVal = typeof body.sessionsCount === "number" ? body.sessionsCount : 12;
      const calc = calculateTermSessions(body.startDate, sessionsCountVal, shiftObj.weekDays, db.calendarOverrides);

      const newTerm = {
        id: newId,
        memberId: body.memberId,
        shiftId: body.shiftId,
        startDate: body.startDate,
        endDate: calc.endDate,
        sessionsCount: sessionsCountVal,
        sessions: calc.sessions,
        deskType: body.deskType || "regular",
      };
      db.terms.push(newTerm);
      const updated = await writeDb(env, db);
      return jsonResponse({ db: updated, newId });
    }

    if (path.startsWith("/api/terms/") && method === "PUT") {
      const id = path.replace("/api/terms/", "");
      const body = await request.json() as any;
      const db = await readDb(env);
      db.terms = db.terms.map((t) => {
        if (t.id === id) {
          const merged = { ...t, ...body };
          const shiftObj = db.shifts.find((s: any) => s.id === merged.shiftId);
          if (shiftObj) {
            const sessionsCountVal = typeof merged.sessionsCount === "number" ? merged.sessionsCount : 12;
            const calc = calculateTermSessionsWithHistory(
              merged,
              shiftObj.weekDays,
              db.calendarOverrides,
              getTodayJalali(),
              db.sessionAttendance
            );
            merged.sessions = calc.sessions;
            merged.endDate = calc.endDate;
            merged.sessionsCount = sessionsCountVal;
          }
          return merged;
        }
        return t;
      });
      const updated = await writeDb(env, db);
      return jsonResponse(updated);
    }

    if (path.startsWith("/api/terms/") && method === "DELETE") {
      const id = path.replace("/api/terms/", "");
      const db = await readDb(env);
      db.terms = db.terms.filter((t) => t.id !== id);
      Object.keys(db.sessionNotes).forEach((key) => {
        if (key.startsWith(`${id}_`)) delete db.sessionNotes[key];
      });
      Object.keys(db.sessionAttendance).forEach((key) => {
        if (key.startsWith(`${id}_`)) delete db.sessionAttendance[key];
      });
      const updated = await writeDb(env, db);
      return jsonResponse(updated);
    }

    // OVERRIDES
    if (path === "/api/overrides" && method === "POST") {
      const body = await request.json() as any;
      const db = await readDb(env);
      const dateStr = body.dateStr;
      const currentStatus = db.calendarOverrides[dateStr];
      if (!currentStatus) {
        db.calendarOverrides[dateStr] = "holiday";
      } else if (currentStatus === "holiday") {
        db.calendarOverrides[dateStr] = "working";
      } else {
        delete db.calendarOverrides[dateStr];
      }
      recalculateAllTerms(db);
      const updated = await writeDb(env, db);
      return jsonResponse(updated);
    }

    // NOTES
    if (path === "/api/notes" && method === "POST") {
      const body = await request.json() as any;
      const db = await readDb(env);
      const key = `${body.termId}_${body.dateStr}`;
      db.sessionNotes[key] = body.note;
      const updated = await writeDb(env, db);
      return jsonResponse(updated);
    }

    // ATTENDANCE
    if (path === "/api/attendance" && method === "POST") {
      const body = await request.json() as any;
      const db = await readDb(env);
      const key = `${body.termId}_${body.dateStr}`;
      db.sessionAttendance[key] = body.status;
      const updated = await writeDb(env, db);
      return jsonResponse(updated);
    }

    // WIPE
    if (path === "/api/wipe" && method === "POST") {
      const db = await readDb(env);
      db.config = { totalRegularDesks: 20, totalPremiumDesks: 5 };
      db.shifts = [];
      db.members = [];
      db.terms = [];
      db.sessionNotes = {};
      db.sessionAttendance = {};
      db.calendarOverrides = {};
      const updated = await writeDb(env, db);
      return jsonResponse(updated);
    }

    // IMPORT
    if (path === "/api/import" && method === "POST") {
      const body = await request.json() as any;
      if (!body.data || typeof body.data !== "object") {
        return jsonResponse({ error: "اطلاعات پشتیبان معتبر نمی‌باشد" }, 400);
      }
      const migratedDb = migrateAndNormalizeState(body.data);
      const currentDb = await readDb(env).catch(() => ({ version: 0 }));
      migratedDb.version = (currentDb.version || 0) + 1;
      const updated = await writeDb(env, migratedDb);
      return jsonResponse(updated);
    }

    return jsonResponse({ error: "Endpoint not found" }, 404);
  } catch (err: any) {
    return jsonResponse({ error: err.message || "Internal server error" }, 500);
  }
}
