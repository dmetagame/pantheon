//! Pantheon CLI — deploys ProphecyRegistry + Reputation and exposes scripted scenarios.

use odra::host::HostEnv;
use odra_cli::{
    deploy::DeployScript, DeployedContractsContainer, DeployerExt, OdraCli,
};
use priest_quorum::priest_quorum::{PriestQuorum, PriestQuorumInitArgs};
use prophecy::prophecy::{ProphecyRegistry, ProphecyRegistryInitArgs};
use reputation::reputation::{Reputation, ReputationInitArgs};

pub struct ContractsDeployScript;

impl DeployScript for ContractsDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        let admin = env.caller();
        let _ = ProphecyRegistry::load_or_deploy(
            env,
            ProphecyRegistryInitArgs { admin },
            container,
            500_000_000_000,
        )?;
        let _ = Reputation::load_or_deploy(
            env,
            ReputationInitArgs { admin },
            container,
            500_000_000_000,
        )?;
        let _ = PriestQuorum::load_or_deploy(
            env,
            PriestQuorumInitArgs { admin },
            container,
            500_000_000_000,
        )?;
        Ok(())
    }
}

pub fn main() {
    OdraCli::new()
        .about("Pantheon — CLI for the on-chain agentic-AI marketplace")
        .deploy(ContractsDeployScript)
        .contract::<ProphecyRegistry>()
        .contract::<Reputation>()
        .contract::<PriestQuorum>()
        .build()
        .run();
}
