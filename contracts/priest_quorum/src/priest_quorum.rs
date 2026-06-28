//! PriestQuorum — god + priest co-signing for Temple actions.
//!
//! Each god has a priesthood pair: the god's autonomous Casper account
//! and an elected human priest's account. Sensitive Temple actions
//! (worshipper payouts, liquidations, strategy upgrades) require both
//! addresses to approve a proposal before it can execute.
//!
//! Below-threshold actions on a Temple bypass the quorum entirely — those
//! are gated on the Temple side. The PriestQuorum exists for the moments
//! that matter.
//!
//! Execution emits a `ProposalExecuted` event; the Temple contract (or
//! the off-chain agent operator) acts on it. In Days 9–10 this is upgraded
//! to a direct cross-contract call into Temple via Odra's ContractRef.

use odra::prelude::*;
use odra::casper_types::bytesrepr::Bytes;

const DEFAULT_TTL_MS: u64 = 72 * 3_600 * 1_000; // 72 hours

#[odra::odra_error]
pub enum Error {
    NotAdmin = 1,
    NoPriesthoodForGod = 2,
    NotPriesthood = 3,
    ProposalNotFound = 4,
    ProposalExpired = 5,
    AlreadyExecuted = 6,
    QuorumNotMet = 7,
    NotInitialized = 8,
    InvalidTtl = 9,
}

#[odra::odra_type]
pub enum ProposalKind {
    /// Pay out worshipper distributions from the Temple to a recipient (epoch close).
    WithdrawUsdc { recipient: Address, amount: u64 },
    /// Initiate full Temple liquidation (e.g., post-exile).
    LiquidateTemple,
    /// Upgrade the god's strategy pointer (URI to a new Odra module or strategy spec).
    UpdateStrategy { uri: String },
    /// Reserved generic payload for forward-compat.
    Custom { tag: String, payload: Bytes },
    /// Settle a prophecy with a god-asserted truth + the oracle reading that
    /// backs it. Off-chain orchestrator picks this up and calls
    /// `ProphecyRegistry.settle(prophecy_id, truth, source_value)` once the
    /// priest co-signs. `source_value` is the human-readable oracle reading
    /// (e.g. `"0.9994 USDC"`); the truth bit is what's reputation-binding.
    SettleProphecy {
        prophecy_id: u64,
        truth: bool,
        source_value: String,
    },
}

#[odra::odra_type]
pub struct PriesthoodPair {
    pub god: Address,
    pub priest: Address,
}

#[odra::odra_type]
pub struct Proposal {
    pub god_id: String,
    pub kind: ProposalKind,
    pub proposer: Address,
    pub created_at: u64,
    pub expires_at: u64,
    pub god_approved: bool,
    pub priest_approved: bool,
    pub executed: bool,
}

#[odra::event]
pub struct PriesthoodSet {
    pub god_id: String,
    pub god: Address,
    pub priest: Address,
}

#[odra::event]
pub struct ProposalCreated {
    pub id: u64,
    pub god_id: String,
    pub proposer: Address,
    pub expires_at: u64,
}

#[odra::event]
pub struct ProposalApproved {
    pub id: u64,
    pub approver: Address,
}

#[odra::event]
pub struct ProposalExecuted {
    pub id: u64,
    pub god_id: String,
}

#[odra::module]
pub struct PriestQuorum {
    admin: Var<Address>,
    pairs: Mapping<String, PriesthoodPair>,
    next_id: Var<u64>,
    proposals: Mapping<u64, Proposal>,
    default_ttl_ms: Var<u64>,
}

#[odra::module]
impl PriestQuorum {
    pub fn init(&mut self, admin: Address) {
        self.admin.set(admin);
        self.next_id.set(0);
        self.default_ttl_ms.set(DEFAULT_TTL_MS);
    }

    /// Admin sets the (god, priest) pair authorized for a god_id.
    /// Re-setting overrides — used after a community priest re-election.
    pub fn set_priesthood(&mut self, god_id: String, god: Address, priest: Address) {
        self.require_admin();
        self.pairs.set(
            &god_id,
            PriesthoodPair {
                god,
                priest,
            },
        );
        self.env().emit_event(PriesthoodSet {
            god_id,
            god,
            priest,
        });
    }

    /// Admin can tune proposal TTL (in milliseconds).
    pub fn set_default_ttl_ms(&mut self, ttl: u64) {
        self.require_admin();
        if ttl == 0 {
            self.env().revert(Error::InvalidTtl);
        }
        self.default_ttl_ms.set(ttl);
    }

