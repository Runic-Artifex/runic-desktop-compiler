//! The desktop preferences media queries see natively (CSS slice 2b):
//! `prefers-reduced-motion` and `prefers-contrast`, read as Chromium 153
//! (no command-line switches) reads them on Linux.
//!
//! Chromium takes both from its Linux UI toolkit
//! (ui/linux/linux_ui_factory.cc): Qt on KDE, UKUI, Deepin and LXQt
//! desktops, GTK elsewhere. With GTK, `prefers-reduced-motion` is `reduce`
//! when `gtk-enable-animations` is off (ui/gfx/animation/animation_linux.cc,
//! ui/gtk/gtk_ui.cc) and `prefers-contrast` is `more` when
//! `gtk-theme-name`, lowercased, contains "high" and "contrast"
//! (ui/gtk/os_settings_provider_gtk.cc); a theme name that is empty, `.`,
//! `..` or contains `/` is replaced by "Adwaita" for the rest of the run
//! (`SanitizeThemeName`, ui/gtk/gtk_util.cc `IsValidThemeName`). GTK reads
//! the two settings from:
//!
//! - X11 (`XDG_SESSION_TYPE` is not `wayland`, ui/linux/display_server_utils.cc):
//!   the XSETTINGS manager's `Gtk/EnableAnimations` and `Net/ThemeName`
//!   (gdk/x11/xsettings-client.c, the same in GTK 3 and 4);
//! - Wayland, GTK 4 (on GNOME, if installed, gtk_compat.cc): the settings
//!   portal's `org.gnome.desktop.interface` `enable-animations` and
//!   `gtk-theme`, their defaults where the portal lacks them
//!   (gdk/wayland/gdksettings-wayland.c);
//! - Wayland, GTK 3: GSettings directly, where
//!   `org.gnome.desktop.a11y.interface` `high-contrast` makes the theme
//!   "HighContrast" (gdk/wayland/gdkscreen-wayland.c). The runtime reads the
//!   same keys through the portal, whose GNOME and GTK backends serve
//!   GSettings.
//!
//! Where a setting cannot be read (a Qt desktop, no XSETTINGS manager or no
//! value from it, no portal, GTK 3 and GTK 4 disagreeing), the preference is
//! unknown: media queries see no preference and the rules and `matchMedia`
//! queries that test it are reported (`timeline`, `media_matches`). Changes
//! while the app runs apply as Chromium applies them (GTK's notifications).

use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::task::Waker;

/// A preference: known, or unknown with the reason.
pub type Reading = Result<bool, &'static str>;

/// What the desktop says (`Err` where it cannot be read).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Preferences {
    pub reduced_motion: Reading,
    pub contrast_more: Reading,
}

impl Preferences {
    pub const UNREAD: Preferences = Preferences {
        reduced_motion: Err("the desktop settings were not read"),
        contrast_more: Err("the desktop settings were not read"),
    };

    /// The preference a media feature tests (`prefers-reduced-motion`,
    /// `prefers-contrast`).
    pub fn feature(&self, feature: &str) -> Option<Reading> {
        match feature {
            "prefers-reduced-motion" => Some(self.reduced_motion),
            "prefers-contrast" => Some(self.contrast_more),
            _ => None,
        }
    }
}

struct Shared {
    prefs: Preferences,
    /// The first reading is published.
    read: bool,
    waker: Option<Waker>,
}

static SHARED: Mutex<Shared> = Mutex::new(Shared {
    prefs: Preferences::UNREAD,
    read: false,
    waker: None,
});
static READ: Condvar = Condvar::new();

/// The desktop preferences as last read.
pub fn current() -> Preferences {
    SHARED
        .lock()
        .map(|s| s.prefs)
        .unwrap_or(Preferences::UNREAD)
}

/// The event loop's waker, woken when the preferences change.
pub(crate) fn register_waker(waker: &Waker) {
    if let Ok(mut s) = SHARED.lock()
        && !s.waker.as_ref().is_some_and(|w| w.will_wake(waker))
    {
        s.waker = Some(waker.clone());
    }
}

fn publish(prefs: Preferences) {
    let waker = match SHARED.lock() {
        Ok(mut s) => {
            let first = !std::mem::replace(&mut s.read, true);
            if first {
                READ.notify_all();
            }
            if s.prefs != prefs {
                s.prefs = prefs;
                s.waker.clone()
            } else {
                None
            }
        }
        Err(_) => None,
    };
    if let Some(w) = waker {
        w.wake();
    }
}

/// Starts reading the preferences ([`wait`] for the first reading), then
/// follows their changes on a thread of their own. XSETTINGS are read at
/// once (a few requests); the portal on that thread, while the app starts.
pub fn start() {
    read();
}

/// Runs `f` on a thread of its own (the preferences stay as read if it
/// cannot be started).
#[cfg(target_os = "linux")]
fn spawn(name: &str, f: impl FnOnce() + Send + 'static) {
    let _ = std::thread::Builder::new().name(name.into()).spawn(f);
}

