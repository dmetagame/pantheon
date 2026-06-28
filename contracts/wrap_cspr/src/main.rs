//! Session WASM that wraps native CSPR into WCSPR in a single deploy.
//!
//! Runtime args:
//!   - `wcspr_package_hash: ContractPackageHash` — the WCSPR contract package
//!   - `amount: U512` — motes to wrap
//!
//! Flow:
//!   1. Read caller's main purse.
//!   2. Create a new temporary purse.
//!   3. Transfer `amount` from main purse to temporary purse.
//!   4. Call `WCSPR.deposit(purse: URef)` — the wcspr contract transfers
//!      from the temp purse to its own purse and mints WCSPR to the caller.

#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]

extern crate alloc;

use alloc::string::String;
use casper_contract::contract_api::{account, runtime, system};
use casper_contract::unwrap_or_revert::UnwrapOrRevert;
use casper_types::{runtime_args, ApiError, URef, U512};
use casper_types::contracts::ContractPackageHash;

// `casper-contract`'s `no-std-helpers` feature gives us the global
// WeeAlloc allocator + the panic handler so we don't have to wire either.

#[no_mangle]
pub extern "C" fn call() {
    let wcspr_package_hash: ContractPackageHash =
        runtime::get_named_arg("wcspr_package_hash");
    let amount: U512 = runtime::get_named_arg("amount");

    let source = account::get_main_purse();
    let temp: URef = system::create_purse();

    system::transfer_from_purse_to_purse(source, temp, amount, None)
        .unwrap_or_revert_with(ApiError::Transfer);

    let entry: String = String::from("deposit");
    runtime::call_versioned_contract::<()>(
        wcspr_package_hash,
        None,
        &entry,
        runtime_args! {
            "purse" => temp,
        },
    );
}
