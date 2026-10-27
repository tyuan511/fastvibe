//! The agent's `browser` tool, answered here: the server cannot touch the native web view, so it
//! asks the app (`browser/request`) and the app runs the action on the conversation's browser tab.
//!
//! Elements are addressed by `ref`: a snapshot stamps each interactive element with
//! `data-fv-ref="e3"` and lists them, and a later click or type finds the element by that stamp.
//! A ref belongs to the snapshot that made it. The page has no bridge back to the app: the app
//! evaluates a script and reads its value, nothing more.

use std::time::Duration;

use fv_protocol::RequestId;
use fv_protocol::types::{BrowserRequest, BrowserResponse};
use gpui_kit::*;
use serde_json::Value;

use super::Workspace;
use super::pane::PaneTabKind;

const MOUNT_WAIT: Duration = Duration::from_secs(8);
const LOAD_WAIT: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(150);

const SNAPSHOT: &str = r#"(() => {
  const sel = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=""],[contenteditable=true],[onclick]';
  document.querySelectorAll('[data-fv-ref]').forEach(e => e.removeAttribute('data-fv-ref'));
  let n = 0; const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none') continue;
    if (r.bottom < 0 || r.top > innerHeight * 3) continue;
    const ref = 'e' + (n++); el.setAttribute('data-fv-ref', ref);
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    out.push(ref + ' ' + el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : '') + ' "' + label + '"' + (el.href ? ' -> ' + String(el.href).slice(0, 120) : ''));
    if (n >= 150) break;
  }
  return location.href + '\n' + document.title + '\n' + (out.join('\n') || '(no interactive elements)');
})()"#;

const TEXT: &str = "(() => (document.body ? document.body.innerText : '').slice(0, 12000))()";

fn valid_ref(value: &str) -> bool {
    value.len() <= 8
        && value.starts_with('e')
        && value.len() > 1
        && value[1..].bytes().all(|b| b.is_ascii_digit())
}

fn quoted(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

/// The script for an action that runs on the page, or the reason it cannot.
pub(super) fn script_for(action: &str, args: &Value) -> Result<String, String> {
    let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("");
    let element = |args_ref: &str| -> Result<String, String> {
        if !valid_ref(args_ref) {
            return Err("`ref` must be an element ref from the latest snapshot, like e3".into());
        }
        Ok(format!(
            "const el = document.querySelector('[data-fv-ref=\"{args_ref}\"]'); if (!el) return 'ERR:no element {args_ref} on this page; take a new snapshot';"
        ))
    };
    match action {
        "snapshot" => Ok(SNAPSHOT.into()),
        "text" => Ok(TEXT.into()),
        "click" => Ok(format!(
            "(() => {{ {} el.scrollIntoView({{block:'center'}}); el.click(); return 'Clicked {}'; }})()",
            element(text("ref"))?,
            text("ref")
        )),
        "type" => {
            let submit = args.get("submit").and_then(Value::as_bool).unwrap_or(false);
            Ok(format!(
                "(() => {{ {} el.scrollIntoView({{block:'center'}}); el.focus();
                   const value = {};
                   if (el.isContentEditable) {{ el.textContent = value; }}
                   else {{
                     const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                     const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                     if (set) set.call(el, value); else el.value = value;
                   }}
                   el.dispatchEvent(new Event('input', {{bubbles:true}}));
                   el.dispatchEvent(new Event('change', {{bubbles:true}}));
                   if ({submit}) {{
                     for (const t of ['keydown','keypress','keyup']) el.dispatchEvent(new KeyboardEvent(t, {{key:'Enter', code:'Enter', keyCode:13, bubbles:true}}));
                     if (el.form) el.form.requestSubmit();
                   }}
                   return 'Typed into {}'; }})()",
                element(text("ref"))?,
                quoted(text("text")),
                text("ref")
            ))
        }
        "press" => {
            let key = text("key");
            if key.is_empty() {
                return Err("`key` is required for press".into());
            }
            Ok(format!(
                "(() => {{ const el = document.activeElement || document.body; const key = {};
                   for (const t of ['keydown','keypress','keyup']) el.dispatchEvent(new KeyboardEvent(t, {{key, bubbles:true}}));
                   if (key === 'Enter' && el.form) el.form.requestSubmit();
                   return 'Pressed ' + key; }})()",
                quoted(key)
            ))
        }
        "scroll" => {
            let by = match text("direction") {
                "up" => "window.scrollBy(0, -innerHeight * 0.8)",
                "top" => "window.scrollTo(0, 0)",
                "bottom" => "window.scrollTo(0, document.documentElement.scrollHeight)",
                _ => "window.scrollBy(0, innerHeight * 0.8)",
            };
            Ok(format!(
                "(() => {{ {by}; return 'Scrolled to ' + Math.round(scrollY) + ' of ' + document.documentElement.scrollHeight; }})()"
            ))
        }
        other => Err(format!("`{other}` does not run on the page")),
    }
}

impl Workspace {
    fn browser_answer(&self, id: RequestId, output: impl Into<String>, is_error: bool) {
        if let Some(backend) = &self.backend {
            let response = BrowserResponse {
                output: output.into(),
                is_error,
            };
            backend.respond(id, serde_json::to_value(response).unwrap_or(Value::Null));
        }
    }

