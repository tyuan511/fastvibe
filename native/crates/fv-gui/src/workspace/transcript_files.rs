//! File actions shared by tool subjects, folded summaries and turn changes.
use super::{Workspace, diff};
use crate::conversation_resources::resolve;
use crate::ui::px;
use fv_theme::Token;
use gpui_kit::component::hover_card::HoverCard;
use gpui_kit::component::menu::{ContextMenuExt, PopupMenuItem};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

impl Workspace {
    pub(super) fn transcript_path(&self, path: &str) -> Option<String> {
        let cwd = self
            .selected
            .as_ref()
            .and_then(|id| self.project_root_for(id));
        resolve(path, cwd.as_deref())
    }

    /// Left click previews (or reviews a turn change); the context menu always
    /// offers the same three file actions. A child link must not toggle its fold.
    pub(super) fn file_actions(
        &self,
        mut element: Stateful<Div>,
        path: &str,
        review: bool,
        patch: Option<&str>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(path) = self.transcript_path(path) else {
            return element.into_any_element();
        };
        let click_path = path.clone();
        let title = path.rsplit('/').next().unwrap_or(&path).to_string();
        let preview_title = title.clone();
        let weak = cx.entity().downgrade();
        let menu_owner = weak.clone();
        let english = self.english();
        let palette = self.palette.clone();
        let hover_path = path.clone();
        let patch = patch.map(str::to_string);
        let hover_id = SharedString::from(format!(
            "file-hover-{:?}",
            element.interactivity().element_id
        ));
        let trigger = element
            .cursor_pointer()
            .when(patch.is_none(), |d| {
                d.tooltip({
                    let path = hover_path.clone();
                    move |window, cx| Tooltip::new(path.clone()).build(window, cx)
                })
            })
            .on_click(move |_, window, cx| {
                cx.stop_propagation();
                _ = weak.update(cx, |this, cx| {
                    if review {
                        this.review_transcript_file(click_path.clone(), window, cx);
                    } else {
                        this.open_in_pane(click_path.clone(), title.clone(), window, cx);
                    }
                });
            })
            .context_menu(move |menu, _, _| {
                let owner = menu_owner.clone();
                let preview_path = path.clone();
                let title = preview_title.clone();
                let reveal_path = path.clone();
                let copy_path = path.clone();
                menu.item(
                    PopupMenuItem::new(super::static_text(english, "transcript.path_preview"))
                        .on_click(move |_, window, cx| {
                            _ = owner.update(cx, |this, cx| {
                                this.open_in_pane(preview_path.clone(), title.clone(), window, cx)
                            });
                        }),
                )
                .item(
                    PopupMenuItem::new(super::static_text(english, "mod.show_in_file_manager"))
                        .on_click(move |_, _, cx| {
                            cx.reveal_path(std::path::Path::new(&reveal_path))
                        }),
                )
                .item(
                    PopupMenuItem::new(super::static_text(english, "transcript.path_copy"))
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copy_path.clone()))
                        }),
                )
            })
            .into_any_element();
        let Some(patch) = patch else { return trigger };
        HoverCard::new(hover_id)
            .anchor(Anchor::TopLeft)
            .open_delay(std::time::Duration::from_millis(300))
            .close_delay(std::time::Duration::from_millis(150))
            .trigger(trigger)
            .content(move |_, window, _| {
                div()
                    .w(px(600.0))
                    .max_w(window.viewport_size().width - window.rem_size() * 2.0)
                    .child(div().px(px(8.0)).py(px(4.0)).child(hover_path.clone()))
                    .child(diff::view("file-hover-diff", &patch, &palette))
            })
            .into_any_element()
    }

    pub(super) fn file_link(
        &self,
        id: String,
        path: &str,
        label: String,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.file_actions(
            div()
                .id(SharedString::from(id))
                .min_w_0()
                .font_family(crate::assets::MONO_FONT)
                .text_color(self.palette.c(Token::Primary))
                .underline()
                .child(crate::ui::truncate(label)),
            path,
            false,
            None,
            cx,
        )
    }
}
