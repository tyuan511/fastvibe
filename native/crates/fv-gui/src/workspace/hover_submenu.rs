//! Shared hover lifecycle for sibling flyout menus.
//!
//! A trigger and its flyout are separate GPUI hitboxes. Leaving the trigger therefore emits a
//! leave before the pointer reaches the flyout. This controller gives that crossing a small grace
//! period and cancels the close as soon as either surface is entered again.

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use gpui_kit::Context;

#[derive(Clone, Default)]
pub(crate) struct HoverSubmenuController {
    generation: Arc<AtomicU64>,
}

impl HoverSubmenuController {
    pub(crate) fn entered(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn close_after<T: 'static>(
        &self,
        cx: &mut Context<T>,
        clear: impl Fn(&mut T) + 'static,
    ) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let controller = self.clone();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(100))
                .await;
            this.update(cx, |this, cx| {
                if controller.generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                clear(this);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}
