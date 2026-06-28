# PriestQuorum redeploy — toolchain blocker (v2 item)

## What's blocked

The working tree has a typed `ProposalKind::SettleProphecy { prophecy_id,
truth, source_value }` variant plus a convenience `propose_settle` entry
point. Both have unit tests and would replace the deployed contract's
generic `Custom { tag: "SettleProphecy", payload }` variant on cspr.live —
making the on-chain ABI self-documenting instead of requiring callers to
decode our private bytesrepr layout.

The deploy itself fails:

```
ExecutionError(ContractDeploymentError)
```

## Why

Two layers of incompatibility:

1. **Rust nightly emits bulk-memory ops by default.**
   Recent nightlies (anything after ~mid-2024) enable the `bulk-memory`
   target feature. The Casper testnet WASM interpreter at the current
   protocol (2.2.2) rejects `memory.copy` and `memory.fill` opcodes. Our
   `.cargo/config.toml` already opts out (`-C target-feature=-bulk-memory`),
   but the dep tree (specifically Odra's `casper-event-standard` /
   `casper-types`) still emits them via `core::ptr::copy_nonoverlapping`
   and friends that the compiler chooses to lower to bulk ops.

2. **wasm-opt 130 only partially lowers them.**
   `wasm-opt --llvm-memory-copy-fill-lowering` removes `memory.copy` but
   leaves `memory.fill` opcodes intact. So even after post-processing the
   binary still has unsupported ops.

Confirmed by binary inspection after `wasm-opt --enable-bulk-memory
--llvm-memory-copy-fill-lowering -Os`:

```
memory.copy bytes: False     # ← lowered ✓
memory.fill bytes: True      # ← still present ✗
```

## Three resolution paths

Listed in order of likely effort:

1. **Newer binaryen.** v131+ may add `memory.fill` lowering. Build from
   source or wait for a release.
2. **Older Rust nightly.** Pin `contracts/rust-toolchain` to a 2024-mid
   nightly (e.g. `nightly-2024-08-01`) that pre-dates the default-on
   `bulk-memory` flag. Trade-off: may not compile some newer dep versions.
3. **`wasm32v1-none` target.** If a recent `rustc` ships this, switching
   the contract crates' target avoids emitting unsupported ops at source.
   Needs `rustup target add` + investigation into Odra compat.

## Workaround in production

The contract deployed at
`cef55e4a11859d46562160105e2a04924feb8357951ed64abcc1cf553b31922f` uses the
generic `Custom { tag, payload }` variant. `packages/sdk/src/casper.ts`'s
`proposeSettlementOnChain` encodes the `(prophecy_id, truth, source_value)`
tuple as Odra `bytesrepr` and wraps it in the Custom variant. The
quorum-gated settle pipeline works end-to-end; the only difference vs. the
typed variant is what cspr.live displays for the `kind` field of the
ProposalCreated event payload.

The typed variant + entry-point unit tests (`propose_settle_round_trip`)
still pass under `cargo test`, so the source remains a drop-in replacement
once the toolchain unblocks.
