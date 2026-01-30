use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::CreatePermissionCpiBuilder;
use ephemeral_rollups_sdk::access_control::structs::{Member, MembersArgs};
use ephemeral_rollups_sdk::anchor::{delegate, ephemeral};
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use inco_lightning::cpi::accounts::Operation;
use inco_lightning::cpi::{as_euint128, e_add, e_ge, e_mul, e_select, e_sub, new_euint128};
use inco_lightning::types::{Ebool, Euint128};
use inco_lightning::ID as INCO_LIGHTNING_ID;
use light_sdk::{
    account::LightAccount,
    address::v2::derive_address,
    cpi::v2::{CpiAccounts, LightSystemProgramCpi},
    cpi::{InvokeLightSystemProgram, LightCpiInstruction},
    derive_light_cpi_signer,
    instruction::{PackedAddressTreeInfo, PackedAddressTreeInfoExt, ValidityProof as SdkValidityProof},
    CpiSigner, LightDiscriminator,
};

declare_id!("4b8jCufu7b4WKXdxFRQHWSks4QdskW62qF7tApSNXuZD");

pub const LIGHT_CPI_SIGNER: CpiSigner =
    derive_light_cpi_signer!("4b8jCufu7b4WKXdxFRQHWSks4QdskW62qF7tApSNXuZD");

const POOL_AUTH_SEED: &[u8] = b"pool_authority";
const SCALAR_BYTE: u8 = 0;

/// Compute encrypted swap updates using Inco Lightning FHE operations
#[inline(never)]
fn compute_swap_updates<'info>(
    inco_program: &AccountInfo<'info>,
    signer: &AccountInfo<'info>,
    reserve_in: Euint128,
    reserve_out: Euint128,
    protocol_fee_in: Euint128,
    amount_in_ciphertext: &[u8],
    amount_out_ciphertext: &[u8],
    fee_amount_ciphertext: &[u8],
    input_type: u8,
) -> Result<(Euint128, Euint128, Euint128)> {
    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    let mut amount_in = new_euint128(cpi_ctx, amount_in_ciphertext.to_vec(), input_type)?;

    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    let mut amount_out = new_euint128(cpi_ctx, amount_out_ciphertext.to_vec(), input_type)?;

    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    let mut fee_amount = new_euint128(cpi_ctx, fee_amount_ciphertext.to_vec(), input_type)?;

    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    let zero = as_euint128(cpi_ctx, 0)?;

    // Check liquidity: reserve_out >= amount_out
    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    let has_liquidity: Ebool = e_ge(cpi_ctx, reserve_out, amount_out, SCALAR_BYTE)?;

    // Zero out amounts if no liquidity
    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    amount_in = e_select(cpi_ctx, has_liquidity, amount_in, zero, SCALAR_BYTE)?;

    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    amount_out = e_select(cpi_ctx, has_liquidity, amount_out, zero, SCALAR_BYTE)?;

    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    fee_amount = e_select(cpi_ctx, has_liquidity, fee_amount, zero, SCALAR_BYTE)?;

    // Calculate new reserves
    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    let temp_reserve_in = e_add(cpi_ctx, reserve_in, amount_in, SCALAR_BYTE)?;

    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    let temp_reserve_out = e_sub(cpi_ctx, reserve_out, amount_out, SCALAR_BYTE)?;

    // Verify constant product invariant: new_k >= old_k
    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    let old_k = e_mul(cpi_ctx, reserve_in, reserve_out, SCALAR_BYTE)?;

    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    let new_k = e_mul(cpi_ctx, temp_reserve_in, temp_reserve_out, SCALAR_BYTE)?;

    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    let k_ok: Ebool = e_ge(cpi_ctx, new_k, old_k, SCALAR_BYTE)?;

    // Zero out if invariant violated
    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    amount_in = e_select(cpi_ctx, k_ok, amount_in, zero, SCALAR_BYTE)?;

    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    amount_out = e_select(cpi_ctx, k_ok, amount_out, zero, SCALAR_BYTE)?;

    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    fee_amount = e_select(cpi_ctx, k_ok, fee_amount, zero, SCALAR_BYTE)?;

    // Final reserve calculations
    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    let new_reserve_in = e_add(cpi_ctx, reserve_in, amount_in, SCALAR_BYTE)?;

    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    let new_reserve_out = e_sub(cpi_ctx, reserve_out, amount_out, SCALAR_BYTE)?;

    let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
    let new_protocol_fee = e_add(cpi_ctx, protocol_fee_in, fee_amount, SCALAR_BYTE)?;

    Ok((new_reserve_in, new_reserve_out, new_protocol_fee))
}