/// Waits for the first reading (Chromium reads the settings before it
/// shows a page).
pub fn wait() {
    if let Ok(mut s) = SHARED.lock() {
        while !s.read {
            match READ.wait(s) {
                Ok(next) => s = next,
                Err(_) => return,
            }
        }
    }
}

fn read() {
    let env = |name: &str| std::env::var(name).ok();
    #[cfg(target_os = "linux")]
    {
        let mut tracker = Tracker::default();
        match platform(&env) {
            Platform::Qt(reason) => publish(Preferences {
                reduced_motion: Err(reason),
                contrast_more: Err(reason),
            }),
            Platform::X11 => x11::start(tracker),
            Platform::Wayland(toolkits) => {
                let spawned = std::thread::Builder::new()
                    .name("runic-settings-portal".into())
                    .spawn(move || portal::start(tracker, toolkits));
                if spawned.is_err() {
                    publish(Preferences {
                        reduced_motion: Err("the settings portal could not be read"),
                        contrast_more: Err("the settings portal could not be read"),
                    });
                }
            }
            Platform::Unknown(reason) => {
                publish(tracker.apply(&[Raw::unknown(reason)]));
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = env;
        publish(Preferences {
            reduced_motion: Err("desktop preferences are read on Linux only"),
            contrast_more: Err("desktop preferences are read on Linux only"),
        });
    }
}

/// Where Chromium would take the preferences from.
#[derive(Debug, PartialEq)]
enum Platform {
    /// Chromium's Qt UI (Qt's style and theme, not read).
    Qt(&'static str),
    X11,
    /// GTK on Wayland: the GTK versions Chromium may load and how each reads
    /// the settings.
    Wayland(Toolkits),
    Unknown(&'static str),
}

/// How the GTK versions Chromium may load on Wayland read their settings.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Toolkits {
    /// GTK 3 reads the settings portal (`GTK_USE_PORTAL=1`) instead of
    /// GSettings.
    gtk3_portal: bool,
    /// `GDK_DEBUG` is set: GTK 4 may skip the portal or the settings.
    gtk4_debug: bool,
}

/// Chromium's desktop environment (base/nix/xdg_util.cc
/// `GetDesktopEnvironment`) is one it uses Qt for
/// (ui/linux/linux_ui_factory.cc `GetDefaultSystemTheme`).
fn qt_desktop(env: &dyn Fn(&str) -> Option<String>) -> Option<&'static str> {
    if let Some(current) = env("XDG_CURRENT_DESKTOP") {
        for value in current.split(':').map(str::trim).filter(|v| !v.is_empty()) {
            match value {
                "Unity" | "GNOME" | "X-Cinnamon" | "Pantheon" | "XFCE" | "COSMIC" => return None,
                "Deepin" => return Some("Chromium reads it through Qt on Deepin"),
                "KDE" => return Some("Chromium reads it through Qt on KDE"),
                "UKUI" => return Some("Chromium reads it through Qt on UKUI"),
                "LXQt" => return Some("Chromium reads it through Qt on LXQt"),
                _ => {}
            }
        }
    }
    let session = env("DESKTOP_SESSION").unwrap_or_default();
    match session.as_str() {
        "deepin" => return Some("Chromium reads it through Qt on Deepin"),
        "gnome" | "mate" => return None,
        "kde4" | "kde-plasma" | "kde" => return Some("Chromium reads it through Qt on KDE"),
        "ukui" => return Some("Chromium reads it through Qt on UKUI"),
        _ => {}
    }
    if session.contains("xfce") || session == "xubuntu" {
        return None;
    }
    if env("GNOME_DESKTOP_SESSION_ID").is_some() {
        return None;
    }
    if env("KDE_FULL_SESSION").is_some() {
        return Some("Chromium reads it through Qt on KDE");
    }
    None
}

fn platform(env: &dyn Fn(&str) -> Option<String>) -> Platform {
    if let Some(reason) = qt_desktop(env) {
        return Platform::Qt(reason);
    }
    if env("XDG_SESSION_TYPE").as_deref() == Some("wayland") {
        Platform::Wayland(Toolkits {
            gtk3_portal: env("GTK_USE_PORTAL").is_some_and(|v| v.starts_with('1')),
            gtk4_debug: env("GDK_DEBUG").is_some_and(|v| !v.is_empty()),
        })
    } else if env("DISPLAY").is_some() {
        Platform::X11
    } else {
        Platform::Unknown("Chromium would run on X11 here, and there is no X display")
    }
}

/// The theme name as Chromium checks it.
#[derive(Clone, Debug, PartialEq)]
enum Theme {
    /// A name Chromium keeps: whether it asks for more contrast.
    Valid(bool),
    /// A name Chromium replaces with "Adwaita" for the rest of the run.
    Invalid,
}

impl Theme {
    fn of(name: &[u8]) -> Theme {
        // ui/base/cursor/cursor_factory.cc `IsValidCursorThemeName`: not
        // empty, `.` or `..`, not absolute, one path component.
        if name.is_empty() || name == b"." || name == b".." || name.contains(&b'/') {
            return Theme::Invalid;
        }
        let lower = name.to_ascii_lowercase();
        let has = |w: &[u8]| lower.windows(w.len()).any(|x| x == w);
        Theme::Valid(has(b"high") && has(b"contrast"))
    }
}

/// One GTK's reading of the two settings.
#[derive(Clone, Debug, PartialEq)]
struct Raw {
    animations: Result<bool, &'static str>,
    theme: Result<Theme, &'static str>,
}

impl Raw {
    fn unknown(reason: &'static str) -> Raw {
        Raw {
            animations: Err(reason),
            theme: Err(reason),
        }
    }

    /// A new XSETTINGS reading: GTK keeps a setting's last value from the
    /// manager when the manager no longer gives one (gtk/gtksettings.c
    /// `settings_update_xsetting` changes nothing then).
    fn update(&mut self, new: Raw) {
        if new.animations.is_ok() || self.animations.is_err() {
            self.animations = new.animations;
        }
        if new.theme.is_ok() || self.theme.is_err() {
            self.theme = new.theme;
        }
    }
}

/// Chromium's state across readings: a replaced theme name stays replaced.
#[derive(Debug, Default)]
struct Tracker {
    /// The theme name was replaced by "Adwaita" (no contrast preference).
    replaced: bool,
    /// A theme name could not be read: whether Chromium replaced it is
    /// unknown from then on.
    unknown: Option<&'static str>,
}

impl Tracker {
    /// The preferences from the readings of the GTK versions Chromium may
    /// load: known where they agree.
    fn apply(&mut self, raws: &[Raw]) -> Preferences {
        const DIFFER: &str =
            "GTK 3 and GTK 4 read it differently here, and which one Chromium loads is unknown";
        let animations = agree(raws.iter().map(|r| r.animations.clone()), DIFFER);
        let theme = agree(raws.iter().map(|r| r.theme.clone()), DIFFER);
        let contrast_more = if self.replaced {
            Ok(false)
        } else if let Some(reason) = self.unknown {
            Err(reason)
        } else {
            match theme {
                Ok(Theme::Valid(more)) => Ok(more),
                Ok(Theme::Invalid) => {
                    self.replaced = true;
                    Ok(false)
                }
                Err(reason) => {
                    self.unknown = Some(reason);
                    Err(reason)
                }
            }
        };
        Preferences {
            reduced_motion: animations.map(|on| !on),
            contrast_more,
        }
    }
}

fn agree<T: PartialEq>(
    mut values: impl Iterator<Item = Result<T, &'static str>>,
    differ: &'static str,
) -> Result<T, &'static str> {
    let first = values.next().unwrap_or(Err("no reading"))?;
    for v in values {
        if v? != first {
            return Err(differ);
        }
    }
    Ok(first)
}

/// An XSETTINGS value (gdk/x11/xsettings-client.c `parse_settings`).
#[derive(Clone, Debug, PartialEq)]
enum XValue {
    Int(i32),
    /// Up to its first NUL (`g_strndup`).
    Str(Vec<u8>),
    Color,
}

/// GTK's parse of the `_XSETTINGS_SETTINGS` property: the settings by name,
/// or `None` where GTK discards the whole property. A setting of an unknown
/// type has no value. A name given twice makes GTK 3 and GTK 4 discard the
/// property only if they know it (their tables differ slightly), so any
/// repeated name counts as unreadable.
fn parse_xsettings(data: &[u8]) -> Option<HashMap<Vec<u8>, Option<XValue>>> {
    struct Buf<'a> {
        data: &'a [u8],
        pos: usize,
        msb: bool,
    }
    impl Buf<'_> {
        fn take(&mut self, n: usize) -> Option<&[u8]> {
            let end = self.pos.checked_add(n)?;
            let s = self.data.get(self.pos..end)?;
            self.pos = end;
            Some(s)
        }
        fn card8(&mut self) -> Option<u8> {
            self.take(1).map(|b| b[0])
        }
        fn card16(&mut self) -> Option<u16> {
            let msb = self.msb;
            self.take(2).map(|b| {
                let b = [b[0], b[1]];
                if msb {
                    u16::from_be_bytes(b)
                } else {
                    u16::from_le_bytes(b)
                }
            })
        }
        fn card32(&mut self) -> Option<u32> {
            let msb = self.msb;
            self.take(4).map(|b| {
                let b = [b[0], b[1], b[2], b[3]];
                if msb {
                    u32::from_be_bytes(b)
                } else {
                    u32::from_le_bytes(b)
                }
            })
        }
        fn string(&mut self, len: u32) -> Option<Vec<u8>> {
            let len = len as usize;
            let padded = len.checked_add(3)? & !3;
            let s = self.take(padded)?;
            let s = &s[..len];
            Some(s[..s.iter().position(|&c| c == 0).unwrap_or(len)].to_vec())
        }
    }
    let mut b = Buf {
        data,
        pos: 0,
        msb: false,
    };
    // Byte order: LSBFirst (0) or MSBFirst (1).
    b.msb = match b.card8()? {
        0 => false,
        1 => true,
        _ => return None,
    };
    b.take(3)?;
    let _serial = b.card32()?;
    let n = b.card32()?;
    let mut out = HashMap::new();
    for _ in 0..n {
        let ty = b.card8()?;
        b.take(1)?;
        let name_len = b.card16()?;
        let name = b.string(u32::from(name_len))?;
        let _last_change = b.card32()?;
        let value = match ty {
            0 => Some(XValue::Int(b.card32()? as i32)),
            1 => {
                let len = b.card32()?;
                Some(XValue::Str(b.string(len)?))
            }
            2 => {
                b.take(8)?;
                Some(XValue::Color)
            }
            _ => None,
        };
        if out.insert(name, value).is_some() {
            return None;
        }
    }
    Some(out)
}

