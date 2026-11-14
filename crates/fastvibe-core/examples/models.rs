fn main() {
    match fastvibe_core::harness::discover_codex_models().recv_blocking() {
        Ok(Ok(models)) => {
            for m in models {
                println!("{} | {} | {:?}", m.id, m.label, m.reasoning);
            }
        }
        other => eprintln!("{other:?}"),
    }
}
