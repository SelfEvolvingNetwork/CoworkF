import React, { useState, useEffect } from 'react';
import { Member, Term, Shift, SessionNotes, CalendarOverrides, SessionAttendance } from '../types';
import { MemberProfileCard } from './MemberProfileCard';
import { TermsListTable } from './TermsListTable';
import { TermCalendarModal } from './TermCalendarModal';
import { MemberListTable } from './MemberListTable';
import { 
  User, 
  List, 
  Plus,
  Calendar,
  UserX
} from 'lucide-react';

interface ProfileTabProps {
  members: Member[];
  terms: Term[];
  shifts: Shift[];
  todayDate: string;
  sessionNotes: SessionNotes;
  calendarOverrides: CalendarOverrides;
  saveSessionNote: (termId: string, dateStr: string, note: string) => void;
  sessionAttendance: SessionAttendance;
  saveSessionAttendance: (termId: string, dateStr: string, status: 'present' | 'absent' | '') => void;
  addMember: (fullName: string, phone: string) => any;
  updateMember: (id: string, updated: Partial<Omit<Member, 'id'>>) => void;
  deleteMember: (id: string) => any;
  addTerm: (memberId: string, shiftId: string, startDate: string, sessionsCount?: number, deskType?: 'regular' | 'premium') => any;
  updateTerm: (id: string, updated: Partial<Omit<Term, 'id' | 'endDate' | 'sessions'>>) => any;
  deleteTerm: (id: string) => any;
  selectedMemberId?: string | null;
  setSelectedMemberId?: (id: string | null) => void;
  initialTermId?: string | null;
  setInitialTermId?: (id: string | null) => void;
}

