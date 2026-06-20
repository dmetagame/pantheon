//! Reputation — per-god rolling Brier accuracy with exponential decay.
//!
//! For each god we track an EWMA of Brier scores (basis points, lower is
//! better). At display time the public reputation is `10_000 - accuracy_bp`
//! so higher numbers look better to humans.
//!
//! Outcomes are recorded by either the admin (off-chain oracle worker) or
//! a registered writer contract (the ProphecyRegistry, once wired in
//! Days 7-8). Missed prophecies are recorded by the admin and slash the
//! reputation by `miss_penalty_bp`.

use odra::prelude::*;

const MAX_BP: u32 = 10_000;
const DEFAULT_ALPHA_BP: u32 = 500; // ~14-day half-life at daily cadence.
const DEFAULT_MISS_PENALTY_BP: u32 = 500;

#[odra::odra_error]
pub enum Error {
    NotAdmin = 1,
    NotAuthorizedWriter = 2,
    InvalidAlpha = 3,
    InvalidBrier = 4,
    NotInitialized = 5,
}

#[odra::odra_type]
pub struct GodReputation {
    /// EWMA of Brier scores in basis points. Lower = better.
    pub accuracy_bp: u32,
    pub prophecies_settled: u32,
    pub prophecies_missed: u32,
    pub last_updated: u64,
}

impl Default for GodReputation {
    fn default() -> Self {
        Self {
            accuracy_bp: 0,
            prophecies_settled: 0,
            prophecies_missed: 0,
            last_updated: 0,
        }
    }
}

#[odra::event]
pub struct OutcomeRecorded {
    pub god_id: String,
    pub brier_bp: u32,
    pub new_accuracy_bp: u32,
    pub prophecies_settled: u32,
}

#[odra::event]
pub struct ProphecyMissed {
    pub god_id: String,
    pub new_accuracy_bp: u32,
    pub prophecies_missed: u32,
}

#[odra::module]
pub struct Reputation {
    admin: Var<Address>,
    /// The ProphecyRegistry contract address — second authorized writer.
    writer: Var<Address>,
    reputations: Mapping<String, GodReputation>,
    alpha_bp: Var<u32>,
    miss_penalty_bp: Var<u32>,
}

#[odra::module]
impl Reputation {
    pub fn init(&mut self, admin: Address) {
        self.admin.set(admin);
        self.alpha_bp.set(DEFAULT_ALPHA_BP);
        self.miss_penalty_bp.set(DEFAULT_MISS_PENALTY_BP);
    }

    /// Register the ProphecyRegistry contract address as an authorized writer.
    pub fn set_writer(&mut self, writer: Address) {
        self.require_admin();
        self.writer.set(writer);
    }

    /// Adjust the EWMA blending factor in basis points (1..=10_000).
    pub fn set_alpha_bp(&mut self, alpha: u32) {
        self.require_admin();
        if alpha == 0 || alpha > MAX_BP {
            self.env().revert(Error::InvalidAlpha);
        }
        self.alpha_bp.set(alpha);
    }

    /// Adjust the per-miss penalty in basis points.
    pub fn set_miss_penalty_bp(&mut self, penalty: u32) {
        self.require_admin();
        if penalty > MAX_BP {
            self.env().revert(Error::InvalidAlpha);
        }
        self.miss_penalty_bp.set(penalty);
    }

    /// Record a settled outcome. Updates the god's EWMA accuracy.
    /// Callable by admin or the registered writer.
    pub fn record_outcome(&mut self, god_id: String, brier_bp: u32, settled_at: u64) {
        self.require_authorized_writer();
        if brier_bp > MAX_BP {
            self.env().revert(Error::InvalidBrier);
        }

        let alpha = self.alpha_bp.get_or_default();
        let mut rep = self.reputations.get(&god_id).unwrap_or_default();

        rep.accuracy_bp = if rep.prophecies_settled == 0 {
            brier_bp
        } else {
            ewma_bp(alpha, brier_bp, rep.accuracy_bp)
        };
        rep.prophecies_settled += 1;
        rep.last_updated = settled_at;

        let new_accuracy_bp = rep.accuracy_bp;
        let prophecies_settled = rep.prophecies_settled;
        self.reputations.set(&god_id, rep);

        self.env().emit_event(OutcomeRecorded {
            god_id,
            brier_bp,
            new_accuracy_bp,
            prophecies_settled,
        });
    }

    /// Slash the god's reputation for a prophecy that was never settled in time.
    pub fn record_miss(&mut self, god_id: String) {
        self.require_admin();
        let penalty = self.miss_penalty_bp.get_or_default();
        let mut rep = self.reputations.get(&god_id).unwrap_or_default();
        // A miss inflates accuracy_bp (worse score), saturating at MAX_BP.
        rep.accuracy_bp = rep.accuracy_bp.saturating_add(penalty).min(MAX_BP);
        rep.prophecies_missed += 1;
        rep.last_updated = self.env().get_block_time();

        let new_accuracy_bp = rep.accuracy_bp;
        let prophecies_missed = rep.prophecies_missed;
        self.reputations.set(&god_id, rep);

        self.env().emit_event(ProphecyMissed {
            god_id,
            new_accuracy_bp,
            prophecies_missed,
        });
    }

