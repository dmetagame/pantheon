# wrap_cspr — session WASM (v2, blocked)

A single-deploy programmatic wrap of native CSPR into Wrapped CSPR. The
petitioner would deploy this session WASM with `amount` + `wcspr_package_hash`
runtime args and it would:

1. Create a temporary purse via `system::create_purse()`
2. Transfer `amount` motes from the caller's main purse to the temporary purse
3. Call `WCSPR.deposit(purse: URef)` with the temporary purse

That closes the only remaining manual step in the petitioner demo flow
(today the petitioner needs `testnet.cspr.trade` to wrap CSPR → WCSPR via
the UI before x402 settlements can fire).

## Status: blocked on Rust nightly toolchain

`cargo build --release --target wasm32-unknown-unknown -p wrap_cspr`
currently fails inside `casper-contract` 5.1's `no_std_handlers.rs`:

```
error: `#[no_mangle]` cannot be used on internal language items
 --> casper-contract-5.1.1/src/no_std_handlers.rs:5:1
  |
5 | #[no_mangle]
  | ^^^^^^^^^^^^
```

This is the same class of Rust-nightly / wasm-target incompatibility that
blocks the PriestQuorum redeploy with the typed `SettleProphecy` variant.
Resolution paths (in order of effort):

1. Try an older nightly (e.g. `nightly-2025-09-01`) where
   `casper-contract`'s `no_mangle`-on-`rust_begin_unwind` still compiled.
2. Patch `casper-contract` locally to use the new
   `#[lang = "panic_impl"]` form.
3. Switch the contract dep to a community-maintained fork that's already
   patched.

The session source in `src/main.rs` is otherwise complete; once the
toolchain issue resolves, the path forward is:

1. `cargo build --release --target wasm32-unknown-unknown -p wrap_cspr`
2. `wasm-strip target/wasm32-unknown-unknown/release/wrap_cspr.wasm`
3. Petitioner CLI does a `SessionBuilder` deploy with the stripped WASM
   passing `amount: U512` + `wcspr_package_hash: ContractPackageHash`.

`packages/petitioner/src/petition.ts` would then check the petitioner's
WCSPR balance on startup and run a wrap if it's below threshold — fully
autonomous demo, no manual step.
