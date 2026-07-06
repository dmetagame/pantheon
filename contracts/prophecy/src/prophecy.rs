//! Prophecy — on-chain record of every god's binary prediction.
//!
//! Each prophecy is a (claim, confidence) pair settled later by the
//! admin oracle. The Brier score, computed at settle time, is the
//! foundation of the Reputation system.

use odra::casper_types::bytesrepr::Bytes;
use odra::prelude::*;

/// Confidence is expressed in basis points: 5000..=10000 (i.e. 50%..=100%).
const MIN_CONFIDENCE_BP: u32 = 5000;
const MAX_CONFIDENCE_BP: u32 = 10000;

#[odra::odra_error]
pub enum Error {
    NotAdmin = 1,
    NotRegisteredPublisher = 2,
    ConfidenceOutOfRange = 3,
    ProphecyNotFound = 4,
    AlreadySettled = 5,
    NotInitialized = 6,
    SettlementTooEarly = 7,
}

#[odra::odra_type]
pub struct Prophecy {
    pub god_id: String,
    pub question_hash: Bytes,
    pub claim: bool,
    pub confidence_bp: u32,
    pub published_at: u64,
    pub settles_at: u64,
    pub oracle_source: String,
    pub publisher: Address,
}

#[odra::odra_type]
pub struct Outcome {
    pub truth: bool,
    pub brier_bp: u32,
    pub settled_at: u64,
    pub source_value: String,
}

#[odra::event]
pub struct ProphecyPublished {
    pub id: u64,
    pub god_id: String,
    pub claim: bool,
    pub confidence_bp: u32,
    pub settles_at: u64,
}

#[odra::event]
pub struct ProphecySettled {
    pub id: u64,
    pub god_id: String,
    pub truth: bool,
    pub brier_bp: u32,
}

#[odra::module]
pub struct ProphecyRegistry {
    admin: Var<Address>,
    next_id: Var<u64>,
    prophecies: Mapping<u64, Prophecy>,
    outcomes: Mapping<u64, Outcome>,
    publishers: Mapping<String, Address>,
}

#[odra::module]
impl ProphecyRegistry {
    pub fn init(&mut self, admin: Address) {
        self.admin.set(admin);
        self.next_id.set(0);
    }

    /// Admin registers which address may publish prophecies for a god.
    pub fn register_god(&mut self, god_id: String, publisher: Address) {
        self.require_admin();
        self.publishers.set(&god_id, publisher);
    }

    pub fn publisher_of(&self, god_id: String) -> Option<Address> {
        self.publishers.get(&god_id)
    }

    /// Publish a prophecy. Caller must be the registered publisher for the god.
    pub fn publish(
        &mut self,
        god_id: String,
        question_hash: Bytes,
        claim: bool,
        confidence_bp: u32,
        settles_at: u64,
        oracle_source: String,
    ) -> u64 {
        if confidence_bp < MIN_CONFIDENCE_BP || confidence_bp > MAX_CONFIDENCE_BP {
            self.env().revert(Error::ConfidenceOutOfRange);
        }

        let caller = self.env().caller();
        let expected = self
            .publishers
            .get(&god_id)
            .unwrap_or_else(|| self.env().revert(Error::NotRegisteredPublisher));
        if caller != expected {
            self.env().revert(Error::NotRegisteredPublisher);
        }

        let id = self.next_id.get_or_default();
        let prophecy = Prophecy {
            god_id: god_id.clone(),
            question_hash,
            claim,
            confidence_bp,
            published_at: self.env().get_block_time(),
            settles_at,
            oracle_source,
            publisher: caller,
        };
        self.prophecies.set(&id, prophecy);
        self.next_id.set(id + 1);

        self.env().emit_event(ProphecyPublished {
            id,
            god_id,
            claim,
            confidence_bp,
            settles_at,
        });

        id
    }

    /// Admin settles a prophecy with the observed truth + a human-readable source value.
    pub fn settle(&mut self, id: u64, truth: bool, source_value: String) {
        self.require_admin();

        if self.outcomes.get(&id).is_some() {
            self.env().revert(Error::AlreadySettled);
        }

        let prophecy = self
            .prophecies
            .get(&id)
            .unwrap_or_else(|| self.env().revert(Error::ProphecyNotFound));
        if self.env().get_block_time() < prophecy.settles_at {
            self.env().revert(Error::SettlementTooEarly);
        }

        let brier_bp = brier_basis_points(prophecy.claim, prophecy.confidence_bp, truth);

        self.outcomes.set(
            &id,
            Outcome {
                truth,
                brier_bp,
                settled_at: self.env().get_block_time(),
                source_value,
            },
        );

        self.env().emit_event(ProphecySettled {
            id,
            god_id: prophecy.god_id,
            truth,
            brier_bp,
        });
    }