/// GTK's reading of the two settings from the XSETTINGS manager's property
/// (`None`: no manager, or no property of the right type and format).
fn x11_raw(settings: Option<&[u8]>) -> Raw {
    let Some(data) = settings else {
        return Raw::unknown(
            "there is no XSETTINGS manager, so GTK uses its settings.ini files and defaults",
        );
    };
    let Some(map) = parse_xsettings(data) else {
        return Raw::unknown("GTK discards the XSETTINGS manager's settings");
    };
    // `g_value_transform` to the property's type: an integer converts to a
    // boolean (non-zero) and to a string (decimal); otherwise GTK falls back
    // to its settings.ini files and defaults.
    let animations = match map.get(b"Gtk/EnableAnimations".as_slice()) {
        Some(Some(XValue::Int(i))) => Ok(*i != 0),
        Some(Some(_)) => Err("the XSETTINGS manager's Gtk/EnableAnimations is not an integer"),
        _ => Err("the XSETTINGS manager does not set Gtk/EnableAnimations"),
    };
    let theme = match map.get(b"Net/ThemeName".as_slice()) {
        Some(Some(XValue::Str(s))) => Ok(Theme::of(s)),
        Some(Some(XValue::Int(i))) => Ok(Theme::of(i.to_string().as_bytes())),
        Some(Some(XValue::Color)) => Err("the XSETTINGS manager's Net/ThemeName is a color"),
        _ => Err("the XSETTINGS manager does not set Net/ThemeName"),
    };
    Raw { animations, theme }
}

