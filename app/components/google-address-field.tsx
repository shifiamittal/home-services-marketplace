"use client";

import { useEffect, useRef, useState } from "react";

export type SelectedAddress = {
  formattedAddress: string;
  locality: string;
  latitude: number;
  longitude: number;
};

type GoogleWindow = Window & {
  google?: {
    maps?: {
      importLibrary?: (name: string) => Promise<Record<string, unknown>>;
    };
  };
};

let mapsPromise: Promise<GoogleWindow["google"]> | null = null;

async function loadGoogleMaps() {
  const browser = window as GoogleWindow;
  if (browser.google?.maps?.importLibrary) return browser.google;
  if (mapsPromise) return mapsPromise;

  mapsPromise = fetch("/api/maps/config", { credentials: "same-origin" })
    .then(async response => {
      const result = await response.json() as { apiKey?: string; error?: string };
      if (!response.ok || !result.apiKey) throw new Error(result.error || "Address search is not configured.");
      return new Promise<GoogleWindow["google"]>((resolve, reject) => {
        const callback = `nivasaMapsReady_${crypto.randomUUID().replaceAll("-", "")}`;
        const callbackWindow = window as unknown as Record<string, unknown>;
        callbackWindow[callback] = () => {
          delete callbackWindow[callback];
          resolve((window as GoogleWindow).google);
        };
        const script = document.createElement("script");
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(result.apiKey!)}&loading=async&libraries=places&v=weekly&callback=${callback}`;
        script.async = true;
        script.dataset.nivasaGoogleMaps = "true";
        script.onerror = () => {
          delete callbackWindow[callback];
          reject(new Error("Google address search could not load."));
        };
        document.head.appendChild(script);
      });
    });
  return mapsPromise;
}

export function GoogleAddressField({
  value,
  onSelect,
  onClear,
  placeholder,
}: {
  value: string;
  onSelect: (address: SelectedAddress) => void;
  onClear: () => void;
  placeholder: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onSelectRef = useRef(onSelect);
  const onClearRef = useRef(onClear);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { onClearRef.current = onClear; }, [onClear]);

  useEffect(() => {
    let active = true;
    let element: HTMLElement | null = null;
    const mount = async () => {
      try {
        const google = await loadGoogleMaps();
        const places = await google?.maps?.importLibrary?.("places") as { PlaceAutocompleteElement?: new (options?: Record<string, unknown>) => HTMLElement } | undefined;
        if (!active || !places?.PlaceAutocompleteElement || !containerRef.current) throw new Error("Google address search is unavailable.");
        element = new places.PlaceAutocompleteElement({ includedRegionCodes: ["in"] });
        element.setAttribute("aria-label", "Search for an address");
        (element as unknown as { placeholder: string }).placeholder = placeholder;
        element.addEventListener("gmp-select", (async (event: Event) => {
          const prediction = (event as Event & { placePrediction?: { toPlace: () => {
            fetchFields: (options: { fields: string[] }) => Promise<void>;
            formattedAddress?: string;
            displayName?: string;
            location?: { lat: () => number; lng: () => number };
          } } }).placePrediction;
          if (!prediction) return;
          const place = prediction.toPlace();
          await place.fetchFields({ fields: ["displayName", "formattedAddress", "location"] });
          if (!place.formattedAddress || !place.location) return;
          onSelectRef.current({
            formattedAddress: place.formattedAddress,
            locality: place.displayName || place.formattedAddress,
            latitude: place.location.lat(),
            longitude: place.location.lng(),
          });
        }) as EventListener);
        element.addEventListener("input", () => onClearRef.current());
        containerRef.current.replaceChildren(element);
        setStatus("ready");
      } catch (caught) {
        if (!active) return;
        setStatus("error");
        setError(caught instanceof Error ? caught.message : "Address search could not load.");
      }
    };
    void mount();
    return () => {
      active = false;
      element?.remove();
    };
  }, [placeholder]);

  return <div className="google-address-control">
    <div className="google-address-element" ref={containerRef} aria-busy={status === "loading"} />
    {status === "loading" && <div className="address-loading">Loading address search…</div>}
    {value && status === "ready" && <div className="address-confirmed"><span>✓</span><span><b>Location confirmed</b><small>{value}</small></span></div>}
    {status === "error" && <p className="field-error maps-error">{error}</p>}
  </div>;
}
