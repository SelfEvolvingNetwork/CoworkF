import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs/promises";
import fsSync from "fs";
import { DatabaseSync } from "node:sqlite";
import { calculateTermSessions, calculateTermSessionsWithHistory, getTodayJalali } from "./src/utils/jalali";

let DB_DIR = path.join(process.cwd(), "my");
let DB_PATH = path.join(DB_DIR, "database.json");
let SQLITE_PATH = path.join(DB_DIR, "database.sqlite");
let dirSource = "fallback_local";

let serverVersion = "dev";
let sqliteDb: DatabaseSync | null = null;

async function detectVersion() {
  try {
    const distIndexPath = path.join(process.cwd(), "dist", "index.html");
    const stats = await fs.stat(distIndexPath);
    serverVersion = `prod-${stats.mtime.getTime()}`;
    console.log(`Detected production version from dist/index.html mtime: ${serverVersion}`);
  } catch (err) {
    serverVersion = `dev-${Date.now()}`;
    console.log(`Fallback version generated for development: ${serverVersion}`);
  }
}

async function initDbDirectory() {
  const envPath = process.env.UPLOAD_PATH;
  if (envPath) {
    try {
      await fs.mkdir(envPath, { recursive: true });
      const testFile = path.join(envPath, ".test-write");
      await fs.writeFile(testFile, "test", "utf-8");
      await fs.unlink(testFile);
      DB_DIR = envPath;
      dirSource = "env";
      console.log(`Successfully verified and initialized storage at UPLOAD_PATH: ${DB_DIR}`);
    } catch (err) {
      console.error(`Warning: UPLOAD_PATH (${envPath}) is not writable. Falling back to local folder.`, err);
      DB_DIR = path.join(process.cwd(), "my");
      dirSource = "fallback_local";
    }
  } else {
    try {
      await fs.mkdir("/my", { recursive: true });
      const testFile = path.join("/my", ".test-write");
      await fs.writeFile(testFile, "test", "utf-8");
      await fs.unlink(testFile);
      DB_DIR = "/my";
      dirSource = "default";
      console.log(`Successfully verified and initialized storage at default /my: ${DB_DIR}`);
    } catch (err) {
      console.warn(`Warning: Default path /my is not writable. Falling back to local project folder ./my.`);
      DB_DIR = path.join(process.cwd(), "my");
      dirSource = "fallback_local";
    }
  }
  DB_PATH = path.join(DB_DIR, "database.json");
  SQLITE_PATH = path.join(DB_DIR, "database.sqlite");
}