    /// The key of the browser tab the agent works in for this conversation, made and shown if
    /// there is none: the native view only exists while its tab is on screen.
    fn browser_tab_for_agent(&mut self, thread: &str, cx: &mut Context<Self>) -> Option<String> {
        let has_browser = self.panes.get(thread).is_some_and(|p| {
            p.tabs
                .iter()
                .any(|t| matches!(t.kind, PaneTabKind::Browser { .. }))
        });
        if !has_browser {
            self.open_browser_tab(thread, "about:blank", cx);
        }
        let state = self.panes.get_mut(thread)?;
        let active_is_browser = state
            .active_tab()
            .is_some_and(|t| matches!(t.kind, PaneTabKind::Browser { .. }));
        if !active_is_browser {
            let id = state
                .tabs
                .iter()
                .find(|t| matches!(t.kind, PaneTabKind::Browser { .. }))?
                .id
                .clone();
            state.activate(id);
        }
        self.side_pane_collapsed = false;
        cx.notify();
        self.panes.get(thread)?.active_tab().map(|t| t.id.clone())
    }

    pub(super) fn browser_request(
        &mut self,
        id: RequestId,
        request: BrowserRequest,
        cx: &mut Context<Self>,
    ) {
        if self.selected.as_deref() != Some(request.thread_id.as_str()) {
            self.browser_answer(
                id,
                "The user is not looking at this conversation, so its browser cannot be shown. Ask them to open it.",
                true,
            );
            return;
        }
        let Some(key) = self.browser_tab_for_agent(&request.thread_id, cx) else {
            self.browser_answer(id, "Could not open a browser tab.", true);
            return;
        };
        cx.spawn(async move |this, cx| {
            // The view is made when the tab is first painted.
            let mut waited = Duration::ZERO;
            loop {
                let ready = this
                    .update(cx, |this, _| {
                        this.web_views.get(&key).is_some_and(|v| v.surface.is_mounted())
                    })
                    .unwrap_or(false);
                if ready {
                    break;
                }
                if waited >= MOUNT_WAIT {
                    let _ = this.update(cx, |this, _| {
                        this.browser_answer(
                            id.clone(),
                            "The browser pane did not come up. It needs the app window to be visible.",
                            true,
                        )
                    });
                    return;
                }
                cx.background_executor().timer(POLL).await;
                waited += POLL;
            }
            let outcome = run_action(&this, cx, &key, &request).await;
            let _ = this.update(cx, |this, _| match outcome {
                Ok(text) => this.browser_answer(id, text, false),
                Err(text) => this.browser_answer(id, text, true),
            });
        })
        .detach();
    }
}

async fn run_action(
    this: &WeakEntity<Workspace>,
    cx: &mut AsyncApp,
    key: &str,
    request: &BrowserRequest,
) -> Result<String, String> {
    let action = request.action.as_str();
    let gone = || "The browser tab was closed.".to_string();
    match action {
        "open" => {
            let url = request
                .args
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if url.trim().is_empty() {
                return Err("`url` is required for open".into());
            }
            this.update(cx, |this, cx| this.navigate_browser(key, &url, cx))
                .map_err(|_| gone())?;
            let mut waited = Duration::ZERO;
            loop {
                cx.background_executor().timer(POLL).await;
                waited += POLL;
                let (loading, location) = this
                    .update(cx, |this, _| {
                        this.web_views
                            .get(key)
                            .map(|v| (v.loading, v.url.clone()))
                            .unwrap_or((false, String::new()))
                    })
                    .map_err(|_| gone())?;
                if !loading || waited >= LOAD_WAIT {
                    return Ok(format!(
                        "{} {location}",
                        if loading { "Still loading" } else { "Loaded" }
                    ));
                }
            }
        }
        "back" | "forward" | "reload" => {
            this.update(cx, |this, cx| this.web_command(key, action, cx))
                .map_err(|_| gone())?;
            cx.background_executor()
                .timer(Duration::from_millis(600))
                .await;
            Ok(format!("Did {action}"))
        }
        _ => {
            let script = super::browser_bridge::script_for(action, &request.args)?;
            let (tx, rx) = futures_channel::oneshot::channel::<String>();
            let tx = std::sync::Mutex::new(Some(tx));
            let started = this
                .update(cx, |this, _| {
                    this.web_views
                        .get(key)
                        .ok_or_else(gone)?
                        .surface
                        .eval(&script, move |value| {
                            if let Some(tx) = tx.lock().unwrap().take() {
                                let _ = tx.send(value);
                            }
                        })
                })
                .map_err(|_| gone())?;
            started?;
            let value = futures_util::future::select(
                rx,
                cx.background_executor().timer(Duration::from_secs(15)),
            )
            .await;
            let raw = match value {
                futures_util::future::Either::Left((Ok(raw), _)) => raw,
                _ => return Err("The page did not answer.".into()),
            };
            let text = serde_json::from_str::<String>(&raw).unwrap_or(raw);
            match text.strip_prefix("ERR:") {
                Some(problem) => Err(problem.to_string()),
                None => Ok(text),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::script_for;
    use serde_json::json;

    #[test]
    fn only_a_ref_from_a_snapshot_reaches_a_script() {
        assert!(script_for("click", &json!({"ref": "e12"})).is_ok());
        for bad in ["", "e", "12", "e1\"]');alert(1);//", "e1 e2"] {
            assert!(script_for("click", &json!({"ref": bad})).is_err(), "{bad}");
            assert!(
                script_for("type", &json!({"ref": bad, "text": "x"})).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn typed_text_is_a_string_literal_not_code() {
        let script = script_for(
            "type",
            &json!({"ref": "e1", "text": "\"); fetch('//evil'); (\""}),
        )
        .unwrap();
        // The text sits inside one JSON string; its quotes are escaped.
        assert!(script.contains(r#"\"); fetch('//evil'); (\""#));
    }

    #[test]
    fn navigation_actions_do_not_run_on_the_page() {
        assert!(script_for("open", &json!({})).is_err());
        assert!(script_for("snapshot", &json!({})).is_ok());
        assert!(script_for("press", &json!({})).is_err());
    }
}
