//! AppKit scales the enclosing view while WebKit keeps the requested CSS viewport size.
#![allow(unexpected_cfgs)]
use gpui_kit::{Bounds, Pixels};
use objc::{class, msg_send, runtime::Object, sel, sel_impl};
#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct Point {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct Size {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct Rect {
    origin: Point,
    size: Size,
}
unsafe impl objc::Encode for Point {
    fn encode() -> objc::Encoding {
        unsafe { objc::Encoding::from_str("{CGPoint=dd}") }
    }
}
unsafe impl objc::Encode for Size {
    fn encode() -> objc::Encoding {
        unsafe { objc::Encoding::from_str("{CGSize=dd}") }
    }
}
unsafe impl objc::Encode for Rect {
    fn encode() -> objc::Encoding {
        unsafe { objc::Encoding::from_str("{CGRect={CGPoint=dd}{CGSize=dd}}") }
    }
}
pub struct Container(*mut Object);
impl Container {
    pub unsafe fn attach(view: *mut Object) -> Self {
        unsafe {
            let parent: *mut Object = msg_send![view, superview];
            let container: *mut Object = msg_send![class!(NSView), new];
            let _: () = msg_send![parent,addSubview:container];
            let _: () = msg_send![view, removeFromSuperview];
            let _: () = msg_send![container,addSubview:view];
            Self(container)
        }
    }
    pub fn place(&self, view: *mut Object, bounds: Bounds<Pixels>, viewport: Option<(f32, f32)>) {
        let (x, y, w, h) = (
            f32::from(bounds.left()),
            f32::from(bounds.top()),
            f32::from(bounds.size.width),
            f32::from(bounds.size.height),
        );
        let (dw, dh, vw, vh) = fit(w, h, viewport);
        unsafe {
            let parent: *mut Object = msg_send![self.0, superview];
            let parent_frame: Rect = msg_send![parent, frame];
            let frame = Rect {
                origin: Point {
                    x: f64::from(x + (w - dw) / 2.),
                    y: parent_frame.size.height - f64::from(y + (h - dh) / 2. + dh),
                },
                size: Size {
                    width: dw.into(),
                    height: dh.into(),
                },
            };
            let _: () = msg_send![self.0,setFrame:frame];
            let _: () = msg_send![self.0,setBoundsSize:Size{width:vw.into(),height:vh.into()}];
            let _: () = msg_send![view,setFrame:Rect{origin:Point{x:0.,y:0.},size:Size{width:vw.into(),height:vh.into()}}];
        }
    }
}
impl Drop for Container {
    fn drop(&mut self) {
        unsafe {
            let _: () = msg_send![self.0, removeFromSuperview];
            let _: () = msg_send![self.0, release];
        }
    }
}
fn fit(width: f32, height: f32, viewport: Option<(f32, f32)>) -> (f32, f32, f32, f32) {
    let Some((w, h)) = viewport else {
        return (width, height, width, height);
    };
    let scale = 1f32.min(width / w).min(height / h).max(0.);
    (w * scale, h * scale, w, h)
}
#[cfg(test)]
mod tests {
    use super::fit;
    #[test]
    fn preset_is_fitted_without_changing_its_css_dimensions() {
        assert_eq!(
            fit(400., 500., Some((768., 1024.))),
            (375., 500., 768., 1024.)
        );
        assert_eq!(fit(1000., 1000., None), (1000., 1000., 1000., 1000.));
        assert_eq!(
            fit(1000., 1000., Some((375., 812.))),
            (375., 812., 375., 812.)
        );
    }
}
