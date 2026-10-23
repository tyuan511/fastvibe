#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    /// `POST {base}/chat/completions`, and everything that imitates it.
    OpenAiChat,
    /// `POST {base}/responses`.
    OpenAiResponses,
    /// `POST {base}/messages`.
    Anthropic,
    /// `POST {base}/models/{model}:streamGenerateContent`.
    Google,
}

/// Thinking effort as the user picks it. There is deliberately no "off": asking an upstream to
/// disable thinking is rejected by models that reason by default, so "leave it alone" is
/// `None` on the config instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThinkingLevel {
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// Everything needed to call one model.
#[derive(Clone, Debug)]
pub struct ModelConfig {
    /// `provider/model`, recorded on every reply so signatures are only replayed to their author.
    pub label: String,
    /// The id the provider knows the model by.
    pub model_id: String,
    pub protocol: Protocol,
    /// As the user typed it; [`crate::engine_base_url`] turns it into what the protocol needs.
    pub base_url: String,
    pub api_key: String,
    pub thinking: Option<ThinkingLevel>,
    /// The output ceiling to ask for; the provider's own default when absent.
    pub max_output_tokens: Option<u32>,
    pub headers: Vec<(String, String)>,
    /// How many times a request that failed before producing anything is repeated.
    pub max_retries: u32,
    /// Whether the model can look at images. Without it, a picture a tool returns is replaced
    /// by a sentence, and `view_image` says it is not allowed.
    pub images: bool,
    /// The context window in tokens, when known; conversations are summarized before it fills.
    pub context_window: Option<u32>,
}

impl ModelConfig {
    pub fn new(
        label: &str,
        model_id: &str,
        protocol: Protocol,
        base_url: &str,
        api_key: &str,
    ) -> Self {
        Self {
            label: label.into(),
            model_id: model_id.into(),
            protocol,
            base_url: base_url.into(),
            api_key: api_key.into(),
            thinking: None,
            max_output_tokens: None,
            headers: Vec::new(),
            max_retries: 5,
            images: true,
            context_window: None,
        }
    }
}