    /// Display reputation, 0..=10_000 bp where higher = better.
    pub fn reputation_bp(&self, god_id: String) -> u32 {
        let rep = self.reputations.get(&god_id).unwrap_or_default();
        MAX_BP - rep.accuracy_bp
    }

    pub fn get(&self, god_id: String) -> Option<GodReputation> {
        self.reputations.get(&god_id)
    }

    pub fn admin(&self) -> Address {
        self.admin
            .get()
            .unwrap_or_else(|| self.env().revert(Error::NotInitialized))
    }

    pub fn writer(&self) -> Option<Address> {
        self.writer.get()
    }

    fn require_admin(&self) {
        let admin = self
            .admin
            .get()
            .unwrap_or_else(|| self.env().revert(Error::NotInitialized));
        if self.env().caller() != admin {
            self.env().revert(Error::NotAdmin);
        }
    }

    fn require_authorized_writer(&self) {
        let caller = self.env().caller();
        let admin = self
            .admin
            .get()
            .unwrap_or_else(|| self.env().revert(Error::NotInitialized));
        if caller == admin {
            return;
        }
        if let Some(writer) = self.writer.get() {
            if caller == writer {
                return;
            }
        }
        self.env().revert(Error::NotAuthorizedWriter);
    }
}

/// EWMA in basis points: `alpha * sample + (1 - alpha) * prior`, all in bp.
fn ewma_bp(alpha_bp: u32, sample_bp: u32, prior_bp: u32) -> u32 {
    let a = alpha_bp as u64;
    let s = sample_bp as u64;
    let p = prior_bp as u64;
    let inv = MAX_BP as u64 - a;
    ((a * s + inv * p) / MAX_BP as u64) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::Deployer;

    fn deploy() -> (odra::host::HostEnv, ReputationHostRef, Address) {
        let env = odra_test::env();
        let admin = env.get_account(0);
        env.set_caller(admin);
        let reputation = Reputation::deploy(&env, ReputationInitArgs { admin });
        (env, reputation, admin)
    }

    #[test]
    fn first_outcome_seeds_accuracy() {
        let (_env, mut reputation, _admin) = deploy();
        reputation.record_outcome("demeter".to_string(), 400, 1_700_000_000);
        let rep = reputation.get("demeter".to_string()).unwrap();
        assert_eq!(rep.accuracy_bp, 400);
        assert_eq!(rep.prophecies_settled, 1);
        // Display = 10_000 - 400 = 9_600 bp = 96%.
        assert_eq!(reputation.reputation_bp("demeter".to_string()), 9_600);
    }

    #[test]
    fn second_outcome_blends_via_ewma() {
        let (_env, mut reputation, _admin) = deploy();
        // Default alpha = 500 bp (5%).
        reputation.record_outcome("demeter".to_string(), 400, 1);
        reputation.record_outcome("demeter".to_string(), 6_400, 2);
        // EWMA: 0.05 * 6400 + 0.95 * 400 = 320 + 380 = 700.
        let rep = reputation.get("demeter".to_string()).unwrap();
        assert_eq!(rep.accuracy_bp, 700);
        assert_eq!(rep.prophecies_settled, 2);
    }

    #[test]
    fn miss_inflates_accuracy() {
        let (_env, mut reputation, _admin) = deploy();
        reputation.record_outcome("demeter".to_string(), 400, 1);
        reputation.record_miss("demeter".to_string());
        let rep = reputation.get("demeter".to_string()).unwrap();
        // 400 + 500 penalty = 900.
        assert_eq!(rep.accuracy_bp, 900);
        assert_eq!(rep.prophecies_missed, 1);
    }

    #[test]
    fn miss_saturates_at_max() {
        let (_env, mut reputation, _admin) = deploy();
        reputation.record_outcome("demeter".to_string(), 9_800, 1);
        reputation.record_miss("demeter".to_string());
        let rep = reputation.get("demeter".to_string()).unwrap();
        assert_eq!(rep.accuracy_bp, 10_000);
    }

    #[test]
    fn writer_can_record_outcome() {
        let (env, mut reputation, _admin) = deploy();
        let writer = env.get_account(1);
        reputation.set_writer(writer);

        env.set_caller(writer);
        reputation.record_outcome("demeter".to_string(), 400, 1);
        assert_eq!(
            reputation.reputation_bp("demeter".to_string()),
            9_600
        );
    }

    #[test]
    fn non_writer_cannot_record_outcome() {
        let (env, mut reputation, _admin) = deploy();
        let rando = env.get_account(2);
        env.set_caller(rando);
        let result = reputation.try_record_outcome("demeter".to_string(), 400, 1);
        assert!(result.is_err());
    }

    #[test]
    fn invalid_brier_reverts() {
        let (_env, mut reputation, _admin) = deploy();
        let result =
            reputation.try_record_outcome("demeter".to_string(), 20_000, 1);
        assert!(result.is_err());
    }

    #[test]
    fn invalid_alpha_reverts() {
        let (_env, mut reputation, _admin) = deploy();
        assert!(reputation.try_set_alpha_bp(0).is_err());
        assert!(reputation.try_set_alpha_bp(20_000).is_err());
        assert!(reputation.try_set_alpha_bp(1_000).is_ok());
    }
}
