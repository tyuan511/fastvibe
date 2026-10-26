//! Shared models.dev decoder, deterministic fold, and live refresh service.
pub mod fold;
pub mod meta;
mod service;
pub use meta::{
    Catalog, CatalogStats, InputModality, ModelMeta, Price, PriceTier, default_context_window,
    default_meta, load_catalog,
};
pub use service::{CatalogService, CatalogUpdate, next_refresh_delay};