/// A settings portal value (`org.freedesktop.portal.Settings`).
#[derive(Clone, Debug, PartialEq)]
enum PValue {
    Bool(bool),
    Str(String),
    Other,
}

/// The portal's settings: namespace, key, value. `None`: no portal (its
/// `version` or `ReadAll` failed).
type Portal = Option<HashMap<String, HashMap<String, PValue>>>;

const INTERFACE: &str = "org.gnome.desktop.interface";
const A11Y: &str = "org.gnome.desktop.a11y.interface";

fn portal_value<'a>(
    portal: &'a HashMap<String, HashMap<String, PValue>>,
    ns: &str,
    key: &str,
) -> Option<&'a PValue> {
    portal.get(ns).and_then(|keys| keys.get(key))
}

/// GTK's portal path (GTK 4, and GTK 3 with `GTK_USE_PORTAL=1`): taken when
/// `ReadAll` of its patterns returns a namespace; each setting is the
/// portal's value, or GTK's default where the portal lacks it.
/// `g_variant_get_boolean` and `g_variant_get_string` of another type give
/// false and NULL. `None`: GTK falls back to GSettings.
fn portal_path(portal: &Portal, appearance: bool) -> Option<Raw> {
    let portal = portal.as_ref()?;
    let any = portal.keys().any(|ns| {
        ns.starts_with("org.gnome.") || (appearance && ns == "org.freedesktop.appearance")
    });
    if !any {
        return None;
    }
    let animations = match portal_value(portal, INTERFACE, "enable-animations") {
        None => true,
        Some(PValue::Bool(b)) => *b,
        Some(_) => false,
    };
    let theme = match portal_value(portal, INTERFACE, "gtk-theme") {
        None => Theme::of(b"Adwaita"),
        Some(PValue::Str(s)) => Theme::of(s.as_bytes()),
        Some(_) => Theme::of(b""),
    };
    Some(Raw {
        animations: Ok(animations),
        theme: Ok(theme),
    })
}

