import type { HelperAddress } from "./helper-address";

export type HelperGeolocation = {
  getCurrentPosition: (
    success: (position: { coords: { latitude: number; longitude: number } }) => void,
    failure: (error: { code?: number; message?: string }) => void,
    options?: PositionOptions,
  ) => void;
};

export type DetectedHelperAddress = {
  address: HelperAddress;
  latitude: number;
  longitude: number;
};

export function detectHelperLocation(
  geolocation: HelperGeolocation | undefined,
  reverseGeocode: (latitude: number, longitude: number) => Promise<HelperAddress>,
): Promise<DetectedHelperAddress> {
  if (!geolocation) return Promise.reject(new Error("Location detection is not supported on this device. Enter your address manually."));
  return new Promise((resolve, reject) => geolocation.getCurrentPosition(
    position => {
      const { latitude, longitude } = position.coords;
      void reverseGeocode(latitude, longitude)
        .then(address => resolve({ address, latitude, longitude }))
        .catch(() => reject(new Error("We could not identify your address. Enter it manually.")));
    },
    error => reject(new Error(error.code === 1
      ? "Location permission was denied. Enter your address manually."
      : "We could not detect your location. Enter your address manually.")),
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
  ));
}