function getSqliteDb(): DatabaseSync {
  if (!sqliteDb) {
    sqliteDb = new DatabaseSync(SQLITE_PATH);
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS shifts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        week_days TEXT NOT NULL,
        total_regular INTEGER NOT NULL DEFAULT 20,
        total_premium INTEGER NOT NULL DEFAULT 5,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS terms (
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
      );
      CREATE INDEX IF NOT EXISTS idx_terms_member ON terms(member_id);
      CREATE INDEX IF NOT EXISTS idx_terms_shift ON terms(shift_id);

      CREATE TABLE IF NOT EXISTS session_notes (
        term_id TEXT NOT NULL,
        date_str TEXT NOT NULL,
        note TEXT NOT NULL,
        PRIMARY KEY (term_id, date_str)
      );

      CREATE TABLE IF NOT EXISTS session_attendance (
        term_id TEXT NOT NULL,
        date_str TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (term_id, date_str)
      );

      CREATE TABLE IF NOT EXISTS calendar_overrides (
        date_str TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS db_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
  return sqliteDb;
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

class DbQueue {
  private queue: Promise<any> = Promise.resolve();

  async run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op);
    this.queue = next.catch(() => {});
    return next;
  }
}

const dbQueue = new DbQueue();

function readSqliteState(): DbState {
  const db = getSqliteDb();

  const configRows = db.prepare("SELECT key, value FROM config").all() as any[];
  const shiftRows = db.prepare("SELECT id, name, week_days, total_regular, total_premium FROM shifts").all() as any[];
  const memberRows = db.prepare("SELECT id, full_name, phone FROM members").all() as any[];
  const termRows = db.prepare("SELECT id, member_id, shift_id, start_date, end_date, sessions_count, desk_type, sessions FROM terms").all() as any[];
  const noteRows = db.prepare("SELECT term_id, date_str, note FROM session_notes").all() as any[];
  const attendanceRows = db.prepare("SELECT term_id, date_str, status FROM session_attendance").all() as any[];
  const overrideRows = db.prepare("SELECT date_str, status FROM calendar_overrides").all() as any[];
  const metaRow = db.prepare("SELECT value FROM db_meta WHERE key = 'version'").get() as any;

  if (shiftRows.length === 0 && memberRows.length === 0 && termRows.length === 0 && configRows.length === 0) {
    try {
      if (fsSync.existsSync(DB_PATH)) {
        const jsonContent = fsSync.readFileSync(DB_PATH, "utf-8");
        const parsed = JSON.parse(jsonContent);
        const migrated = migrateAndNormalizeState(parsed);
        writeSqliteState(migrated);
        return migrated;
      }
    } catch (e) {
      console.error("Failed to migrate database.json to sqlite:", e);
    }
  }

  const configObj: any = { ...DEFAULT_DB.config };
  for (const r of configRows) {
    if (r.key === "totalRegularDesks") configObj.totalRegularDesks = Number(r.value);
    else if (r.key === "totalPremiumDesks") configObj.totalPremiumDesks = Number(r.value);
    else if (r.key === "academyName") configObj.academyName = r.value;
    else if (r.key === "academyPhone") configObj.academyPhone = r.value;
    else if (r.key === "academyAddress") configObj.academyAddress = r.value;
    else if (r.key === "academyLogo") configObj.academyLogo = r.value;
  }

  const shifts = shiftRows.map((s) => ({
    id: s.id,
    name: s.name,
    weekDays: typeof s.week_days === "string" ? JSON.parse(s.week_days) : (s.week_days || []),
    totalRegular: typeof s.total_regular === "number" ? s.total_regular : 20,
    totalPremium: typeof s.total_premium === "number" ? s.total_premium : 5,
  }));

  const members = memberRows.map((m) => ({
    id: m.id,
    fullName: m.full_name,
    phone: m.phone,
  }));

  const terms = termRows.map((t) => ({
    id: t.id,
    memberId: t.member_id,
    shiftId: t.shift_id,
    startDate: t.start_date,
    endDate: t.end_date,
    sessionsCount: typeof t.sessions_count === "number" ? t.sessions_count : 12,
    deskType: t.desk_type || "regular",
    sessions: typeof t.sessions === "string" ? JSON.parse(t.sessions) : (t.sessions || []),
  }));

  const sessionNotes: Record<string, string> = {};
  for (const n of noteRows) {
    sessionNotes[`${n.term_id}_${n.date_str}`] = n.note;
  }

  const sessionAttendance: Record<string, string> = {};
  for (const a of attendanceRows) {
    sessionAttendance[`${a.term_id}_${a.date_str}`] = a.status;
  }

  const calendarOverrides: Record<string, "holiday" | "working"> = {};
  for (const o of overrideRows) {
    if (o.status === "holiday" || o.status === "working") {
      calendarOverrides[o.date_str] = o.status;
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

function writeSqliteState(state: DbState): DbState {
  const db = getSqliteDb();
  state.version = (state.version || 0) + 1;
  const cleanState = migrateAndNormalizeState(state);
  cleanState.version = state.version;

  db.exec("BEGIN TRANSACTION;");
  try {
    db.exec("DELETE FROM config;");
    db.exec("DELETE FROM shifts;");
    db.exec("DELETE FROM members;");
    db.exec("DELETE FROM terms;");
    db.exec("DELETE FROM session_notes;");
    db.exec("DELETE FROM session_attendance;");
    db.exec("DELETE FROM calendar_overrides;");

    const metaStmt = db.prepare("INSERT INTO db_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    metaStmt.run(String(cleanState.version));

    const configStmt = db.prepare("INSERT INTO config (key, value) VALUES (?, ?)");
    for (const [k, v] of Object.entries(cleanState.config)) {
      if (v !== undefined && v !== null) {
        configStmt.run(k, String(v));
      }
    }

    const shiftStmt = db.prepare("INSERT INTO shifts (id, name, week_days, total_regular, total_premium) VALUES (?, ?, ?, ?, ?)");
    for (const s of cleanState.shifts) {
      shiftStmt.run(
        s.id,
        s.name,
        JSON.stringify(s.weekDays || []),
        s.totalRegular ?? 20,
        s.totalPremium ?? 5
      );
    }

    const memberStmt = db.prepare("INSERT INTO members (id, full_name, phone) VALUES (?, ?, ?)");
    for (const m of cleanState.members) {
      memberStmt.run(m.id, m.fullName, m.phone);
    }

    const termStmt = db.prepare("INSERT INTO terms (id, member_id, shift_id, start_date, end_date, sessions_count, desk_type, sessions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const t of cleanState.terms) {
      termStmt.run(
        t.id,
        t.memberId,
        t.shiftId,
        t.startDate,
        t.endDate,
        t.sessionsCount,
        t.deskType || "regular",
        JSON.stringify(t.sessions || [])
      );
    }

    const noteStmt = db.prepare("INSERT INTO session_notes (term_id, date_str, note) VALUES (?, ?, ?)");
    for (const [key, note] of Object.entries(cleanState.sessionNotes)) {
      const parts = key.split("_");
      if (parts.length >= 2) {
        noteStmt.run(parts[0], parts.slice(1).join("_"), note);
      }
    }

    const attendanceStmt = db.prepare("INSERT INTO session_attendance (term_id, date_str, status) VALUES (?, ?, ?)");
    for (const [key, status] of Object.entries(cleanState.sessionAttendance)) {
      const parts = key.split("_");
      if (parts.length >= 2) {
        attendanceStmt.run(parts[0], parts.slice(1).join("_"), status);
      }
    }

    const overrideStmt = db.prepare("INSERT INTO calendar_overrides (date_str, status) VALUES (?, ?)");
    for (const [dateStr, status] of Object.entries(cleanState.calendarOverrides)) {
      overrideStmt.run(dateStr, status);
    }

    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }

  try {
    fsSync.writeFileSync(DB_PATH, JSON.stringify(cleanState, null, 2), "utf-8");
  } catch (e) {}

  return cleanState;
}

async function readDb(): Promise<DbState> {
  return dbQueue.run(async () => {
    try {
      await fs.mkdir(DB_DIR, { recursive: true });
    } catch (e) {}
    return readSqliteState();
  });
}

async function writeDb(state: DbState): Promise<DbState> {
  return dbQueue.run(async () => {
    try {
      await fs.mkdir(DB_DIR, { recursive: true });
    } catch (e) {}
    return writeSqliteState(state);
  });
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  await detectVersion();
  await initDbDirectory();

  try {
    await fs.mkdir(DB_DIR, { recursive: true });
    console.log(`Directory ${DB_DIR} verified/created.`);
  } catch (err) {
    console.error(`Warning: Failed to create DB_DIR: ${DB_DIR}`, err);
  }

  app.use(express.json({ limit: "10mb" }));

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", service: "coworking-manager" });
  });

  app.get("/api/version", (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.json({ version: serverVersion });
  });

  app.get("/api/secure-folder-status", async (req, res) => {
    try {
      res.json({
        status: "ok",
        sqliteBound: true,
        diskPath: SQLITE_PATH,
        source: dirSource,
        timestamp: new Date().toISOString()
      });
    } catch (err: any) {
      res.status(500).json({
        status: "error",
        diskPath: DB_DIR,
        source: dirSource,
        error: err.message
      });
    }
  });

  app.get("/api/data", async (req, res) => {
    try {
      const db = await readDb();
      res.json(db);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/config", async (req, res) => {
    try {
      const { config } = req.body;
      const db = await readDb();
      db.config = { ...db.config, ...config };
      await writeDb(db);
      res.json(db);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/shifts", async (req, res) => {
    try {
      const { id, name, weekDays, totalRegular, totalPremium } = req.body;
      const db = await readDb();
      const newShift = {
        id: id || `shift-${Date.now()}`,
        name: (name || "").trim(),
        weekDays: weekDays || [],
        totalRegular: typeof totalRegular === "number" ? totalRegular : 20,
        totalPremium: typeof totalPremium === "number" ? totalPremium : 5,
      };
      db.shifts.push(newShift);
      await writeDb(db);
      res.json(db);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/shifts/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const updated = req.body;
      const db = await readDb();
      db.shifts = db.shifts.map((s) => (s.id === id ? { ...s, ...updated } : s));
      recalculateAllTerms(db);
      await writeDb(db);
      res.json(db);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/shifts/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const db = await readDb();
      db.shifts = db.shifts.filter((s) => s.id !== id);
      await writeDb(db);
      res.json(db);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/members", async (req, res) => {
    try {
      const { id, fullName, phone } = req.body;
      const db = await readDb();
      const newId = id || `member-${Date.now()}`;
      const newMember = {
        id: newId,
        fullName: (fullName || "").trim(),
        phone: (phone || "").trim(),
      };
      db.members.push(newMember);
      await writeDb(db);
      res.json({ db, newId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/members/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const updated = req.body;
      const db = await readDb();
      db.members = db.members.map((m) => (m.id === id ? { ...m, ...updated } : m));
      await writeDb(db);
      res.json(db);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/members/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const db = await readDb();
      db.members = db.members.filter((m) => m.id !== id);
      await writeDb(db);
      res.json(db);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/terms", async (req, res) => {
    try {
      const { id, memberId, shiftId, startDate, sessionsCount, deskType } = req.body;
      const db = await readDb();
      const newId = id || `term-${Date.now()}`;

      const shiftObj = db.shifts.find((s: any) => s.id === shiftId);
      if (!shiftObj) {
        return res.status(400).json({ error: "Shift not found" });
      }

      const sessionsCountVal = typeof sessionsCount === "number" ? sessionsCount : 12;
      const calc = calculateTermSessions(startDate, sessionsCountVal, shiftObj.weekDays, db.calendarOverrides);

      const newTerm = {
        id: newId,
        memberId,
        shiftId,
        startDate,
        endDate: calc.endDate,
        sessionsCount: sessionsCountVal,
        sessions: calc.sessions,
        deskType: deskType || "regular",
      };
      db.terms.push(newTerm);
      await writeDb(db);
      res.json({ db, newId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/terms/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const updated = req.body;
      const db = await readDb();
      db.terms = db.terms.map((t) => {
        if (t.id === id) {
          const merged = { ...t, ...updated };
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
      await writeDb(db);
      res.json(db);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/terms/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const db = await readDb();
      db.terms = db.terms.filter((t) => t.id !== id);
      Object.keys(db.sessionNotes).forEach((key) => {
        if (key.startsWith(`${id}_`)) delete db.sessionNotes[key];
      });
      Object.keys(db.sessionAttendance).forEach((key) => {
        if (key.startsWith(`${id}_`)) delete db.sessionAttendance[key];
      });
      await writeDb(db);
      res.json(db);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/overrides", async (req, res) => {
    try {
      const { dateStr } = req.body;
      const db = await readDb();
      const currentStatus = db.calendarOverrides[dateStr];
      if (!currentStatus) {
        db.calendarOverrides[dateStr] = "holiday";
      } else if (currentStatus === "holiday") {
        db.calendarOverrides[dateStr] = "working";
      } else {
        delete db.calendarOverrides[dateStr];
      }
      recalculateAllTerms(db);
      await writeDb(db);
      res.json(db);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/notes", async (req, res) => {
    try {
      const { termId, dateStr, note } = req.body;
      const db = await readDb();
      const key = `${termId}_${dateStr}`;
      db.sessionNotes[key] = note;
      await writeDb(db);
      res.json(db);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/attendance", async (req, res) => {
    try {
      const { termId, dateStr, status } = req.body;
      const db = await readDb();
      const key = `${termId}_${dateStr}`;
      db.sessionAttendance[key] = status;
      await writeDb(db);
      res.json(db);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/wipe", async (req, res) => {
    try {
      const db = await readDb();
      db.config = { totalRegularDesks: 20, totalPremiumDesks: 5 };
      db.shifts = [];
      db.members = [];
      db.terms = [];
      db.sessionNotes = {};
      db.sessionAttendance = {};
      db.calendarOverrides = {};
      await writeDb(db);
      res.json(db);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/import", async (req, res) => {
    try {
      const { data } = req.body;
      if (!data || typeof data !== "object") {
        return res.status(400).json({ error: "اطلاعات پشتیبان معتبر نمی‌باشد" });
      }
      const migratedDb = migrateAndNormalizeState(data);
      const currentDb = await readDb().catch(() => ({ version: 0 }));
      migratedDb.version = (currentDb.version || 0) + 1;

      await writeDb(migratedDb);
      res.json(migratedDb);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath, {
      setHeaders: (res, filePath) => {
        const fileName = path.basename(filePath);
        if (fileName === "sw.js" || fileName === "service-worker.js" || filePath.endsWith(".html") || fileName === "manifest.json") {
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
        } else {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      }
    }));

    app.get('*', (req, res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