/// GTK 3's GSettings path, through the portal's GSettings-backed namespaces:
/// `high-contrast` makes the theme "HighContrast"; a key the schema lacks
/// takes GTK's default.
fn gsettings_path(portal: &Portal) -> Raw {
    const NO_PORTAL: &str =
        "GTK reads GSettings here, and there is no settings portal serving them";
    const NO_SCHEMA: &str = "GTK reads GSettings here, and the settings portal does not serve org.gnome.desktop.interface";
    let Some(portal) = portal.as_ref() else {
        return Raw::unknown(NO_PORTAL);
    };
    if !portal.contains_key(INTERFACE) {
        return Raw::unknown(NO_SCHEMA);
    }
    const TYPE: &str = "the settings portal gives a GSettings value of another type";
    let animations = match portal_value(portal, INTERFACE, "enable-animations") {
        None => Ok(true),
        Some(PValue::Bool(b)) => Ok(*b),
        Some(_) => Err(TYPE),
    };
    let high_contrast = match portal_value(portal, A11Y, "high-contrast") {
        None => Ok(false),
        Some(PValue::Bool(b)) => Ok(*b),
        Some(_) => Err(TYPE),
    };
    let theme = high_contrast.and_then(|hc| {
        if hc {
            return Ok(Theme::of(b"HighContrast"));
        }
        match portal_value(portal, INTERFACE, "gtk-theme") {
            None => Ok(Theme::of(b"Adwaita")),
            Some(PValue::Str(s)) => Ok(Theme::of(s.as_bytes())),
            Some(_) => Err(TYPE),
        }
    });
    Raw { animations, theme }
}

/// The readings of GTK 3 and GTK 4 on Wayland (Chromium's packages depend on
/// either; on GNOME it prefers GTK 4, elsewhere GTK 3).
fn wayland_raws(portal: &Portal, toolkits: Toolkits) -> [Raw; 2] {
    let gtk3 = if toolkits.gtk3_portal {
        portal_path(portal, false).unwrap_or_else(|| gsettings_path(portal))
    } else {
        gsettings_path(portal)
    };
    let gtk4 = if toolkits.gtk4_debug {
        Raw::unknown("GDK_DEBUG is set, which can change how GTK 4 reads its settings")
    } else {
        portal_path(portal, true).unwrap_or_else(|| gsettings_path(portal))
    };
    [gtk3, gtk4]
}

#[cfg(target_os = "linux")]
mod x11 {
    use super::{Raw, Tracker, publish, x11_raw};
    use x11rb::connection::Connection;
    use x11rb::protocol::Event;
    use x11rb::protocol::xproto::{
        Atom, ChangeWindowAttributesAux, ConnectionExt as _, EventMask, Window,
    };
    use x11rb::rust_connection::RustConnection;

    struct Manager {
        conn: RustConnection,
        selection: Atom,
        property: Atom,
        manager: Atom,
        window: Window,
    }

    impl Manager {
        /// The atoms of `names`, requested together.
        fn atoms<const N: usize>(conn: &RustConnection, names: [&str; N]) -> Option<[Atom; N]> {
            let cookies = names.map(|n| conn.intern_atom(false, n.as_bytes()).ok());
            let atoms = cookies.map(|c| c.and_then(|c| c.reply().ok()).map(|r| r.atom));
            atoms
                .iter()
                .all(Option::is_some)
                .then(|| atoms.map(Option::unwrap_or_default))
        }

        /// gdk/x11/xsettings-client.c `check_manager_window`, then
        /// `read_settings`.
        fn check(&mut self) -> Option<Vec<u8>> {
            let conn = &self.conn;
            let _ = conn.grab_server();
            self.window = conn
                .get_selection_owner(self.selection)
                .ok()
                .and_then(|c| c.reply().ok())
                .map_or(x11rb::NONE, |r| r.owner);
            if self.window != x11rb::NONE {
                let _ = conn.change_window_attributes(
                    self.window,
                    &ChangeWindowAttributesAux::new()
                        .event_mask(EventMask::PROPERTY_CHANGE | EventMask::STRUCTURE_NOTIFY),
                );
            }
            let _ = conn.ungrab_server();
            let _ = conn.flush();
            self.read()
        }

        fn read(&self) -> Option<Vec<u8>> {
            if self.window == x11rb::NONE {
                return None;
            }
            let reply = self
                .conn
                .get_property(
                    false,
                    self.window,
                    self.property,
                    self.property,
                    0,
                    u32::MAX,
                )
                .ok()?
                .reply()
                .ok()?;
            (reply.type_ == self.property && reply.format == 8).then_some(reply.value)
        }
    }

