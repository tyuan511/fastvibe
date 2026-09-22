/**
 * Whether 电脑操控 can work at all here, decided before anything is attempted.
 *
 * The feature used to answer that by failing: a Linux user or someone on the web client
 * saw the switches, turned them on, and found out at the first tool call. A typed
 * verdict lets Settings say which machine this is and why it cannot be driven, and lets
 * the tools refuse with the same sentence instead of whatever the driver happened to
 * report from three layers down.
 *
 * Shared, and imported by a relative path so `node --test` can resolve it: the renderer
 * decides what to render from this and Main decides what to refuse from it, and two
 * copies would disagree the moment one was edited.
 */

export type ComputerAvailabilityKind = "local-macos" | "local-windows" | "local-linux" | "remote";

export type ComputerAvailability = {
  kind: ComputerAvailabilityKind;
  supported: boolean;
};

/**
 * `platform` is the host Main runs on; `remote` says this client is a browser talking to
 * that host from somewhere else.
 *
 * A remote client is unsupported even when the host is a Mac, and that is not a
 * limitation to work around. The tools would drive the *host's* desktop — the machine
 * nobody is sitting at — while the person issuing them watches a different screen. Every
 * observation they got back would be of a desktop they cannot see, and the agent cursor
 * that exists to show a human what is happening would be painted for an empty room.
 *
 * Linux is unsupported for a narrower reason: cua's Linux input path needs
 * compositor-specific helpers under Wayland (its tree carries a Hyprland plugin, a KWin
 * helper and a Wayland helper), none of which this app ships. X11 would mostly work, but
 * shipping a feature that silently depends on which session manager someone logged into
 * is worse than not shipping it.
 */
export function resolveComputerAvailability(platform: string, remote: boolean): ComputerAvailability {
  if (remote) return { kind: "remote", supported: false };
  if (platform === "darwin") return { kind: "local-macos", supported: true };
  if (platform === "win32") return { kind: "local-windows", supported: true };
  return { kind: "local-linux", supported: false };
}
