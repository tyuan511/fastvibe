fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        eprintln!("usage: verify-native-update ARCHIVE VERSION");
        std::process::exit(2);
    }
    if let Err(error) = fv_update::verify_archive(std::path::Path::new(&args[0]), &args[1]) {
        eprintln!("native update archive rejected: {error}");
        std::process::exit(1);
    }
    println!("Native update archive passes the in-app installer checks");
}
