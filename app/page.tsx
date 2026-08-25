"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { GoogleAddressField, SelectedAddress } from "./components/google-address-field";
import type { BookingWorkflowState } from "./lib/booking-workflow";

type Role = "resident" | "provider";
type AccountRole = Role;
type BookingState = "draft" | "pending" | "booked" | "active" | "ending";
type MatchPerson = {
  id: string;
  name: string;
  initial: string;
  tone: string;
  price: number;
  time: string;
  secondTime: string;
  match: string;
  detail: string;
  rating: string;
  distance: number;
  experience: number;
  addressProofProvided: boolean;
  reviewCount: number;
  averageRating: number | null;
  withinTravelPreference: boolean;
};
type StoredRequest = {
  id: string;
  status: string;
  helperId?: string;
  helperName?: string;
  helperMobile?: string | null;
  residentName?: string;
  residentMobile?: string | null;
  residentLocality?: string;
  residentAddress?: string | null;
  package: { service: string; homeSize: string; cleaningVisit: string };
  monthlyPriceRupees: number;
  requestedStartDate: string;
  responseDueAt: string;
  cycleEndsAt?: string | null;
  bookingId?: string | null;
  bookingStatus?: string | null;
  workflowState?: BookingWorkflowState;
  trialVisitsAllowed?: number | null;
  trialVisitsCompleted?: number | null;
  canCancelNow?: boolean;
  trialDays?: Array<{ ordinal: number; scheduledFor: string; completionAvailableAt?: string; status: string }>;
  slots: Array<{ visitOrdinal: number; startTime: string; endTime: string; includesHouseCleaning: boolean }>;
};
type TrialPayment = {
  id: string;
  amountRupees: number;
  status: string;
  transactionReference?: string | null;
  residentMarkedPaidAt?: string | null;
  helperName?: string | null;
  residentName?: string | null;
  helperMobile?: string | null;
};
type AppNotification = {
  id: string;
  templateKey: string;
  title: string;
  body: string;
  actionView: string | null;
  readAt: string | null;
  createdAt: string;
};
declare global {
  interface Window {
    initSendOTP?: (configuration: Record<string, unknown>) => void;
  }
}

function providerMessage(error: unknown, fallback: string) {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message;
  }
  return fallback;
}

function msg91AccessToken(data: unknown, depth = 0): string {
  if (depth > 6 || data == null) return "";
  if (typeof data === "string") {
    const value = data.trim().replace(/^Bearer\s+/i, "");
    if ((value.startsWith("{") || value.startsWith("[")) && value.length < 20_000) {
      try {
        return msg91AccessToken(JSON.parse(value), depth + 1);
      } catch {
        return "";
      }
    }
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ? value : "";
  }
  if (typeof data !== "object") return "";
  const entries = Array.isArray(data) ? data.map((value, index) => [String(index), value] as const) : Object.entries(data as Record<string, unknown>);
  for (const [key, value] of entries) {
    const normalizedKey = key.toLowerCase().replace(/[-_\s]/g, "");
    if (["accesstoken", "jwttoken", "jwt"].includes(normalizedKey) && typeof value === "string" && value.trim()) {
      return value.trim().replace(/^Bearer\s+/i, "");
    }
  }
  for (const [, value] of entries) {
    const nested = msg91AccessToken(value, depth + 1);
    if (nested) return nested;
  }
  return "";
}