    /// Convenience entry-point for the most common case: a god proposing a
    /// prophecy settlement. Constructs `ProposalKind::SettleProphecy { … }`
    /// and forwards to `propose`, so the caller doesn't need to hand-encode
    /// the variant as bytes. Same auth + return semantics as `propose`.
    pub fn propose_settle(
        &mut self,
        god_id: String,
        prophecy_id: u64,
        truth: bool,
        source_value: String,
    ) -> u64 {
        self.propose(
            god_id,
            ProposalKind::SettleProphecy {
                prophecy_id,
                truth,
                source_value,
            },
        )
    }

    /// God or priest proposes an action. The proposer's slot is auto-approved.
    /// Returns the new proposal id.
    pub fn propose(&mut self, god_id: String, kind: ProposalKind) -> u64 {
        let pair = self
            .pairs
            .get(&god_id)
            .unwrap_or_else(|| self.env().revert(Error::NoPriesthoodForGod));

        let caller = self.env().caller();
        let is_god = caller == pair.god;
        let is_priest = caller == pair.priest;
        if !is_god && !is_priest {
            self.env().revert(Error::NotPriesthood);
        }

        let id = self.next_id.get_or_default();
        let now = self.env().get_block_time();
        let ttl = self.default_ttl_ms.get_or_default();

        let proposal = Proposal {
            god_id: god_id.clone(),
            kind,
            proposer: caller,
            created_at: now,
            expires_at: now + ttl,
            god_approved: is_god,
            priest_approved: is_priest,
            executed: false,
        };
        self.proposals.set(&id, proposal);
        self.next_id.set(id + 1);

        self.env().emit_event(ProposalCreated {
            id,
            god_id,
            proposer: caller,
            expires_at: now + ttl,
        });
        id
    }

    /// The other party signs off on a pending proposal.
    pub fn approve(&mut self, proposal_id: u64) {
        let mut p = self
            .proposals
            .get(&proposal_id)
            .unwrap_or_else(|| self.env().revert(Error::ProposalNotFound));
        if p.executed {
            self.env().revert(Error::AlreadyExecuted);
        }
        if self.env().get_block_time() >= p.expires_at {
            self.env().revert(Error::ProposalExpired);
        }

        let pair = self
            .pairs
            .get(&p.god_id)
            .unwrap_or_else(|| self.env().revert(Error::NoPriesthoodForGod));
        let caller = self.env().caller();

        if caller == pair.god {
            p.god_approved = true;
        } else if caller == pair.priest {
            p.priest_approved = true;
        } else {
            self.env().revert(Error::NotPriesthood);
        }

        self.proposals.set(&proposal_id, p);
        self.env().emit_event(ProposalApproved {
            id: proposal_id,
            approver: caller,
        });
    }

    /// Anyone may flip a fully-approved, unexpired proposal into the
    /// `executed` state. Subscribers (Temple contract, off-chain agent)
    /// pick up the event and apply the action.
    pub fn execute(&mut self, proposal_id: u64) {
        let mut p = self
            .proposals
            .get(&proposal_id)
            .unwrap_or_else(|| self.env().revert(Error::ProposalNotFound));
        if p.executed {
            self.env().revert(Error::AlreadyExecuted);
        }
        if self.env().get_block_time() >= p.expires_at {
            self.env().revert(Error::ProposalExpired);
        }
        if !(p.god_approved && p.priest_approved) {
            self.env().revert(Error::QuorumNotMet);
        }

        p.executed = true;
        let god_id = p.god_id.clone();
        self.proposals.set(&proposal_id, p);

        self.env().emit_event(ProposalExecuted {
            id: proposal_id,
            god_id,
        });
    }

    pub fn priesthood_of(&self, god_id: String) -> Option<PriesthoodPair> {
        self.pairs.get(&god_id)
    }

    pub fn get_proposal(&self, id: u64) -> Option<Proposal> {
        self.proposals.get(&id)
    }

    pub fn next_id(&self) -> u64 {
        self.next_id.get_or_default()
    }