#[ephemeral]
#[program]
pub mod light_swap_psp {
    use super::*;

    pub fn create_permission(
        ctx: Context<CreatePermission>,
        account_type: AccountType,
        members: Option<Vec<Member>>,
    ) -> Result<()> {
        let CreatePermission {
            permissioned_account,
            permission,
            payer,
            permission_program,
            system_program,
        } = ctx.accounts;

        let seed_data = derive_seeds_from_account_type(&account_type);
        let seeds_slices: Vec<&[u8]> = seed_data.iter().map(|s| s.as_slice()).collect();
        let (pda, bump) = Pubkey::find_program_address(&seeds_slices, &crate::ID);
        require_keys_eq!(permissioned_account.key(), pda, ErrorCode::InvalidPermissionAccount);

        let mut seeds = seed_data.clone();
        seeds.push(vec![bump]);
        let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();

        CreatePermissionCpiBuilder::new(&permission_program)
            .permissioned_account(&permissioned_account.to_account_info())
            .permission(&permission)
            .payer(&payer)
            .system_program(&system_program)
            .args(MembersArgs { members })
            .invoke_signed(&[seed_refs.as_slice()])?;
        Ok(())
    }

    /// Delegate pool authority PDA to the MagicBlock validator for PER execution.
    pub fn delegate_pda(ctx: Context<DelegatePda>, account_type: AccountType) -> Result<()> {
        let seed_data = derive_seeds_from_account_type(&account_type);
        let seeds_refs: Vec<&[u8]> = seed_data.iter().map(|s| s.as_slice()).collect();

        let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &seeds_refs,
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;
        Ok(())
    }

    pub fn initialize_pool<'info>(
        ctx: Context<'_, '_, '_, 'info, InitializePool<'info>>,
        proof: SdkValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_tree_index: u8,
        mint_a: Pubkey,
        mint_b: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        let light_cpi_accounts = CpiAccounts::new(
            ctx.accounts.fee_payer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );

        let tree_pubkey = address_tree_info
            .get_tree_pubkey(&light_cpi_accounts)
            .map_err(|error| ProgramError::Custom(error.into()))?;
        let (address, address_seed) =
            derive_address(&[b"pool", mint_a.as_ref(), mint_b.as_ref()], &tree_pubkey, &crate::ID);
        let new_address_params =
            address_tree_info.into_new_address_params_assigned_packed(address_seed, Some(0));

        let mut pool_account = LightAccount::<SwapPool>::new_init(
            &crate::ID,
            Some(address),
            output_tree_index,
        );
        let inco_program = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.fee_payer.to_account_info();
        
        let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
        pool_account.reserve_a = as_euint128(cpi_ctx, 0)?;

        let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
        pool_account.reserve_b = as_euint128(cpi_ctx, 0)?;

        let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
        pool_account.protocol_fee_a = as_euint128(cpi_ctx, 0)?;

        let cpi_ctx = CpiContext::new(inco_program, Operation { signer });
        pool_account.protocol_fee_b = as_euint128(cpi_ctx, 0)?;
        
        let (pool_authority, _) = Pubkey::find_program_address(
            &[POOL_AUTH_SEED, mint_a.as_ref(), mint_b.as_ref()],
            &crate::ID,
        );
        pool_account.authority = ctx.accounts.authority.key();
        pool_account.pool_authority = pool_authority;
        pool_account.mint_a = mint_a;
        pool_account.mint_b = mint_b;
        pool_account.fee_bps = fee_bps;
        pool_account.is_paused = false;
        pool_account.last_update_ts = Clock::get()?.unix_timestamp;

