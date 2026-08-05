import { calculateTermSessions, calculateTermSessionsWithHistory, getTodayJalali } from "./utils/jalali";

export interface Env {
  COWORKING_DO?: DurableObjectNamespace;
  COWORKING_KV?: KVNamespace;
  KV?: KVNamespace;
  ASSETS?: { fetch: typeof fetch };
}

export interface DbState {
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

  // Unwrap if nested in data, db, state, or backup property
  let raw = input;
  if (raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)) {
    raw = raw.data;
  }
  if (raw.db && typeof raw.db === "object" && !Array.isArray(raw.db)) {
    raw = raw.db;
  }
  if (raw.state && typeof raw.state === "object" && !Array.isArray(raw.state)) {
    raw = raw.state;
  }
  if (raw.backup && typeof raw.backup === "object" && !Array.isArray(raw.backup)) {
    raw = raw.backup;
  }

  const config = raw.config || {};
  const rawShifts = Array.isArray(raw.shifts) ? raw.shifts : [];
  const rawMembers = Array.isArray(raw.members) ? raw.members : [];
  const rawTerms = Array.isArray(raw.terms) ? raw.terms : [];
  
  let rawNotes = raw.sessionNotes || raw.notes || {};
  let rawAttendance = raw.sessionAttendance || raw.attendance || {};
  let rawOverrides = raw.calendarOverrides || raw.overrides || {};

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
    const rawDays = Array.isArray(s.weekDays) ? s.weekDays : (Array.isArray(s.days) ? s.days : []);
    const weekDays = rawDays.map((d: any) => Number(d)).filter((n: number) => !isNaN(n) && n >= 0 && n <= 6);

    return {
      id: String(s.id || `shift-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`),
      name: String(s.name || s.title || "").trim(),
      weekDays,
      totalRegular: typeof s.totalRegular === "number" ? s.totalRegular : (typeof s.regularSeats === "number" ? s.regularSeats : 20),
      totalPremium: typeof s.totalPremium === "number" ? s.totalPremium : (typeof s.premiumSeats === "number" ? s.premiumSeats : 5)
    };
  }).filter(Boolean);

  const normalizedMembers = rawMembers.map((m: any) => {
    if (!m || typeof m !== "object") return null;
    return {
      id: String(m.id || `member-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`),
      fullName: String(m.fullName || m.name || "").trim(),
      phone: String(m.phone || m.mobile || m.phoneNumber || "").trim()
    };
  }).filter(Boolean);

  const normalizedOverrides: Record<string, "holiday" | "working"> = {};
  for (const [key, val] of Object.entries(rawOverrides)) {
    if (val === "holiday" || val === "working") {
      const cleanKey = key.toString().replace(/-/g, '/');
      normalizedOverrides[cleanKey] = val;
    }
  }

  const normalizedTerms = rawTerms.map((t: any) => {
    if (!t || typeof t !== "object") return null;
    const startDate = String(t.startDate || "").trim().replace(/-/g, '/');
    const endDate = String(t.endDate || "").trim().replace(/-/g, '/');
    const rawSessions = Array.isArray(t.sessions) ? t.sessions : [];
    const sessions = rawSessions.map((sess: any) => String(sess).replace(/-/g, '/'));

    return {
      id: String(t.id || `term-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`),
      memberId: String(t.memberId || ""),
      shiftId: String(t.shiftId || ""),
      startDate,
      endDate,
      sessionsCount: typeof t.sessionsCount === "number" ? t.sessionsCount : (typeof t.count === "number" ? t.count : 12),
      sessions,
      deskType: t.deskType === "premium" ? "premium" : "regular"
    };
  }).filter(Boolean);

  const cleanNotes: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawNotes)) {
    if (typeof value === "string") {
      const cleanKey = key.toString().replace(/-/g, '/');
      cleanNotes[cleanKey] = value;
    }
  }

  const cleanAttendance: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawAttendance)) {
    if (typeof value === "string") {
      const cleanKey = key.toString().replace(/-/g, '/');
      cleanAttendance[cleanKey] = value;
    }
  }

  const cleanState: DbState = {
    version: typeof raw.version === "number" ? raw.version : (typeof input.version === "number" ? input.version : 1),
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

export class CoworkingDO {
  ctx: DurableObjectState;
  env: Env;
  inMemoryState: DbState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async readDb(): Promise<DbState> {
    if (this.inMemoryState) {
      return this.inMemoryState;
    }
    const saved = await this.ctx.storage.get<DbState>("database_state");
    if (saved) {
      this.inMemoryState = migrateAndNormalizeState(saved);
      return this.inMemoryState;
    }
    const defaultState = migrateAndNormalizeState(DEFAULT_DB);
    await this.ctx.storage.put("database_state", defaultState);
    this.inMemoryState = defaultState;
    return defaultState;
  }

  async writeDb(state: DbState): Promise<DbState> {
    state.version = (state.version || 0) + 1;
    const cleanState = migrateAndNormalizeState(state);
    cleanState.version = state.version;
    await this.ctx.storage.put("database_state", cleanState);
    this.inMemoryState = cleanState;
    return cleanState;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return jsonResponse({ ok: true });
    }

    try {
      if (path === "/api/health") {
        return jsonResponse({
          status: "ok",
          service: "coworking-manager",
          platform: "cloudflare-durable-objects"
        });
      }

      if (path === "/api/version") {
        return jsonResponse({ version: "cf-do-1.0.0" });
      }

      if (path === "/api/secure-folder-status") {
        return jsonResponse({
          status: "ok",
          doBound: true,
          diskPath: "پایگاه داده ابری کلودفلر (Cloudflare Durable Objects)",
          source: "cloudflare_do",
          timestamp: new Date().toISOString()
        });
      }

      // Read DB
      if (path === "/api/data" && method === "GET") {
        const db = await this.readDb();
        return jsonResponse(db);
      }

      // Update config
      if (path === "/api/config" && method === "POST") {
        const body = await request.json() as any;
        const db = await this.readDb();
        db.config = { ...db.config, ...body.config };
        const updated = await this.writeDb(db);
        return jsonResponse(updated);
      }

      // Shifts CRUD
      if (path === "/api/shifts" && method === "POST") {
        const body = await request.json() as any;
        const db = await this.readDb();
        const newShift = {
          id: body.id || `shift-${Date.now()}`,
          name: (body.name || "").trim(),
          weekDays: body.weekDays || [],
          totalRegular: typeof body.totalRegular === "number" ? body.totalRegular : 20,
          totalPremium: typeof body.totalPremium === "number" ? body.totalPremium : 5,
        };
        db.shifts.push(newShift);
        const updated = await this.writeDb(db);
        return jsonResponse(updated);
      }

      if (path.startsWith("/api/shifts/") && method === "PUT") {
        const id = path.replace("/api/shifts/", "");
        const body = await request.json() as any;
        const db = await this.readDb();
        db.shifts = db.shifts.map((s) => (s.id === id ? { ...s, ...body } : s));
        recalculateAllTerms(db);
        const updated = await this.writeDb(db);
        return jsonResponse(updated);
      }

      if (path.startsWith("/api/shifts/") && method === "DELETE") {
        const id = path.replace("/api/shifts/", "");
        const db = await this.readDb();
        db.shifts = db.shifts.filter((s) => s.id !== id);
        const updated = await this.writeDb(db);
        return jsonResponse(updated);
      }

      // Members CRUD
      if (path === "/api/members" && method === "POST") {
        const body = await request.json() as any;
        const db = await this.readDb();
        const newId = body.id || `member-${Date.now()}`;
        const newMember = {
          id: newId,
          fullName: (body.fullName || "").trim(),
          phone: (body.phone || "").trim(),
        };
        db.members.push(newMember);
        const updated = await this.writeDb(db);
        return jsonResponse({ db: updated, newId });
      }

      if (path.startsWith("/api/members/") && method === "PUT") {
        const id = path.replace("/api/members/", "");
        const body = await request.json() as any;
        const db = await this.readDb();
        db.members = db.members.map((m) => (m.id === id ? { ...m, ...body } : m));
        const updated = await this.writeDb(db);
        return jsonResponse(updated);
      }

      if (path.startsWith("/api/members/") && method === "DELETE") {
        const id = path.replace("/api/members/", "");
        const db = await this.readDb();
        db.members = db.members.filter((m) => m.id !== id);
        const updated = await this.writeDb(db);
        return jsonResponse(updated);
      }

      // Terms CRUD
      if (path === "/api/terms" && method === "POST") {
        const body = await request.json() as any;
        const db = await this.readDb();
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
        const updated = await this.writeDb(db);
        return jsonResponse({ db: updated, newId });
      }

      if (path.startsWith("/api/terms/") && method === "PUT") {
        const id = path.replace("/api/terms/", "");
        const body = await request.json() as any;
        const db = await this.readDb();
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
        const updated = await this.writeDb(db);
        return jsonResponse(updated);
      }

      if (path.startsWith("/api/terms/") && method === "DELETE") {
        const id = path.replace("/api/terms/", "");
        const db = await this.readDb();
        db.terms = db.terms.filter((t) => t.id !== id);
        Object.keys(db.sessionNotes).forEach((key) => {
          if (key.startsWith(`${id}_`)) delete db.sessionNotes[key];
        });
        Object.keys(db.sessionAttendance).forEach((key) => {
          if (key.startsWith(`${id}_`)) delete db.sessionAttendance[key];
        });
        const updated = await this.writeDb(db);
        return jsonResponse(updated);
      }

      // Calendar overrides
      if (path === "/api/overrides" && method === "POST") {
        const body = await request.json() as any;
        const db = await this.readDb();
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
        const updated = await this.writeDb(db);
        return jsonResponse(updated);
      }

      // Notes
      if (path === "/api/notes" && method === "POST") {
        const body = await request.json() as any;
        const db = await this.readDb();
        const key = `${body.termId}_${body.dateStr}`;
        db.sessionNotes[key] = body.note;
        const updated = await this.writeDb(db);
        return jsonResponse(updated);
      }

      // Attendance
      if (path === "/api/attendance" && method === "POST") {
        const body = await request.json() as any;
        const db = await this.readDb();
        const key = `${body.termId}_${body.dateStr}`;
        db.sessionAttendance[key] = body.status;
        const updated = await this.writeDb(db);
        return jsonResponse(updated);
      }

      // Wipe
      if (path === "/api/wipe" && method === "POST") {
        const db = await this.readDb();
        db.config = { totalRegularDesks: 20, totalPremiumDesks: 5 };
        db.shifts = [];
        db.members = [];
        db.terms = [];
        db.sessionNotes = {};
        db.sessionAttendance = {};
        db.calendarOverrides = {};
        const updated = await this.writeDb(db);
        return jsonResponse(updated);
      }

      // Import
      if (path === "/api/import" && method === "POST") {
        const body = await request.json() as any;
        if (!body.data || typeof body.data !== "object") {
          return jsonResponse({ error: "اطلاعات پشتیبان معتبر نمی‌باشد" }, 400);
        }
        const migratedDb = migrateAndNormalizeState(body.data);
        const currentDb = await this.readDb().catch(() => ({ version: 0 }));
        migratedDb.version = (currentDb.version || 0) + 1;
        const updated = await this.writeDb(migratedDb);
        return jsonResponse(updated);
      }

      return jsonResponse({ error: "Endpoint not found" }, 404);
    } catch (err: any) {
      return jsonResponse({ error: err.message || "Internal server error" }, 500);
    }
  }
}