export function ProfileTab({
  members,
  terms,
  shifts,
  todayDate,
  sessionNotes,
  calendarOverrides,
  saveSessionNote,
  sessionAttendance,
  saveSessionAttendance,
  addMember,
  updateMember,
  deleteMember,
  addTerm,
  updateTerm,
  deleteTerm,
  selectedMemberId: selectedMemberIdProp,
  setSelectedMemberId: setSelectedMemberIdProp,
  initialTermId: initialTermIdProp,
  setInitialTermId: setInitialTermIdProp,
}: ProfileTabProps) {
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(selectedMemberIdProp || null);
  const [activeSubTab, setActiveSubTab] = useState<'subscribers' | 'profile' | 'calendar'>('subscribers');
  const [selectedTermId, setSelectedTermId] = useState<string | null>(initialTermIdProp || null);
  const isCalendarOpen = activeSubTab === 'calendar';

  // New Membership Term adding state
  const [isAddingTerm, setIsAddingTerm] = useState(false);

  useEffect(() => {
    if (selectedMemberIdProp) {
      setSelectedMemberId(selectedMemberIdProp);
      if (initialTermIdProp) {
        setSelectedTermId(initialTermIdProp);
        setActiveSubTab('calendar');
      } else {
        setSelectedTermId(null);
        setActiveSubTab('profile');
      }
      setIsAddingTerm(false);
    }
  }, [selectedMemberIdProp, initialTermIdProp]);

  // Wrapper function to keep both local state and parent state in sync
  const selectMemberId = (id: string | null) => {
    setSelectedMemberId(id);
    setIsAddingTerm(false);
    if (setSelectedMemberIdProp) {
      setSelectedMemberIdProp(id);
    }
    if (setInitialTermIdProp) {
      setInitialTermIdProp(null);
    }
    if (id !== null) {
      setActiveSubTab('profile');
    }
  };

  const selMember = members.find((m) => m.id === selectedMemberId);
  const memberTerms = terms.filter((t) => t.memberId === selectedMemberId);

  // Selected term and enriched properties
  const selTerm = terms.find((t) => t.id === selectedTermId);
  const selTermEnriched = (() => {
    if (!selTerm) return null;
    const shift = shifts.find((s) => s.id === selTerm.shiftId);
    let status: 'current' | 'finished' | 'reserved' = 'current';
    if (todayDate > selTerm.endDate) {
      status = 'finished';
    } else if (todayDate < selTerm.startDate) {
      status = 'reserved';
    }
    return {
      ...selTerm,
      shiftName: shift ? shift.name : 'سانس حذف شده',
      status,
    };
  })();

  return (
    <div id="profile-tab" className="w-full flex-1 min-h-0 flex flex-col gap-4 animate-fade-in text-right overflow-hidden">
      
      {/* Sub-tab switcher */}
      <div className="flex border-b border-slate-200 flex-row-reverse justify-between items-center shrink-0">
        <div className="flex flex-row-reverse items-center">
          <button
            onClick={() => setActiveSubTab('subscribers')}
            className={`flex items-center gap-1.5 px-4 py-2.5 font-bold text-xs border-b-2 transition-all cursor-pointer ${
              activeSubTab === 'subscribers'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
            title="فهرست مشتریان"
          >
            <List className="w-4 h-4" />
            <span>مشتریان</span>
            <span className="bg-slate-100 text-slate-600 text-[10px] px-2 py-0.5 rounded-full font-mono font-bold">
              {members.length}
            </span>
          </button>
          <button
            onClick={() => setActiveSubTab('profile')}
            className={`flex items-center gap-1.5 px-4 py-2.5 font-bold text-xs border-b-2 transition-all cursor-pointer ${
              activeSubTab === 'profile'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
            title="جزئیات پرونده"
          >
            <User className="w-4 h-4" />
            <span>پرونده</span>
            {selMember && (
              <span className="bg-blue-50 text-blue-700 text-[10px] px-2 py-0.5 rounded-full font-bold">
                {selMember.fullName}
              </span>
            )}
          </button>
          {selMember && selTermEnriched && (
            <button
              onClick={() => setActiveSubTab('calendar')}
              className={`flex items-center gap-1.5 px-4 py-2.5 font-bold text-xs border-b-2 transition-all cursor-pointer ${
                activeSubTab === 'calendar'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-400 hover:text-slate-600'
              }`}
              title="تقویم دوره"
            >
              <Calendar className="w-4 h-4 text-indigo-500" />
              <span>تقویم</span>
              <span className="bg-indigo-50 text-indigo-700 text-[10px] px-2 py-0.5 rounded-full font-bold">
                {selTermEnriched.shiftName}
              </span>
            </button>
          )}
        </div>

        {/* Register Contract button moved to the header */}
        <div className="pl-4">
          {selMember && (
            <button
              onClick={() => {
                setActiveSubTab('profile');
                setIsAddingTerm(true);
              }}
              className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-all cursor-pointer shadow-xs"
              title="ثبت قرارداد جدید"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>قرارداد</span>
            </button>
          )}
        </div>
      </div>

      <div className="w-full flex-1 min-h-0 flex flex-col overflow-hidden">
        {activeSubTab === 'subscribers' ? (
          /* Interactive Client Table Component */
          <MemberListTable
            members={members}
            terms={terms}
            todayDate={todayDate}
            selectedMemberId={selectedMemberId}
            selectMemberId={selectMemberId}
            addMember={addMember}
            updateMember={updateMember}
            deleteMember={deleteMember}
            setSelectedTermId={setSelectedTermId}
          />
        ) : (
          /* Member Detail Area */
          <div className="w-full h-full flex-1 min-h-0 flex flex-col overflow-hidden">
            {!selMember ? (
              <div className="bg-white border border-slate-200 rounded-3xl p-8 text-center shadow-xs flex flex-col items-center justify-center h-full flex-1 min-h-0">
                <UserX className="w-12 h-12 text-slate-300" />
                <h3 className="text-xs font-bold text-slate-600 mt-3">پرونده‌ای انتخاب نشده است</h3>
                <button
                  onClick={() => setActiveSubTab('subscribers')}
                  className="mt-3 bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold px-4 py-2 rounded-xl text-xs flex items-center gap-1.5 transition-all cursor-pointer border border-blue-200"
                  title="انتخاب از فهرست مشتریان"
                >
                  <List className="w-3.5 h-3.5" />
                  <span>انتخاب از لیست</span>
                </button>
              </div>
            ) : (
              <div className="h-full flex-1 min-h-0 flex flex-col gap-4 animate-fade-in overflow-hidden">
                {/* Member Profile Card Component */}
                <div className={activeSubTab === 'calendar' ? 'hidden' : 'shrink-0'}>
                  <MemberProfileCard
                    member={selMember}
                    memberTermsCount={memberTerms.length}
                    updateMember={updateMember}
                    deleteMember={deleteMember}
                    onDeleteSuccess={() => {
                      selectMemberId(null);
                      setSelectedTermId(null);
                      setActiveSubTab('subscribers');
                    }}
                  />
                </div>

                {/* Subscription / Contract List Table Component */}
                <div className={activeSubTab === 'calendar' ? 'hidden' : 'flex-1 min-h-0 flex flex-col overflow-hidden'}>
                  <TermsListTable
                    memberId={selMember.id}
                    terms={terms}
                    shifts={shifts}
                    todayDate={todayDate}
                    calendarOverrides={calendarOverrides}
                    sessionAttendance={sessionAttendance}
                    addTerm={addTerm}
                    updateTerm={updateTerm}
                    deleteTerm={deleteTerm}
                    selectedTermId={selectedTermId}
                    setSelectedTermId={setSelectedTermId}
                    onOpenCalendar={() => setActiveSubTab('calendar')}
                    isAddingTerm={isAddingTerm}
                    setIsAddingTerm={setIsAddingTerm}
                  />
                </div>

                {/* Interactive Term Calendar Modal Component */}
                {isCalendarOpen && selTermEnriched && (
                  <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                    <TermCalendarModal
                      isInline={true}
                      onClose={() => setActiveSubTab('profile')}
                      selTermEnriched={selTermEnriched}
                      shifts={shifts}
                      todayDate={todayDate}
                      sessionNotes={sessionNotes}
                      saveSessionNote={saveSessionNote}
                      sessionAttendance={sessionAttendance}
                      saveSessionAttendance={saveSessionAttendance}
                      calendarOverrides={calendarOverrides}
                    />
                  </div>
                )}
               </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

