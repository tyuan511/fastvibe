//! Which settings panes a platform offers.
//!
//! The navigation is a `const` table filtered by one pure function, so the platform rule is
//! testable without a window. Its server-side half — a platform with no pane also gets no basic
//! `computer` fallback tool — is pinned by `fv-server`'s `every_os_with_a_build_shows_the_pane`.

use fv_gui::workspace::settings::{Section, all_sections, section_available};

#[test]
fn the_driver_platforms_offer_every_pane() {
    for os in ["macos", "windows"] {
        for section in all_sections() {
            assert!(section_available(section, os), "{os} hides {section:?}");
        }
    }
}

#[test]
fn linux_hides_computer_control_and_nothing_else() {
    // There is no driver build for Linux, so there is no pane to open — and `fv-server` withholds
    // the basic `computer` tool on the same reading, so nothing is left that the hidden switch
    // would have governed.
    assert!(!section_available(Section::Computer, "linux"));
    for section in all_sections() {
        if section == Section::Computer {
            continue;
        }
        assert!(
            section_available(section, "linux"),
            "linux hides {section:?}"
        );
    }
}

#[test]
fn an_unknown_platform_hides_it_too() {
    // A build this app does not ship a driver for is not a platform to advertise one on.
    assert!(!section_available(Section::Computer, "freebsd"));
    assert!(section_available(Section::General, "freebsd"));
}