        LightSystemProgramCpi::new_cpi(crate::LIGHT_CPI_SIGNER, proof)
            .with_light_account(pool_account)?
            .with_new_addresses(&[new_address_params])
            .invoke(light_cpi_accounts)?;
        Ok(())
    }

    /// Add liquidity to the pool with encrypted amounts
    pub fn add_liquidity<'info>(
        ctx: Context<'_, '_, '_, 'info, AddLiquidity<'info>>,
        proof: SdkValidityProof,
        pool_meta: light_sdk::instruction::account_meta::CompressedAccountMeta,
        pool_data: Vec<u8>,
        amount_a_ciphertext: Vec<u8>,
        amount_b_ciphertext: Vec<u8>,
        input_type: u8,
    ) -> Result<()> {
        let light_cpi_accounts = CpiAccounts::new(
            ctx.accounts.fee_payer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );

        let pool_state = SwapPool::try_from_slice(&pool_data)?;
        let mut pool_account = LightAccount::<SwapPool>::new_mut(
            &crate::ID,
            &pool_meta,
            pool_state,
        )?;

        require!(!pool_account.is_paused, ErrorCode::PoolPaused);
        require_keys_eq!(pool_account.authority, ctx.accounts.authority.key(), ErrorCode::Unauthorized);

        let inco_program = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.fee_payer.to_account_info();

        // Parse encrypted amounts
        let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
        let amount_a = new_euint128(cpi_ctx, amount_a_ciphertext, input_type)?;

        let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
        let amount_b = new_euint128(cpi_ctx, amount_b_ciphertext, input_type)?;

        // Add to reserves
        let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
        pool_account.reserve_a = e_add(cpi_ctx, pool_account.reserve_a, amount_a, SCALAR_BYTE)?;

        let cpi_ctx = CpiContext::new(inco_program, Operation { signer });
        pool_account.reserve_b = e_add(cpi_ctx, pool_account.reserve_b, amount_b, SCALAR_BYTE)?;

        pool_account.last_update_ts = Clock::get()?.unix_timestamp;

        // Commit pool state update
        LightSystemProgramCpi::new_cpi(crate::LIGHT_CPI_SIGNER, proof)
            .with_light_account(pool_account)?
            .invoke(light_cpi_accounts)?;

        Ok(())
    }

    /// Remove liquidity from the pool with encrypted amounts
    pub fn remove_liquidity<'info>(
        ctx: Context<'_, '_, '_, 'info, RemoveLiquidity<'info>>,
        proof: SdkValidityProof,
        pool_meta: light_sdk::instruction::account_meta::CompressedAccountMeta,
        pool_data: Vec<u8>,
        amount_a_ciphertext: Vec<u8>,
        amount_b_ciphertext: Vec<u8>,
        input_type: u8,
    ) -> Result<()> {
        let light_cpi_accounts = CpiAccounts::new(
            ctx.accounts.fee_payer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );

        let pool_state = SwapPool::try_from_slice(&pool_data)?;
        let mut pool_account = LightAccount::<SwapPool>::new_mut(
            &crate::ID,
            &pool_meta,
            pool_state,
        )?;

        require!(!pool_account.is_paused, ErrorCode::PoolPaused);
        require_keys_eq!(pool_account.authority, ctx.accounts.authority.key(), ErrorCode::Unauthorized);

        let inco_program = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.fee_payer.to_account_info();

        // Parse encrypted amounts
        let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
        let amount_a = new_euint128(cpi_ctx, amount_a_ciphertext, input_type)?;

        let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
        let amount_b = new_euint128(cpi_ctx, amount_b_ciphertext, input_type)?;

        // Subtract from reserves
        let cpi_ctx = CpiContext::new(inco_program.clone(), Operation { signer: signer.clone() });
        pool_account.reserve_a = e_sub(cpi_ctx, pool_account.reserve_a, amount_a, SCALAR_BYTE)?;

        let cpi_ctx = CpiContext::new(inco_program, Operation { signer });
        pool_account.reserve_b = e_sub(cpi_ctx, pool_account.reserve_b, amount_b, SCALAR_BYTE)?;

        pool_account.last_update_ts = Clock::get()?.unix_timestamp;

        // Commit pool state update
        LightSystemProgramCpi::new_cpi(crate::LIGHT_CPI_SIGNER, proof)
            .with_light_account(pool_account)?
            .invoke(light_cpi_accounts)?;

        Ok(())
    }

    /// Execute a private swap with encrypted amounts
    /// Token transfers are handled separately via compressed token program
    pub fn swap_exact_in<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapExactIn<'info>>,
        proof: SdkValidityProof,
        pool_meta: light_sdk::instruction::account_meta::CompressedAccountMeta,
        pool_data: Vec<u8>,
        amount_in_ciphertext: Vec<u8>,
        amount_out_ciphertext: Vec<u8>,
        fee_amount_ciphertext: Vec<u8>,
        input_type: u8,
        a_to_b: bool,
    ) -> Result<()> {
        let light_cpi_accounts = CpiAccounts::new(
            ctx.accounts.fee_payer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );

        let pool_state = SwapPool::try_from_slice(&pool_data)?;
        let mut pool_account = LightAccount::<SwapPool>::new_mut(
            &crate::ID,
            &pool_meta,
            pool_state,
        )?;

        require!(!pool_account.is_paused, ErrorCode::PoolPaused);

        let inco_program = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.fee_payer.to_account_info();

        // Verify pool authority
        let (expected_pool_authority, _) = Pubkey::find_program_address(
            &[POOL_AUTH_SEED, pool_account.mint_a.as_ref(), pool_account.mint_b.as_ref()],
            &crate::ID,
        );
        require_keys_eq!(pool_account.pool_authority, expected_pool_authority);

        // Get reserves based on swap direction
        let (reserve_in, reserve_out, protocol_fee_in) = if a_to_b {
            (pool_account.reserve_a, pool_account.reserve_b, pool_account.protocol_fee_a)
        } else {
            (pool_account.reserve_b, pool_account.reserve_a, pool_account.protocol_fee_b)
        };

        // Compute encrypted swap updates
        let (new_reserve_in, new_reserve_out, new_protocol_fee) = compute_swap_updates(
            &inco_program,
            &signer,
            reserve_in,
            reserve_out,
            protocol_fee_in,
            &amount_in_ciphertext,
            &amount_out_ciphertext,
            &fee_amount_ciphertext,
            input_type,
        )?;

        // Update pool state
        if a_to_b {
            pool_account.reserve_a = new_reserve_in;
            pool_account.reserve_b = new_reserve_out;
            pool_account.protocol_fee_a = new_protocol_fee;
        } else {
            pool_account.reserve_b = new_reserve_in;
            pool_account.reserve_a = new_reserve_out;
            pool_account.protocol_fee_b = new_protocol_fee;
        }

        pool_account.last_update_ts = Clock::get()?.unix_timestamp;

        // Commit pool state update
        LightSystemProgramCpi::new_cpi(crate::LIGHT_CPI_SIGNER, proof)
            .with_light_account(pool_account)?
            .invoke(light_cpi_accounts)?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Inco Lightning program for encrypted operations
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    pub authority: Signer<'info>,
    /// CHECK: Inco Lightning program for encrypted operations
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    pub authority: Signer<'info>,
    /// CHECK: Inco Lightning program for encrypted operations
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct SwapExactIn<'info> {
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    /// CHECK: Inco Lightning program for encrypted operations
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
}

