use anchor_lang::prelude::*;
use inco_lightning::cpi::accounts::Operation;
use inco_lightning::cpi::{as_euint128, e_add, e_ge, e_mul, e_select, e_sub, new_euint128};
use inco_lightning::types::{Ebool, Euint128};
use inco_lightning::ID as INCO_LIGHTNING_ID;
use inco_token::cpi::accounts::IncoTransfer;
use inco_token::cpi::transfer as inco_token_transfer;
use inco_token::{IncoAccount, ID as INCO_TOKEN_ID};
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
const POOL_VAULT_SEED: &[u8] = b"pool_vault";
const SCALAR_BYTE: u8 = 0;

/// Compute encrypted swap updates using Inco Lightning FHE operations
#[inline(never)]
fn compute_swap_updates<'info>(
    _inco_program: &AccountInfo<'info>,
    _signer: &AccountInfo<'info>,
    reserve_in: Euint128,
    reserve_out: Euint128,
    protocol_fee_in: Euint128,
    _amount_in_ciphertext: &[u8],
    _amount_out_ciphertext: &[u8],
    _fee_amount_ciphertext: &[u8],
    _input_type: u8,
) -> Result<(Euint128, Euint128, Euint128)> {
    // DEMO PATH: Skip all FHE operations to avoid consuming ECIES ciphertexts.
    // The ciphertexts are one-time use and must be reserved for the actual
    // token transfers (transfer_in / transfer_out). Consuming them here would
    // cause Custom:1 errors when the transfers try to reuse them.
    msg!("compute_swap_updates: demo (passthrough)");
    Ok((reserve_in, reserve_out, protocol_fee_in))
}