    pub(super) fn start(mut tracker: Tracker) {
        let Ok((conn, screen)) = x11rb::connect(None) else {
            publish(tracker.apply(&[super::Raw::unknown(
                "Chromium would run on X11 here, and the X display cannot be opened",
            )]));
            return;
        };
        let root = conn.setup().roots[screen].root;
        let selection_name = format!("_XSETTINGS_S{screen}");
        let Some([selection, property, manager]) =
            Manager::atoms(&conn, [&selection_name, "_XSETTINGS_SETTINGS", "MANAGER"])
        else {
            publish(tracker.apply(&[super::Raw::unknown("the X display cannot be read")]));
            return;
        };
        // A new manager announces itself on the root window.
        let _ = conn.change_window_attributes(
            root,
            &ChangeWindowAttributesAux::new().event_mask(EventMask::STRUCTURE_NOTIFY),
        );
        let mut m = Manager {
            conn,
            selection,
            property,
            manager,
            window: x11rb::NONE,
        };
        let settings = m.check();
        let mut last = Raw::unknown("not read");
        last.update(x11_raw(settings.as_deref()));
        publish(tracker.apply(std::slice::from_ref(&last)));
        super::spawn("runic-xsettings", move || {
            while let Ok(event) = m.conn.wait_for_event() {
                let settings = match event {
                    Event::ClientMessage(e)
                        if e.type_ == m.manager && e.data.as_data32()[1] == m.selection =>
                    {
                        m.check()
                    }
                    Event::DestroyNotify(e) if e.window == m.window => m.check(),
                    Event::PropertyNotify(e) if e.window == m.window && e.atom == m.property => {
                        m.read()
                    }
                    _ => continue,
                };
                last.update(x11_raw(settings.as_deref()));
                publish(tracker.apply(std::slice::from_ref(&last)));
            }
        });
    }
}

#[cfg(target_os = "linux")]
mod portal {
    use super::{PValue, Portal, Toolkits, Tracker, publish, wayland_raws};
    use std::collections::HashMap;
    use zbus::zvariant::OwnedValue;

    const DESTINATION: &str = "org.freedesktop.portal.Desktop";
    const PATH: &str = "/org/freedesktop/portal/desktop";
    const SETTINGS: &str = "org.freedesktop.portal.Settings";

    fn value(v: &OwnedValue) -> PValue {
        use zbus::zvariant::Value;
        match &**v {
            Value::Bool(b) => PValue::Bool(*b),
            Value::Str(s) => PValue::Str(s.as_str().to_owned()),
            _ => PValue::Other,
        }
    }

    /// GTK 4's check (`gdk_display_should_use_portal`: the interface's
    /// `version`), then `ReadAll` of the namespaces GTK reads.
    fn read(conn: &zbus::blocking::Connection) -> Portal {
        let version: u32 = conn
            .call_method(
                Some(DESTINATION),
                PATH,
                Some("org.freedesktop.DBus.Properties"),
                "Get",
                &(SETTINGS, "version"),
            )
            .ok()?
            .body()
            .deserialize::<OwnedValue>()
            .ok()
            .and_then(|v| u32::try_from(&v).ok())?;
        if version == 0 {
            return None;
        }
        let reply = conn
            .call_method(
                Some(DESTINATION),
                PATH,
                Some(SETTINGS),
                "ReadAll",
                &(vec!["org.gnome.*", "org.freedesktop.appearance"],),
            )
            .ok()?;
        let all: HashMap<String, HashMap<String, OwnedValue>> = reply.body().deserialize().ok()?;
        Some(
            all.into_iter()
                .map(|(ns, keys)| (ns, keys.into_iter().map(|(k, v)| (k, value(&v))).collect()))
                .collect(),
        )
    }

