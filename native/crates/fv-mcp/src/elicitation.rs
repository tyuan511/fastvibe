//! A server asking the user something in the middle of a tool call (`elicitation/create`).
//!
//! The question is put to whoever is on the other end of the tool call that is in flight, through
//! the same channel `request_user_input` uses. A form's fields become one question each; a
//! server asking for something we cannot show (a URL flow) is declined, which the protocol
//! defines as "continue without".

use std::sync::{Arc, Mutex};

use fv_agent::UserInput;
use fv_core::{Question, QuestionOption};
use rmcp::model::{ElicitRequestParams, ElicitResult, ElicitationAction};
use serde_json::{Map, Value};

/// The `UserInput` of each tool call currently running on one connection, newest last.
#[derive(Default)]
pub(crate) struct Askers(Mutex<Vec<(String, Arc<dyn UserInput>)>>);

impl Askers {
    pub fn enter(self: &Arc<Self>, call_id: &str, ui: Arc<dyn UserInput>) -> Leave {
        self.0.lock().unwrap().push((call_id.to_string(), ui));
        Leave {
            askers: self.clone(),
            call_id: call_id.to_string(),
        }
    }

    fn current(&self) -> Option<(String, Arc<dyn UserInput>)> {
        self.0.lock().unwrap().last().cloned()
    }
}

/// Removes the call from the list however the call ends.
pub(crate) struct Leave {
    askers: Arc<Askers>,
    call_id: String,
}

impl Drop for Leave {
    fn drop(&mut self) {
        self.askers
            .0
            .lock()
            .unwrap()
            .retain(|(id, _)| *id != self.call_id);
    }
}

fn short(text: &str) -> String {
    text.chars().take(12).collect()
}

/// One question per field of the form.
fn questions(message: &str, schema: &Value) -> Vec<(String, Question, String)> {
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    properties
        .iter()
        .enumerate()
        .map(|(index, (name, field))| {
            let kind = field
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("string");
            let title = field
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or(name.as_str());
            let detail = field
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or(title);
            let options: Vec<QuestionOption> = match (field.get("enum"), kind) {
                (Some(Value::Array(values)), _) => values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|v| QuestionOption {
                        label: v.to_string(),
                        description: String::new(),
                    })
                    .collect(),
                (_, "boolean") => ["yes", "no"]
                    .into_iter()
                    .map(|v| QuestionOption {
                        label: v.into(),
                        description: String::new(),
                    })
                    .collect(),
                _ => Vec::new(),
            };
            let text = if index == 0 {
                format!("{message}\n\n{detail}")
            } else {
                detail.to_string()
            };
            (
                name.clone(),
                Question {
                    id: name.clone(),
                    header: short(title),
                    question: text,
                    is_other: options.is_empty(),
                    options,
                },
                kind.to_string(),
            )
        })
        .collect()
}

fn typed(kind: &str, answer: &str) -> Value {
    match kind {
        "boolean" => Value::Bool(matches!(
            answer.trim().to_lowercase().as_str(),
            "yes" | "true" | "y" | "1"
        )),
        "integer" => answer
            .trim()
            .parse::<i64>()
            .map(Value::from)
            .unwrap_or_else(|_| Value::String(answer.into())),
        "number" => answer
            .trim()
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(answer.into())),
        _ => Value::String(answer.into()),
    }
}

pub(crate) async fn respond(askers: &Askers, request: ElicitRequestParams) -> ElicitResult {
    let decline = || ElicitResult::new(ElicitationAction::Decline);
    let ElicitRequestParams::FormElicitationParams {
        message,
        requested_schema,
        ..
    } = request
    else {
        return decline();
    };
    let Some((call_id, ui)) = askers.current() else {
        return decline();
    };
    let schema = serde_json::to_value(&requested_schema).unwrap_or(Value::Null);
    let fields = questions(&message, &schema);
    if fields.is_empty() {
        return decline();
    }
    let asked: Vec<Question> = fields.iter().map(|(_, q, _)| q.clone()).collect();
    let Some(answers) = ui.ask(call_id, asked).await else {
        return ElicitResult::new(ElicitationAction::Cancel);
    };
    let mut content = Map::new();
    for (name, _, kind) in fields {
        if let Some(answer) = answers
            .answers
            .get(&name)
            .and_then(|list| list.answers.first())
        {
            content.insert(name, typed(&kind, answer));
        }
    }
    let mut result = ElicitResult::new(ElicitationAction::Accept);
    result.content = Some(Value::Object(content));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_form_becomes_one_question_per_field_with_choices_for_enums_and_booleans() {
        let schema = json!({
            "type": "object",
            "properties": {
                "branch": {"type": "string", "description": "Which branch?", "enum": ["main", "dev"]},
                "force": {"type": "boolean"},
                "note": {"type": "string", "title": "Note"}
            }
        });
        let fields = questions("Deploying", &schema);
        assert_eq!(fields.len(), 3);
        let by_name = |n: &str| fields.iter().find(|(name, _, _)| name == n).unwrap();
        assert_eq!(by_name("branch").1.options.len(), 2);
        assert!(by_name("branch").1.question.starts_with("Deploying"));
        assert_eq!(by_name("force").1.options.len(), 2);
        assert!(by_name("note").1.is_other);
    }

    #[test]
    fn answers_take_the_type_the_form_asked_for() {
        assert_eq!(typed("boolean", "Yes"), Value::Bool(true));
        assert_eq!(typed("boolean", "no"), Value::Bool(false));
        assert_eq!(typed("integer", "7"), json!(7));
        assert_eq!(typed("string", "x"), json!("x"));
    }
}
