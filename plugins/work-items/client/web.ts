import { Platform } from "react-native";

// Electron's preload exposes window.paseoDesktop; plain browsers and native apps do not.
declare const window: { paseoDesktop?: unknown } | undefined;

/** The work-items pill is desktop-only for now. */
export function isDesktopApp(): boolean {
  return Platform.OS === "web" && typeof window !== "undefined" && window?.paseoDesktop != null;
}
