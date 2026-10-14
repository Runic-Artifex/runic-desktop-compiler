# Desktop preferences (2026-10-14)

CSS compatibility slice 2b. A native app reads `prefers-reduced-motion` and `prefers-contrast` from the desktop as Chromium 153 does on Linux (`runic_runtime::desktop`), instead of reporting every rule that tests them ([media-preferences](media-preferences.md), slice 0b). New direct dependencies of runic-runtime on Linux (user decision, ROADMAP decisions log): `x11rb =0.13.2` (already in the lock through winit) and `zbus =5.19.0` (`blocking-api`, `async-io`).

## Chromium's rules (153.0.8010.12 sources, GTK 3.24.51 and 4.20.0)

- Toolkit (ui/linux/linux_ui_factory.cc, base/nix/xdg_util.cc): Qt on KDE, UKUI, Deepin and LXQt desktops (`XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION`, `KDE_FULL_SESSION`), GTK elsewhere. Backend (ui/linux/display_server_utils.cc): Wayland when `XDG_SESSION_TYPE` is `wayland`, else X11. GTK version (ui/gtk/gtk_compat.cc): GTK 4 first on GNOME under Wayland, GTK 3 first otherwise; Chromium's packages depend on either.
- `prefers-reduced-motion` is `reduce` when `gtk-enable-animations` is off (ui/gfx/animation/animation_linux.cc, ui/gtk/gtk_ui.cc). `prefers-contrast` is `more` when `gtk-theme-name`, lowercased, contains "high" and "contrast" (ui/gtk/os_settings_provider_gtk.cc). A theme name that is empty, `.`, `..` or contains `/` is set to "Adwaita" at application priority, so it stays for the rest of the run (`SanitizeThemeName`, `IsValidCursorThemeName`).
- GTK on X11 reads the XSETTINGS manager's `Gtk/EnableAnimations` (an integer, non-zero is on) and `Net/ThemeName` (a string; an integer converts to its decimal) and keeps a setting's last value when the manager stops giving it (gtk/gtksettings.c `settings_update_xsetting`). Without a value from the manager it reads settings.ini files at paths of its own installation.
- GTK 4 on Wayland reads the settings portal (`ReadAll` of `org.gnome.*` and `org.freedesktop.appearance`, after checking the interface's `version`), each setting the portal lacks at GTK's default (`true`, "Adwaita"); without a portal, GSettings. GTK 3 on Wayland reads GSettings directly (the portal only with `GTK_USE_PORTAL=1`), where `org.gnome.desktop.a11y.interface` `high-contrast` makes the theme "HighContrast".

## The runtime

The runtime reads the same settings on a thread of its own, started before the window system connects and waited for before the app mounts, and follows their changes (XSETTINGS property and manager events; the portal's `SettingChanged`). On Wayland it reads GTK 3's GSettings keys through the portal, whose GNOME and GTK backends serve GSettings, and computes both GTK versions' readings: a preference is known only where they agree. Where a preference cannot be read, media queries see no preference and the compiler's guards (`when: "desktop:<features>"`) report the rules testing it once they match an element; `matchMedia` of such a query is reported too. Reasons are given in the report (gaps: [PLATFORM](../../docs/gaps/PLATFORM.md)).

## Verification

`node conformance/desktop-preferences.mjs` builds test desktops on a private session bus: an XSETTINGS manager on Xvfb, or a headless KWin with GSettings in a keyfile served by the real xdg-desktop-portal and its GTK backend (or a stand-in portal, or none). Chromium runs headful in each, with Playwright's preference emulation off, loading the dev shell's GTK 3.24.52 or GTK 4.22.4; the runtime's reader runs in the same environment.

- 22 scenarios (14 on X11: GNOME, Xfce, Cinnamon, i3 and KDE desktops, valid, integer, string, missing and invalid settings, changes, a replaced theme name, a manager that leaves or arrives; 8 on Wayland: GNOME and sway, the a11y high-contrast switch, `GTK_USE_PORTAL=1`, no portal, a portal serving only `org.freedesktop.appearance`, changes), 35 Chromium runs: **45 readings equal Chromium's, 0 differ, 15 reported**. The reported ones: no XSETTINGS manager or no value from it (Chromium shows GTK's defaults there), KDE (Qt), Wayland without a portal serving GSettings, a theme name after it was unreadable, and GNOME's high-contrast switch on Wayland, where Chromium itself differs with GTK 3 (`more`) and GTK 4 (no preference).
- **Incomplete: 2 Chromium runs.** Chromium 153 with GTK 4.22.4 crashes on Wayland (SIGSEGV at start, in Chromium) without the desktop's portal backend: with no portal, and with a stand-in portal serving only `org.freedesktop.appearance`. The runtime reports both cases; GTK 3 Chromium runs of the same scenarios are complete.
- End to end, the case fixture `media-preferences-svelte` as a native app (no probe) on Xvfb with a test XSETTINGS manager: its window is pixel-identical (mean absolute error 0) to the probe emulating the same preferences, at start and after two live changes (`reduce` and `more`, then neither); it reports nothing where both are readable, the 3 `prefers-contrast` rules where only animations are set, and all 7 rules without a manager.
- The runtime's parsing and decisions have unit tests (`desktop::tests`: toolkit and backend selection, theme names, XSETTINGS parsing in both byte orders, kept values, GTK 3 and GTK 4 agreement, the replaced theme name).

## Other checks

- `npm test` 509/509; `node compiler/cargo.mjs test --offline --workspace` passes (189 tests).
- `node conformance/run.mjs media-preferences bits-select bits-command animations --pixels`: 12/12 runs pass semantics, geometry and pixels (probes still emulate the preferences).
- `node conformance/differential.mjs media-preferences-svelte`: 20 mount steps, 0 failures; incomplete as before (the fixture has no actions to generate).
- Native start-up: the reading runs while the window system connects and is awaited before the app mounts. MEASURE