function Mark({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return <span className={muted ? "mark muted" : "mark"}>{children}</span>;
}
function Avatar({ person, small = false }: { person: MatchPerson; small?: boolean }) {
  return <span className={`avatar ${person.tone} ${small ? "small" : ""}`}>{person.initial}</span>;
}
function Check() { return <span className="check" aria-hidden>✓</span>; }
function ScreenTitle({ eyebrow, title, text }: { eyebrow?: string; title: string; text?: string }) {
  return <header className="screen-title">{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{text && <p>{text}</p>}</header>;
}
function Segmented({ options, value, onChange, label }: { options: string[]; value: string; onChange: (v: string) => void; label: string }) {
  return <div className="segmented" aria-label={label}>{options.map(option => <button key={option} className={value === option ? "selected" : ""} onClick={() => onChange(option)}>{option}</button>)}</div>;
}
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <div className="field"><label>{label}</label>{children}{hint && <small>{hint}</small>}</div>;
}
function SummaryRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div className="summary-row"><span>{label}</span><b className={strong ? "strong" : ""}>{value}</b></div>;
}
function storedPackageName(request?: StoredRequest | null) {
  const service = request?.package.service;
  if (service === "house_cleaning") return "House cleaning";
  if (service === "utensils_once") return "Utensil cleaning · once daily";
  if (service === "utensils_twice") return "Utensil cleaning · twice daily";
  if (service === "house_plus_utensils_once") return "House cleaning + utensils · once daily";
  if (service === "house_plus_utensils_twice") return "House cleaning + utensils · twice daily";
  return "Home help";
}
function friendlyDate(value?: string | null) {
  if (!value) return "To be confirmed";
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(date);
}
function friendlyDateTime(value?: string | null) {
  if (!value) return "after the final visit";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
function serviceDay(value: string | undefined, ordinal: number) {
  const date = new Date(`${value || new Date().toISOString().slice(0, 10)}T00:00:00`);
  let remaining = ordinal - 1;
  while (remaining > 0) {
    date.setDate(date.getDate() + 1);
    if (date.getDay() !== 0) remaining -= 1;
  }
  return {
    weekday: date.toLocaleDateString("en-IN", { weekday: "short" }).toUpperCase(),
    day: date.getDate(),
    label: date.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
  };
}

export default function Home() {
  const [role, setRole] = useState<Role>("resident");
  const [view, setView] = useState("welcome");
  const [accountRole, setAccountRole] = useState<AccountRole>("resident");
  const [signedIn, setSignedIn] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notificationError, setNotificationError] = useState("");
  const [alertPermission, setAlertPermission] = useState<NotificationPermission | "unsupported">("default");
  const knownNotificationIds = useRef<Set<string>>(new Set());
  const notificationsInitialized = useRef(false);
  const [mobile, setMobile] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [msg91Ready, setMsg91Ready] = useState(false);
  const msg91Configuration = useRef<Record<string, unknown> | null>(null);
  const [residentName, setResidentName] = useState("");
  const [residentHouse, setResidentHouse] = useState("");
  const [residentAddress, setResidentAddress] = useState<SelectedAddress | null>(null);
  const [addressSaving, setAddressSaving] = useState(false);
  const [helperName, setHelperName] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [legalReturnView, setLegalReturnView] = useState("welcome");
  const [service, setService] = useState("House cleaning");
  const [frequency, setFrequency] = useState("Once daily");
  const [homeSize, setHomeSize] = useState("1–2 BHK");
  const [firstTime, setFirstTime] = useState("08:00");
  const [secondTime, setSecondTime] = useState("19:00");
  const [cleaningVisit, setCleaningVisit] = useState("First visit");
  const [flexibility, setFlexibility] = useState("Up to 30 min");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [exactOnly, setExactOnly] = useState(false);
  const [verifiedOnly, setVerifiedOnly] = useState(true);
  const [sortBy, setSortBy] = useState("Best match");
  const [people, setPeople] = useState<MatchPerson[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchesError, setMatchesError] = useState("");
  const [selectedHelperId, setSelectedHelperId] = useState("");
  const [requestedStartDate, setRequestedStartDate] = useState(() => new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString().slice(0, 10));
  const [currentRequest, setCurrentRequest] = useState<StoredRequest | null>(null);
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [helperRequest, setHelperRequest] = useState<StoredRequest | null>(null);
  const [helperActiveBooking, setHelperActiveBooking] = useState<StoredRequest | null>(null);
  const [helperActiveBookings, setHelperActiveBookings] = useState<StoredRequest[]>([]);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelFeedback, setCancelFeedback] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [trialPayment, setTrialPayment] = useState<TrialPayment | null>(null);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  const [booking, setBooking] = useState<BookingState>("draft");
  const [issueSent, setIssueSent] = useState(false);
  const [issueCaseNumber, setIssueCaseNumber] = useState<number | null>(null);
  const [residentIssue, setResidentIssue] = useState("");
  const [residentIssueFeedback, setResidentIssueFeedback] = useState("");
  const [providerIssueSent, setProviderIssueSent] = useState(false);
  const [providerIssue, setProviderIssue] = useState("");
  const [providerIssueFeedback, setProviderIssueFeedback] = useState("");
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueError, setIssueError] = useState("");
  const [profilePaused, setProfilePaused] = useState(false);
  const [profilePauseBusy, setProfilePauseBusy] = useState(false);
  const [addressProofUploaded, setAddressProofUploaded] = useState(false);
  const [addressProofName, setAddressProofName] = useState("");
  const [addressProofType, setAddressProofType] = useState("aadhaar");
  const [proofUploading, setProofUploading] = useState(false);
  const proofInputRef = useRef<HTMLInputElement | null>(null);
  const analyticsSessionId = useRef("");
  const [setupSubmitted, setSetupSubmitted] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [helperLocality, setHelperLocality] = useState("");
  const [helperAddress, setHelperAddress] = useState<SelectedAddress | null>(null);
  const [helperTravelDistance, setHelperTravelDistance] = useState("");
  const [yearsExperience, setYearsExperience] = useState("");
  const [houseCleaningEnabled, setHouseCleaningEnabled] = useState(false);
  const [housePrices, setHousePrices] = useState({ oneTwo: "", three: "", fourPlus: "" });
  const [utensilsOnceEnabled, setUtensilsOnceEnabled] = useState(false);
  const [utensilsOncePrice, setUtensilsOncePrice] = useState("");
  const [utensilsTwiceEnabled, setUtensilsTwiceEnabled] = useState(false);
  const [utensilsTwicePrice, setUtensilsTwicePrice] = useState("");
  const [availabilitySlots, setAvailabilitySlots] = useState([{ id: "initial", days: "mon_sat", start: "", end: "" }]);
  const twice = frequency === "Twice daily" && service !== "House cleaning";
  const packageName = useMemo(() => service === "House cleaning" ? "House cleaning" : service === "Utensil cleaning" ? `Utensils · ${frequency.toLowerCase()}` : `House cleaning + utensils · ${frequency.toLowerCase()}`, [service, frequency]);
  const priceFor = (person: MatchPerson) => person.price;
  const formatTime = (value: string) => {
    if (!value) return "Select time";
    const [hourText, minute] = value.split(":");
    const hour = Number(hourText);
    return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
  };
  const scheduleText = twice ? `${formatTime(firstTime)} & ${formatTime(secondTime)}` : `Mon–Sat · ${formatTime(firstTime)}`;
  const residentBookingSchedule = currentRequest?.slots.length
    ? currentRequest.slots.map(slot => formatTime(slot.startTime)).join(" & ")
    : scheduleText;
  const visiblePeople = useMemo(() => {
    let result = people.filter(person => (!exactOnly || person.match === "Exact time") && (!verifiedOnly || person.addressProofProvided));
    if (sortBy === "Closest") result = [...result].sort((a, b) => a.distance - b.distance);
    if (sortBy === "Lowest price") result = [...result].sort((a, b) => priceFor(a) - priceFor(b));
    if (sortBy === "Most experienced") result = [...result].sort((a, b) => b.experience - a.experience);
    if (sortBy === "Highest rated") result = [...result].sort((a, b) => (b.averageRating ?? -1) - (a.averageRating ?? -1));
    return result;
  }, [exactOnly, verifiedOnly, sortBy, people]);
  const selectedPerson = people.find(person => person.id === selectedHelperId) ?? people[0] ?? null;
  const monthlyPrice = selectedPerson?.price ?? currentRequest?.monthlyPriceRupees ?? helperRequest?.monthlyPriceRupees ?? 0;
  const chosenHelperName = selectedPerson?.name ?? currentRequest?.helperName ?? "your selected home helper";
  const matchedFirstTime = selectedPerson?.time || currentRequest?.slots[0]?.startTime || firstTime;
  const matchedSecondTime = selectedPerson?.secondTime || currentRequest?.slots[1]?.startTime || secondTime;
  const trialDayOne = serviceDay(currentRequest?.requestedStartDate || requestedStartDate, 1);
  const trialDayTwo = serviceDay(currentRequest?.requestedStartDate || requestedStartDate, 2);
  const helperPriceRows = useMemo(() => {
    const rows: Array<{ label: string; price: number }> = [];
    const sizes = [
      { label: "1–2 BHK", price: Number(housePrices.oneTwo) },
      { label: "3 BHK", price: Number(housePrices.three) },
      { label: "4+ BHK", price: Number(housePrices.fourPlus) },
    ];
    if (houseCleaningEnabled) {
      for (const size of sizes) if (size.price > 0) rows.push({ label: `House cleaning · ${size.label}`, price: size.price });
    }
    const oncePrice = Number(utensilsOncePrice);
    const twicePrice = Number(utensilsTwicePrice);
    if (utensilsOnceEnabled && oncePrice > 0) rows.push({ label: "Utensil cleaning · once daily", price: oncePrice });
    if (utensilsTwiceEnabled && twicePrice > 0) rows.push({ label: "Utensil cleaning · twice daily", price: twicePrice });
    return rows;
  }, [houseCleaningEnabled, housePrices, utensilsOnceEnabled, utensilsOncePrice, utensilsTwiceEnabled, utensilsTwicePrice]);
  const invalidTimes = twice && (!firstTime || !secondTime || secondTime <= firstTime);
  const betaMode = true;

  function recordClientEvent(eventName: string, properties: Record<string, string> = {}) {
    if (!analyticsSessionId.current) {
      analyticsSessionId.current = window.sessionStorage.getItem("nivasa_analytics_session") || crypto.randomUUID();
      window.sessionStorage.setItem("nivasa_analytics_session", analyticsSessionId.current);
    }
    void fetch("/api/analytics", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventName, properties, sessionId: analyticsSessionId.current }),
      keepalive: true,
    }).catch(() => undefined);
  }

  const activeRequest = role === "resident" ? currentRequest : helperActiveBooking;
  const canCancelBooking = Boolean(activeRequest?.bookingId && activeRequest?.canCancelNow === true);
  const completedTrialDays = Number(activeRequest?.trialVisitsCompleted ?? 0);
  const estimatedTrialPayment = activeRequest?.bookingStatus === "trial" && completedTrialDays > 0
    ? Math.round((activeRequest.monthlyPriceRupees / 26) * completedTrialDays)
    : 0;
  const nextTrialOrdinal = Number(helperActiveBooking?.trialVisitsCompleted ?? 0) + 1;
  const canRequestPaymentReview = Boolean(trialPayment?.residentMarkedPaidAt
    && Date.now() - new Date(trialPayment.residentMarkedPaidAt).getTime() >= 12 * 60 * 60 * 1_000);
  const paymentBlocking = trialPayment?.status === "pending" || trialPayment?.status === "resident_marked_paid";
  const paymentMobile = trialPayment?.helperMobile?.replace(/^\+91/, "") || "";

  async function cancelBooking() {
    if (!activeRequest?.bookingId || !cancelReason) return;
    setCancelBusy(true);
    setCancelError("");
    try {
      const response = await fetch("/api/bookings/cancel", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingId: activeRequest.bookingId, reason: cancelReason, feedback: cancelFeedback }),
      });
      const result = await response.json() as { error?: string; paymentDueRupees?: number; paymentPending?: TrialPayment | null };
      if (!response.ok) throw new Error(result.error || "We could not cancel this booking.");
      setCancelOpen(false);
      setCancelReason("");
      setCancelFeedback("");
      setBooking("draft");
      setTrialPayment(result.paymentPending ?? null);
      if (role === "resident") {
        setCurrentRequest(null);
        setSelectedHelperId("");
        setPeople([]);
        setMatchesError(result.paymentDueRupees
          ? `Booking cancelled. ₹${result.paymentDueRupees.toLocaleString("en-IN")} remains payable for completed trial work.`
          : "Booking cancelled. The recurring time has been released and you can search again.");
        navTo("requirement");
        await loadResidentRequest(false);
      } else {
        setHelperActiveBooking(null);
        navTo("providerDashboard");
        await loadHelperRequests(false);
      }
      void loadNotifications(false);
    } catch (error) {
      setCancelError(providerMessage(error, "We could not cancel this booking."));
    } finally {
      setCancelBusy(false);
    }
  }

  async function completeTrialDay(ordinal: number) {
    if (!helperActiveBooking?.bookingId) return;
    setRequestBusy(true);
    setRequestError("");
    try {
      const response = await fetch("/api/bookings/visits", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingId: helperActiveBooking.bookingId, trialOrdinal: ordinal }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "We could not complete this service day.");
      await loadHelperRequests(false);
      void loadNotifications(false);
    } catch (error) {
      setRequestError(providerMessage(error, "We could not complete this service day."));
    } finally {
      setRequestBusy(false);
    }
  }

  async function updateTrialPayment(action: "mark_paid" | "confirm_received" | "request_review") {
    if (!trialPayment) return;
    setPaymentBusy(true);
    setPaymentError("");
    try {
      const response = await fetch("/api/bookings/payment", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentId: trialPayment.id, action }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "We could not update this payment.");
      if (role === "resident") await loadResidentRequest(false);
      else await loadHelperRequests(false);
      void loadNotifications(false);
    } catch (error) {
      setPaymentError(providerMessage(error, "We could not update this payment."));
    } finally {
      setPaymentBusy(false);
    }
  }

  async function submitIssue() {
    const category = role === "resident" ? residentIssue : providerIssue;
    const description = role === "resident" ? residentIssueFeedback : providerIssueFeedback;
    if (!category) return;
    setIssueBusy(true);
    setIssueError("");
    try {
      const response = await fetch("/api/issues", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category, description, bookingId: activeRequest?.bookingId || null }),
      });
      const result = await response.json() as { error?: string; caseNumber?: number };
      if (!response.ok) throw new Error(result.error || "We could not submit your report.");
      setIssueCaseNumber(result.caseNumber ?? null);
      if (role === "resident") setIssueSent(true);
      else setProviderIssueSent(true);
    } catch (error) {
      setIssueError(providerMessage(error, "We could not submit your report. Please try again."));
    } finally {
      setIssueBusy(false);
    }
  }

  async function setHelperProfilePaused(paused: boolean) {
    setProfilePauseBusy(true);
    setSetupError("");
    try {
      const response = await fetch("/api/helper/profile", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "We could not update your profile availability.");
      setProfilePaused(paused);
    } catch (error) {
      setSetupError(providerMessage(error, "We could not update your profile availability."));
    } finally {
      setProfilePauseBusy(false);
    }
  }

  function openIssueReport() {
    setIssueError("");
    setIssueCaseNumber(null);
    if (role === "resident") {
      setIssueSent(false);
      setResidentIssue("");
      setResidentIssueFeedback("");
      navTo("issue");
    } else {
      setProviderIssueSent(false);
      setProviderIssue("");
      setProviderIssueFeedback("");
      navTo("providerIssue");
    }
  }

  function openLegalPage(target: "terms" | "privacyPolicy") {
    setLegalReturnView(view);
    navTo(target);
  }

  async function loadResidentRequest(redirect = true) {
    try {
      const response = await fetch("/api/resident/requests", { credentials: "same-origin" });
      const result = await response.json() as { error?: string; workflowState?: BookingWorkflowState; request?: StoredRequest | null; paymentPending?: TrialPayment | null };
      if (!response.ok) throw new Error(result.error || "We could not load your booking request.");
      const saved = result.request ?? null;
      const workflowState = result.workflowState ?? saved?.workflowState ?? "ready_to_search";
      setCurrentRequest(saved);
      setTrialPayment(result.paymentPending ?? null);
      const shouldSyncView = redirect || ["pending", "confirmed", "dashboard"].includes(view);
      if (workflowState === "request_pending") {
        setBooking("pending");
        if (shouldSyncView) setView("pending");
      } else if (workflowState === "booking_trial") {
        setBooking("booked");
        if (shouldSyncView) setView(view === "dashboard" ? "dashboard" : "confirmed");
      } else if (workflowState === "booking_active" || workflowState === "booking_ending") {
        setBooking(workflowState === "booking_ending" ? "ending" : "active");
        if (shouldSyncView) setView("dashboard");
      } else if (["booking_cancelled", "booking_completed", "trial_payment_due", "trial_payment_confirmation_pending", "trial_payment_under_review", "request_withdrawn", "ready_to_search"].includes(workflowState)) {
        setBooking("draft");
        if (shouldSyncView) setView("requirement");
      } else if (workflowState === "request_declined" || workflowState === "request_expired") {
        setBooking("draft");
        setMatchesError(workflowState === "request_declined" ? `${saved?.helperName || "The helper"} was not available for this request. Choose another match.` : "The 24-hour response window ended. Choose another available match.");
        if (shouldSyncView) setView("requirement");
      } else if (workflowState === "inconsistent") {
        setBooking("draft");
        setRequestError("Your booking could not be confirmed completely. Please try again or report the issue.");
        if (shouldSyncView) setView("requirement");
      }
      return saved;
    } catch (error) {
      setRequestError(providerMessage(error, "We could not load your booking request."));
      return null;
    }
  }

  async function loadHelperRequests(redirect = true) {
    try {
      const response = await fetch("/api/helper/requests", { credentials: "same-origin" });
      const result = await response.json() as { error?: string; pendingRequest?: StoredRequest | null; activeBooking?: StoredRequest | null; activeBookings?: StoredRequest[]; paymentPending?: TrialPayment | null };
      if (!response.ok) throw new Error(result.error || "We could not load your booking requests.");
      const activeBookings = result.activeBookings ?? (result.activeBooking ? [result.activeBooking] : []);
      setHelperRequest(result.pendingRequest ?? null);
      setHelperActiveBookings(activeBookings);
      setHelperActiveBooking(current => activeBookings.find(item => item.bookingId === current?.bookingId) ?? activeBookings[0] ?? null);
      setTrialPayment(result.paymentPending ?? null);
      if (result.activeBooking?.bookingStatus === "trial") setBooking("booked");
      else if (result.activeBooking?.bookingStatus === "active") setBooking("active");
      else if (result.activeBooking?.bookingStatus === "ending") setBooking("ending");
      else if (!result.pendingRequest) setBooking("draft");
      if (result.pendingRequest) {
        if (redirect || ["incoming", "providerDashboard"].includes(view)) setView("incoming");
      } else if (view === "incoming") {
        setView("providerDashboard");
      }
      return result;
    } catch (error) {
      setSetupError(providerMessage(error, "We could not load your booking requests."));
      return null;
    }
  }

  async function showBrowserAlert(item: AppNotification) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const registration = "serviceWorker" in navigator
        ? await navigator.serviceWorker.register("/notification-worker.js")
        : null;
      if (registration) {
        await registration.showNotification(item.title, { body: item.body, icon: "/favicon.svg", tag: item.id });
      }
    } catch {
      // The in-app notification remains available even when a browser alert is unavailable.
    }
  }

  async function loadNotifications(alertForNew = false) {
    try {
      const response = await fetch("/api/notifications", { credentials: "same-origin" });
      const result = await response.json() as { error?: string; unreadCount?: number; notifications?: AppNotification[] };
      if (!response.ok) throw new Error(result.error || "We could not load notifications.");
      const next = result.notifications ?? [];
      if (notificationsInitialized.current && alertForNew) {
        const fresh = next.filter(item => !knownNotificationIds.current.has(item.id));
        for (const item of fresh.slice().reverse()) void showBrowserAlert(item);
        if (fresh.length && accountRole === "provider") void loadHelperRequests(false);
        if (fresh.length && accountRole === "resident") void loadResidentRequest(false);
      }
      knownNotificationIds.current = new Set(next.map(item => item.id));
      notificationsInitialized.current = true;
      setNotifications(next);
      setUnreadCount(Number(result.unreadCount ?? 0));
      setNotificationError("");
    } catch (error) {
      setNotificationError(providerMessage(error, "We could not load notifications."));
    }
  }

  async function enableBrowserAlerts() {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      setAlertPermission("unsupported");
      return;
    }
    try {
      await navigator.serviceWorker.register("/notification-worker.js");
      const permission = await Notification.requestPermission();
      setAlertPermission(permission);
      if (permission === "granted") {
        const registration = await navigator.serviceWorker.ready;
        const configResponse = await fetch("/api/push/config", { credentials: "same-origin" });
        const config = await configResponse.json() as { publicKey?: string; error?: string };
        if (!configResponse.ok || !config.publicKey) throw new Error(config.error || "Device alerts are not configured.");
        const padding = "=".repeat((4 - config.publicKey.length % 4) % 4);
        const raw = atob((config.publicKey + padding).replace(/-/g, "+").replace(/_/g, "/"));
        const applicationServerKey = Uint8Array.from(raw, character => character.charCodeAt(0));
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        const saveResponse = await fetch("/api/push/subscriptions", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(subscription.toJSON()),
        });
        if (!saveResponse.ok) throw new Error("We could not save alerts for this device.");
        await registration.showNotification("Nivasa alerts are on", { body: "We’ll alert you about requests and booking decisions even when Nivasa is closed.", icon: "/favicon.svg", tag: "nivasa-alerts-enabled" });
      }
    } catch {
      setAlertPermission("unsupported");
    }
  }

  async function openNotification(item: AppNotification) {
    setNotificationOpen(false);
    if (!item.readAt) {
      setNotifications(current => current.map(existing => existing.id === item.id ? { ...existing, readAt: new Date().toISOString() } : existing));
      setUnreadCount(current => Math.max(0, current - 1));
      await fetch("/api/notifications", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      }).catch(() => undefined);
    }
    if (item.actionView) {
      if (accountRole === "provider") {
        const latest = await loadHelperRequests(false);
        if (item.actionView === "incoming" && !latest?.pendingRequest) navTo("providerDashboard");
        else navTo(item.actionView);
      } else {
        const latest = await loadResidentRequest(false);
        const liveBooking = Boolean(latest?.bookingId && ["trial", "active", "ending"].includes(latest.bookingStatus || ""));
        const pendingRequest = latest?.workflowState === "request_pending" || latest?.status === "pending";
        if (item.actionView === "pending" && !pendingRequest) navTo(liveBooking ? "dashboard" : "requirement");
        else if (["confirmed", "dashboard", "membership"].includes(item.actionView) && !liveBooking) navTo("requirement");
        else navTo(item.actionView);
      }
    }
  }

  async function markAllNotificationsRead() {
    setNotifications(current => current.map(item => ({ ...item, readAt: item.readAt || new Date().toISOString() })));
    setUnreadCount(0);
    await fetch("/api/notifications", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => undefined);
  }

  async function completeMsg91SignIn(data: unknown) {
    const accessToken = msg91AccessToken(data);
    if (!accessToken) {
      setAuthBusy(false);
      setAuthError("Mobile verification succeeded, but secure sign-in could not be completed. Please try again.");
      return;
    }

    setAuthBusy(true);
    setAuthError("");
    try {
      const response = await fetch("/api/auth/msg91/complete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken, role: accountRole }),
      });
      const result = await response.json() as { error?: string; profileComplete?: boolean; user?: { name?: string; mobile?: string } };
      if (!response.ok) throw new Error(result.error || "We could not complete sign-in.");
      if (result.user?.name) {
        if (accountRole === "resident") setResidentName(result.user.name);
        else setHelperName(result.user.name);
      }
      if (result.user?.mobile) setMobile(result.user.mobile.replace(/^\+91/, ""));
      setSignedIn(true);
      setView(result.profileComplete ? (accountRole === "resident" ? "requirement" : "providerDashboard") : (accountRole === "resident" ? "residentAccount" : "helperAccount"));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setAuthError(providerMessage(error, "We could not complete sign-in."));
    } finally {
      setAuthBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { credentials: "same-origin" })
      .then(async response => response.ok ? response.json() as Promise<{ user: { role: AccountRole; name: string; mobile: string }; profileComplete: boolean }> : null)
      .then(session => {
        if (!active || !session) return;
        setAccountRole(session.user.role);
        setRole(session.user.role);
        setSignedIn(true);
        setMobile(session.user.mobile.replace(/^\+91/, ""));
        if (session.user.name) {
          if (session.user.role === "resident") setResidentName(session.user.name);
          else setHelperName(session.user.name);
        }
        setView(session.profileComplete ? (session.user.role === "resident" ? "requirement" : "providerDashboard") : (session.user.role === "resident" ? "residentAccount" : "helperAccount"));
      })
      .catch(() => undefined);

    return () => { active = false; };
  }, []);

  useEffect(() => {
    recordClientEvent("screen_viewed", { screen: view, role: accountRole });
  }, [view, accountRole]);

  useEffect(() => {
    if (!signedIn || accountRole !== "resident") return;
    fetch("/api/resident/address", { credentials: "same-origin" })
      .then(async response => response.ok ? response.json() as Promise<{ address?: { house?: string; formattedAddress?: string; locality?: string; latitude?: number | null; longitude?: number | null } | null }> : null)
      .then(result => {
        const address = result?.address;
        if (!address) return;
        setResidentHouse(address.house || "");
        if (address.formattedAddress && address.locality && typeof address.latitude === "number" && typeof address.longitude === "number") {
          setResidentAddress({ formattedAddress: address.formattedAddress, locality: address.locality, latitude: address.latitude, longitude: address.longitude });
        }
      })
      .catch(() => undefined);
  }, [signedIn, accountRole]);

  useEffect(() => {
    if (!signedIn) return;
    if (accountRole === "resident") void loadResidentRequest(true);
    else void loadHelperRequests(true);
  }, [signedIn, accountRole]);

  useEffect(() => {
    if (!signedIn) return;
    setAlertPermission("Notification" in window ? Notification.permission : "unsupported");
    void loadNotifications(false);
    const timer = window.setInterval(() => void loadNotifications(true), 15_000);
    return () => window.clearInterval(timer);
  }, [signedIn, accountRole]);

  useEffect(() => {
    if (view !== "pending" || currentRequest?.status !== "pending") return;
    const timer = window.setInterval(() => void loadResidentRequest(true), 15_000);
    return () => window.clearInterval(timer);
  }, [view, currentRequest?.id, currentRequest?.status]);

  useEffect(() => {
    const providerView = view === "setup" || view === "providerDashboard" || view === "providerSettings";
    if (!providerView || !signedIn || accountRole !== "provider") return;
    let active = true;
    if (view === "setup") setSetupLoading(true);
    setSetupError("");
    fetch("/api/helper/profile", { credentials: "same-origin" })
      .then(async response => {
        const result = await response.json() as {
          error?: string;
          profile?: { locality?: string; homeAddress?: string; latitude?: number | null; longitude?: number | null; travelDistanceKm?: number | null; yearsExperience?: number; profileStatus?: string } | null;
          offerings?: Array<{ service_type: string; home_size: string; monthly_price_paise: number; is_active: number }>;
          availability?: Array<{ id: string; days: string; start: string; end: string }>;
          addressProof?: { filename: string; documentType: string; status: string } | null;
        };
        if (!response.ok) throw new Error(result.error || "We could not load your work profile.");
        if (!active) return;
        if (result.profile) {
          setHelperLocality(result.profile.locality || "");
          if (result.profile.homeAddress && typeof result.profile.latitude === "number" && typeof result.profile.longitude === "number") {
            setHelperAddress({
              formattedAddress: result.profile.homeAddress,
              locality: result.profile.locality || result.profile.homeAddress,
              latitude: result.profile.latitude,
              longitude: result.profile.longitude,
            });
          }
          setHelperTravelDistance(result.profile.travelDistanceKm ? String(result.profile.travelDistanceKm) : "");
          setYearsExperience(String(result.profile.yearsExperience ?? 0));
          setProfilePaused(result.profile.profileStatus === "paused");
        }
        if (result.offerings?.length) {
          const activeOfferings = result.offerings.filter(item => Boolean(item.is_active));
          const price = (serviceType: string, homeSize: string) => {
            const found = activeOfferings.find(item => item.service_type === serviceType && item.home_size === homeSize);
            return found ? String(Math.round(found.monthly_price_paise / 100)) : "";
          };
          setHouseCleaningEnabled(activeOfferings.some(item => item.service_type === "house_cleaning"));
          setHousePrices({
            oneTwo: price("house_cleaning", "one_two_bhk"),
            three: price("house_cleaning", "three_bhk"),
            fourPlus: price("house_cleaning", "four_plus_bhk"),
          });
          setUtensilsOnceEnabled(activeOfferings.some(item => item.service_type === "utensils_once"));
          setUtensilsOncePrice(price("utensils_once", "not_applicable"));
          setUtensilsTwiceEnabled(activeOfferings.some(item => item.service_type === "utensils_twice"));
          setUtensilsTwicePrice(price("utensils_twice", "not_applicable"));
        }
        if (result.availability?.length) setAvailabilitySlots(result.availability);
        if (result.addressProof) {
          setAddressProofUploaded(true);
          setAddressProofName(result.addressProof.filename);
          setAddressProofType(result.addressProof.documentType);
        }
      })
      .catch(error => { if (active) setSetupError(providerMessage(error, "We could not load your work profile.")); })
      .finally(() => { if (active && view === "setup") setSetupLoading(false); });
    return () => { active = false; };
  }, [view, signedIn, accountRole]);

  useEffect(() => {
    if (view !== "mobile") return;
    let active = true;
    const initialize = (widgetId: string, tokenAuth: string) => {
      if (!active || !window.initSendOTP) return;
      try {
        const configuration = {
          widgetId,
          tokenAuth,
          success: (data: unknown) => {
            if (active) void completeMsg91SignIn(data);
          },
          failure: (error: unknown) => {
            if (!active) return;
            setAuthBusy(false);
            setAuthError(providerMessage(error, "Mobile verification was not completed. Reopen verification and try again."));
          },
        };
        msg91Configuration.current = configuration;
        setMsg91Ready(true);
        window.initSendOTP(configuration);
      } catch {
        setAuthError("Mobile verification could not start. Please refresh and try again.");
      }
    };
    fetch("/api/auth/msg91/config", { credentials: "same-origin" })
      .then(async response => {
        const config = await response.json() as { widgetId?: string; tokenAuth?: string; error?: string };
        if (!response.ok || !config.widgetId || !config.tokenAuth) throw new Error(config.error || "Mobile verification is not configured.");
        const existing = document.querySelector<HTMLScriptElement>('script[data-nivasa-msg91="true"]');
        if (existing) {
          if (window.initSendOTP) initialize(config.widgetId, config.tokenAuth);
          else existing.addEventListener("load", () => initialize(config.widgetId!, config.tokenAuth!), { once: true });
          return;
        }
        const script = document.createElement("script");
        script.src = "https://verify.msg91.com/otp-provider.js";
        script.async = true;
        script.dataset.nivasaMsg91 = "true";
        script.addEventListener("load", () => initialize(config.widgetId!, config.tokenAuth!), { once: true });
        script.addEventListener("error", () => setAuthError("Mobile verification could not load. Check your connection and try again."), { once: true });
        document.head.appendChild(script);
      })
      .catch(error => {
        if (active) setAuthError(providerMessage(error, "Mobile verification is not configured."));
      });
    return () => { active = false; };
  }, [view, accountRole]);
  const navTo = (next: string) => {
    let destination = next;
    if (signedIn && role === "resident") {
      const hasPendingRequest = currentRequest?.workflowState === "request_pending" || currentRequest?.status === "pending";
      const hasLiveBooking = Boolean(currentRequest?.bookingId && ["trial", "active", "ending"].includes(currentRequest.bookingStatus || ""));
      const hasTrialBooking = currentRequest?.bookingStatus === "trial";
      if (destination === "pending" && !hasPendingRequest) destination = paymentBlocking ? "requirement" : hasLiveBooking ? "dashboard" : "requirement";
      if (destination === "confirmed" && !hasTrialBooking) destination = hasLiveBooking ? "dashboard" : "requirement";
      if (["dashboard", "membership"].includes(destination) && !hasLiveBooking) destination = "requirement";
      if (["matches", "profile", "review"].includes(destination) && paymentBlocking) destination = "requirement";
    }
    if (signedIn && role === "provider" && destination === "incoming" && !helperRequest) destination = "providerDashboard";
    setView(destination);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const loadMatches = async () => {
    if (paymentBlocking) {
      setMatchesError("Complete the payment for finished trial work before searching for another home helper.");
      navTo("requirement");
      return;
    }
    if (!residentAddress) {
      setMatchesError("Add your home address before searching for helpers.");
      navTo("requirement");
      return;
    }
    if (currentRequest?.status === "pending" || ["trial", "active", "ending"].includes(currentRequest?.bookingStatus || "")) {
      setMatchesError("Manage your current request or booking before searching for another home helper.");
      navTo(currentRequest?.status === "pending" ? "pending" : "dashboard");
      return;
    }
    const serviceKey = service === "House cleaning"
      ? "house_cleaning"
      : service === "Utensil cleaning"
        ? frequency === "Twice daily" ? "utensils_twice" : "utensils_once"
        : frequency === "Twice daily" ? "house_plus_utensils_twice" : "house_plus_utensils_once";
    const homeSizeKey = homeSize === "1–2 BHK" ? "one_two_bhk" : homeSize === "3 BHK" ? "three_bhk" : "four_plus_bhk";
    const flexibilityMinutes = flexibility === "Exact time" ? 0 : flexibility === "Up to 30 min" ? 30 : 60;
    setMatchesLoading(true);
    setMatchesError("");
    navTo("matches");
    try {
      const response = await fetch("/api/resident/matches", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          service: serviceKey,
          homeSize: homeSizeKey,
          firstTime,
          secondTime: twice ? secondTime : null,
          cleaningVisit: cleaningVisit === "Second visit" ? "second" : "first",
          flexibilityMinutes,
        }),
      });
      const result = await response.json() as {
        error?: string;
        matches?: Array<{
          id: string;
          name: string;
          monthlyPriceRupees: number;
          firstTime: string;
          secondTime: string | null;
          exactTime: boolean;
          timeDifferenceMinutes: number;
          distanceKm: number;
          withinTravelPreference: boolean;
          yearsExperience: number;
          addressProofProvided: boolean;
          averageRating: number | null;
          reviewCount: number;
        }>;
      };
      if (!response.ok) throw new Error(result.error || "We could not find available helpers.");
      const tones = ["clay", "sage", "violet"];
      const mapped = (result.matches ?? []).map((person, index): MatchPerson => ({
        id: person.id,
        name: person.name,
        initial: person.name.trim().charAt(0).toUpperCase() || "H",
        tone: tones[index % tones.length],
        price: person.monthlyPriceRupees,
        time: person.firstTime,
        secondTime: person.secondTime || "",
        match: person.exactTime ? "Exact time" : `${person.timeDifferenceMinutes} min nearby time`,
        detail: `${person.yearsExperience} ${person.yearsExperience === 1 ? "year" : "years"}’ experience · ${person.distanceKm < 1 ? `${Math.max(100, Math.round(person.distanceKm * 10) * 100)} m away` : `${person.distanceKm.toFixed(1)} km away`}`,
        rating: person.reviewCount ? `${person.averageRating?.toFixed(1)} · ${person.reviewCount} ${person.reviewCount === 1 ? "review" : "reviews"}` : "",
        distance: person.distanceKm,
        experience: person.yearsExperience,
        addressProofProvided: person.addressProofProvided,
        reviewCount: person.reviewCount,
        averageRating: person.averageRating,
        withinTravelPreference: person.withinTravelPreference,
      }));
      setPeople(mapped);
      setSelectedHelperId(mapped[0]?.id || "");
    } catch (error) {
      setPeople([]);
      setSelectedHelperId("");
      setMatchesError(providerMessage(error, "We could not find available helpers. Please try again."));
    } finally {
      setMatchesLoading(false);
    }
  };
  const sendRequest = async () => {
    if (paymentBlocking) {
      setRequestError("Complete the payment for finished trial work before sending another booking request.");
      navTo("requirement");
      return;
    }
    if (!selectedPerson) {
      setRequestError("Choose an available home helper first.");
      return;
    }
    const serviceKey = service === "House cleaning"
      ? "house_cleaning"
      : service === "Utensil cleaning"
        ? frequency === "Twice daily" ? "utensils_twice" : "utensils_once"
        : frequency === "Twice daily" ? "house_plus_utensils_twice" : "house_plus_utensils_once";
    const homeSizeKey = homeSize === "1–2 BHK" ? "one_two_bhk" : homeSize === "3 BHK" ? "three_bhk" : "four_plus_bhk";
    setRequestBusy(true);
    setRequestError("");
    try {
      const response = await fetch("/api/resident/requests", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          helperId: selectedPerson.id,
          service: serviceKey,
          homeSize: homeSizeKey,
          firstTime: selectedPerson.time,
          secondTime: twice ? selectedPerson.secondTime : null,
          cleaningVisit: cleaningVisit === "Second visit" ? "second" : "first",
          requestedStartDate,
        }),
      });
      const result = await response.json() as { error?: string; requestId?: string; responseDueAt?: string };
      if (!response.ok) throw new Error(result.error || "We could not create the booking request.");
      const saved = await loadResidentRequest(false);
      if (saved) setCurrentRequest(saved);
      setBooking("pending");
      navTo("pending");
    } catch (error) {
      setRequestError(providerMessage(error, "We could not create the booking request. Please try again."));
    } finally {
      setRequestBusy(false);
    }
  };
  const respondToRequest = async (decision: "accept" | "decline") => {
    if (!helperRequest) return;
    setRequestBusy(true);
    setRequestError("");
    try {
      const response = await fetch("/api/helper/requests", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: helperRequest.id, decision }),
      });
      const result = await response.json() as { error?: string; status?: string; request?: StoredRequest };
      if (!response.ok) throw new Error(result.error || "We could not save your response.");
      setHelperRequest(null);
      if (decision === "accept") setBooking("booked");
      else setBooking("draft");
      const refreshed = await loadHelperRequests(false);
      if (!refreshed?.pendingRequest) navTo("providerDashboard");
    } catch (error) {
      setRequestError(providerMessage(error, "We could not save your response. Please try again."));
    } finally {
      setRequestBusy(false);
    }
  };
  const withdrawRequest = async () => {
    if (!currentRequest) return;
    setRequestBusy(true);
    setRequestError("");
    try {
      const response = await fetch("/api/resident/requests", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: currentRequest.id }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "We could not withdraw the request.");
      setCurrentRequest(null);
      setBooking("draft");
      navTo("matches");
    } catch (error) {
      setRequestError(providerMessage(error, "We could not withdraw the request."));
    } finally {
      setRequestBusy(false);
    }
  };
  const chooseAccountRole = (next: AccountRole) => {
    recordClientEvent("account_role_selected", { role: next });
    setAccountRole(next);
    setRole(next);
    setAuthError("");
    navTo("mobile");
  };
  const openMsg91Widget = () => {
    setAuthError("");
    if (!window.initSendOTP || !msg91Configuration.current) {
      setAuthError("Secure verification is still loading. Please try again in a moment.");
      return;
    }
    try {
      recordClientEvent("otp_window_requested", { role: accountRole });
      window.initSendOTP(msg91Configuration.current);
    } catch {
      setAuthError("Mobile verification could not open. Please refresh and try again.");
    }
  };
  const uploadAddressProof = async (file?: File) => {
    if (!file) return;
    setProofUploading(true);
    setSetupError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("documentType", addressProofType);
      const response = await fetch("/api/helper/address-proof", { method: "POST", credentials: "same-origin", body: form });
      const result = await response.json() as { error?: string; filename?: string };
      if (!response.ok) throw new Error(result.error || "We could not upload the address proof.");
      setAddressProofUploaded(true);
      setAddressProofName(result.filename || file.name);
    } catch (error) {
      setSetupError(providerMessage(error, "We could not upload the address proof. Please try again."));
    } finally {
      setProofUploading(false);
      if (proofInputRef.current) proofInputRef.current.value = "";
    }
  };
  const saveHelperProfile = async () => {
    if (!addressProofUploaded) {
      setSetupError("Upload an address proof before publishing your profile.");
      return;
    }
    const offerings: Array<{ serviceType: string; homeSize: string; monthlyPriceRupees: number }> = [];
    if (houseCleaningEnabled) {
      offerings.push(
        { serviceType: "house_cleaning", homeSize: "one_two_bhk", monthlyPriceRupees: Number(housePrices.oneTwo) },
        { serviceType: "house_cleaning", homeSize: "three_bhk", monthlyPriceRupees: Number(housePrices.three) },
        { serviceType: "house_cleaning", homeSize: "four_plus_bhk", monthlyPriceRupees: Number(housePrices.fourPlus) },
      );
    }
    if (utensilsOnceEnabled) offerings.push({ serviceType: "utensils_once", homeSize: "not_applicable", monthlyPriceRupees: Number(utensilsOncePrice) });
    if (utensilsTwiceEnabled) offerings.push({ serviceType: "utensils_twice", homeSize: "not_applicable", monthlyPriceRupees: Number(utensilsTwicePrice) });
    setSetupSaving(true);
    setSetupError("");
    try {
      const response = await fetch("/api/helper/profile", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          locality: helperLocality,
          homeAddress: helperAddress?.formattedAddress,
          latitude: helperAddress?.latitude,
          longitude: helperAddress?.longitude,
          travelDistanceKm: Number(helperTravelDistance),
          yearsExperience: Number(yearsExperience),
          offerings,
          availability: availabilitySlots,
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "We could not save your work profile.");
      setSetupSubmitted(true);
    } catch (error) {
      setSetupError(providerMessage(error, "We could not save your work profile. Please try again."));
    } finally {
      setSetupSaving(false);
    }
  };
  const completeAccount = async () => {
    const name = accountRole === "resident" ? residentName.trim() : helperName.trim();
    if (!name || (accountRole === "resident" && (!residentHouse.trim() || !residentAddress)) || !termsAccepted) {
      setAuthError("Complete the required details and accept the Terms and Privacy Policy.");
      return;
    }
    setAuthBusy(true);
    setAuthError("");
    try {
      const response = await fetch("/api/account/complete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: accountRole,
          name,
          house: residentHouse.trim(),
          locality: residentAddress?.locality,
          formattedAddress: residentAddress?.formattedAddress,
          latitude: residentAddress?.latitude,
          longitude: residentAddress?.longitude,
          termsAccepted,
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "We could not save your account.");
      navTo(accountRole === "resident" ? "requirement" : "setup");
    } catch (error) {
      setAuthError(providerMessage(error, "We could not save your account. Please try again."));
    } finally {
      setAuthBusy(false);
    }
  };
  const signOut = async () => {
    setAccountMenuOpen(false);
    setAuthBusy(true);
    await fetch("/api/auth/signout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    window.location.assign("/");
  };
  const saveResidentAddress = async () => {
    if (!residentHouse.trim() || !residentAddress) {
      setAuthError("Enter your house number and choose your address from Google suggestions.");
      return;
    }
    setAddressSaving(true);
    setAuthError("");
    try {
      const response = await fetch("/api/resident/address", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ house: residentHouse.trim(), ...residentAddress }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "We could not save your address.");
      navTo("settings");
    } catch (error) {
      setAuthError(providerMessage(error, "We could not save your address."));
    } finally {
      setAddressSaving(false);
    }
  };
  const handleBack = () => {
    const previous: Record<string, string> = { mobile: "welcome", residentAccount: "mobile", helperAccount: "mobile", matches: "requirement", profile: "matches", review: "profile", pending: "review", confirmed: "pending", dashboard: "confirmed", membership: "dashboard", issue: "dashboard", settings: "dashboard", address: "settings", privacy: role === "provider" ? "providerSettings" : "settings", terms: legalReturnView, privacyPolicy: legalReturnView, signedOut: "settings", incoming: "setup", providerDashboard: "incoming", providerSettings: "providerDashboard", providerIssue: "providerDashboard" };
    if (previous[view]) navTo(previous[view]);
  };

  const displayName = role === "resident" ? residentName : helperName;
  const accountDestination = role === "resident" ? "settings" : "providerSettings";
  const homeDestination = role === "resident" ? "dashboard" : "providerDashboard";
  const showBack = !["welcome", "requirement", "dashboard", "setup", "providerDashboard"].includes(view);

  return <main>
    <header className="topbar">
      <button className="brand" onClick={() => navTo(signedIn ? homeDestination : "welcome")}><span className="brand-mark">N</span><span>Nivasa</span></button>
      {signedIn ? <div className="topbar-actions">
        <div className="notification-nav">
          {notificationOpen && <button className="account-menu-backdrop" aria-label="Close notifications" onClick={() => setNotificationOpen(false)}/>}
          <button className="notification-trigger" aria-label={unreadCount ? `${unreadCount} unread notifications` : "Notifications"} aria-expanded={notificationOpen} onClick={() => { setAccountMenuOpen(false); setNotificationOpen(open => !open); void loadNotifications(false); }}><svg aria-hidden viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>{unreadCount > 0 && <b>{unreadCount > 9 ? "9+" : unreadCount}</b>}</button>
          {notificationOpen && <section className="notification-panel" aria-label="Notifications">
            <div className="notification-panel-head"><div><h2>Notifications</h2><p>Booking updates in one place</p></div>{unreadCount > 0 && <button onClick={() => void markAllNotificationsRead()}>Mark all read</button>}</div>
            {alertPermission !== "granted" && <div className="browser-alert-card"><span aria-hidden>!</span><div><b>Don’t miss a booking update</b><small>{alertPermission === "denied" ? "Alerts are blocked in your browser settings." : alertPermission === "unsupported" ? "Browser alerts are not supported on this device." : "Allow booking alerts on this device."}</small></div>{alertPermission === "default" && <button onClick={() => void enableBrowserAlerts()}>Turn on</button>}</div>}
            {notificationError && <p className="notification-error">{notificationError}</p>}
            <div className="notification-list">{notifications.length ? notifications.map(item => <button key={item.id} className={item.readAt ? "" : "unread"} onClick={() => void openNotification(item)}><span className="notification-dot"/><span><b>{item.title}</b><small>{item.body}</small><em>{new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(item.createdAt.endsWith("Z") ? item.createdAt : `${item.createdAt.replace(" ", "T")}Z`))}</em></span><span aria-hidden>›</span></button>) : <div className="notification-empty"><span aria-hidden>✓</span><b>You’re all caught up</b><small>New requests and booking decisions will appear here.</small></div>}</div>
          </section>}
        </div>
        <div className="account-nav">
        {accountMenuOpen && <button className="account-menu-backdrop" aria-label="Close account menu" onClick={() => setAccountMenuOpen(false)}/>}
        <button className="account-trigger" aria-haspopup="menu" aria-expanded={accountMenuOpen} onClick={() => { setNotificationOpen(false); setAccountMenuOpen(open => !open); }}><span className="account-avatar">{displayName.trim().charAt(0).toUpperCase() || "N"}</span><span className="account-trigger-copy"><b>{displayName}</b><small>{role === "resident" ? "Resident" : "Home helper"}</small></span><span className="account-caret">⌄</span></button>
        {accountMenuOpen && <div className="account-menu" role="menu"><div className="account-menu-summary"><b>{displayName}</b><small>+91 {mobile || "verified mobile"}</small></div><button role="menuitem" onClick={() => { setAccountMenuOpen(false); navTo(accountDestination); }}><span>Profile & settings</span><span>›</span></button><button className="signout-menu-item" role="menuitem" disabled={authBusy} onClick={signOut}><span>{authBusy ? "Signing out…" : "Sign out"}</span></button></div>}
        </div>
      </div> : null}
    </header>
    <div className="workspace app-workspace">
      <section className="phone-stage"><div className="phone-shell">
        {showBack && <div className="mobile-header"><button className="mobile-back" aria-label="Go back" onClick={handleBack}>← <span>Back</span></button></div>}
        {cancelOpen && <div className="sheet-backdrop" role="presentation" onClick={() => !cancelBusy && setCancelOpen(false)}><section className="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="cancel-title" onClick={event => event.stopPropagation()}><button className="sheet-close" aria-label="Close cancellation" disabled={cancelBusy} onClick={() => setCancelOpen(false)}>×</button><h2 id="cancel-title">Cancel this booking?</h2><p>The recurring time will be released immediately.</p>{activeRequest?.bookingStatus === "trial" && <div className="fee-card"><div><span>Payment for completed trial work</span><strong>{estimatedTrialPayment ? `₹${estimatedTrialPayment.toLocaleString("en-IN")}` : "₹0"}</strong></div><p>{estimatedTrialPayment ? `${completedTrialDays} completed service ${completedTrialDays === 1 ? "day remains" : "days remain"} payable directly to the home helper after cancellation.` : "No service day has been marked complete, so no trial payment is due."}</p></div>}<div className="cancel-reasons">{(role === "resident" ? ["Helper did not arrive", "Timing did not work", "Not satisfied with service", "Safety or misconduct", "Something else"] : ["Timing did not work", "Resident was unavailable", "Safety or misconduct", "Something else"]).map(item => <label key={item}><input type="radio" name="cancel-reason" checked={cancelReason === item} onChange={() => setCancelReason(item)}/><span>{item}</span></label>)}</div><Field label="Share feedback (optional)"><textarea rows={3} maxLength={1000} value={cancelFeedback} onChange={event => setCancelFeedback(event.target.value)} placeholder="Tell us what happened"/></Field>{cancelError && <p className="auth-error" role="alert">{cancelError}</p>}<button className="primary danger-button" disabled={!cancelReason || cancelBusy} onClick={() => void cancelBooking()}>{cancelBusy ? "Cancelling…" : "Cancel and release time"}</button><button className="secondary" disabled={cancelBusy} onClick={() => setCancelOpen(false)}>Keep booking</button></section></div>}
        {paymentOpen && <div className="sheet-backdrop" role="presentation"><section className="bottom-sheet payment-sheet" role="dialog" aria-modal="true" aria-labelledby="payment-title"><button className="sheet-close" aria-label="Close payment" onClick={() => setPaymentOpen(false)}>×</button><Mark>Secure payment</Mark><h2 id="payment-title">Complete your slot membership</h2><p>You would now continue to the payment provider. The final amount, billing period and renewal consent will be shown before payment.</p><button className="primary" onClick={() => { setBooking("active"); setPaymentOpen(false); navTo("dashboard"); }}>Simulate successful payment</button><button className="secondary" onClick={() => setPaymentOpen(false)}>Return without paying</button></section></div>}

        {view === "welcome" && <div className="screen auth-screen welcome-screen">
          <div className="welcome-mark" aria-hidden><span>N</span></div>
          <ScreenTitle eyebrow="Nivasa" title="Reliable home help, close to home" text="Find and book verified home helpers whose services, prices and recurring times are clear before you request." />
          <div className="auth-role-cards" aria-label="Choose how you want to use Nivasa">
            <button onClick={() => chooseAccountRole("resident")}><span className="auth-role-icon">⌂</span><span><b>I need home help</b><small>Find and book a recurring home helper</small></span><span className="chevron">›</span></button>
            <button onClick={() => chooseAccountRole("provider")}><span className="auth-role-icon helper-icon">✦</span><span><b>I provide home help</b><small>List your services, prices and free times</small></span><span className="chevron">›</span></button>
          </div>
          <p className="auth-footnote">One account, secured with your mobile number. No password needed.</p>
        </div>}

        {view === "mobile" && <div className="screen auth-screen">
          <ScreenTitle eyebrow={accountRole === "resident" ? "Resident account" : "Home helper account"} title="Create your account with your mobile number" text="We’ll send a one-time code to verify your number. No password is required." />
          <section className="privacy-note"><b>Your number stays private</b><p>It is used to secure your account and send essential booking updates.</p></section>
          {authError && <p className="auth-error" role="alert">{authError}</p>}
          <button className="primary" disabled={authBusy || !msg91Ready} onClick={openMsg91Widget}>{authBusy ? "Completing sign-in…" : msg91Ready ? "Continue with mobile number" : "Preparing secure sign-in…"}</button>
          <p className="auth-footnote">You’ll enter your mobile number and verification code in the secure sign-in window.</p>
        </div>}

        {view === "residentAccount" && <div className="screen auth-screen">
          <ScreenTitle eyebrow="Almost done" title="Set up your resident account" text="We need only the details required to match you with nearby home helpers." />
          <Field label="Your name"><input className="text-input" autoComplete="name" value={residentName} onChange={event => setResidentName(event.target.value)} /></Field>
          <Field label="House or flat number"><input className="text-input" autoComplete="address-line1" value={residentHouse} onChange={event => setResidentHouse(event.target.value)} placeholder="For example, House 214" /></Field>
          <Field label="Search for your society or address" hint="Choose a result from Google so we can calculate nearby matches."><GoogleAddressField value={residentAddress?.formattedAddress || ""} onSelect={setResidentAddress} onClear={() => setResidentAddress(null)} placeholder="Start typing your society or address" /></Field>
          <div className="privacy-note"><b>Your address stays private</b><p>Before booking, home helpers see only your approximate locality. Your full address is shared only after acceptance.</p></div>
          <label className="consent account-consent"><input type="checkbox" checked={termsAccepted} onChange={event => setTermsAccepted(event.target.checked)} /><span>I agree to Nivasa’s <button type="button" onClick={() => openLegalPage("terms")}>Terms</button> and <button type="button" onClick={() => openLegalPage("privacyPolicy")}>Privacy Policy</button>.</span></label>
          {authError && <p className="auth-error" role="alert">{authError}</p>}
          <button className="primary" disabled={authBusy} onClick={completeAccount}>{authBusy ? "Saving…" : "Find home help"}</button>
        </div>}

        {view === "helperAccount" && <div className="screen auth-screen">
          <ScreenTitle eyebrow="Almost done" title="Create your home helper account" text="Start with your name. Your services, prices and available times come next." />
          <Field label="Your name"><input className="text-input" autoComplete="name" value={helperName} onChange={event => setHelperName(event.target.value)} /></Field>
          <div className="privacy-note"><b>You control what residents see</b><p>Your mobile number, exact home address and proof document stay private until the appropriate booking step.</p></div>
          <label className="consent account-consent"><input type="checkbox" checked={termsAccepted} onChange={event => setTermsAccepted(event.target.checked)} /><span>I agree to Nivasa’s <button type="button" onClick={() => openLegalPage("terms")}>Terms</button> and <button type="button" onClick={() => openLegalPage("privacyPolicy")}>Privacy Policy</button>.</span></label>
          {authError && <p className="auth-error" role="alert">{authError}</p>}
          <button className="primary" disabled={authBusy} onClick={completeAccount}>{authBusy ? "Saving…" : "Continue to work profile"}</button>
        </div>}

        {view === "requirement" && <div className="screen">
          <ScreenTitle title="Find reliable house help nearby" text="Tell us the work and timing. We’ll show people who can fit it into their regular schedule." />
          {trialPayment && <section className="payment-action-card"><Mark>{trialPayment.status === "pending" ? "Payment due" : trialPayment.status === "resident_marked_paid" ? "Awaiting confirmation" : "Review requested"}</Mark><h2>₹{trialPayment.amountRupees.toLocaleString("en-IN")} for completed trial work</h2>{trialPayment.status === "pending" ? <><p>Pay {trialPayment.helperName || "your home helper"} directly. You cannot send another booking request until you mark this payment as sent.</p>{paymentMobile ? <><SummaryRow label="Pay using mobile number" value={`+91 ${paymentMobile}`}/><p className="payment-note">Open your preferred UPI app and pay using this registered mobile number.</p></> : <p className="payment-note">Use the payment method agreed with the home helper.</p>}<button className="primary" disabled={paymentBusy} onClick={() => void updateTrialPayment("mark_paid")}>{paymentBusy ? "Saving…" : "I have paid"}</button></> : trialPayment.status === "resident_marked_paid" ? <><p>{trialPayment.helperName || "Your home helper"} has been asked to confirm receipt after checking her payment app.</p>{canRequestPaymentReview ? <button className="secondary" disabled={paymentBusy} onClick={() => void updateTrialPayment("request_review")}>Payment sent but not confirmed</button> : <small>You can request a backend review 12 hours after marking the payment as sent.</small>}</> : <p>Your payment is queued for backend review. You can now send a new booking request.</p>}{paymentError && <p className="auth-error" role="alert">{paymentError}</p>}</section>}
          <Field label="What services do you need?"><div className="service-cards">{["House cleaning", "Utensil cleaning", "House cleaning + utensils"].map(item => <button key={item} onClick={() => { setService(item); if (item === "House cleaning") setFrequency("Once daily"); }} className={service === item ? "selected" : ""}><span className="service-icon">{item === "House cleaning" ? "⌂" : item === "Utensil cleaning" ? "◒" : "✦"}</span><span>{item}</span>{service === item && <Check />}</button>)}</div></Field>
          {service !== "House cleaning" && <Field label="How often should utensils be cleaned?"><Segmented label="Utensil frequency" options={["Once daily", "Twice daily"]} value={frequency} onChange={setFrequency} /></Field>}
          {service.includes("House cleaning") && <Field label="Home size"><Segmented label="Home size" options={["1–2 BHK", "3 BHK", "4+ BHK"]} value={homeSize} onChange={setHomeSize} /></Field>}
          <div className={twice ? "time-grid" : ""}><Field label={twice ? "First visit time" : "Preferred time"}><input className="time-input" type="time" value={firstTime} onChange={event => setFirstTime(event.target.value)} /></Field>{twice && <Field label="Second visit time"><input className="time-input" type="time" value={secondTime} min={firstTime} onChange={event => setSecondTime(event.target.value)} /></Field>}</div>{invalidTimes && <p className="field-error">Choose a second visit time after the first visit.</p>}
          {twice && service.startsWith("House") && <Field label="Which visit should include house cleaning?"><Segmented label="Cleaning visit" options={["First visit", "Second visit"]} value={cleaningVisit} onChange={setCleaningVisit} /><small>The other visit will be utensils only.</small></Field>}
          <Field label="Can your timing be flexible?"><Segmented label="Time flexibility" options={["Exact time", "Up to 30 min", "Up to 1 hour"]} value={flexibility} onChange={setFlexibility} /></Field>
          <Field label="When should the service start?"><input className="text-input" type="date" min={new Date().toISOString().slice(0, 10)} value={requestedStartDate} onChange={event => setRequestedStartDate(event.target.value)} /></Field>
          <Field label="Your home"><button className="input-like" onClick={() => navTo("address")}><span>⌖</span><span>{residentAddress ? `${residentHouse}, ${residentAddress.locality}` : "Add your home address"}<small>Exact address stays private until booking</small></span><span>›</span></button></Field>
          {matchesError && <p className="auth-error" role="alert">{matchesError}</p>}
          <button className="primary" disabled={invalidTimes || matchesLoading || paymentBlocking} onClick={() => void loadMatches()}>{paymentBlocking ? "Complete trial payment to search" : matchesLoading ? "Finding available helpers…" : "Find available home helpers"} {!paymentBlocking && <span>→</span>}</button>
        </div>}

        {view === "matches" && <div className="screen">
          <ScreenTitle eyebrow={matchesLoading ? "Searching saved profiles" : `${visiblePeople.length} ${visiblePeople.length === 1 ? "person" : "people"} available`} title="Choose who feels right" />
          <button className="requirement-summary" onClick={() => navTo("requirement")}><span><b>{packageName}</b><small>{scheduleText} · {residentAddress?.locality || "Your home"}</small></span><span>Edit</span></button>
          <div className="filter-row"><button onClick={() => { setFiltersOpen(!filtersOpen); setSortOpen(false); }}>☷ Filters <Mark>{Number(exactOnly) + Number(verifiedOnly)}</Mark></button><button onClick={() => { setSortOpen(!sortOpen); setFiltersOpen(false); }}>{sortBy} <span>⌄</span></button></div>
          {filtersOpen && <section className="control-panel"><div className="panel-head"><h2>Filters</h2><button onClick={() => { setExactOnly(false); setVerifiedOnly(false); }}>Clear all</button></div><label className="toggle-row"><span><b>Exact requested times</b><small>Hide nearby alternatives</small></span><input type="checkbox" checked={exactOnly} onChange={event => setExactOnly(event.target.checked)} /></label><label className="toggle-row"><span><b>Address proof provided</b><small>Show profiles with a private address-proof upload</small></span><input type="checkbox" checked={verifiedOnly} onChange={event => setVerifiedOnly(event.target.checked)} /></label><p className="section-copy">Distance is used to rank helpers, not to hide suitable people.</p><button className="primary" onClick={() => setFiltersOpen(false)}>Show {visiblePeople.length} matches</button></section>}
          {sortOpen && <section className="control-panel sort-panel"><h2>Sort matches</h2>{["Best match", "Closest", "Lowest price", "Most experienced", "Highest rated"].map(option => <button key={option} className={sortBy === option ? "selected" : ""} onClick={() => { setSortBy(option); setSortOpen(false); }}>{option}{sortBy === option && <Check />}</button>)}</section>}
          {matchesLoading ? <div className="empty-dashboard"><b>Checking live availability…</b><p>We’re comparing your services and times with saved helper profiles.</p></div> : matchesError ? <div className="empty-dashboard"><b>We couldn’t load matches</b><p>{matchesError}</p><button className="secondary" onClick={() => void loadMatches()}>Try again</button></div> : visiblePeople.length === 0 ? <div className="empty-dashboard"><b>No available match yet</b><p>Try a wider time flexibility, or return later as more home helpers join.</p><button className="secondary" onClick={() => navTo("requirement")}>Change requirements</button></div> : <div className="people-list">{visiblePeople.map(person => <button className="person-card" key={person.id} onClick={() => { setSelectedHelperId(person.id); navTo("profile"); }}><div className="person-head"><Avatar person={person}/><span className="person-name"><b>{person.name}</b><small>{person.addressProofProvided ? <><Check /> Address proof provided</> : "Profile information provided"}</small></span><span className="chevron">›</span></div>{twice ? <div className="two-slot-match"><b className={person.match === "Exact time" ? "exact" : "alternative"}>{person.match === "Exact time" ? "✓ Available for both visits" : `◷ ${person.match}`}</b><span><small>First visit</small>{formatTime(person.time)}</span><span><small>Second visit</small>{formatTime(person.secondTime)}</span>{service.startsWith("House") && <em>House cleaning during the {cleaningVisit.toLowerCase()}</em>}</div> : <div className="match-line"><span className={person.match === "Exact time" ? "exact" : "alternative"}>{person.match === "Exact time" ? "✓" : "◷"} {person.match}</span><span>{formatTime(person.time)}</span></div>}<p>{person.detail}</p><div className="price-line"><b>₹{priceFor(person).toLocaleString("en-IN")}<small>/month</small></b>{person.rating ? <span>★ {person.rating}</span> : <span>Reviews appear after verified work</span>}</div></button>)}</div>}
        </div>}

        {view === "profile" && <div className="screen profile-screen">{selectedPerson ? <>
          <div className="profile-hero"><Avatar person={selectedPerson}/><div><h1>{selectedPerson.name}</h1><p>{selectedPerson.addressProofProvided ? <><Check /> Address proof provided</> : "Profile information provided"}</p></div></div>
          <div className="fit-card"><span className="success-icon">✓</span><div><b>Fits your schedule</b><p>{twice ? `Both visits · ${formatTime(matchedFirstTime)} and ${formatTime(matchedSecondTime)}` : `Mon–Sat · ${formatTime(matchedFirstTime)}`}</p><small>{selectedPerson.match === "Exact time" ? "Available at your preferred time" : "Available at the closest suitable time"}</small></div></div>
          <div className="price-panel"><span>Your selected service</span><b>₹{monthlyPrice.toLocaleString("en-IN")}<small>/month</small></b><p>{packageName}</p></div>
          <div className="facts"><span><b>{selectedPerson.experience} {selectedPerson.experience === 1 ? "year" : "years"}</b><small>Experience</small></span><span><b>{selectedPerson.distance < 1 ? `${Math.max(100, Math.round(selectedPerson.distance * 10) * 100)} m` : `${selectedPerson.distance.toFixed(1)} km`}</b><small>Approx. distance</small></span><span><b>{selectedPerson.averageRating ? `${selectedPerson.averageRating.toFixed(1)} ★` : "New"}</b><small>{selectedPerson.reviewCount ? `${selectedPerson.reviewCount} reviews` : "No reviews yet"}</small></span></div>
          <section className="content-section"><h2>Your selected package</h2>{twice && <div className="selected-visits"><p><b>First visit · {formatTime(matchedFirstTime)}</b>{service.startsWith("House") && cleaningVisit === "First visit" ? "House cleaning and utensil cleaning" : "Utensil cleaning"}</p><p><b>Second visit · {formatTime(matchedSecondTime)}</b>{service.startsWith("House") && cleaningVisit === "Second visit" ? "House cleaning and utensil cleaning" : "Utensil cleaning"}</p></div>}<h2>What’s included</h2><ul>{service.includes("House cleaning") && <><li><Check /> Sweeping and mopping occupied rooms</li><li><Check /> Kitchen floor</li><li><Check /> Bathroom floor, sink and accessible surfaces</li></>}{service.includes("utensil") || service.includes("Utensil") ? <><li><Check /> Regular daily kitchen utensils</li><li><Check /> Kitchen sink cleaned after completion</li></> : null}</ul><h3>Not included</h3><p>{service.includes("House cleaning") && "Toilet/commode, seat or flush cleaning; laundry, ironing or balcony washing. "}{service.includes("utensil") || service.includes("Utensil") ? "Deep scrubbing of heavily burnt cookware or unusually large party loads." : ""}</p></section>
          <section className="content-section"><h2>Verified reviews</h2>{selectedPerson.reviewCount ? <p>{selectedPerson.averageRating?.toFixed(1)} out of 5 from {selectedPerson.reviewCount} verified {selectedPerson.reviewCount === 1 ? "review" : "reviews"}.</p> : <p>Reviews will appear after residents complete verified service through Nivasa.</p>}</section>
          <section className="how-it-works"><h2>What happens next</h2><ol><li><span>1</span>{selectedPerson.name} has 24 hours to respond.</li><li><span>2</span>If she accepts, your booking is confirmed.</li><li><span>3</span>Your first two service days are a paid trial.</li></ol><p className="trial-note">You can cancel during the trial. Pay only for completed work. If you continue after Day 2, the booking runs through the current 30-day cycle.</p></section>
          <div className="sticky-cta"><span><b>₹{monthlyPrice.toLocaleString("en-IN")}</b><small>/month</small></span><button className="primary" onClick={() => navTo("review")}>Request this booking</button></div>
        </> : <div className="empty-dashboard"><b>Select a home helper first</b><p>Return to your matches to choose an available profile.</p><button className="secondary" onClick={() => navTo("matches")}>View matches</button></div>}</div>}

        {view === "review" && <div className="screen">
          <ScreenTitle eyebrow="One last check" title="Review your booking request" text="Nothing will be charged today." />
          {selectedPerson && <div className="mini-person"><Avatar person={selectedPerson} small/><span><b>{selectedPerson.name}</b><small>{selectedPerson.addressProofProvided ? <><Check /> Address proof provided</> : "Profile information provided"} · {selectedPerson.distance.toFixed(1)} km away</small></span></div>}
          <section className="review-section"><h2>Service</h2><SummaryRow label="Package" value={packageName}/>{service.includes("House cleaning") && <SummaryRow label="Home size" value={homeSize}/>}<SummaryRow label={twice ? "First visit" : "Schedule"} value={twice ? `${formatTime(matchedFirstTime)}${service.startsWith("House") && cleaningVisit === "First visit" ? " · includes house cleaning" : " · utensils"}` : `Mon–Sat · ${formatTime(matchedFirstTime)}`}/>{twice && <SummaryRow label="Second visit" value={`${formatTime(matchedSecondTime)}${service.startsWith("House") && cleaningVisit === "Second visit" ? " · includes house cleaning" : " · utensils"}`}/>}<SummaryRow label="Starts" value={friendlyDate(requestedStartDate)}/><SummaryRow label={`${chosenHelperName}’s monthly price`} value={`₹${monthlyPrice.toLocaleString("en-IN")}`} strong/></section>
          <section className="review-section"><h2>How the booking works</h2><div className="timeline"><span/><div><b>Request sent</b><p>{chosenHelperName} gets 24 hours to respond.</p></div><span/><div><b>Booking confirmed on acceptance</b><p>Your recurring {twice ? "times are" : "time is"} reserved immediately.</p></div><span/><div><b>Two-day paid trial</b><p>You can cancel during the first two service days; completed work remains payable.</p></div></div></section>
          <section className="fee-card"><div><span>Platform slot membership</span><Mark>No platform fee during beta</Mark></div><p>During the beta, {twice ? "both recurring time slots are" : "your recurring time slot is"} reserved without a platform charge. After the beta, you will see the complete membership offer and choose whether to continue before any payment is requested.</p></section>
          {requestError && <p className="auth-error" role="alert">{requestError}</p>}<button className="primary" disabled={requestBusy || !selectedPerson} onClick={() => void sendRequest()}>{requestBusy ? "Holding this time…" : "Send booking request"} <span>→</span></button><p className="consent-copy">By continuing, you agree to the service scope, listed price and booking terms.</p>
        </div>}

        {view === "pending" && <div className="screen state-screen">
          <div className="state-illustration pending-art"><span>◷</span></div><Mark>Awaiting response</Mark><ScreenTitle title={`Request sent to ${chosenHelperName}`} text="Your requested time is being held while she decides." />
          <div className="deadline"><span>Respond by</span><b>{currentRequest?.responseDueAt ? new Date(currentRequest.responseDueAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "Within 24 hours"}</b><small>The recurring time remains unavailable to other residents until then.</small></div><section className="compact-card"><SummaryRow label="Service" value={currentRequest ? storedPackageName(currentRequest) : packageName}/><SummaryRow label={(currentRequest?.slots.length ?? (twice ? 2 : 1)) > 1 ? "Times held" : "Time held"} value={currentRequest?.slots.map(slot => formatTime(slot.startTime)).join(" & ") || scheduleText}/><SummaryRow label="Starts" value={friendlyDate(currentRequest?.requestedStartDate || requestedStartDate)}/></section>
          <div className="info-banner"><span>i</span><p>If {chosenHelperName} accepts, your booking is confirmed automatically. Your first two service days are a paid trial. You can cancel during the trial and pay only for completed work. If you continue after Day 2, the booking remains active until the end of the current 30-day cycle. You can stop the next renewal or report a serious service issue at any time.</p></div>{requestError && <p className="auth-error" role="alert">{requestError}</p>}<button className="primary" disabled={requestBusy} onClick={() => void loadResidentRequest(true)}>{requestBusy ? "Checking…" : "Check response"}</button><button className="secondary" disabled={requestBusy} onClick={() => void withdrawRequest()}>Withdraw request</button>
        </div>}

        {view === "confirmed" && <div className="screen state-screen">
          <div className="state-illustration confirmed-art"><span>✓</span></div><Mark>Booking confirmed</Mark><ScreenTitle title={`You’re booked with ${chosenHelperName}`} text="Your recurring time is reserved. Your first two service days are a paid trial." />
          <section className="visit-card"><div className="visit-head"><h2>Upcoming paid trial</h2><Mark muted>2 service days</Mark></div><div className="visit"><span><b>{trialDayOne.weekday}</b>{trialDayOne.day}</span><p><b>Trial day 1 · {trialDayOne.label}</b>{currentRequest?.slots.map(slot => formatTime(slot.startTime)).join(" & ") || formatTime(matchedFirstTime)} · {currentRequest ? storedPackageName(currentRequest) : packageName}</p></div><div className="visit"><span><b>{trialDayTwo.weekday}</b>{trialDayTwo.day}</span><p><b>Trial day 2 · {trialDayTwo.label}</b>{currentRequest?.slots.map(slot => formatTime(slot.startTime)).join(" & ") || formatTime(matchedFirstTime)} · {currentRequest ? storedPackageName(currentRequest) : packageName}</p></div></section>
          <div className="contact-actions">{currentRequest?.helperMobile ? <a href={`tel:${currentRequest.helperMobile}`}>☎<span>Call {chosenHelperName}</span></a> : <button disabled>Contact available after acceptance</button>}</div><section className="next-card"><span>Your recurring slot</span><h2>Reserved during the beta</h2><p>No platform payment is required during the beta. You can cancel during the first two paid trial service days; completed work remains payable.</p></section><button className="primary" onClick={() => navTo("dashboard")}>Go to your dashboard</button><button className="text-button danger" onClick={() => { setCancelReason(""); setCancelError(""); setCancelOpen(true); }}>Cancel during trial</button>
        </div>}

        {view === "dashboard" && <div className="screen dashboard-screen">
          <ScreenTitle title="Your home help" />
          {currentRequest?.bookingId && currentRequest.bookingStatus !== "cancelled" ? <section className="active-booking"><div className="booking-person"><span className="avatar clay small">{currentRequest.helperName?.trim().charAt(0).toUpperCase() || "H"}</span><span><b>{currentRequest.helperName}</b><small>{storedPackageName(currentRequest)} · Mon–Sat</small></span></div><div className="next-visit"><span><b>{currentRequest.bookingStatus === "trial" ? "Paid trial" : "Current service period"}</b><small>{currentRequest.bookingStatus === "trial" ? `${Number(currentRequest.trialVisitsCompleted ?? 0)} of 2 service days completed` : `Runs through ${friendlyDate(currentRequest.cycleEndsAt)}`}</small></span><strong>{residentBookingSchedule}</strong></div><div className="contact-actions">{currentRequest.helperMobile ? <a href={`tel:${currentRequest.helperMobile}`}>☎ Call {currentRequest.helperName}</a> : <button disabled>Contact unavailable</button>}</div></section> : <div className="empty-dashboard"><b>No confirmed booking</b><p>Find an available home helper to begin.</p><button className="secondary" onClick={() => navTo("requirement")}>Find home help</button></div>}
          <section className="dashboard-block"><div className="section-head"><h2>Booking details</h2></div><div className="dashboard-list"><div className="dashboard-info"><span className="list-icon">◷</span><span><b>Recurring schedule</b><small>{residentBookingSchedule}</small></span></div><button onClick={() => navTo("membership")}><span className="list-icon">₹</span><span><b>Membership</b><small>{booking === "ending" ? `Renewal off · ends ${friendlyDate(currentRequest?.cycleEndsAt)}` : "Slot protected during beta"}</small></span><span>›</span></button><div className="dashboard-info"><span className="list-icon">▤</span><span><b>Monthly compensation</b><small>₹{monthlyPrice.toLocaleString("en-IN")} due after the first 30-day cycle</small></span></div></div></section>
          <section className="dashboard-block"><div className="section-head"><h2>Manage</h2></div><div className="dashboard-list"><button onClick={openIssueReport}><span className="list-icon">!</span><span><b>Report an issue</b><small>No-show, payment, safety or service concern</small></span><span>›</span></button>{canCancelBooking ? <button onClick={() => { setCancelReason(""); setCancelError(""); setCancelOpen(true); }}><span className="list-icon">×</span><span><b>Cancel booking</b><small>Release this recurring time immediately</small></span><span>›</span></button> : <div className="dashboard-info"><span className="list-icon">⌁</span><span><b>Cancellation unavailable</b><small>Available again after {friendlyDate(currentRequest?.cycleEndsAt)}</small></span></div>}</div></section>
        </div>}

        {view === "membership" && <div className="screen"><ScreenTitle eyebrow="Keep your recurring slot" title="Your booking" text={`Membership keeps ${chosenHelperName}’s recurring time reserved for you.`} />{betaMode ? <section className="beta-membership"><Mark>Beta access</Mark><h2>Your slot is reserved during the beta</h2><p>No platform payment is required. After the beta, you can review the complete membership offer and choose whether to continue.</p></section> : <section className="membership-price"><span>30-day membership</span><b>Final price shown here</b><p>Separate from your home helper’s monthly compensation.</p></section>}<section className="benefits"><h2>Included</h2><p><Check /> Recurring slot protection</p><p><Check /> Rematch support without extra cost</p><p><Check /> Verified booking and review history</p><p><Check /> Issue reporting</p></section><button className="primary" onClick={() => betaMode ? navTo("dashboard") : setPaymentOpen(true)}>{betaMode ? "Return to booking" : "Continue to secure payment"}</button>{canCancelBooking && <button className="secondary" onClick={() => setCancelOpen(true)}>Cancel booking</button>}<p className="consent-copy">Completed service remains payable even if you cancel.</p></div>}

        {view === "issue" && <div className="screen">{!issueSent ? <><ScreenTitle eyebrow="We’re here to help" title="What happened?" text="Choose the closest option. Safety concerns are reviewed urgently." /><div className="issue-options">{["Helper did not arrive", "Timing did not work", "Not satisfied with service", "Safety or misconduct", "Something else"].map(item => <label key={item}><input type="radio" name="issue" checked={residentIssue === item} onChange={() => setResidentIssue(item)}/><span>{item}</span></label>)}</div><Field label="Share feedback (optional)"><textarea value={residentIssueFeedback} onChange={event => setResidentIssueFeedback(event.target.value)} maxLength={1000} placeholder="Add a short description. Please don’t include Aadhaar or other identity numbers." rows={4}/></Field>{issueError && <p className="auth-error" role="alert">{issueError}</p>}<button className="primary" disabled={!residentIssue || issueBusy} onClick={() => void submitIssue()}>{issueBusy ? "Submitting…" : "Submit report"}</button></> : <div className="state-screen"><div className="state-illustration confirmed-art"><span>✓</span></div><Mark>Report received</Mark><ScreenTitle title={issueCaseNumber ? `Case #${issueCaseNumber} has been created` : "Your report has been saved"} text="We’ll review your report and contact you on your registered mobile number if we need more information."/><button className="primary" onClick={() => navTo("dashboard")}>Return to dashboard</button></div>}</div>}

        {view === "settings" && <div className="screen"><ScreenTitle eyebrow="Account" title="Profile & settings"/><div className="profile-summary"><span className="avatar violet">S</span><div><b>{residentName}</b><small><Check/> Mobile verified</small></div></div><div className="dashboard-list standalone"><button onClick={() => navTo("address")}><span className="list-icon">⌂</span><span><b>Home address</b><small>Saved privately for matching</small></span><span>›</span></button><button><span className="list-icon">◉</span><span><b>Mobile</b><small>+91 {mobile || "98XXX XXXXX"}</small></span><span>›</span></button><button onClick={() => navTo("privacy")}><span className="list-icon">⌾</span><span><b>Privacy & data</b><small>See and manage your information</small></span><span>›</span></button></div><button className="secondary" onClick={signOut}>Sign out</button></div>}

        {view === "providerSettings" && <div className="screen"><ScreenTitle eyebrow="Account" title="Profile & settings"/><div className="profile-summary"><span className="avatar sage">{helperName.trim().charAt(0).toUpperCase() || "H"}</span><div><b>{helperName}</b><small><Check/> Mobile verified</small></div></div><div className="dashboard-list standalone"><button onClick={() => navTo("setup")}><span className="list-icon">✦</span><span><b>Work profile</b><small>Services, prices, work area and available times</small></span><span>›</span></button><div className="dashboard-info"><span className="list-icon">◉</span><span><b>Mobile</b><small>+91 {mobile || "98XXX XXXXX"}</small></span></div><button onClick={() => navTo("privacy")}><span className="list-icon">⌾</span><span><b>Privacy & data</b><small>See and manage your information</small></span><span>›</span></button></div><button className="secondary" disabled={authBusy} onClick={signOut}>{authBusy ? "Signing out…" : "Sign out"}</button></div>}

        {view === "address" && <div className="screen"><ScreenTitle eyebrow="Private information" title="Edit home address" text="Your exact address is used for nearby matching and shared with your home helper only after a booking is confirmed."/><Field label="House or flat number"><input className="text-input" value={residentHouse} onChange={event => setResidentHouse(event.target.value)} placeholder="For example, House 214"/></Field><Field label="Search for your society or address" hint="Choose a result from Google so we can calculate nearby matches."><GoogleAddressField value={residentAddress?.formattedAddress || ""} onSelect={setResidentAddress} onClear={() => setResidentAddress(null)} placeholder="Start typing your society or address"/></Field>{booking !== "draft" && <div className="info-banner"><span>i</span><p>Changing your address may affect {chosenHelperName}’s distance and availability. We’ll recheck the current booking before applying the change.</p></div>}{authError && <p className="auth-error" role="alert">{authError}</p>}<button className="primary" disabled={addressSaving} onClick={() => void saveResidentAddress()}>{addressSaving ? "Saving…" : "Save address"}</button></div>}

        {view === "privacy" && <div className="screen"><ScreenTitle eyebrow="Your information" title="Privacy & data" text="A simple view of what Nivasa collects and shares."/><section className="privacy-section"><h2>Information we collect</h2><p>Name and mobile number, saved home address, requests and bookings, payments, reviews, complaints and product usage.</p></section><section className="privacy-section"><h2>What is shared</h2><p>Only an approximate locality is shown before acceptance. Your exact address and contact are shared with your selected home helper after booking confirmation. Private verification documents are never publicly displayed.</p></section><section className="privacy-section"><h2>Read our policies</h2><p>See how Nivasa operates the pilot and handles your information.</p><button className="secondary" onClick={() => openLegalPage("privacyPolicy")}>Privacy Policy</button><button className="secondary" onClick={() => openLegalPage("terms")}>Terms of Use</button></section><section className="privacy-section"><h2>Need help?</h2><p>Submit a private backend case and choose “Something else” for an account or privacy question.</p><button className="secondary" onClick={openIssueReport}>Report an issue</button></section></div>}

        {view === "terms" && <div className="screen legal-screen"><ScreenTitle eyebrow="Pilot terms · 25 August 2026" title="Terms of Use" text="These terms explain how the Nivasa home-help marketplace pilot works."/><section><h2>1. Who may use Nivasa</h2><p>You must be at least 18 years old and provide accurate account, service, address, availability and payment information.</p></section><section><h2>2. Nivasa is a marketplace</h2><p>Nivasa helps residents and independent home helpers find each other, compare listed services and prices, request recurring times and record bookings. Nivasa is not the employer, agent or guarantor of either party.</p></section><section><h2>3. Profiles and checks</h2><p>A verified mobile number or an “address proof provided” label confirms only that the stated step was completed. It is not a police verification, background check, skill certification or guarantee of identity, safety, conduct or service quality.</p></section><section><h2>4. Requests and bookings</h2><p>A request temporarily holds the selected recurring time while the home helper responds. Acceptance confirms the booking. The listed package, schedule and monthly compensation shown before the request form the booking record.</p></section><section><h2>5. Paid trial and compensation</h2><p>The first two scheduled service days are a paid trial. Completed work remains payable even if either party cancels. During the beta, residents pay home helpers directly and Nivasa does not automatically charge a platform fee.</p></section><section><h2>6. Cancellation and availability</h2><p>Either party may cancel during the two-day trial. After the trial, cancellation is available at the end of the current 30-day service period. Cancelling releases the recurring time according to the booking status shown in the app.</p></section><section><h2>7. Conduct and safety</h2><p>Users must behave lawfully and respectfully, protect each other’s personal information and report no-shows, payment concerns, safety issues or misconduct through the app. Nivasa is not an emergency service; contact local emergency services when immediate help is required.</p></section><section><h2>8. Pilot availability</h2><p>The pilot may contain errors, change or be paused while we learn. Nivasa may restrict accounts for fraud, abuse, non-payment, safety concerns or misuse of the platform.</p></section><section><h2>9. Support and changes</h2><p>Use “Report an issue” in the app and choose “Something else” for general support. Material changes to these terms will be shown before they apply to a future booking or require renewed consent.</p></section><button className="primary" onClick={() => navTo(legalReturnView)}>Return</button></div>}

        {view === "privacyPolicy" && <div className="screen legal-screen"><ScreenTitle eyebrow="Pilot policy · 25 August 2026" title="Privacy Policy" text="This policy explains what Nivasa collects, why it is needed and how it is shared."/><section><h2>1. Information we collect</h2><p>We collect account details such as name and verified mobile number; resident and helper addresses and map coordinates; helper services, prices, availability and address-proof documents; requests, bookings, visits, payments, reviews, reports, notifications, consent records and product-usage events.</p></section><section><h2>2. Why we use it</h2><p>We use this information to secure accounts, find nearby matches, prevent overlapping bookings, run the paid-trial and payment workflows, send essential booking notifications, resolve reports, protect users and understand whether the pilot works.</p></section><section><h2>3. What other users see</h2><p>Before acceptance, users see only information needed to evaluate a match, including name, approximate locality or distance, services, prices, availability and profile-status labels. After acceptance, the matched resident and home helper receive the contact and address information needed to perform the booking.</p></section><section><h2>4. Private documents</h2><p>Address-proof documents are stored separately in private file storage and are not displayed to residents or included in analytics. Uploading a document does not represent a police or background verification.</p></section><section><h2>5. Service providers</h2><p>Nivasa uses service providers for cloud hosting and storage, mobile OTP verification, maps and address search, and essential browser notifications. They receive only the information needed to provide those services under their own security and privacy obligations.</p></section><section><h2>6. Analytics and marketing</h2><p>We record product events such as screens viewed, requests, bookings and issue submissions to evaluate the pilot. We do not sell personal information. Essential account and booking messages are not marketing messages.</p></section><section><h2>7. Retention and protection</h2><p>We keep information only while it is reasonably needed to operate the pilot, maintain booking and payment records, resolve disputes, prevent misuse and meet legal obligations. Access is restricted and private documents are not publicly accessible. No online system can guarantee absolute security.</p></section><section><h2>8. Your choices</h2><p>You can update available profile information in the app. For another account or privacy request, use “Report an issue,” choose “Something else,” and describe the request. We may need to retain booking, payment, safety or legal records even after an account is no longer used.</p></section><section><h2>9. Consent and policy changes</h2><p>You may choose not to complete account setup, but Nivasa cannot provide matching and booking without the required information. Material policy changes will be shown before renewed consent is requested.</p></section><button className="primary" onClick={() => navTo(legalReturnView)}>Return</button></div>}

        {view === "signedOut" && <div className="screen state-screen"><div className="state-illustration pending-art"><span>⌁</span></div><ScreenTitle title="You’re signed out" text="Use your registered mobile number and OTP to access your account again."/><button className="primary" onClick={() => navTo("welcome")}>Sign in with mobile OTP</button></div>}

        {view === "setup" && <div className="screen provider-form">{setupSubmitted ? <div className="state-screen"><div className="state-illustration confirmed-art"><span>✓</span></div><Mark>Profile live</Mark><ScreenTitle title="Residents can now find you" text="Your services, prices and available times have been saved. Your address proof is stored privately and marked as provided."/><button className="primary" onClick={() => navTo("providerDashboard")}>Go to your dashboard</button><button className="secondary" onClick={() => setSetupSubmitted(false)}>Edit work profile</button></div> : setupLoading ? <div className="state-screen"><ScreenTitle title="Loading your work profile" text="Your saved services and available times will appear here."/></div> : <>
          <ScreenTitle eyebrow={`Welcome, ${helperName || "home helper"}`} title="Set up your work profile" text="Add your work area, services, prices and free times. You can return and edit them later."/>
          <section className="form-section"><h2>Payment details</h2><p className="form-guidance">Residents will use your verified mobile number to pay you directly through their preferred UPI app.</p><small>You receive trial and monthly compensation directly. Nivasa does not deduct it during the beta.</small></section>
          <section className="form-section"><h2>1. Where you can work</h2><Field label="Where do you usually start work from?" hint="Choose your address from Google suggestions."><GoogleAddressField value={helperAddress?.formattedAddress || ""} onSelect={address => { setHelperAddress(address); setHelperLocality(address.locality); }} onClear={() => { setHelperAddress(null); setHelperLocality(""); }} placeholder="Start typing your home or starting address" /></Field><Field label="Approximately how far are you willing to travel?" hint="Enter a rough estimate. This helps rank suitable work; it is not a strict promise."><div className="distance-input"><input className="text-input" type="number" inputMode="decimal" min="0.1" step="0.5" value={helperTravelDistance} onChange={event => setHelperTravelDistance(event.target.value)} placeholder="For example, 8"/><span>km</span></div></Field><small>Your exact address stays private. Residents will see only an approximate distance when matching.</small></section>
          <section className="form-section"><div className="inline-heading"><div><h2>2. Address proof</h2><p>Aadhaar, voter ID or another government-issued address proof</p></div></div><Field label="Document type"><select className="text-input" value={addressProofType} onChange={event => setAddressProofType(event.target.value)}><option value="aadhaar">Aadhaar</option><option value="voter_id">Voter ID</option><option value="other_address_proof">Other address proof</option></select></Field><input ref={proofInputRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,application/pdf" onChange={event => void uploadAddressProof(event.target.files?.[0])}/><button className="secondary upload-proof" disabled={proofUploading} onClick={() => proofInputRef.current?.click()}>{proofUploading ? "Uploading securely…" : addressProofUploaded ? "Replace address proof" : "Upload address proof"}</button>{addressProofUploaded && <div className="document-status"><Check/><span><b>Address proof provided</b><small>{addressProofName}</small></span></div>}<small>JPG, PNG or PDF · maximum 5 MB. The document is private and is never shown to residents.</small></section>
          <section className="form-section"><h2>3. Services and monthly prices</h2><Field label="Years of experience"><input className="text-input" type="number" min="0" max="60" value={yearsExperience} onChange={event => setYearsExperience(event.target.value)} placeholder="Enter years"/></Field><div className="service-price-block"><label className="toggle-row"><span><b>House cleaning</b><small>Sweeping, mopping, kitchen and bathroom surfaces; flush cleaning is not included</small></span><input type="checkbox" checked={houseCleaningEnabled} onChange={event => setHouseCleaningEnabled(event.target.checked)}/></label>{houseCleaningEnabled && <div className="price-inputs"><Field label="1–2 BHK"><input className="text-input" inputMode="numeric" value={housePrices.oneTwo} placeholder="₹ monthly" onChange={event => setHousePrices(current => ({...current, oneTwo:event.target.value.replace(/\D/g, "")}))}/></Field><Field label="3 BHK"><input className="text-input" inputMode="numeric" value={housePrices.three} placeholder="₹ monthly" onChange={event => setHousePrices(current => ({...current, three:event.target.value.replace(/\D/g, "")}))}/></Field><Field label="4+ BHK"><input className="text-input" inputMode="numeric" value={housePrices.fourPlus} placeholder="₹ monthly" onChange={event => setHousePrices(current => ({...current, fourPlus:event.target.value.replace(/\D/g, "")}))}/></Field></div>}</div><div className="service-price-block"><label className="toggle-row"><span><b>Utensil cleaning · once daily</b></span><input type="checkbox" checked={utensilsOnceEnabled} onChange={event => setUtensilsOnceEnabled(event.target.checked)}/></label>{utensilsOnceEnabled && <Field label="Monthly price"><input className="text-input" inputMode="numeric" value={utensilsOncePrice} placeholder="₹ monthly" onChange={event => setUtensilsOncePrice(event.target.value.replace(/\D/g, ""))}/></Field>}</div><div className="service-price-block"><label className="toggle-row"><span><b>Utensil cleaning · twice daily</b></span><input type="checkbox" checked={utensilsTwiceEnabled} onChange={event => setUtensilsTwiceEnabled(event.target.checked)}/></label>{utensilsTwiceEnabled && <Field label="Monthly price"><input className="text-input" inputMode="numeric" value={utensilsTwicePrice} placeholder="₹ monthly" onChange={event => setUtensilsTwicePrice(event.target.value.replace(/\D/g, ""))}/></Field>}</div><small>Residents will see one total price calculated for the exact package they request.</small></section>
          <section className="form-section"><h2>4. Available recurring times</h2><p className="section-copy">Add every regular time during which residents may book you.</p><div className="availability-slots">{availabilitySlots.map((slot, index) => <div className="availability-slot" key={slot.id}><Field label="Days"><select className="text-input" value={slot.days} onChange={event => setAvailabilitySlots(current => current.map(item => item.id === slot.id ? {...item, days:event.target.value} : item))}><option value="mon_sat">Monday–Saturday</option><option value="mon_fri">Monday–Friday</option><option value="every_day">Every day</option></select></Field><div className="time-grid"><Field label="From"><input className="time-input" type="time" value={slot.start} onChange={event => setAvailabilitySlots(current => current.map(item => item.id === slot.id ? {...item, start:event.target.value} : item))}/></Field><Field label="Until"><input className="time-input" type="time" value={slot.end} onChange={event => setAvailabilitySlots(current => current.map(item => item.id === slot.id ? {...item, end:event.target.value} : item))}/></Field></div>{availabilitySlots.length > 1 && <button className="text-button danger" onClick={() => setAvailabilitySlots(current => current.filter(item => item.id !== slot.id))}>Remove this time</button>}</div>)}</div><button className="secondary add-slot" onClick={() => setAvailabilitySlots(current => [...current, {id:crypto.randomUUID(), days:"mon_sat", start:"18:00", end:"20:00"}])}>+ Add another available time</button><small>A 15-minute travel buffer is enforced automatically between bookings.</small></section>
          <section className="privacy-note"><b>Your privacy matters</b><p>Residents never see your proof document, exact home address or phone number before an accepted booking.</p></section>{setupError && <p className="auth-error" role="alert">{setupError}</p>}<button className="primary" disabled={setupSaving || proofUploading} onClick={() => void saveHelperProfile()}>{setupSaving ? "Saving profile…" : "Save and publish profile"}</button>
        </>}</div>}

        {view === "incoming" && <div className="screen">{helperRequest ? <><ScreenTitle eyebrow="New booking request" title={`${helperRequest.residentName || "A resident"} needs ${storedPackageName(helperRequest).toLowerCase()}`}/><section className="response-deadline"><span>◷</span><div><small>Response needed within 24 hours</small><b>Respond by {new Date(helperRequest.responseDueAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</b><p>Your {helperRequest.slots.map(slot => formatTime(slot.startTime)).join(" and ")} recurring {helperRequest.slots.length > 1 ? "times are" : "time is"} held until then.</p><strong>Respond before the hold expires</strong></div></section><div className="resident-chip"><span className="avatar violet small">{helperRequest.residentName?.trim().charAt(0).toUpperCase() || "R"}</span><span><b>{helperRequest.residentName || "Resident"}</b><small><Check/> Mobile verified · {helperRequest.residentLocality}</small></span></div><section className="request-details"><SummaryRow label="Service" value={storedPackageName(helperRequest)}/><SummaryRow label="Your listed price" value={`₹${helperRequest.monthlyPriceRupees.toLocaleString("en-IN")}/month`} strong/><SummaryRow label="Schedule" value={helperRequest.slots.map(slot => formatTime(slot.startTime)).join(" & ")}/><SummaryRow label="Starts" value={friendlyDate(helperRequest.requestedStartDate)}/><SummaryRow label="Location" value={helperRequest.residentLocality || "Shared after acceptance"}/></section><div className="info-banner"><span>i</span><p>Accepting confirms the booking immediately. The first two service days are a paid trial.</p></div>{requestError && <p className="auth-error" role="alert">{requestError}</p>}<button className="primary" disabled={requestBusy} onClick={() => void respondToRequest("accept")}>{requestBusy ? "Confirming…" : "Accept booking"}</button><button className="secondary" disabled={requestBusy} onClick={() => void respondToRequest("decline")}>Not available</button><p className="consent-copy">The resident’s exact address and contact are shared only after acceptance.</p></> : <div className="empty-dashboard"><b>No active booking request</b><p>The request may have been withdrawn or its 24-hour hold may have ended.</p><button className="secondary" onClick={() => { void loadHelperRequests(false); navTo("providerDashboard"); }}>Return to your work</button></div>}</div>}

        {view === "providerDashboard" && <div className="screen dashboard-screen">
          <ScreenTitle title="Your work"/>
          <div className="provider-stats"><span><b>{helperActiveBookings.length}</b><small>Bookings</small></span><span><b>{helperRequest ? 1 : 0}</b><small>Next request</small></span><span><b>{availabilitySlots.filter(slot => slot.start && slot.end).length}</b><small>Available times</small></span></div>
          {helperRequest && <section className="success-banner"><span>◷</span><span><b>New request from {helperRequest.residentName}</b><small>Respond before {new Date(helperRequest.responseDueAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}</small></span><button className="text-button" onClick={() => navTo("incoming")}>Review</button></section>}
          {helperActiveBooking && <section className="success-banner"><Check/><span><b>{helperActiveBookings.length === 1 ? `Booking confirmed with ${helperActiveBooking.residentName}` : `${helperActiveBookings.length} confirmed bookings`}</b><small>Selected: {helperActiveBooking.residentName} · {helperActiveBooking.slots.map(slot => formatTime(slot.startTime)).join(" & ")}</small></span></section>}
          {helperActiveBooking?.bookingStatus === "trial" && <section className="trial-progress-card"><div className="section-head"><h2>Paid trial</h2><Mark>{Number(helperActiveBooking.trialVisitsCompleted ?? 0)} of 2 complete</Mark></div>{helperActiveBooking.trialDays?.map(day => { const isFuture = !day.completionAvailableAt || new Date(day.completionAvailableAt).getTime() > Date.now(); return <div className="trial-progress-row" key={day.ordinal}><span><b>Service day {day.ordinal}</b><small>{friendlyDate(day.scheduledFor)} · {helperActiveBooking.slots.map(slot => formatTime(slot.startTime)).join(" & ")}</small></span>{day.status === "completed" ? <Mark muted>Completed</Mark> : day.ordinal === nextTrialOrdinal ? <button className="compact-action" disabled={requestBusy || isFuture} title={isFuture ? `Available ${friendlyDateTime(day.completionAvailableAt)}` : undefined} onClick={() => void completeTrialDay(day.ordinal)}>{isFuture ? `Available ${friendlyDateTime(day.completionAvailableAt)}` : requestBusy ? "Saving…" : "Mark completed"}</button> : <Mark muted>Upcoming</Mark>}</div>; })}{requestError && <p className="auth-error" role="alert">{requestError}</p>}<small>A service day can be marked complete only after its final scheduled visit has ended.</small></section>}
          {trialPayment && <section className="payment-action-card"><Mark>{trialPayment.status === "resident_marked_paid" ? "Confirmation needed" : trialPayment.status === "pending" ? "Awaiting payment" : "Under review"}</Mark><h2>₹{trialPayment.amountRupees.toLocaleString("en-IN")} trial payment</h2>{trialPayment.status === "resident_marked_paid" ? <><p>{trialPayment.residentName} marked the payment as sent. Check your payment app before confirming.</p><button className="primary" disabled={paymentBusy} onClick={() => void updateTrialPayment("confirm_received")}>{paymentBusy ? "Confirming…" : "Payment received"}</button></> : trialPayment.status === "pending" ? <p>{trialPayment.residentName} has not marked the payment as sent yet. The “Payment received” button will appear here after she does.</p> : <p>The resident requested backend review. Your time remains available for other bookings.</p>}{paymentError && <p className="auth-error" role="alert">{paymentError}</p>}</section>}
          <section className="dashboard-block"><div className="section-head"><h2>Services and prices</h2><button onClick={() => navTo("setup")}>Edit</button></div>{helperPriceRows.length ? <div className="price-catalogue dashboard-prices">{helperPriceRows.map(row => <div key={row.label}><span>{row.label}</span><strong>₹{row.price.toLocaleString("en-IN")}<small>/month</small></strong></div>)}</div> : <div className="empty-dashboard"><b>No services added yet</b><p>Add services and monthly prices to appear in resident searches.</p><button className="secondary" onClick={() => navTo("setup")}>Complete work profile</button></div>}</section>
          <section className="dashboard-block"><div className="section-head"><h2>Schedule</h2></div>{helperActiveBookings.length ? <><div className="job-list">{helperActiveBookings.map(item => <button className={item.bookingId === helperActiveBooking?.bookingId ? "selected" : ""} key={item.bookingId || item.id} onClick={() => setHelperActiveBooking(item)}><b>{item.slots.map(slot => formatTime(slot.startTime)).join(" & ")}</b><span><strong>{item.residentName}</strong><small>{item.residentAddress} · {item.bookingStatus === "trial" ? "paid trial" : "confirmed booking"}</small></span></button>)}</div>{canCancelBooking && <button className="secondary danger-outline" onClick={() => { setCancelReason(""); setCancelError(""); setCancelOpen(true); }}>Cancel selected booking</button>}</> : <div className="empty-dashboard"><b>No confirmed work yet</b><p>Accepted bookings will appear here.</p></div>}</section>
          <section className="dashboard-block"><div className="section-head"><h2>Availability</h2><button onClick={() => navTo("setup")}>Edit</button></div><div className="availability-control"><span className={profilePaused?"dot paused":"dot"}/><span><b>{profilePaused?"Profile paused":"Profile is active"}</b><small>{profilePaused?"Residents cannot find you":`${availabilitySlots.filter(slot => slot.start && slot.end).length} recurring time ${availabilitySlots.filter(slot => slot.start && slot.end).length === 1 ? "window" : "windows"} available`}</small></span><input aria-label="Show profile in resident searches" type="checkbox" disabled={profilePauseBusy} checked={!profilePaused} onChange={event => void setHelperProfilePaused(!event.target.checked)} /></div>{setupError && <p className="auth-error" role="alert">{setupError}</p>}</section>
          <section className="dashboard-block"><div className="section-head"><h2>Manage</h2></div><div className="dashboard-list"><button onClick={openIssueReport}><span className="list-icon">!</span><span><b>Report a problem</b><small>Payment, safety or work-scope concern</small></span><span>›</span></button></div></section>
        </div>}

        {view === "providerIssue" && <div className="screen">{!providerIssueSent ? <><ScreenTitle eyebrow="Support" title="Report a booking problem" text="Your report is private and will not appear as a public rating."/><div className="issue-options">{["Resident was unavailable", "Work requested was different", "Payment is overdue", "Safety or misconduct", "I need to end this job", "Something else"].map(item=><label key={item}><input type="radio" name="provider-issue" checked={providerIssue === item} onChange={() => setProviderIssue(item)}/><span>{item}</span></label>)}</div><Field label="Share feedback (optional)"><textarea value={providerIssueFeedback} onChange={event => setProviderIssueFeedback(event.target.value)} maxLength={1000} rows={4} placeholder="Add a short description"/></Field>{issueError && <p className="auth-error" role="alert">{issueError}</p>}<button className="primary" disabled={!providerIssue || issueBusy} onClick={() => void submitIssue()}>{issueBusy ? "Submitting…" : "Submit report"}</button></> : <div className="state-screen"><div className="state-illustration confirmed-art"><span>✓</span></div><Mark>Report received</Mark><ScreenTitle title={issueCaseNumber ? `Case #${issueCaseNumber} has been created` : "Your report has been saved"} text="We’ll review your report and contact you on your registered mobile number if we need more information."/><button className="primary" onClick={() => navTo("providerDashboard")}>Return to dashboard</button></div>}</div>}

      </div></section>
    </div>
  </main>;
}