#[program]
pub mod light_swap_psp {
    use super::*;

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
    /// Includes CPI to Inco Token for actual token transfers
    ///
    /// remaining_accounts layout:
    ///   [0..N-num_allowance] = Light Protocol accounts
    ///   [N-num_allowance..N] = Allowance accounts (0 or 6):
    ///     [0..2] transfer_in:  [user_src_allowance_pda, user_address]
    ///     [2..6] transfer_out: [pool_src_allowance_pda, pool_authority, user_dest_allowance_pda, user_address]
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
        num_allowance_accounts: u8,
    ) -> Result<()> {
        let total = ctx.remaining_accounts.len();
        let n_allow = num_allowance_accounts as usize;
        let n_light = total.saturating_sub(n_allow);

        let light_cpi_accounts = CpiAccounts::new(
            ctx.accounts.fee_payer.as_ref(),
            &ctx.remaining_accounts[..n_light],
            crate::LIGHT_CPI_SIGNER,
        );

        let allowance_accounts = if n_allow > 0 {
            &ctx.remaining_accounts[n_light..]
        } else {
            &[] as &[AccountInfo<'info>]
        };

        let pool_state = SwapPool::try_from_slice(&pool_data)?;
        let mut pool_account = LightAccount::<SwapPool>::new_mut(
            &crate::ID,
            &pool_meta,
            pool_state,
        )?;

        require!(!pool_account.is_paused, ErrorCode::PoolPaused);

        let inco_program = ctx.accounts.inco_lightning_program.to_account_info();
        let inco_token_program = ctx.accounts.inco_token_program.to_account_info();
        let signer = ctx.accounts.fee_payer.to_account_info();

        // Verify pool authority - use bump from Anchor's verified constraint
        let bump = ctx.bumps.pool_authority;
        let expected_pool_authority = ctx.accounts.pool_authority.key();
        require_keys_eq!(pool_account.pool_authority, expected_pool_authority);

        // Get reserves based on swap direction
        let (reserve_in, reserve_out, protocol_fee_in) = if a_to_b {
            (pool_account.reserve_a, pool_account.reserve_b, pool_account.protocol_fee_a)
        } else {
            (pool_account.reserve_b, pool_account.reserve_a, pool_account.protocol_fee_b)
        };

        msg!("swap_exact_in: compute_swap_updates");
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
        msg!("swap_exact_in: compute_swap_updates done");

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

        // === TOKEN TRANSFERS via Inco Token CPI ===
        
        // Transfer token_in FROM user TO pool vault
        let (user_token_in, pool_vault_in, user_token_out, pool_vault_out) = if a_to_b {
            (
                ctx.accounts.user_token_a.to_account_info(),
                ctx.accounts.pool_vault_a.to_account_info(),
                ctx.accounts.user_token_b.to_account_info(),
                ctx.accounts.pool_vault_b.to_account_info(),
            )
        } else {
            (
                ctx.accounts.user_token_b.to_account_info(),
                ctx.accounts.pool_vault_b.to_account_info(),
                ctx.accounts.user_token_a.to_account_info(),
                ctx.accounts.pool_vault_a.to_account_info(),
            )
        };

        msg!("swap_exact_in: transfer_in");
        // CPI: Transfer amount_in from user to pool vault (user signs)
        // Forward allowance accounts [0..2] for user source allowance
        let mut transfer_in_ctx = CpiContext::new(
            inco_token_program.clone(),
            IncoTransfer {
                source: user_token_in,
                destination: pool_vault_in,
                authority: signer.clone(),
                inco_lightning_program: inco_program.clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        if allowance_accounts.len() >= 2 {
            transfer_in_ctx = transfer_in_ctx
                .with_remaining_accounts(allowance_accounts[..2].to_vec());
        }
        inco_token_transfer(transfer_in_ctx, amount_in_ciphertext.clone(), input_type)?;

        msg!("swap_exact_in: transfer_out");
        // CPI: Transfer amount_out from pool vault to user (pool authority PDA signs)
        let mint_a_key = ctx.accounts.user_token_a.mint;
        let mint_b_key = ctx.accounts.user_token_b.mint;
        let pool_auth_seeds: &[&[u8]] = &[
            POOL_AUTH_SEED,
            mint_a_key.as_ref(),
            mint_b_key.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[pool_auth_seeds];
        // Forward allowance accounts [2..6] for pool source + user dest allowance
        let mut transfer_out_ctx = CpiContext::new_with_signer(
            inco_token_program,
            IncoTransfer {
                source: pool_vault_out,
                destination: user_token_out,
                authority: ctx.accounts.pool_authority.to_account_info(),
                inco_lightning_program: inco_program,
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            signer_seeds,
        );
        if allowance_accounts.len() >= 6 {
            transfer_out_ctx = transfer_out_ctx
                .with_remaining_accounts(allowance_accounts[2..6].to_vec());
        }
        inco_token_transfer(transfer_out_ctx, amount_out_ciphertext.clone(), input_type)?;

        msg!("swap_exact_in: commit_light_account");
        // Commit pool state update to Light Protocol
        LightSystemProgramCpi::new_cpi(crate::LIGHT_CPI_SIGNER, proof)
            .with_light_account(pool_account)?
            .invoke(light_cpi_accounts)?;

        msg!("swap_exact_in: done");

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
    /// CHECK: Pool authority PDA for signing token transfers (mut required for CPI)
    #[account(mut, seeds = [POOL_AUTH_SEED, user_token_a.mint.as_ref(), user_token_b.mint.as_ref()], bump)]
    pub pool_authority: AccountInfo<'info>,
    /// User's Inco token account for token A
    #[account(mut)]
    pub user_token_a: Account<'info, IncoAccount>,
    /// User's Inco token account for token B  
    #[account(mut)]
    pub user_token_b: Account<'info, IncoAccount>,
    /// Pool vault for token A (owned by pool_authority)
    #[account(mut, constraint = pool_vault_a.owner == pool_authority.key())]
    pub pool_vault_a: Account<'info, IncoAccount>,
    /// Pool vault for token B (owned by pool_authority)
    #[account(mut, constraint = pool_vault_b.owner == pool_authority.key())]
    pub pool_vault_b: Account<'info, IncoAccount>,
    /// CHECK: Inco Lightning program for encrypted operations
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
    /// CHECK: Inco Token program for token transfers
    #[account(address = INCO_TOKEN_ID)]
    pub inco_token_program: AccountInfo<'info>,
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
    #[msg("Unauthorized - only pool authority can perform this action")]
    Unauthorized,
}

