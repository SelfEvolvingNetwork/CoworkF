import { calculateTermSessions, calculateTermSessionsWithHistory, getTodayJalali } from "../../src/utils/jalali";

interface Env {
  COWORKING_KV?: any;
  KV?: any;
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
      id: s.id || `shift-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      name: (s.name || s.title || "").trim(),
      weekDays: Array.isArray(s.weekDays) ? s.weekDays : (Array.isArray(s.days) ? s.days : []),
      totalRegular: typeof s.totalRegular === "number" ? s.totalRegular : (typeof s.regularSeats === "number" ? s.regularSeats : 20),
      totalPremium: typeof s.totalPremium === "number" ? s.totalPremium : (typeof s.premiumSeats === "number" ? s.premiumSeats : 5)
    };
  }).filter(Boolean);

  const normalizedMembers = rawMembers.map((m: any) => {
    if (!m || typeof m !== "object") return null;
    return {
      id: m.id || `member-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      fullName: (m.fullName || m.name || "").trim(),
      phone: (m.phone || m.mobile || m.phoneNumber || "").trim()
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
      id: t.id || `term-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      memberId: t.memberId || "",
      shiftId: t.shiftId || "",
      startDate: t.startDate || "",
      endDate: t.endDate || "",
      sessionsCount: typeof t.sessionsCount === "number" ? t.sessionsCount : 12,
      sessions: Array.isArray(t.sessions) ? t.sessions : [],
      deskType: t.deskType || "regular"
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

function getKvStore(env: Env) {
  return env.COWORKING_KV || env.KV || null;
}

async function readDb(env: Env): Promise<DbState> {
  const kv = getKvStore(env);
  if (kv) {
    try {
      const dataStr = await kv.get("database_state");
      if (dataStr) {
        const parsed = JSON.parse(dataStr);
        return migrateAndNormalizeState(parsed);
      }
    } catch (e) {
      console.error("Cloudflare KV read error:", e);
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

  const kv = getKvStore(env);
  if (kv) {
    try {
      await kv.put("database_state", JSON.stringify(cleanState));
    } catch (e) {
      console.error("Cloudflare KV write error:", e);
    }
  }

  inMemoryDb = cleanState;
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
      return jsonResponse({ version: "cf-pages-1.0.0" });
    }

    // Secure Folder Status
    if (path === "/api/secure-folder-status") {
      const kv = getKvStore(env);
      if (kv) {
        return jsonResponse({
          status: "ok",
          kvBound: true,
          diskPath: "پایگاه داده ابری کلودفلر (Cloudflare KV Persisted)",
          source: "cloudflare_kv",
          timestamp: new Date().toISOString()
        });
      } else {
        return jsonResponse({
          status: "unbound",
          kvBound: false,
          diskPath: "حافظه موقت ایج (پایگاه داده KV متصل نشده است)",
          source: "edge_memory",
          error: "پایگاه داده KV در کلودفلر متصل نشده است.",
          timestamp: new Date().toISOString()
        });
      }
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