    pub fn get_prophecy(&self, id: u64) -> Option<Prophecy> {
        self.prophecies.get(&id)
    }

    pub fn get_outcome(&self, id: u64) -> Option<Outcome> {
        self.outcomes.get(&id)
    }

    pub fn next_id(&self) -> u64 {
        self.next_id.get_or_default()
    }

    pub fn admin(&self) -> Address {
        self.admin
            .get()
            .unwrap_or_else(|| self.env().revert(Error::NotInitialized))
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
}

/// Brier score in basis points (0 = perfect, 10000 = maximally wrong).
///
/// If the god predicted `claim` with `confidence_bp` probability and the
/// truth is `truth`, the probability the god assigned to the truth is:
/// - `confidence_bp`             when claim == truth
/// - `10000 - confidence_bp`     when claim != truth
///
/// Brier = (1 - p_truth)^2, scaled to basis points.
fn brier_basis_points(claim: bool, confidence_bp: u32, truth: bool) -> u32 {
    let p_truth_bp = if claim == truth {
        confidence_bp
    } else {
        10_000u32 - confidence_bp
    };
    let diff = 10_000u32 - p_truth_bp;
    ((diff as u64 * diff as u64) / 10_000) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::Deployer;

    #[test]
    fn admin_registers_publisher_and_god_publishes() {
        let env = odra_test::env();
        let admin = env.get_account(0);
        env.set_caller(admin);
        let mut registry = ProphecyRegistry::deploy(&env, ProphecyRegistryInitArgs { admin });

        let god_account = env.get_account(1);
        registry.register_god("demeter".to_string(), god_account);

        env.set_caller(god_account);
        let id = registry.publish(
            "demeter".to_string(),
            Bytes::from(vec![0u8; 32]),
            true,
            7500,
            env.block_time() + 86_400_000,
            "cspr.cloud/tvl".to_string(),
        );
        assert_eq!(id, 0);
        let p = registry.get_prophecy(0).unwrap();
        assert_eq!(p.god_id, "demeter");
        assert_eq!(p.confidence_bp, 7500);
    }

    #[test]
    fn settle_computes_brier() {
        let env = odra_test::env();
        let admin = env.get_account(0);
        env.set_caller(admin);
        let mut registry = ProphecyRegistry::deploy(&env, ProphecyRegistryInitArgs { admin });

        let god_account = env.get_account(1);
        registry.register_god("demeter".to_string(), god_account);

        env.set_caller(god_account);
        let settles_at = env.block_time() + 86_400_000;
        let id = registry.publish(
            "demeter".to_string(),
            Bytes::from(vec![1u8; 32]),
            true,
            8000,
            settles_at,
            "cspr.cloud/tvl".to_string(),
        );

        env.set_caller(admin);
        env.advance_block_time(settles_at - env.block_time());
        registry.settle(id, true, "TVL up 12%".to_string());
        let outcome = registry.get_outcome(id).unwrap();
        // Predicted yes with 80% conf, truth yes → p_truth=0.8 → brier=(0.2)² = 0.04 → 400 bp.
        assert_eq!(outcome.brier_bp, 400);
        assert!(outcome.truth);
    }

    #[test]
    fn early_settle_reverts() {
        let env = odra_test::env();
        let admin = env.get_account(0);
        env.set_caller(admin);
        let mut registry = ProphecyRegistry::deploy(&env, ProphecyRegistryInitArgs { admin });

        let god_account = env.get_account(1);
        registry.register_god("demeter".to_string(), god_account);

        env.set_caller(god_account);
        let id = registry.publish(
            "demeter".to_string(),
            Bytes::from(vec![1u8; 32]),
            true,
            8000,
            env.block_time() + 86_400_000,
            "cspr.cloud/tvl".to_string(),
        );

        env.set_caller(admin);
        let result = registry.try_settle(id, true, "TVL up 12%".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn confidence_out_of_range_reverts() {
        let env = odra_test::env();
        let admin = env.get_account(0);
        env.set_caller(admin);
        let mut registry = ProphecyRegistry::deploy(&env, ProphecyRegistryInitArgs { admin });

        let god_account = env.get_account(1);
        registry.register_god("demeter".to_string(), god_account);

        env.set_caller(god_account);
        let result = registry.try_publish(
            "demeter".to_string(),
            Bytes::from(vec![0u8; 32]),
            true,
            4000,
            env.block_time() + 86_400_000,
            "cspr.cloud/tvl".to_string(),
        );
        assert!(result.is_err());
    }
}
