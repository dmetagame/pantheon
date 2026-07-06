# Changelog

Changelog for `pantheon_contracts`.

## [0.3.0] - 2026-06-28
### Added
- `priest_quorum::propose_settle(god_id, prophecy_id, truth, source_value)`
  convenience entry-point that wraps the SettleProphecy variant of
  `ProposalKind`. (Source path available; production defaults to the generic
  `Custom` variant unless `PRIEST_QUORUM_PROPOSE_MODE=typed` is enabled
  after a matching redeploy.)
- `ProposalKind::SettleProphecy { prophecy_id, truth, source_value }`
  typed variant (working tree only).
- `propose_settle_round_trip` unit test for the new variant.

### Notes
- 8/8 priest_quorum unit tests pass.
- 7/7 reputation unit tests pass.
- 3/3 prophecy unit tests pass.

## [0.2.0] - 2026-06-09
### Added
- `prophecy::ProphecyRegistry` deployed to testnet at
  `d1d0e57c20d6fbf477928a68d7c0395273ad492b26aa87715fe125be2388e6dd`.
- `reputation::Reputation` deployed to testnet at
  `7e07920bc99e415f89994a01534afa0a43172d727e2bacae9e864ef47310b1b2`.
- `priest_quorum::PriestQuorum` deployed to testnet at
  `cef55e4a11859d46562160105e2a04924feb8357951ed64abcc1cf553b31922f`
  initially; current production package is
  `2ed7015d8995208ccb0d68ff14a7fd3ba2495a54855cd3f4d42e42ebae64706e`.
- `pantheon_cli` deploy + scenario harness.

### Reputation
- EWMA Brier score per god, default `alpha = 500bp` (≈14-day half-life at
  daily cadence).
- Default miss penalty `500bp` per missed prophecy.
- Writer registry: `Reputation::set_writer` lets the registered
  `ProphecyRegistry` contract address record outcomes alongside admin.

### PriestQuorum
- Per-god `(god, priest)` priesthood pair.
- 72h default proposal TTL.
- `ProposalKind` enum with `WithdrawUsdc / LiquidateTemple /
  UpdateStrategy / Custom { tag, payload }` variants.

### Prophecy
- Per-god registered publisher (admin sets via `register_god`).
- Confidence enforced to `[5000, 10000]bp` (50–100%).
- Brier score computed on settle, range `0..=10000bp`.
- CES events: `ProphecyPublished`, `ProphecySettled`.

## [0.1.0] - 2026-06-07
### Added
- `flipper` and `flapper` modules — boilerplate Odra examples; removed
  before any real deploy.
