# PriestQuorum redeploy — toolchain notes (resolved)

## What was blocked

The earlier "redeploy with typed `SettleProphecy` variant" attempt failed
because every WASM artifact built for the contracts contained
`bulk-memory` (`memory.copy` / `memory.fill`) and/or `sign-ext`
(`i32.extend8_s` etc.) opcodes that the Casper 2.x WASM interpreter
rejects.

`.cargo/config.toml` already passed `-C target-feature=-bulk-memory` for
`wasm32-unknown-unknown`, but two things defeated it:

1. **The pre-built sysroot.** `core` / `alloc` are shipped with
   bulk-memory enabled. LTO would inline `memset`/`memcpy` from them into
   the contract, reintroducing the unsupported ops.
2. **LLVM's `bulk-memory-opt` codegen flag.** Distinct from the
   spec-level `bulk-memory` feature; controls whether LLVM lowers
   `memset` → `memory.fill`. Disabling `bulk-memory` alone leaves it on.

## Resolution

Switched the contracts to the `wasm32v1-none` target plus a `[unstable]
build-std` block that recompiles `core` / `alloc` / `compiler_builtins`
with the same target-feature flags. See `contracts/.cargo/config.toml`.

Build invocation is now the same as before — `cargo build --release
--target wasm32v1-none -p <crate>` — and `cargo odra build -c <Contract>`
likewise uses the configured target.

Verification (with wabt 1.0.36's `wasm-validate` at strict MVP):

```
wasm-validate \
  --disable-bulk-memory --disable-sign-extension --disable-multi-value \
  --disable-reference-types --disable-saturating-float-to-int \
  --disable-mutable-globals \
  contracts/wasm/PriestQuorum.wasm
# exit 0
```

`wasm-objdump -d` shows zero post-MVP opcodes
(`memory.{copy,fill,init}`, `i32.extend{8,16}_s`, `i64.extend{8,16,32}_s`,
`table.{copy,init,fill}`).

## Status

Resolved at the toolchain level. The current source has the typed
`ProposalKind::SettleProphecy { prophecy_id, truth, source_value }` variant
+ a `propose_settle` convenience entry-point.

Production still defaults to the generic `Custom { tag: "SettleProphecy",
payload }` path because it is compatible with the deployed package and with
future typed contracts. The off-chain SDK calls `propose_settle` only when
`PRIEST_QUORUM_PROPOSE_MODE=typed` is set after a matching redeploy.

The current production package is
`2ed7015d8995208ccb0d68ff14a7fd3ba2495a54855cd3f4d42e42ebae64706e`.

## Prerequisites (one-time)

```sh
rustup install nightly-2026-01-01
rustup target add wasm32v1-none --toolchain nightly-2026-01-01
rustup component add rust-src --toolchain nightly-2026-01-01
```

The `rust-src` component is required by `build-std`.