    pub(super) fn start(mut tracker: Tracker, toolkits: Toolkits) {
        let conn = zbus::blocking::connection::Builder::session()
            .and_then(|b| b.method_timeout(std::time::Duration::from_secs(5)).build());
        let Ok(conn) = conn else {
            publish(tracker.apply(&wayland_raws(&None, toolkits)));
            return;
        };
        // Subscribe first, so no change between the read and the
        // subscription is lost.
        let changes = zbus::blocking::proxy::Builder::<zbus::blocking::Proxy<'_>>::new(&conn)
            .destination(DESTINATION)
            .and_then(|b| b.path(PATH))
            .and_then(|b| b.interface(SETTINGS))
            .map(|b| b.cache_properties(zbus::proxy::CacheProperties::No))
            .and_then(|b| b.build())
            .and_then(|p| p.receive_signal("SettingChanged").map(|s| (p, s)));
        let mut portal = read(&conn);
        publish(tracker.apply(&wayland_raws(&portal, toolkits)));
        // Without a portal GTK reads GSettings, which stay unreadable.
        let (true, Ok((_proxy, signals))) = (portal.is_some(), changes) else {
            return;
        };
        for message in signals {
            let Ok((ns, key, v)) = message.body().deserialize::<(String, String, OwnedValue)>()
            else {
                continue;
            };
            if let Some(settings) = portal.as_mut() {
                settings.entry(ns).or_default().insert(key, value(&v));
            }
            publish(tracker.apply(&wayland_raws(&portal, toolkits)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            vars.iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn toolkit_and_backend_follow_chromium() {
        let p = |vars: &[(&str, &str)]| platform(&env(vars));
        assert!(matches!(
            p(&[
                ("XDG_CURRENT_DESKTOP", "KDE"),
                ("XDG_SESSION_TYPE", "wayland")
            ]),
            Platform::Qt(_)
        ));
        assert!(matches!(
            p(&[("XDG_CURRENT_DESKTOP", "foo:LXQt")]),
            Platform::Qt(_)
        ));
        assert!(matches!(
            p(&[("DESKTOP_SESSION", "kde-plasma"), ("DISPLAY", ":0")]),
            Platform::Qt(_)
        ));
        assert!(matches!(
            p(&[("KDE_FULL_SESSION", "true"), ("DISPLAY", ":0")]),
            Platform::Qt(_)
        ));
        // The first value Chromium knows decides.
        assert_eq!(
            p(&[
                ("XDG_CURRENT_DESKTOP", "ubuntu:GNOME:KDE"),
                ("DISPLAY", ":0")
            ]),
            Platform::X11
        );
        assert_eq!(
            p(&[("XDG_CURRENT_DESKTOP", "sway"), ("DISPLAY", ":0")]),
            Platform::X11
        );
        // Chromium runs on Wayland only where the session says so.
        assert_eq!(
            p(&[("WAYLAND_DISPLAY", "wayland-0"), ("DISPLAY", ":0")]),
            Platform::X11
        );
        assert_eq!(
            p(&[("XDG_SESSION_TYPE", "wayland"), ("GTK_USE_PORTAL", "1")]),
            Platform::Wayland(Toolkits {
                gtk3_portal: true,
                gtk4_debug: false
            })
        );
        assert!(matches!(p(&[]), Platform::Unknown(_)));
    }

    #[test]
    fn theme_names_as_chromium_checks_them() {
        assert_eq!(Theme::of(b"HighContrast"), Theme::Valid(true));
        assert_eq!(Theme::of(b"ContrastHighInverse"), Theme::Valid(true));
        assert_eq!(Theme::of(b"Adwaita-dark"), Theme::Valid(false));
        assert_eq!(Theme::of(b"high"), Theme::Valid(false));
        for invalid in [
            &b""[..],
            b".",
            b"..",
            b"a/HighContrast",
            b"/HighContrast",
            b"HighContrast/",
        ] {
            assert_eq!(Theme::of(invalid), Theme::Invalid);
        }
        assert_eq!(Theme::of(b"..HighContrast"), Theme::Valid(true));
    }

    /// An XSETTINGS property: (type, name, value bytes).
    fn xsettings(msb: bool, entries: &[(u8, &str, Vec<u8>)]) -> Vec<u8> {
        let c16 = |v: u16| {
            if msb {
                v.to_be_bytes().to_vec()
            } else {
                v.to_le_bytes().to_vec()
            }
        };
        let c32 = |v: u32| {
            if msb {
                v.to_be_bytes().to_vec()
            } else {
                v.to_le_bytes().to_vec()
            }
        };
        let pad = |b: &mut Vec<u8>| {
            while b.len() % 4 != 0 {
                b.push(0)
            }
        };
        let mut out = vec![u8::from(msb), 0, 0, 0];
        out.extend(c32(7));
        out.extend(c32(entries.len() as u32));
        for (ty, name, value) in entries {
            out.push(*ty);
            out.push(0);
            out.extend(c16(name.len() as u16));
            out.extend(name.as_bytes());
            pad(&mut out);
            out.extend(c32(0));
            out.extend(value.iter().copied());
        }
        let _ = c16;
        out
    }

    fn int(msb: bool, v: i32) -> Vec<u8> {
        if msb {
            v.to_be_bytes().to_vec()
        } else {
            v.to_le_bytes().to_vec()
        }
    }

    fn string(msb: bool, s: &str) -> Vec<u8> {
        let mut out = int(msb, s.len() as i32);
        out.extend(s.as_bytes());
        while out.len() % 4 != 0 {
            out.push(0);
        }
        out
    }

    #[test]
    fn xsettings_as_gtk_reads_them() {
        for msb in [false, true] {
            let data = xsettings(
                msb,
                &[
                    (1, "Net/ThemeName", string(msb, "HighContrast")),
                    (0, "Gtk/EnableAnimations", int(msb, 0)),
                    (2, "Gtk/Other", vec![0; 8]),
                ],
            );
            let raw = x11_raw(Some(&data));
            assert_eq!(raw.animations, Ok(false));
            assert_eq!(raw.theme, Ok(Theme::Valid(true)));
        }
        // An integer theme name is its decimal; a string animation setting
        // does not convert.
        let data = xsettings(
            false,
            &[
                (0, "Net/ThemeName", int(false, 3)),
                (1, "Gtk/EnableAnimations", string(false, "1")),
            ],
        );
        let raw = x11_raw(Some(&data));
        assert_eq!(raw.theme, Ok(Theme::Valid(false)));
        assert!(raw.animations.is_err());
        // A name given twice, a truncated property and an unknown byte order
        // are discarded; no manager or missing settings are unknown.
        let twice = xsettings(
            false,
            &[
                (0, "Gtk/EnableAnimations", int(false, 0)),
                (0, "Gtk/EnableAnimations", int(false, 1)),
            ],
        );
        assert!(x11_raw(Some(&twice)).animations.is_err());
        let data = xsettings(false, &[(0, "Gtk/EnableAnimations", int(false, 0))]);
        assert!(x11_raw(Some(&data[..data.len() - 1])).animations.is_err());
        let mut bad = data.clone();
        bad[0] = 2;
        assert!(x11_raw(Some(&bad)).animations.is_err());
        assert_eq!(x11_raw(Some(&data)).animations, Ok(false));
        assert!(x11_raw(Some(&data)).theme.is_err());
        assert!(x11_raw(None).animations.is_err());
        // Settings the manager stops giving keep their last value.
        let mut last = Raw::unknown("not read");
        last.update(x11_raw(None));
        assert!(last.animations.is_err());
        last.update(x11_raw(Some(&data)));
        assert_eq!(last.animations, Ok(false));
        last.update(x11_raw(None));
        assert_eq!(last.animations, Ok(false));
        assert!(last.theme.is_err());
        // A theme name stops at its first NUL.
        let data = xsettings(
            false,
            &[(1, "Net/ThemeName", string(false, "Adwaita\0HighContrast"))],
        );
        assert_eq!(x11_raw(Some(&data)).theme, Ok(Theme::Valid(false)));
    }

    fn portal(entries: &[(&str, &str, PValue)]) -> Portal {
        let mut map: HashMap<String, HashMap<String, PValue>> = HashMap::new();
        for (ns, key, v) in entries {
            let keys = map.entry(ns.to_string()).or_default();
            if !key.is_empty() {
                keys.insert(key.to_string(), v.clone());
            }
        }
        Some(map)
    }

    const PLAIN: Toolkits = Toolkits {
        gtk3_portal: false,
        gtk4_debug: false,
    };

    #[test]
    fn wayland_needs_gtk_3_and_4_to_agree() {
        let mut t = Tracker::default();
        let p = portal(&[
            (INTERFACE, "enable-animations", PValue::Bool(false)),
            (INTERFACE, "gtk-theme", PValue::Str("Adwaita".into())),
            (A11Y, "high-contrast", PValue::Bool(false)),
        ]);
        let prefs = t.apply(&wayland_raws(&p, PLAIN));
        assert_eq!(prefs.reduced_motion, Ok(true));
        assert_eq!(prefs.contrast_more, Ok(false));
        // GNOME's high contrast switch: GTK 3 (GSettings) sees
        // "HighContrast", GTK 4 (portal) the gtk-theme key.
        let p = portal(&[
            (INTERFACE, "gtk-theme", PValue::Str("Adwaita".into())),
            (A11Y, "high-contrast", PValue::Bool(true)),
        ]);
        let prefs = Tracker::default().apply(&wayland_raws(&p, PLAIN));
        assert_eq!(prefs.reduced_motion, Ok(false));
        assert!(prefs.contrast_more.is_err());
        // Both read the portal: the switch does not count.
        let prefs = Tracker::default().apply(&wayland_raws(
            &p,
            Toolkits {
                gtk3_portal: true,
                gtk4_debug: false,
            },
        ));
        assert_eq!(prefs.contrast_more, Ok(false));
        // A portal serving only org.freedesktop.appearance: GTK 4 takes its
        // defaults, GTK 3 reads GSettings, which the portal does not serve.
        let p = portal(&[("org.freedesktop.appearance", "color-scheme", PValue::Other)]);
        let prefs = Tracker::default().apply(&wayland_raws(&p, PLAIN));
        assert!(prefs.reduced_motion.is_err());
        // No portal at all.
        let prefs = Tracker::default().apply(&wayland_raws(&None, PLAIN));
        assert!(prefs.reduced_motion.is_err() && prefs.contrast_more.is_err());
    }

    #[test]
    fn a_replaced_theme_stays_replaced() {
        let mut t = Tracker::default();
        let raw = |theme: Result<Theme, &'static str>| Raw {
            animations: Ok(true),
            theme,
        };
        assert_eq!(
            t.apply(&[raw(Ok(Theme::Valid(true)))]).contrast_more,
            Ok(true)
        );
        assert_eq!(t.apply(&[raw(Ok(Theme::Invalid))]).contrast_more, Ok(false));
        assert_eq!(
            t.apply(&[raw(Ok(Theme::Valid(true)))]).contrast_more,
            Ok(false)
        );
        assert_eq!(t.apply(&[raw(Err("x"))]).contrast_more, Ok(false));
        // Once unreadable, whether Chromium replaced it is unknown.
        let mut t = Tracker::default();
        assert!(t.apply(&[raw(Err("x"))]).contrast_more.is_err());
        assert!(
            t.apply(&[raw(Ok(Theme::Valid(true)))])
                .contrast_more
                .is_err()
        );
    }
}
