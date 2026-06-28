# wrap_cspr — session WASM

A single-deploy programmatic wrap of native CSPR into Wrapped CSPR. The
petitioner deploys this session WASM with `amount` + `wcspr_package_hash`
runtime args and it:

1. Creates a temporary purse via `system::create_purse()`
2. Transfers `amount` motes from the caller's main purse to the temporary purse
3. Calls `WCSPR.deposit(purse: URef)` with the temporary purse

That closes the last manual step in the petitioner demo flow — today the
petitioner needs `testnet.cspr.trade` to wrap CSPR → WCSPR via the UI before
x402 settlements can fire.

## Build

```sh
cd contracts
cargo +nightly-2026-01-01 build --release --target wasm32v1-none -p wrap_cspr
wasm-strip target/wasm32v1-none/release/wrap_cspr.wasm
```

The result is ~14 KB of pure MVP wasm (no bulk-memory, no sign-ext,
verified via `wasm-validate --disable-bulk-memory --disable-sign-extension
--disable-multi-value --disable-reference-types
--disable-saturating-float-to-int --disable-mutable-globals`).

## Why we wrote our own no-std handlers

`casper-contract` 5.1.1's `no_std_handlers.rs` puts redundant
`#[no_mangle]` attributes on `#[panic_handler]` and
`#[alloc_error_handler]`. Recent Rust nightlies reject this with:

```
error: `#[no_mangle]` cannot be used on internal language items
```

So the crate is depended on without the `no-std-helpers` feature, and
`src/main.rs` carries a minimal bump allocator plus its own panic /
alloc-error handlers.

## Deploy flow

`packages/petitioner/src/petition.ts` checks the petitioner's WCSPR
balance on startup. If it's below threshold, it does a `SessionBuilder`
deploy of `wrap_cspr.wasm` with:

- `wcspr_package_hash: ContractPackageHash`
- `amount: U512`

— fully autonomous; no manual `testnet.cspr.trade` step.
