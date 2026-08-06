import { useState, useEffect, useRef } from 'react';
import { CoworkingConfig, Shift, Member, Term, SessionNotes, CalendarOverrides, SessionAttendance } from '../types';
import { calculateTermSessions, calculateTermSessionsWithHistory, getTodayJalali, isValidJalaliDate, normalizePersianDigits } from '../utils/jalali';

export interface DialogError {
  isOpen: boolean;
  title: string;
  message: string;
}

export function useCoworkingState() {
  const [activeTab, setActiveTab] = useState<'calendar' | 'reports' | 'profile' | 'shifts' | 'backup'>('reports');

  // Define upload/saving to server status
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Define dynamic today's date
  const [todayDate] = useState<string>(() => getTodayJalali());

  // 1. Core State
  const [config, setConfig] = useState<CoworkingConfig>({ totalRegularDesks: 20, totalPremiumDesks: 5 });
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [calendarOverrides, setCalendarOverrides] = useState<CalendarOverrides>({});
  const [terms, setTerms] = useState<Term[]>([]);
  const [sessionNotes, setSessionNotes] = useState<SessionNotes>({});
  const [sessionAttendance, setSessionAttendance] = useState<SessionAttendance>({});

  const [dialogError, setDialogError] = useState<DialogError>({
    isOpen: false,
    title: '',
    message: '',
  });

  const serverVersionRef = useRef<number>(0);

  interface SyncOperation {
    id: string;
    type: string;
    url: string;
    method: 'POST' | 'PUT' | 'DELETE';
    body?: any;
  }

  const syncQueueRef = useRef<SyncOperation[]>([]);
  const [queueCount, setQueueCount] = useState<number>(0);
  const isProcessingQueueRef = useRef<boolean>(false);

  const processQueue = async () => {
    if (isProcessingQueueRef.current) return;
    isProcessingQueueRef.current = true;
    setUploadStatus('saving');

    while (syncQueueRef.current.length > 0) {
      const op = syncQueueRef.current[0];
      try {
        const res = await fetch(op.url, {
          method: op.method,
          headers: { "Content-Type": "application/json" },
          body: op.body ? JSON.stringify(op.body) : undefined,
        });
        if (!res.ok) {
          throw new Error(`Server returned ${res.status}`);
        }
        const data = (await res.json()) as any;
        const db = (op.type === 'addMember' || op.type === 'addTerm') ? data.db : data;

        syncQueueRef.current.shift();
        setQueueCount(syncQueueRef.current.length);

        if (syncQueueRef.current.length === 0) {
          syncWithServer(db, true);
          setUploadStatus('saved');
          setTimeout(() => {
            setUploadStatus(p => p === 'saved' ? 'idle' : p);
          }, 3000);
        }
      } catch (err) {
        console.error("Failed to process queue operation:", err, op);
        setUploadStatus('error');
        isProcessingQueueRef.current = false;
        
        // Wait and retry in 5 seconds
        setTimeout(() => {
          processQueue();
        }, 5000);
        return;
      }
    }

    isProcessingQueueRef.current = false;
  };

  const addToQueue = (op: Omit<SyncOperation, 'id'>) => {
    const opWithId: SyncOperation = {
      ...op,
      id: `${op.type}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`
    };
    syncQueueRef.current.push(opWithId);
    setQueueCount(syncQueueRef.current.length);
    processQueue();
  };

  // Helper to sync state from server or local fallback
  const syncWithServer = (data: any, force = false) => {
    if (!data || typeof data !== 'object') return;
    const version = data.version || 0;
    if (!force && version <= serverVersionRef.current) return;

    serverVersionRef.current = version;
    if (data.config) setConfig(data.config);
    if (data.shifts) setShifts(data.shifts);
    if (data.members) setMembers(data.members);
    if (data.terms) setTerms(data.terms);
    if (data.sessionNotes) setSessionNotes(data.sessionNotes);
    if (data.sessionAttendance) setSessionAttendance(data.sessionAttendance);
    if (data.calendarOverrides) setCalendarOverrides(data.calendarOverrides);

    try {
      localStorage.setItem('local_coworking_db_v2', JSON.stringify(data));
    } catch (e) {}
  };

  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [lastSyncedTime, setLastSyncedTime] = useState<string>(() => {
    const now = new Date();
    return now.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  });

  const manualSync = async (silent = false): Promise<boolean> => {
    if (syncQueueRef.current.length > 0) {
      return false; // Skip sync if there are pending local operations to avoid overwrites
    }
    setIsSyncing(true);
    try {
      const res = await fetch(`/api/data?t=${Date.now()}`, {
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as any;
      syncWithServer(data, true); // force state sync to guarantee latest server content
      const now = new Date();
      setLastSyncedTime(now.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      return true;
    } catch (e) {
      console.error("Manual sync failed:", e);
      if (!silent) {
        showErrorDialog(
          "خطای ارتباط با سرور",
          "امکان برقراری ارتباط با سرور برای همگام‌سازی وجود ندارد. اطلاعات به صورت محلی ذخیره شده است."
        );
      }
      return false;
    } finally {
      setIsSyncing(false);
    }
  };

  const [isWsConnected, setIsWsConnected] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<any>(null);

  // Real-time WebSocket connection setup
  useEffect(() => {
    let isMounted = true;

    const connectWs = () => {
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
        return;
      }

      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/api/ws`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!isMounted) return;
          setIsWsConnected(true);
        };

        ws.onmessage = (event) => {
          if (!isMounted) return;
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'STATE_UPDATED' || data.type === 'INIT') {
              if (data.db) {
                syncWithServer(data.db, true);
                const now = new Date();
                setLastSyncedTime(now.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
              }
            }
          } catch (e) {
            console.error("WebSocket message parse error:", e);
          }
        };

        ws.onclose = () => {
          if (!isMounted) return;
          setIsWsConnected(false);
          wsRef.current = null;
          reconnectTimeoutRef.current = setTimeout(connectWs, 3000);
        };

        ws.onerror = () => {
          if (!isMounted) return;
          setIsWsConnected(false);
          try { ws.close(); } catch (e) {}
        };
      } catch (e) {
        console.error("WebSocket setup error:", e);
        if (isMounted) {
          reconnectTimeoutRef.current = setTimeout(connectWs, 5000);
        }
      }
    };

    connectWs();

    // Send periodic heartbeats
    const heartbeat = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({ type: 'PING' }));
        } catch (e) {}
      }
    }, 25000);

    return () => {
      isMounted = false;
      clearInterval(heartbeat);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  // 2. Initial load (Try server API first, fallback to localStorage if unreachable)
  useEffect(() => {
    const fetchInitial = async () => {
      try {
        const res = await fetch(`/api/data?t=${Date.now()}`, {
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as any;
        syncWithServer(data);
        const now = new Date();
        setLastSyncedTime(now.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      } catch (e) {
        console.warn("Could not fetch initial data from server. Loading from local storage fallback:", e);
        try {
          const cached = localStorage.getItem('local_coworking_db_v2');
          if (cached) {
            const parsed = JSON.parse(cached);
            syncWithServer(parsed, true);
          }
        } catch (cacheErr) {
          console.error("Failed to load cached local storage fallback:", cacheErr);
        }
      }
    };
    fetchInitial();
  }, []);

  // 2b. Automatic periodic background synchronization (every 1 minute)
  useEffect(() => {
    const interval = setInterval(() => {
      manualSync(true); // silent sync
    }, 60000); // 1 minute (60000 ms)
    return () => clearInterval(interval);
  }, []);



  // Helper to open error dialogs
  const showErrorDialog = (title: string, message: string) => {
    setDialogError({ isOpen: true, title, message });
  };

  const closeErrorDialog = () => {
    setDialogError((prev) => ({ ...prev, isOpen: false }));
  };

  // Helper to check for seat overbooking on session days
  const checkCapacityConflict = (
    termId: string | null,
    shiftId: string,
    deskType: 'regular' | 'premium',
    sessions: string[],
    currentTerms: Term[] = terms
  ): { isConflict: boolean; dateStr?: string; count?: number; capacity?: number } => {
    const shiftObj = shifts.find((s) => s.id === shiftId);
    if (!shiftObj) return { isConflict: false };

    const capacity = deskType === 'premium' ? (shiftObj.totalPremium ?? 5) : (shiftObj.totalRegular ?? 20);

    for (const dateStr of sessions) {
      const activeCount = currentTerms.filter(
        (t) =>
          t.id !== termId &&
          t.shiftId === shiftId &&
          t.deskType === deskType &&
          t.sessions.includes(dateStr)
      ).length;

      if (activeCount + 1 > capacity) {
        return {
          isConflict: true,
          dateStr,
          count: activeCount + 1,
          capacity
        };
      }
    }
    return { isConflict: false };
  };

  // 4. API Operations / REST Transactions

  const updateConfig = async (newConfig: Partial<CoworkingConfig>) => {
    // Optimistic Update
    setConfig(prev => ({ ...prev, ...newConfig }));

    addToQueue({
      type: 'updateConfig',
      url: "/api/config",
      method: "POST",
      body: { config: newConfig }
    });
  };

  // SHIFT CRUD
  const addShift = async (name: string, weekDays: number[], totalRegular = 20, totalPremium = 5) => {
    if (!name.trim()) return;
    const newId = `shift-${Date.now()}`;
    const newShift = {
      id: newId,
      name: name.trim(),
      weekDays,
      totalRegular,
      totalPremium
    };

    // Optimistic Update
    setShifts(prev => [...prev, newShift]);

    addToQueue({
      type: 'addShift',
      url: "/api/shifts",
      method: "POST",
      body: { id: newId, name, weekDays, totalRegular, totalPremium }
    });
  };

  const updateShift = async (id: string, updated: Partial<Omit<Shift, 'id'>>) => {
    // Optimistic Update
    setShifts(prev => prev.map(s => s.id === id ? { ...s, ...updated } : s));

    addToQueue({
      type: 'updateShift',
      url: `/api/shifts/${id}`,
      method: "PUT",
      body: updated
    });
  };

  const deleteShift = async (id: string) => {
    const hasRegisteredTerm = terms.some((t) => t.shiftId === id);
    if (hasRegisteredTerm) {
      showErrorDialog(
        'خطای عدم امکان حذف سانس',
        'امکان حذف این سانس وجود ندارد؛ زیرا تعدادی از کاربران در این سانس دارای عضویت و اشتراک فعال یا رزرو شده هستند. لطفا ابتدا اشتراک‌های این سانس را حذف یا ویرایش کنید.'
      );
      return false;
    }

    // Optimistic Update
    setShifts(prev => prev.filter(s => s.id !== id));

    addToQueue({
      type: 'deleteShift',
      url: `/api/shifts/${id}`,
      method: "DELETE"
    });
    return true;
  };

  // MEMBER CRUD
  const addMember = async (fullName: string, phone: string) => {
    if (!fullName.trim() || !phone.trim()) return null;
    const newId = `member-${Date.now()}`;
    const newMember = {
      id: newId,
      fullName: fullName.trim(),
      phone: phone.trim()
    };

    // Optimistic Update
    setMembers(prev => [...prev, newMember]);

    addToQueue({
      type: 'addMember',
      url: "/api/members",
      method: "POST",
      body: { id: newId, fullName, phone }
    });
    return newId;
  };

  const updateMember = async (id: string, updated: Partial<Omit<Member, 'id'>>) => {
    // Optimistic Update
    setMembers(prev => prev.map(m => m.id === id ? { ...m, ...updated } : m));

    addToQueue({
      type: 'updateMember',
      url: `/api/members/${id}`,
      method: "PUT",
      body: updated
    });
  };

  const deleteMember = async (id: string) => {
    const hasTerms = terms.some((t) => t.memberId === id);
    if (hasTerms) {
      showErrorDialog(
        'خطای عدم امکان حذف مشترک',
        'این مشترک دارای سوابق ترم و اشتراک‌های ثبت شده است. برای حفظ یکپارچگی داده‌ها، حذف این مشترک امکان‌پذیر نیست. لطفا ابتدا ترم‌های مربوط به این کاربر را حذف نمایید.'
      );
      return false;
    }

    // Optimistic Update
    setMembers(prev => prev.filter(m => m.id !== id));

    addToQueue({
      type: 'deleteMember',
      url: `/api/members/${id}`,
      method: "DELETE"
    });
    return true;
  };

  // TERM CRUD
  const addTerm = async (
    memberId: string,
    shiftId: string,
    startDate: string,
    sessionsCount = 12,
    deskType: 'regular' | 'premium' = 'regular'
  ) => {
    if (!memberId || !shiftId || !startDate) return null;

    const normalizedStart = normalizePersianDigits(startDate);

    if (!isValidJalaliDate(normalizedStart)) {
      showErrorDialog(
        'خطای تاریخ نامعتبر',
        'تاریخ شروع وارد شده معتبر نمی‌باشد. لطفاً فرمت تاریخ را به شکل صحیح YYYY/MM/DD (مانند 1405/01/15) با روزها و ماه‌های معتبر وارد انتخاب کنید.'
      );
      return null;
    }

    const shiftObj = shifts.find((s) => s.id === shiftId);
    if (!shiftObj) return null;

    const calc = calculateTermSessionsWithHistory(
      { id: '', startDate: normalizedStart, sessionsCount },
      shiftObj.weekDays,
      calendarOverrides,
      todayDate,
      sessionAttendance
    );

    const capacityConflict = checkCapacityConflict(null, shiftId, deskType, calc.sessions);
    if (capacityConflict.isConflict) {
      showErrorDialog(
        'هشدار تکمیل ظرفیت سانس کاری',
        `توجه: ظرفیت صندلی‌های ${
          deskType === 'premium' ? 'بخش ویژه (VIP)' : 'عادی'
        } در سانس "${shiftObj.name}" در تاریخ ${capacityConflict.dateStr} پر شده است (ظرفیت مجاز: ${capacityConflict.capacity} صندلی). با این حال، ثبت‌نام با موفقیت ذخیره و انجام شد.`
      );
    }

    const newId = `term-${Date.now()}`;
    const newTerm = {
      id: newId,
      memberId,
      shiftId,
      startDate: normalizedStart,
      endDate: calc.endDate,
      sessionsCount,
      sessions: calc.sessions,
      deskType,
    };

    // Optimistic Update
    setTerms(prev => [...prev, newTerm]);

    addToQueue({
      type: 'addTerm',
      url: "/api/terms",
      method: "POST",
      body: {
        id: newId,
        memberId,
        shiftId,
        startDate: normalizedStart,
        sessionsCount,
        deskType,
      }
    });
    return newId;
  };

  const updateTerm = async (
    id: string,
    updated: Partial<Omit<Term, 'id' | 'endDate' | 'sessions'>>
  ) => {
    if (updated.startDate) {
      const normalizedStart = normalizePersianDigits(updated.startDate);
      if (!isValidJalaliDate(normalizedStart)) {
        showErrorDialog(
          'خطای تاریخ نامعتبر',
          'تاریخ شروع وارد شده معتبر نمی‌باشد. لطفاً فرمت صحیح YYYY/MM/DD را وارد کنید.'
        );
        return false;
      } else {
        updated.startDate = normalizedStart;
      }
    }

    const termToUpdate = terms.find((t) => t.id === id);
    if (!termToUpdate) return false;

    const merged = { ...termToUpdate, ...updated };
    const shiftObj = shifts.find((s) => s.id === merged.shiftId);
    if (!shiftObj) return false;

    const calc = calculateTermSessionsWithHistory(
      merged,
      shiftObj.weekDays,
      calendarOverrides,
      todayDate,
      sessionAttendance
    );

    const capacityConflict = checkCapacityConflict(id, merged.shiftId, merged.deskType, calc.sessions, terms);
    if (capacityConflict.isConflict) {
      showErrorDialog(
        'هشدار تکمیل ظرفیت سانس کاری',
        `توجه: ظرفیت صندلی‌های ${
          merged.deskType === 'premium' ? 'بخش ویژه (VIP)' : 'عادی'
        } در سانس "${shiftObj.name}" در تاریخ ${capacityConflict.dateStr} پر شده است (حد مجاز ظرفیت: ${capacityConflict.capacity} عدد). با این حال، تغییرات با موفقیت ذخیره گردید.`
      );
    }

    // Optimistic Update
    setTerms(prev => prev.map(t => t.id === id ? { ...t, ...updated, sessions: calc.sessions, endDate: calc.endDate } : t));

    addToQueue({
      type: 'updateTerm',
      url: `/api/terms/${id}`,
      method: "PUT",
      body: {
        ...updated,
        sessions: calc.sessions,
        endDate: calc.endDate,
      }
    });
    return true;
  };

  const deleteTerm = async (id: string) => {
    // Optimistic Update
    setTerms(prev => prev.filter(t => t.id !== id));

    // Optimistically clean up session notes and attendance
    setSessionNotes(prev => {
      const copy = { ...prev };
      Object.keys(copy).forEach((key) => {
        if (key.startsWith(`${id}_`)) {
          delete copy[key];
        }
      });
      return copy;
    });

    setSessionAttendance(prev => {
      const copy = { ...prev };
      Object.keys(copy).forEach((key) => {
        if (key.startsWith(`${id}_`)) {
          delete copy[key];
        }
      });
      return copy;
    });

    addToQueue({
      type: 'deleteTerm',
      url: `/api/terms/${id}`,
      method: "DELETE"
    });
    return true;
  };

  // CALENDAR DAYS TOGGLE
  const toggleDayStatus = async (dateStr: string) => {
    let nextStatus: 'holiday' | 'working' | undefined;
    const currentStatus = calendarOverrides[dateStr];
    if (!currentStatus) {
      nextStatus = "holiday";
    } else if (currentStatus === "holiday") {
      nextStatus = "working";
    } else {
      nextStatus = undefined;
    }

    const updatedOverrides = { ...calendarOverrides };
    if (nextStatus) {
      updatedOverrides[dateStr] = nextStatus;
    } else {
      delete updatedOverrides[dateStr];
    }

    // Optimistic Update calendar overrides and recalculate terms
    setCalendarOverrides(updatedOverrides);

    setTerms(prevTerms => {
      return prevTerms.map(t => {
        const shift = shifts.find(s => s.id === t.shiftId);
        if (!shift) return t;
        const calc = calculateTermSessionsWithHistory(
          t,
          shift.weekDays,
          updatedOverrides,
          todayDate,
          sessionAttendance
        );
        return {
          ...t,
          sessions: calc.sessions,
          endDate: calc.endDate,
        };
      });
    });

    addToQueue({
      type: 'toggleDayStatus',
      url: "/api/overrides",
      method: "POST",
      body: { dateStr }
    });
  };

  // SESSION NOTES CRUD
  const saveSessionNote = async (termId: string, dateStr: string, note: string) => {
    const normalizedDate = dateStr.replace(/-/g, '/');
    const key = `${termId}_${normalizedDate}`;

    // Optimistic Update
    setSessionNotes(prev => {
      const copy = { ...prev };
      if (note && note.trim()) {
        copy[key] = note.trim();
      } else {
        delete copy[key];
      }
      return copy;
    });

    addToQueue({
      type: 'saveSessionNote',
      url: "/api/notes",
      method: "POST",
      body: { termId, dateStr: normalizedDate, note }
    });
  };

  // SESSION ATTENDANCE CRUD
  const saveSessionAttendance = async (termId: string, dateStr: string, status: 'present' | 'absent' | '') => {
    const normalizedDate = dateStr.replace(/-/g, '/');
    const key = `${termId}_${normalizedDate}`;

    // Compute updated attendance map
    let updatedAttendanceMap: Record<string, string> = {};
    setSessionAttendance(prev => {
      const copy = { ...prev };
      if (status) {
        copy[key] = status;
      } else {
        delete copy[key];
      }
      updatedAttendanceMap = copy;
      return copy;
    });

    // Optimistically recalculate terms with updated attendance
    setTerms(prevTerms => {
      return prevTerms.map(t => {
        if (t.id !== termId) return t;
        const shift = shifts.find(s => s.id === t.shiftId);
        if (!shift) return t;
        const calc = calculateTermSessionsWithHistory(
          t,
          shift.weekDays,
          calendarOverrides,
          todayDate,
          updatedAttendanceMap
        );
        return {
          ...t,
          sessions: calc.sessions,
          endDate: calc.endDate,
        };
      });
    });

    addToQueue({
      type: 'saveSessionAttendance',
      url: "/api/attendance",
      method: "POST",
      body: { termId, dateStr: normalizedDate, status }
    });
  };

  // RESTORE BACKUP DATA
  const importBackupData = async (jsonString: string): Promise<boolean> => {
    setUploadStatus('saving');
    // Clear pending operations when importing a backup
    syncQueueRef.current = [];
    setQueueCount(0);

    try {
      if (!jsonString || typeof jsonString !== 'string') {
        throw new Error("فایل ورودی معتبر نمی‌باشد");
      }
      const cleanStr = jsonString.replace(/^\uFEFF/, '').trim();
      const parsedData = JSON.parse(cleanStr);

      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: parsedData }),
      });
      if (!res.ok) {
        throw new Error("Server import failed");
      }
      const db = (await res.json()) as any;
      syncWithServer(db, true);
      setUploadStatus('saved');
      setTimeout(() => setUploadStatus(p => p === 'saved' ? 'idle' : p), 3000);
      return true;
    } catch (e) {
      console.error("Failed to import backup:", e);
      setUploadStatus('error');
      return false;
    }
  };

  // WIPE ALL OPERATIONAL DATA COLD RESET
  const wipeAllData = async () => {
    setUploadStatus('saving');
    // Clear pending operations when wiping data
    syncQueueRef.current = [];
    setQueueCount(0);

    try {
      const res = await fetch("/api/wipe", {
        method: "POST",
      });
      const db = await res.json();
      syncWithServer(db, true);
      setUploadStatus('saved');
      setTimeout(() => setUploadStatus(p => p === 'saved' ? 'idle' : p), 3000);
    } catch (err) {
      console.error("Failed to wipe data:", err);
      setUploadStatus('error');
    }
  };

  return {
    activeTab,
    setActiveTab,
    todayDate,
    config,
    updateConfig,
    shifts,
    addShift,
    updateShift,
    deleteShift,
    members,
    addMember,
    updateMember,
    deleteMember,
    terms,
    addTerm,
    updateTerm,
    deleteTerm,
    calendarOverrides,
    toggleDayStatus,
    sessionNotes,
    saveSessionNote,
    sessionAttendance,
    saveSessionAttendance,
    importBackupData,
    wipeAllData,

    dialogError,
    closeErrorDialog,
    showErrorDialog,
    isSyncing,
    lastSyncedTime,
    manualSync,
    uploadStatus,
    queueCount,
    isWsConnected,
  };
}
