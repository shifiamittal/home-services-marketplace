"use client";

import { useEffect, useState } from "react";

const destinations = [
  ["providerDashboard", "Home"], ["incoming", "Requests"], ["helperSchedule", "Schedule"],
  ["helperNotifications", "Notifications"], ["providerSettings", "Profile"],
] as const;

export function HelperNavigation({ view, onNavigate }: { view: string; onNavigate: (view: string) => void }) {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resize = () => setKeyboardOpen(viewport.height < window.innerHeight * 0.75);
    viewport.addEventListener("resize", resize);
    return () => viewport.removeEventListener("resize", resize);
  }, []);
  const active = ["setup", "privacy", "providerIssue", "terms", "privacyPolicy"].includes(view) ? "providerSettings" : view;
  return <nav className={`helper-navigation${keyboardOpen ? " keyboard-open" : ""}`} aria-label="Helper navigation">
    {destinations.map(([destination, label]) => <button type="button" key={destination}
      aria-current={active === destination ? "page" : undefined}
      onClick={() => onNavigate(destination)}>{label}</button>)}
  </nav>;
}
