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
#![cfg_attr(not(test), feature(alloc_error_handler))]
#![cfg_attr(not(test), feature(core_intrinsics))]
#![allow(internal_features)]

extern crate alloc;

use alloc::string::String;
use casper_contract::contract_api::{account, runtime, system};
use casper_contract::unwrap_or_revert::UnwrapOrRevert;
use casper_types::contracts::ContractPackageHash;
use casper_types::{runtime_args, ApiError, URef, U512};

// Local copy of casper-contract's no-std helpers WITHOUT the redundant
// `#[no_mangle]` attributes that recent Rust nightlies reject. Using a
// minimal bump allocator instead of wee_alloc to avoid pulling that dep.

#[cfg(not(test))]
mod handlers {
    use core::alloc::{GlobalAlloc, Layout};

    /// Minimal bump allocator. Session WASMs are short-lived (single
    /// transaction) so we never need to free.
    struct BumpAlloc;

    const HEAP_SIZE: usize = 64 * 1024;
    static mut HEAP: [u8; HEAP_SIZE] = [0; HEAP_SIZE];
    static mut OFFSET: usize = 0;

    unsafe impl GlobalAlloc for BumpAlloc {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let align = layout.align();
            let size = layout.size();
            let aligned = (OFFSET + align - 1) & !(align - 1);
            if aligned + size > HEAP_SIZE {
                return core::ptr::null_mut();
            }
            OFFSET = aligned + size;
            (&raw mut HEAP).cast::<u8>().add(aligned)
        }
        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
    }

    #[global_allocator]
    static ALLOC: BumpAlloc = BumpAlloc;

    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        core::intrinsics::abort()
    }

    #[alloc_error_handler]
    fn oom(_: core::alloc::Layout) -> ! {
        core::intrinsics::abort()
    }
}

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