    pub fn default_ttl_ms(&self) -> u64 {
        self.default_ttl_ms.get_or_default()
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

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::Deployer;

    fn setup() -> (
        odra::host::HostEnv,
        PriestQuorumHostRef,
        Address,
        Address,
        Address,
    ) {
        let env = odra_test::env();
        let admin = env.get_account(0);
        let god = env.get_account(1);
        let priest = env.get_account(2);
        env.set_caller(admin);
        let mut q = PriestQuorum::deploy(&env, PriestQuorumInitArgs { admin });
        q.set_priesthood("demeter".to_string(), god, priest);
        (env, q, god, priest, admin)
    }

    #[test]
    fn god_proposes_priest_approves_anyone_executes() {
        let (env, mut q, god, priest, _) = setup();

        env.set_caller(god);
        let id = q.propose(
            "demeter".to_string(),
            ProposalKind::WithdrawUsdc {
                recipient: env.get_account(3),
                amount: 1_000_000,
            },
        );
        let p = q.get_proposal(id).unwrap();
        assert!(p.god_approved);
        assert!(!p.priest_approved);

        env.set_caller(priest);
        q.approve(id);
        let p = q.get_proposal(id).unwrap();
        assert!(p.priest_approved);

        // Anyone (here, admin) can execute once both parties have signed.
        env.set_caller(env.get_account(0));
        q.execute(id);
        let p = q.get_proposal(id).unwrap();
        assert!(p.executed);
    }

    #[test]
    fn priest_proposes_god_approves() {
        let (env, mut q, god, priest, _) = setup();
        env.set_caller(priest);
        let id = q.propose("demeter".to_string(), ProposalKind::LiquidateTemple);
        let p = q.get_proposal(id).unwrap();
        assert!(!p.god_approved);
        assert!(p.priest_approved);
        env.set_caller(god);
        q.approve(id);
        let p = q.get_proposal(id).unwrap();
        assert!(p.god_approved && p.priest_approved);
    }

    #[test]
    fn outsider_cannot_propose() {
        let (env, mut q, _, _, _) = setup();
        env.set_caller(env.get_account(4));
        let res = q.try_propose(
            "demeter".to_string(),
            ProposalKind::LiquidateTemple,
        );
        assert!(res.is_err());
    }

    #[test]
    fn execute_without_quorum_reverts() {
        let (env, mut q, god, _, _) = setup();
        env.set_caller(god);
        let id = q.propose("demeter".to_string(), ProposalKind::LiquidateTemple);
        env.set_caller(env.get_account(0));
        let res = q.try_execute(id);
        assert!(res.is_err());
    }

    #[test]
    fn double_execute_reverts() {
        let (env, mut q, god, priest, _) = setup();
        env.set_caller(god);
        let id = q.propose("demeter".to_string(), ProposalKind::LiquidateTemple);
        env.set_caller(priest);
        q.approve(id);
        env.set_caller(env.get_account(0));
        q.execute(id);
        let res = q.try_execute(id);
        assert!(res.is_err());
    }

    #[test]
    fn expired_proposal_cannot_be_approved_or_executed() {
        let (env, mut q, god, priest, _) = setup();
        env.set_caller(env.get_account(0));
        q.set_default_ttl_ms(1_000); // 1 second TTL

        env.set_caller(god);
        let id = q.propose("demeter".to_string(), ProposalKind::LiquidateTemple);

        env.advance_block_time(2_000);

        env.set_caller(priest);
        let res = q.try_approve(id);
        assert!(res.is_err());
    }

    #[test]
    fn propose_settle_round_trip() {
        let (env, mut q, god, priest, _) = setup();

        env.set_caller(god);
        let id = q.propose_settle(
            "demeter".to_string(),
            42,
            true,
            "0.9994 USDC".to_string(),
        );

        let p = q.get_proposal(id).unwrap();
        assert!(p.god_approved);
        assert!(!p.priest_approved);
        match p.kind {
            ProposalKind::SettleProphecy {
                prophecy_id,
                truth,
                source_value,
            } => {
                assert_eq!(prophecy_id, 42);
                assert!(truth);
                assert_eq!(source_value, "0.9994 USDC".to_string());
            }
            _ => panic!("expected SettleProphecy variant"),
        }

        env.set_caller(priest);
        q.approve(id);
        env.set_caller(env.get_account(0));
        q.execute(id);
        let p = q.get_proposal(id).unwrap();
        assert!(p.executed);
    }

    #[test]
    fn propose_settle_outsider_reverts() {
        let (env, mut q, _, _, _) = setup();
        env.set_caller(env.get_account(4));
        let res = q.try_propose_settle(
            "demeter".to_string(),
            1,
            false,
            "n/a".to_string(),
        );
        assert!(res.is_err());
    }

    #[test]
    fn priesthood_reassignment_works() {
        let (env, mut q, god, _priest, admin) = setup();
        let new_priest = env.get_account(5);
        env.set_caller(admin);
        q.set_priesthood("demeter".to_string(), god, new_priest);

        env.set_caller(god);
        let id = q.propose("demeter".to_string(), ProposalKind::LiquidateTemple);
        env.set_caller(new_priest);
        q.approve(id);
        let p = q.get_proposal(id).unwrap();
        assert!(p.god_approved && p.priest_approved);
    }
}