/// Unified delegate PDA context
#[delegate]
#[derive(Accounts)]
pub struct DelegatePda<'info> {
    /// CHECK: The PDA to delegate
    #[account(mut, del)]
    pub pda: AccountInfo<'info>,
    pub payer: Signer<'info>,
    /// CHECK: Checked by the delegation program
    pub validator: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
pub struct CreatePermission<'info> {
    /// CHECK: Validated via permission program CPI
    pub permissioned_account: UncheckedAccount<'info>,
    /// CHECK: Checked by the permission program
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PERMISSION PROGRAM
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(
    Clone,
    Debug,
    Default,
    LightDiscriminator,
    AnchorSerialize,
    AnchorDeserialize,
)]
pub struct SwapPool {
    pub authority: Pubkey,
    pub pool_authority: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub reserve_a: Euint128,
    pub reserve_b: Euint128,
    pub protocol_fee_a: Euint128,
    pub protocol_fee_b: Euint128,
    pub fee_bps: u16,
    pub is_paused: bool,
    pub last_update_ts: i64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Pool is paused")]
    PoolPaused,
    #[msg("Input mint does not match pool")]
    InvalidInputMint,
    #[msg("Output mint does not match pool")]
    InvalidOutputMint,
    #[msg("Invalid permissioned account")]
    InvalidPermissionAccount,
    #[msg("Unauthorized - only pool authority can perform this action")]
    Unauthorized,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum AccountType {
    PoolAuthority { mint_a: Pubkey, mint_b: Pubkey },
}

fn derive_seeds_from_account_type(account_type: &AccountType) -> Vec<Vec<u8>> {
    match account_type {
        AccountType::PoolAuthority { mint_a, mint_b } => vec![
            POOL_AUTH_SEED.to_vec(),
            mint_a.to_bytes().to_vec(),
            mint_b.to_bytes().to_vec(),
        ],
    }
}
